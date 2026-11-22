// Real-time layer: IDFM PRIM "estimated-timetable" (SIRI Lite JSON).
//
// The metro has no public GPS feed. PRIM publishes, for every stop, when the
// next few trains towards each destination are expected. Trains are rebuilt
// from those per-stop predictions:
//
//   1. each prediction "train towards D reaches stop S in L seconds" is
//      back-projected along the scheduled run to D: the train is where a
//      scheduled train would be L seconds before reaching S;
//   2. predictions that land within a tolerance of each other are the same
//      train seen from several stops; the one from the nearest stop wins.
//
// Between two refreshes (PRIM updates once a minute) trains keep moving along
// the scheduled profile from their last anchor.

import { patternState, type PatternState } from "./schedule";
import type { RtCall, SiriRefs } from "./siri";
import type { FetchRequest, FetchResult } from "./rt-worker";
import type { Network, Pattern, Timetable } from "./types";

export type { RtCall } from "./siri";

export const PRIM_URL = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable";
const REFRESH_MS = 60_000; // PRIM refreshes once a minute
const BACKOFF_MS = 5 * 60_000;
const KEY_STORAGE = "prim-api-key";

/** Predictions further ahead than this say little about where the train is now. */
const MAX_LEAD_MS = 15 * 60_000;
/** Predictions already this far in the past are leftovers. */
const PAST_MS = 45_000;
/** Same-train tolerance: base seconds + share of the prediction's lead. */
const TOL_BASE_S = 60;
const TOL_PER_LEAD = 0.25;
/** A train seen from a single far stop is not trusted. */
const LONE_LEAD_MS = 120_000;
/** Keep extrapolating this long past the anchor when no refresh arrives. */
const COAST_MS = 150_000;
const BLEND_MS = 8_000;

export interface RtTrain {
  id: string;
  line: number;
  dest: number;
  destName: string;
  /** Scheduled run the train is assumed to follow, and its anchor stop on it. */
  pattern: number;
  k: number;
  station: number;
  /** Expected arrival at the anchor stop and end of its dwell there, epoch ms. */
  at: number;
  dwellEnd: number;
  /** Predictions attributed to this train. */
  calls: RtCall[];
  /** Offset (pattern seconds) easing the jump from the previous anchor. */
  blend?: { delta: number; t0: number };
}

export interface RtState extends PatternState {
  tau: number;
}

export type RtStatus =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ok"; at: number; trains: number; journeys: number }
  | { kind: "error"; message: string; auth: boolean };

/** Lookups over the scheduled patterns of each line. */
export class Track {
  private byLine = new Map<number, number[]>();
  private weight: number[];
  private picks = new Map<string, { pattern: number; k: number } | null>();
  private neighbours = new Map<string, Set<number>>();

  constructor(private timetable: Timetable) {
    const { patterns, services } = timetable;
    this.weight = new Array(patterns.length).fill(0);
    for (const flat of services) for (let i = 0; i < flat.length; i += 2) this.weight[flat[i]]++;
    patterns.forEach((p, pi) => {
      let list = this.byLine.get(p.line);
      if (!list) this.byLine.set(p.line, (list = []));
      list.push(pi);
      for (const s of p.stops) {
        const key = `${p.line}|${s}`;
        let set = this.neighbours.get(key);
        if (!set) this.neighbours.set(key, (set = new Set()));
        for (const o of p.stops) set.add(o);
      }
    });
  }

  /** Most common run of the line that serves `station` and then reaches `dest`. */
  pick(line: number, station: number, dest: number): { pattern: number; k: number } | null {
    const key = `${line}|${station}|${dest}`;
    const cached = this.picks.get(key);
    if (cached !== undefined) return cached;
    let best: { pattern: number; k: number } | null = null;
    let bestEnds = false;
    let bestWeight = -1;
    for (const pi of this.byLine.get(line) ?? []) {
      const p = this.timetable.patterns[pi];
      const k = p.stops.indexOf(station);
      if (k < 0 || p.stops.indexOf(dest, k) < 0) continue;
      const ends = p.stops[p.stops.length - 1] === dest;
      const w = this.weight[pi];
      if (!best || (ends && !bestEnds) || (ends === bestEnds && w > bestWeight)) {
        best = { pattern: pi, k };
        bestEnds = ends;
        bestWeight = w;
      }
    }
    this.picks.set(key, best);
    return best;
  }

