// Real-time relay: holds the PRIM key server-side and serves every visitor the
// metro part of the Île-de-France "estimated-timetable" feed.
//
// PRIM allows 1 000 requests a day for the whole region (30 MB of JSON each).
// The relay fetches it at most once per refresh window, and only while someone
// is asking; it keeps the 16 metro lines and the few fields the map reads
// (about 40 KB gzipped) and hands that same snapshot to everyone.
//
// This module has no dependency and no I/O of its own besides `fetch`: the
// snapshot lives in a store (memory here, S3 in lambda.mjs) so that several
// instances can share one snapshot and one upstream budget.

import { gunzipSync, gzipSync } from "node:zlib";

export const PRIM_URL = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable";

/** IDFM identifiers of the metro lines: 1 to 14, then 3bis and 7bis. */
export const METRO_LINES = [
  "C01371", "C01372", "C01373", "C01374", "C01375", "C01376", "C01377",
  "C01378", "C01379", "C01380", "C01381", "C01382", "C01383", "C01384",
  "C01386", "C01387",
];

/** 1 000 requests a day is one every 86.4 s. */
const PRIM_MIN_REFRESH_MS = 87_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
/** How long a request waits for a refresh started by another one when there is nothing to serve. */
const WAIT_MS = 10_000;
const TIMES = ["AimedArrivalTime", "ExpectedArrivalTime", "AimedDepartureTime", "ExpectedDepartureTime"];

// SIRI Lite wraps most strings as {value}; some producers send arrays of them.
function text(x) {
  if (x == null) return undefined;
  if (Array.isArray(x)) return text(x[0]);
  if (typeof x === "string") return x;
  if (typeof x === "object" && "value" in x) return text(x.value);
  return undefined;
}

/**
 * Keeps the journeys of `lines` and, for each, what the map reads: line,
 * destination and the predicted times at each stop. Same SIRI Lite shape as
 * the input, so a client can read PRIM or the relay with the same parser.
 */
export function slim(payload, lines = METRO_LINES) {
  const delivery = payload?.Siri?.ServiceDelivery;
  if (!Array.isArray(delivery?.EstimatedTimetableDelivery)) throw new UpstreamError("upstream_invalid");
  const keep = new Set(lines);
  const journeys = [];
  for (const d of delivery.EstimatedTimetableDelivery) {
    for (const frame of d?.EstimatedJourneyVersionFrame ?? []) {
      for (const vj of frame?.EstimatedVehicleJourney ?? []) {
        const lineRef = text(vj.LineRef);
        const code = lineRef?.match(/C\d{5}/)?.[0];
        if (!code || !keep.has(code)) continue;
        const name = text(vj.DestinationName);
        const calls = [];
        for (const c of vj.EstimatedCalls?.EstimatedCall ?? []) {
          const stop = text(c.StopPointRef);
          if (!stop) continue;
          const call = { StopPointRef: { value: stop } };
          for (const key of TIMES) if (typeof c[key] === "string") call[key] = c[key];
          if (Object.keys(call).length === 1) continue;
          const display = name ? undefined : text(c.DestinationDisplay);
          if (display) call.DestinationDisplay = [{ value: display }];
          calls.push(call);
        }
        if (!calls.length) continue;
        const out = { LineRef: { value: lineRef } };
        const id = text(vj.DatedVehicleJourneyRef);
        if (id) out.DatedVehicleJourneyRef = { value: id };
        const dest = text(vj.DestinationRef);
        if (dest) out.DestinationRef = { value: dest };
        if (name) out.DestinationName = [{ value: name }];
        out.EstimatedCalls = { EstimatedCall: calls };
        journeys.push(out);
      }
    }
  }
  return {
    journeys: journeys.length,
    payload: {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: text(delivery.ResponseTimestamp) ?? null,
          EstimatedTimetableDelivery: [{ EstimatedJourneyVersionFrame: [{ EstimatedVehicleJourney: journeys }] }],
        },
      },
    },
  };
}

