// Fetches and parses the feed off the main thread: straight from PRIM the full
// Île-de-France response is ~30 MB of JSON, of which the metro is a small part.

import { parseSiri, type RtCall, type SiriRefs } from "./siri";

export interface FetchRequest {
  url: string;
  /** Sent as the `apikey` header when not empty. */
  key: string;
  refs: SiriRefs;
}

export type FetchResult =
  | {
      ok: true;
      calls: RtCall[];
      journeys: number;
      /** When the snapshot was produced (epoch ms), if the feed says so. */
      stamp: number | null;
      /** Seconds until a newer snapshot can exist; only a relay says so. */
      refreshIn: number | null;
    }
  | { ok: false; status: number };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FetchRequest>) => void) | null;
  postMessage(message: FetchResult): void;
};

scope.onmessage = async (e) => {
  const { url, key, refs } = e.data;
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers.apikey = key;
    const res = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(45_000) });
    if (!res.ok) {
      scope.postMessage({ ok: false, status: res.status });
      return;
    }
    const refreshIn = res.headers.get("x-refresh-in");
    const { calls, journeys, stamp } = parseSiri(await res.json(), refs);
    scope.postMessage({
      ok: true,
      calls,
      journeys,
      stamp,
      refreshIn: refreshIn === null || !Number.isFinite(Number(refreshIn)) ? null : Number(refreshIn),
    });
  } catch {
    scope.postMessage({ ok: false, status: 0 });
  }
};