  /** True when some run of the line serves both stations (same branch). */
  share(line: number, a: number, b: number): boolean {
    return this.neighbours.get(`${line}|${a}`)?.has(b) ?? false;
  }
}

function baseTau(train: RtTrain, p: Pattern, now: number): number | null {
  const { k } = train;
  if (now < train.at) return p.arr[k] - (train.at - now) / 1000;
  if (now <= train.dwellEnd) return p.arr[k] + Math.min((now - train.at) / 1000, p.dep[k] - p.arr[k]);
  if (now - train.dwellEnd > COAST_MS) return null;
  return p.dep[k] + (now - train.dwellEnd) / 1000;
}

/** Where a reconstructed train is at `now` (epoch ms); null once out of sight. */
export function rtState(train: RtTrain, patterns: Pattern[], now: number): RtState | null {
  const p = patterns[train.pattern];
  let tau = baseTau(train, p, now);
  if (tau === null) return null;
  if (train.blend) {
    const w = 1 - (now - train.blend.t0) / BLEND_MS;
    if (w > 0) tau += train.blend.delta * w;
  }
  if (tau < 0) {
    // Waiting at its first stop: shown shortly before departure only.
    if (train.k !== 0 || train.at - now > 90_000) return null;
    tau = 0;
  }
  const state = patternState(p, tau);
  return state ? { ...state, tau } : null;
}

let nextId = 1;

/** Rebuilds trains from per-stop predictions; `previous` keeps ids stable across refreshes. */
export function buildTrains(
  calls: RtCall[],
  track: Track,
  patterns: Pattern[],
  now: number,
  previous: RtTrain[] = [],
): RtTrain[] {
  interface Candidate {
    call: RtCall;
    pattern: number;
    k: number;
    lead: number;
    /** Seconds left to reach the destination. */
    u: number;
  }
  const groups = new Map<string, Candidate[]>();
  for (const call of calls) {
    call.train = undefined;
    const lead = call.arr - now;
    if (lead < -PAST_MS || lead > MAX_LEAD_MS) continue;
    const pick = track.pick(call.line, call.station, call.dest);
    if (!pick) continue;
    const p = patterns[pick.pattern];
    const ahead = Math.max(lead, 0) / 1000;
    const tau = p.arr[pick.k] - ahead;
    if (tau < 0 && !(pick.k === 0 && lead < 90_000)) continue; // not departed yet
    const key = `${call.line}|${call.dest}`;
    let list = groups.get(key);
    if (!list) groups.set(key, (list = []));
    list.push({ call, ...pick, lead, u: p.arr[p.arr.length - 1] - p.arr[pick.k] + ahead });
  }

  const built: (RtTrain & { u: number; lead: number })[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.lead - b.lead);
    const trains: (RtTrain & { u: number; lead: number })[] = [];
    for (const c of list) {
      const tol = TOL_BASE_S + (TOL_PER_LEAD * Math.max(c.lead, 0)) / 1000;
      let hit: (typeof trains)[number] | undefined;
      for (const t of trains) {
        const d = Math.abs(t.u - c.u);
        if (d > tol || (hit && d >= Math.abs(hit.u - c.u))) continue;
        if (track.share(c.call.line, t.station, c.call.station)) hit = t;
      }
      if (hit) {
        hit.calls.push(c.call);
        continue;
      }
      const p = patterns[c.pattern];
      trains.push({
        id: "",
        line: c.call.line,
        dest: c.call.dest,
        destName: c.call.destName,
        pattern: c.pattern,
        k: c.k,
        station: c.call.station,
        at: c.call.arr,
        dwellEnd: Math.max(c.call.dep, c.call.arr + (p.dep[c.k] - p.arr[c.k]) * 1000),
        calls: [c.call],
        u: c.u,
        lead: c.lead,
      });
    }
    for (const t of trains) if (t.calls.length >= 2 || t.lead <= LONE_LEAD_MS) built.push(t);
  }

  // Keep identities: a new train inherits the id of the previous train that
  // would be at about the same place now.
  const old = previous
    .map((t) => {
      const s = rtState(t, patterns, now);
      const p = patterns[t.pattern];
      return s ? { t, tau: s.tau, u: p.arr[p.arr.length - 1] - s.tau, used: false } : null;
    })
    .filter((x) => x !== null);
  built.sort((a, b) => a.lead - b.lead);
  for (const t of built) {
    let best: (typeof old)[number] | null = null;
    for (const o of old) {
      if (o.used || o.t.line !== t.line || o.t.dest !== t.dest) continue;
      const d = Math.abs(o.u - t.u);
      if (d <= 90 && (!best || d < Math.abs(best.u - t.u))) best = o;
    }
    if (best) {
      best.used = true;
      t.id = best.t.id;
      if (best.t.pattern === t.pattern) {
        const p = patterns[t.pattern];
        const fresh = baseTau(t, p, now);
        if (fresh !== null) t.blend = { delta: best.tau - fresh, t0: now };
      }
    } else {
      t.id = `t${nextId++}`;
    }
    for (const c of t.calls) c.train = t.id;
  }
  return built;
}