export class UpstreamError extends Error {
  /** @param {"upstream_auth" | "upstream_quota" | "upstream_unavailable" | "upstream_invalid"} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Snapshot store for a single process.
 *
 * A store holds the last snapshot `{ body: gzipped JSON, fetchedAt }` and one
 * claim record `{ at, error }`: who last went to PRIM, and how it ended.
 * `claim` must be atomic: of all callers within `gapMs`, one gets `true`.
 */
export class MemoryStore {
  #snapshot = null;
  #claim = null;
  async read() {
    return this.#snapshot;
  }
  async write(snapshot) {
    this.#snapshot = snapshot;
  }
  async claim(now, gapMs) {
    if (this.#claim && now - this.#claim.at < gapMs) return false;
    this.#claim = { at: now, error: null };
    return true;
  }
  async fail(error) {
    if (this.#claim) this.#claim.error = error;
  }
  async status() {
    return this.#claim;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Relay {
  /**
   * @param {object} options
   * @param {string} options.key PRIM API key; only ever sent to `url`.
   * @param {string} [options.url]
   * @param {number} [options.refreshMs] Minimum time between two upstream requests.
   * @param {number} [options.maxStaleMs] Oldest snapshot still worth serving when PRIM fails.
   */
  constructor({ key, url = PRIM_URL, refreshMs = 90_000, maxStaleMs = 300_000, store = new MemoryStore(), log = console.log }) {
    if (!key) throw new Error("PRIM API key missing");
    this.key = key;
    this.url = url;
    // Against the real PRIM the daily quota is a hard floor, whatever the settings say.
    this.refreshMs = url === PRIM_URL ? Math.max(refreshMs, PRIM_MIN_REFRESH_MS) : refreshMs;
    this.maxStaleMs = Math.max(maxStaleMs, this.refreshMs);
    this.store = store;
    this.log = log;
    this.local = null;
  }

  /** @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>} */
  async handle(method, path, headers = {}) {
    const cors = { "access-control-allow-origin": "*" };
    const reply = (status, body, extra = {}) => ({
      status,
      headers: { ...cors, "cache-control": "no-store", ...extra },
      body: method === "HEAD" ? Buffer.alloc(0) : body,
    });
    const json = (status, value) =>
      reply(status, Buffer.from(JSON.stringify(value)), { "content-type": "application/json; charset=utf-8" });

    if (method === "OPTIONS") {
      return reply(204, Buffer.alloc(0), { "access-control-allow-methods": "GET", "access-control-max-age": "86400" });
    }
    if (path === "/health") return reply(200, Buffer.from("ok"), { "content-type": "text/plain" });
    if (path !== "/") return json(404, { error: "not_found" });
    if (method !== "GET" && method !== "HEAD") return json(405, { error: "method_not_allowed" });

    const { snapshot, error } = await this.current();
    if (!snapshot) return json(503, { error: error ?? "upstream_unavailable" });

    const gzip = /\bgzip\b/.test(String(headers["accept-encoding"] ?? ""));
    const refreshIn = Math.max(0, Math.ceil((snapshot.fetchedAt + this.refreshMs - Date.now()) / 1000));
    return reply(200, gzip ? snapshot.body : gunzipSync(snapshot.body), {
      "content-type": "application/json; charset=utf-8",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
      vary: "accept-encoding",
      // Seconds until a newer snapshot can exist: clients poll again then, not blindly.
      "x-refresh-in": String(refreshIn),
      "access-control-expose-headers": "x-refresh-in",
    });
  }

  /** The snapshot to serve now, refreshing it first when it is due and nobody else is on it. */
  async current() {
    const due = (s) => !s || Date.now() - s.fetchedAt >= this.refreshMs;
    const usable = (s) => (s && Date.now() - s.fetchedAt <= this.maxStaleMs ? s : null);
    const sync = async () => {
      const shared = await this.store.read();
      if (shared && (!this.local || shared.fetchedAt > this.local.fetchedAt)) this.local = shared;
    };

    if (!due(this.local)) return { snapshot: this.local };
    await sync(); // another instance may have refreshed already
    if (!due(this.local)) return { snapshot: this.local };

    if (await this.store.claim(Date.now(), this.refreshMs)) {
      try {
        this.local = await this.refresh();
        return { snapshot: this.local };
      } catch (e) {
        const error = e instanceof UpstreamError ? e.reason : "upstream_unavailable";
        this.log(`refresh failed: ${error}`);
        await this.store.fail(error);
        return { snapshot: usable(this.local), error };
      }
    }

    if (usable(this.local)) return { snapshot: this.local };
    // Nothing to serve. Either the last attempt failed (say so), or a refresh
    // is under way elsewhere (wait for it rather than answer empty-handed).
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const status = await this.store.status();
      if (status?.error) return { snapshot: null, error: status.error };
      if (Date.now() >= deadline) return { snapshot: null, error: "upstream_unavailable" };
      await sleep(250);
      await sync();
      if (usable(this.local) && !due(this.local)) return { snapshot: this.local };
    }
  }

  async refresh() {
    const started = Date.now();
    let res;
    try {
      res = await fetch(this.url, {
        headers: { apikey: this.key, accept: "application/json" },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new UpstreamError("upstream_unavailable");
    }
    if (!res.ok) {
      await res.body?.cancel();
      const auth = res.status === 401 || res.status === 403;
      throw new UpstreamError(auth ? "upstream_auth" : res.status === 429 ? "upstream_quota" : "upstream_unavailable");
    }
    let parsed;
    try {
      parsed = await res.json();
    } catch {
      throw new UpstreamError("upstream_invalid");
    }
    const { payload, journeys } = slim(parsed);
    const snapshot = { body: gzipSync(JSON.stringify(payload)), fetchedAt: Date.now() };
    await this.store.write(snapshot);
    const quota = res.headers.get("x-ratelimit-remaining-day");
    this.log(
      `refreshed in ${Date.now() - started} ms: ${journeys} metro journeys, ${Math.round(snapshot.body.length / 1024)} KB gzipped` +
        (quota === null ? "" : `, ${quota} PRIM requests left today`),
    );
    return snapshot;
  }
}
