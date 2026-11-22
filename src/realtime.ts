// Real-time layer: IDFM PRIM "estimated-timetable" (SIRI Lite JSON).
//
// The metro has no public GPS feed. PRIM publishes, for each running train,
// the expected arrival/departure time at its upcoming stops; positions are
// interpolated between the previous and next stop along the GTFS track shape.

import type { Network, Timetable } from "./types";

export const PRIM_URL = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable";
const REFRESH_MS = 60_000; // PRIM refreshes once a minute
const BACKOFF_MS = 5 * 60_000;
const KEY_STORAGE = "prim-api-key";

export interface RtCall {
  station: number;
  /** Epoch milliseconds. */
  arr: number;
  dep: number;
}

export interface RtJourney {
  id: string;
  line: number;
  destination: string;
  calls: RtCall[];
}

export interface RtTrain {
  id: string;
  journey: RtJourney;
  line: number;
  shape: number;
  dist: number;
  /** Station the train is at or has just left, when known. */
  from: number | null;
  /** Index in journey.calls of the next (or current) call. */
  next: number;
  dwelling: boolean;
}

export type RtStatus =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "ok"; at: number; journeys: number }
  | { kind: "error"; message: string; auth: boolean };

// SIRI Lite wraps most strings as {value}; some producers send arrays of them.
type Json = any;
function text(x: Json): string | undefined {
  if (x == null) return undefined;
  if (Array.isArray(x)) return text(x[0]);
  if (typeof x === "string") return x;
  if (typeof x === "object" && "value" in x) return text(x.value);
  return undefined;
}
function time(...candidates: Json[]): number | undefined {
  for (const c of candidates) {
    const s = text(c);
    if (!s) continue;
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}
const lastCode = (ref: string | undefined) => ref?.split(":").filter(Boolean).pop();

export function parseSiri(payload: Json, network: Network): RtJourney[] {
  const lineByRef = new Map(network.lines.map((l, i) => [l.ref, i]));
  const deliveries: Json[] = payload?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery ?? [];
  const out: RtJourney[] = [];
  let n = 0;
  for (const delivery of deliveries) {
    for (const frame of delivery?.EstimatedJourneyVersionFrame ?? []) {
      for (const vj of frame?.EstimatedVehicleJourney ?? []) {
        n++;
        const lineRef = text(vj.LineRef)?.match(/C\d{5}/)?.[0];
        const line = lineRef ? lineByRef.get(lineRef) : undefined;
        if (line === undefined) continue;

        const raw: Json[] = [
          ...(vj.RecordedCalls?.RecordedCall ?? []),
          ...(vj.EstimatedCalls?.EstimatedCall ?? []),
        ];
        const calls: RtCall[] = [];
        for (const c of raw) {
          const station = network.stopRefs[lastCode(text(c.StopPointRef)) ?? ""];
          if (station === undefined) continue;
          const arr = time(c.ActualArrivalTime, c.ExpectedArrivalTime, c.AimedArrivalTime);
          const dep = time(c.ActualDepartureTime, c.ExpectedDepartureTime, c.AimedDepartureTime);
          if (arr === undefined && dep === undefined) continue;
          const call = { station, arr: arr ?? dep!, dep: Math.max(dep ?? arr!, arr ?? dep!) };
          const prev = calls[calls.length - 1];
          if (prev && prev.station === call.station) {
            prev.dep = Math.max(prev.dep, call.dep);
            continue;
          }
          calls.push(call);
        }
        if (!calls.length) continue;
        calls.sort((a, b) => a.arr - b.arr);

        const lastRaw = raw[raw.length - 1];
        const destination =
          text(vj.DestinationName) ??
          text(lastRaw?.DestinationDisplay) ??
          network.stations[calls[calls.length - 1].station].name;
        const id =
          text(vj.DatedVehicleJourneyRef) ??
          text(vj.FramedVehicleJourneyRef?.DatedVehicleJourneyRef) ??
          `${lineRef}-${n}`;
        out.push({ id, line, destination, calls });
      }
    }
  }
  return out;
}

function ease(f: number): number {
  return f - Math.sin(2 * Math.PI * f) / (2 * Math.PI);
}

interface Span {
  shape: number;
  d0: number;
  d1: number;
  /** Scheduled seconds from leaving `a` to reaching `b`. */
  run: number;
}

/** Track geometry lookups between stations, derived from the timetable patterns. */
export class Track {
  private spans = new Map<string, Span | null>();
  private byLine = new Map<number, { shape: number; stops: number[]; dist: number[]; arr: number[]; dep: number[] }[]>();

  constructor(timetable: Timetable) {
    const seen = new Set<string>();
    for (const p of timetable.patterns) {
      const key = `${p.line}|${p.shape}|${p.stops.join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let list = this.byLine.get(p.line);
      if (!list) this.byLine.set(p.line, (list = []));
      list.push(p);
    }
  }

  /** Geometry from station a to b (b after a on some run of the line). */
  span(line: number, a: number, b: number): Span | null {
    const key = `${line}|${a}|${b}`;
    const cached = this.spans.get(key);
    if (cached !== undefined) return cached;
    let best: Span | null = null;
    let bestGap = Infinity;
    for (const p of this.byLine.get(line) ?? []) {
      const i = p.stops.indexOf(a);
      if (i < 0) continue;
      const j = p.stops.indexOf(b, i + 1);
      if (j < 0 || j - i >= bestGap) continue;
      bestGap = j - i;
      best = { shape: p.shape, d0: p.dist[i], d1: p.dist[j], run: p.arr[j] - p.dep[i] };
    }
    this.spans.set(key, best);
    return best;
  }

  /** Station served just before `b` on a run heading on to `c` (if given). */
  before(line: number, b: number, c?: number): number | null {
    let fallback: number | null = null;
    for (const p of this.byLine.get(line) ?? []) {
      const k = p.stops.indexOf(b);
      if (k <= 0) continue;
      if (c === undefined || p.stops[k + 1] === c) return p.stops[k - 1];
      if (c !== undefined && p.stops.indexOf(c, k + 1) > 0) fallback ??= p.stops[k - 1];
    }
    return fallback;
  }
}

/** Where every train of the feed is at `now` (epoch ms). */
export function locate(journeys: RtJourney[], track: Track, now: number): RtTrain[] {
  const out: RtTrain[] = [];
  for (const j of journeys) {
    const t = trainAt(j, track, now);
    if (t) out.push(t);
  }
  return out;
}

export function trainAt(j: RtJourney, track: Track, now: number): RtTrain | null {
  const { calls, line } = j;
  const i = calls.findIndex((c) => c.dep >= now);
  if (i < 0) return null; // run finished
  const c = calls[i];
  const base = { id: j.id, journey: j, line, next: i };

  if (c.arr <= now) {
    // At the platform.
    const neighbour = i > 0 ? track.span(line, calls[i - 1].station, c.station) : null;
    const after = !neighbour && i + 1 < calls.length ? track.span(line, c.station, calls[i + 1].station) : null;
    const s = neighbour ?? after;
    if (!s) return null;
    return { ...base, shape: s.shape, dist: neighbour ? s.d1 : s.d0, from: c.station, dwelling: true };
  }

  // Heading to call i: find where it comes from and when it left.
  let from: number | null;
  let left: number;
  if (i > 0) {
    from = calls[i - 1].station;
    left = calls[i - 1].dep;
  } else {
    from = track.before(line, c.station, calls[1]?.station);
    if (from === null) {
      // First stop of the run: only show it shortly before departure.
      if (c.arr - now > 120_000 || calls.length < 2) return null;
      const s = track.span(line, c.station, calls[1].station);
      return s ? { ...base, shape: s.shape, dist: s.d0, from: c.station, dwelling: true } : null;
    }
    const s = track.span(line, from, c.station);
    left = c.arr - (s ? s.run * 1000 : 90_000);
  }
  const s = track.span(line, from, c.station);
  if (!s) return null;
  if (now < left) {
    // Not yet left the previous station (or still upstream of it).
    if (left - now > 180_000) return null;
    return { ...base, shape: s.shape, dist: s.d0, from, dwelling: true };
  }
  const f = c.arr > left ? ease(Math.min(1, (now - left) / (c.arr - left))) : 1;
  return { ...base, shape: s.shape, dist: s.d0 + (s.d1 - s.d0) * f, from, dwelling: false };
}

export interface RtBoardRow {
  journey: RtJourney;
  arr: number;
  dep: number;
  terminus: boolean;
}

export function rtBoard(journeys: RtJourney[], station: number, now: number, limit = 14): RtBoardRow[] {
  const rows: RtBoardRow[] = [];
  for (const j of journeys) {
    j.calls.forEach((c, k) => {
      if (c.station === station && c.dep >= now) {
        rows.push({ journey: j, arr: c.arr, dep: c.dep, terminus: k === j.calls.length - 1 });
      }
    });
  }
  rows.sort((a, b) => a.arr - b.arr);
  return rows.slice(0, limit);
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
  journeys: RtJourney[] = [];
  status: RtStatus = { kind: "off" };
  private timer: number | undefined;
  private running = false;

  constructor(
    private network: Network,
    private url: string,
    public key: string,
    private onUpdate: () => void,
  ) {}

  get configured(): boolean {
    return this.url !== PRIM_URL || this.key !== "";
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.status.kind !== "ok") this.status = { kind: "loading" };
    this.onUpdate();
    void this.poll();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  restart(): void {
    this.stop();
    this.journeys = [];
    this.status = { kind: "off" };
    this.start();
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    if (this.running) this.timer = window.setTimeout(() => void this.poll(), ms);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    if (document.hidden) return this.schedule(5_000);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.key) headers.apikey = this.key;
      const res = await fetch(this.url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        const auth = res.status === 401 || res.status === 403;
        const message = auth
          ? "Clé API refusée par PRIM"
          : res.status === 429
            ? "Quota PRIM atteint, nouvel essai dans 5 min"
            : `PRIM indisponible (${res.status})`;
        this.status = { kind: "error", message, auth };
        this.onUpdate();
        if (!auth) this.schedule(res.status === 429 ? BACKOFF_MS : REFRESH_MS);
        else this.stop();
        return;
      }
      const journeys = parseSiri(await res.json(), this.network);
      if (!this.running) return;
      this.journeys = journeys;
      this.status = { kind: "ok", at: Date.now(), journeys: journeys.length };
      this.onUpdate();
      this.schedule(REFRESH_MS);
    } catch {
      this.status = { kind: "error", message: "PRIM injoignable", auth: false };
      this.onUpdate();
      this.schedule(REFRESH_MS);
    }
  }
}
