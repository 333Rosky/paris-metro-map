// Stand-in for PRIM "estimated-timetable", used by tests/relay.spec.ts.
//
// Serves the real metro capture of tests/fixtures the way PRIM serves it:
// buried among other lines' journeys and carrying fields the map never reads.
// Requires the `apikey` header, counts calls, and can be told to fail:
//
//   GET /estimated-timetable     the feed (401 without the expected key)
//   GET /__control?status=500    answer every feed request with that status (200 = normal)
//   GET /__stats                 { hits, authorized, unauthorized }

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const KEY = process.env.FAKE_PRIM_KEY ?? "test-relay-key";
const PORT = Number(process.env.PORT ?? 4176);

const fixture = JSON.parse(readFileSync(new URL("./fixtures/prim-metro-20261122T184801Z.json", import.meta.url), "utf8"));
const delivery = fixture.Siri.ServiceDelivery;
const metro = delivery.EstimatedTimetableDelivery[0].EstimatedJourneyVersionFrame[0].EstimatedVehicleJourney;

const noise = (line, n) => ({
  RecordedAtTime: delivery.ResponseTimestamp,
  LineRef: { value: `STIF:Line::${line}:` },
  DatedVehicleJourneyRef: { value: `NOISE:${line}:${n}` },
  DestinationRef: { value: "STIF:StopPoint:Q:1:" },
  DestinationName: [{ value: "Ailleurs" }],
  EstimatedCalls: {
    EstimatedCall: [{ StopPointRef: { value: "STIF:StopPoint:Q:2:" }, ExpectedDepartureTime: delivery.ResponseTimestamp }],
  },
});

// C01742 is RER A, C01389 a non-metro RATP line present in real responses, C02251 a bus.
const journeys = [];
metro.forEach((vj, i) => {
  if (i % 3 === 0) journeys.push(noise(["C01742", "C01389", "C02251"][(i / 3) % 3], i));
  journeys.push({
    RecordedAtTime: delivery.ResponseTimestamp,
    ...vj,
    DirectionRef: { value: "Aller" },
    VehicleMode: ["METRO"],
    PublishedLineName: [{ value: "?" }],
    OperatorRef: { value: "RATP-SIV:Operator::TEST:" },
    JourneyNote: [],
    EstimatedCalls: {
      EstimatedCall: vj.EstimatedCalls.EstimatedCall.map((c) => ({
        ...c,
        DestinationDisplay: vj.DestinationName,
        DepartureStatus: "ON_TIME",
      })),
    },
  });
});

const feed = JSON.stringify({
  Siri: {
    ServiceDelivery: {
      ResponseTimestamp: delivery.ResponseTimestamp,
      ProducerRef: "IVTR_HET",
      ResponseMessageIdentifier: "IVTR_HET:ResponseMessage:test",
      EstimatedTimetableDelivery: [
        {
          ResponseTimestamp: delivery.ResponseTimestamp,
          Version: "2.0",
          Status: "true",
          EstimatedJourneyVersionFrame: [{ EstimatedVehicleJourney: journeys }],
        },
      ],
    },
  },
});

let status = 200;
const stats = { hits: 0, authorized: 0, unauthorized: 0 };

createServer((req, res) => {
  const url = new URL(req.url, "http://fake");
  const json = (code, body, headers = {}) =>
    res.writeHead(code, { "content-type": "application/json", ...headers }).end(typeof body === "string" ? body : JSON.stringify(body));
  if (url.pathname === "/__stats") return json(200, stats);
  if (url.pathname === "/__control") {
    status = Number(url.searchParams.get("status") ?? 200);
    return json(200, { status });
  }
  if (url.pathname !== "/estimated-timetable") return json(404, { message: "no Route matched with those values" });
  stats.hits++;
  if (req.headers.apikey !== KEY) {
    stats.unauthorized++;
    return json(401, { message: "Invalid authentication credentials" });
  }
  stats.authorized++;
  if (status !== 200) return json(status, { message: `simulated ${status}` });
  json(200, feed, { "x-ratelimit-limit-day": "1000", "x-ratelimit-remaining-day": String(1000 - stats.authorized) });
}).listen(PORT, () => console.log(`fake PRIM on :${PORT} (${metro.length} metro journeys among ${journeys.length})`));
