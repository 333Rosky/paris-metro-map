// Fetches and parses the PRIM feed off the main thread: the full Île-de-France
// response is ~30 MB of JSON, of which the metro is a small part.

import { parseSiri, type RtCall, type SiriRefs } from "./siri";

export interface FetchRequest {
  url: string;
  key: string;
  refs: SiriRefs;
}

export type FetchResult =
  | { ok: true; calls: RtCall[]; journeys: number; quotaRemaining: number | null }
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
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(45_000) });
    if (!res.ok) {
      scope.postMessage({ ok: false, status: res.status });
      return;
    }
    // Only readable when PRIM exposes the header to browsers; null otherwise.
    const remaining = res.headers.get("x-ratelimit-remaining-day") ?? res.headers.get("ratelimit-remaining");
    const { calls, journeys } = parseSiri(await res.json(), refs);
    scope.postMessage({ ok: true, calls, journeys, quotaRemaining: remaining === null ? null : Number(remaining) });
  } catch {
    scope.postMessage({ ok: false, status: 0 });
  }
};