export function loadKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    return "";
  }
}

export function saveKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable: key lives for this page only */
  }
}

/** Polls the feed while started. `url` may point to a proxy that holds the key. */
export class RealtimeFeed {
  calls: RtCall[] = [];
  trains: RtTrain[] = [];
  /** Lines the feed currently covers. */
  lines = new Set<number>();
  status: RtStatus = { kind: "off" };
  private byId = new Map<string, RtTrain>();
  private timer: number | undefined;
  private running = false;
  private worker: Worker | undefined;
  private refs: SiriRefs;
  private track: Track;

  constructor(
    network: Network,
    private timetable: Timetable,
    private url: string,
    public key: string,
    private onUpdate: () => void,
  ) {
    this.track = new Track(timetable);
    this.refs = {
      lineRefs: Object.fromEntries(network.lines.map((l, i) => [l.ref, i])),
      stopRefs: network.stopRefs,
    };
  }

  get configured(): boolean {
    return this.url !== PRIM_URL || this.key !== "";
  }

  train(id: string): RtTrain | undefined {
    return this.byId.get(id);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.status.kind !== "ok") this.status = { kind: "loading" };
    this.onUpdate();
    this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  clear(): void {
    this.stop();
    this.calls = [];
    this.trains = [];
    this.lines = new Set();
    this.byId = new Map();
    this.status = { kind: "off" };
  }

  restart(): void {
    this.clear();
    this.start();
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (this.running) this.timer = window.setTimeout(() => this.poll(), ms);
  }

  private poll(): void {
    if (!this.running) return;
    if (document.hidden) return this.schedule(5_000);
    if (!this.worker) {
      this.worker = new Worker(new URL("./rt-worker.ts", import.meta.url), { type: "module" });
      this.worker.onmessage = (e: MessageEvent<FetchResult>) => this.receive(e.data);
      this.worker.onerror = () => this.receive({ ok: false, status: 0 });
    }
    const request: FetchRequest = { url: this.url, key: this.key, refs: this.refs };
    this.worker.postMessage(request);
  }

  private receive(result: FetchResult): void {
    if (!this.running) return;
    if (!result.ok) {
      const auth = result.status === 401 || result.status === 403;
      const message = auth
        ? "Clé API refusée par PRIM"
        : result.status === 429
          ? "Quota PRIM atteint, nouvel essai dans 5 min"
          : result.status === 0
            ? "PRIM injoignable"
            : `PRIM indisponible (${result.status})`;
      this.status = { kind: "error", message, auth };
      if (auth) this.stop();
      else this.schedule(result.status === 429 ? BACKOFF_MS : REFRESH_MS);
      this.onUpdate();
      return;
    }
    const now = Date.now();
    this.calls = result.calls;
    this.trains = buildTrains(result.calls, this.track, this.timetable.patterns, now, this.trains);
    this.byId = new Map(this.trains.map((t) => [t.id, t]));
    this.lines = new Set(result.calls.map((c) => c.line));
    this.status = { kind: "ok", at: now, trains: this.trains.length, journeys: result.journeys };
    this.onUpdate();
    this.schedule(REFRESH_MS);
  }
}
