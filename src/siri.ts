// Parsing of IDFM PRIM "estimated-timetable" responses (SIRI Lite JSON).
// No DOM access: this module also runs inside the feed worker.

/** One prediction: "at this stop, a train towards `dest` is expected at `arr`". */
export interface RtCall {
  line: number;
  /** Destination station index. */
  dest: number;
  destName: string;
  station: number;
  /** Epoch milliseconds. */
  arr: number;
  dep: number;
  /** Reconstructed train this prediction was attributed to, if any. */
  train?: string;
}

export interface SiriRefs {
  /** "C01371" -> line index. */
  lineRefs: Record<string, number>;
  /** Numeric stop code -> station index. */
  stopRefs: Record<string, number>;
}

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
const lastCode = (ref: string | undefined) => ref?.split(":").filter(Boolean).pop() ?? "";

/**
 * Flattens the feed into per-stop predictions.
 *
 * On most metro lines an EstimatedVehicleJourney is NOT one physical train:
 * the same id carries calls from both ends of the line with unrelated times
 * (verified on a capture of 2026-11-22). Only the individual calls are
 * trustworthy, so journeys are deliberately discarded here.
 */
export function parseSiri(payload: Json, refs: SiriRefs): { calls: RtCall[]; journeys: number } {
  const deliveries: Json[] = payload?.Siri?.ServiceDelivery?.EstimatedTimetableDelivery ?? [];
  const calls: RtCall[] = [];
  let journeys = 0;
  for (const delivery of deliveries) {
    for (const frame of delivery?.EstimatedJourneyVersionFrame ?? []) {
      for (const vj of frame?.EstimatedVehicleJourney ?? []) {
        const lineRef = text(vj.LineRef)?.match(/C\d{5}/)?.[0];
        const line = lineRef ? refs.lineRefs[lineRef] : undefined;
        if (line === undefined) continue;
        journeys++;
        const raw: Json[] = vj.EstimatedCalls?.EstimatedCall ?? [];
        let dest: number | undefined = refs.stopRefs[lastCode(text(vj.DestinationRef))];
        const journeyDest = text(vj.DestinationName);
        const parsed: { station: number; arr: number; dep: number; display?: string }[] = [];
        for (const c of raw) {
          const station = refs.stopRefs[lastCode(text(c.StopPointRef))];
          if (station === undefined) continue;
          const arr = time(c.ExpectedArrivalTime, c.AimedArrivalTime);
          const dep = time(c.ExpectedDepartureTime, c.AimedDepartureTime);
          if (arr === undefined && dep === undefined) continue;
          parsed.push({
            station,
            arr: arr ?? dep!,
            dep: Math.max(dep ?? arr!, arr ?? dep!),
            display: text(c.DestinationDisplay),
          });
        }
        if (!parsed.length) continue;
        if (dest === undefined) {
          // No DestinationRef: assume a per-vehicle journey ending at its last call.
          dest = parsed.reduce((a, b) => (b.arr > a.arr ? b : a)).station;
        }
        for (const c of parsed) {
          calls.push({
            line,
            dest,
            destName: journeyDest ?? c.display ?? "",
            station: c.station,
            arr: c.arr,
            dep: c.dep,
          });
        }
      }
    }
  }
  return { calls, journeys };
}
