# Worklog

## Goal
Open-source map of every Paris metro train moving over time, with arrivals and departures, published on GitHub.

## Constraints
- Open data only: IDFM GTFS (ODbL) for timetable and track shapes; OpenFreeMap basemap (no API key).
- Static site (GitHub Pages); data regenerated daily by CI, not committed.

## Decisions
- Positions are interpolated from the planned timetable (GTFS), not real time. Real time (IDFM PRIM API, key required) is a follow-up.
- Trips are deduplicated into ~420 patterns (stops + run times) → <1 MB JSON for ~34k trips.
- Stops are placed on shapes with an order-preserving DP (handles 7bis / 10 loops).
- Stack: Python stdlib pipeline, Vite + TypeScript + MapLibre GL 6, Playwright E2E.

## Status (2026-11-22)
- Pipeline, map, station boards, train detail, playback, line filters done.
- E2E: 7 tests pass locally and in CI (desktop + mobile); evidence uploaded as the `e2e-evidence` workflow artifact.
- Live: https://333rosky.github.io/paris-metro-map/ (deployed and checked in Chromium, no console errors).

## Real time (2026-11-22, verified against the live feed)
- Source: PRIM `marketplace/estimated-timetable` (SIRI Lite JSON, `apikey` header, CORS `*`). Quota confirmed from response headers: 1000 requests/day. Response: 30 MB JSON (2.6 MB gzip), 8.7k journeys, 624 metro.
- Finding: on most lines an EstimatedVehicleJourney is not a physical train (same id carries calls from both ends of the line). Line 14 is the exception. Only per-stop predictions are trusted.
- Model: back-project each prediction along the scheduled run to its destination, cluster predictions landing within 60 s + 25 % of lead, nearest stop wins; ids kept across refreshes by position.
- Check on the live feed (Sunday 20:52): 220 trains rebuilt vs 197 scheduled on the 15 covered lines; line 6 absent from the feed, falls back to the timetable. 214 of 227 ids kept across one refresh.
- Feed fetched and parsed in a worker. Key: user's own, localStorage only; `.env` for local checks (git-ignored); pre-commit hook refuses the key value.

## Line view and train bodies (2026-11-22)
- User request: "model the trains when clicking a line". Clicking a badge or a line trace isolates the line, fits the map and opens a schematic (stations, branches, trains both ways).
- Layout derived from the stop sequences: orientation by the longest run, links weighted by trip count (rare depot runs cannot reroute the diagram), trunk = longest path, branches in a second lane.
- Trains drawn to scale along the track from zoom 12.5 (75 m; 90 m lines 1/4; 120 m line 14; 45 m 3bis/7bis).
- Line badges now focus a line instead of hiding it (the hide toggle is gone).

## Relay (2026-11-22)
- User request: every visitor gets real time without a key. The key stays the only secret of the project.
- `relay/core.mjs` (no dependency): on demand, at most one PRIM request per 90 s (≤ 960/day, floor of 87 s enforced against the real PRIM), metro lines only, same SIRI Lite shape, ~45 KB gzipped. Serves the last snapshot up to 5 min when PRIM fails, then 503 with the cause. `x-refresh-in` tells clients when to poll again.
- `relay/server.mjs`: plain Node server for any host. `relay/lambda.mjs` + `relay/aws/`: AWS Lambda function URL, snapshot and upstream claim in a DynamoDB table (one conditional write per window), key in an SSM SecureString.
- Host decision (user, 2026-11-22): "AWS si c'est gratuit". Design therefore uses only services with a monthly free allowance confirmed on AWS pages that day: Lambda (1M requests, 400k GB-s), DynamoDB provisioned (25 WCU / 25 RCU / 25 GB per Region and payer account; table set to 10/10), CloudWatch Logs (5 GB), data transfer out (100 GB), SSM standard parameters. S3 was dropped: no free allowance could be confirmed. Allowances are shared with whatever else runs in the account.
- Site: `VITE_REALTIME_URL` (repository variable `REALTIME_URL` in CI) switches to relay mode: no key dialog, the stored key is never sent to the relay, trains fall back to the timetable when no snapshot younger than 4 min is available (also applies to direct PRIM mode).
- Verified locally against the real PRIM feed (22:48): refresh in 1.6 s, 597 metro journeys, 43 KB; site through the relay shows 187 real-time trains on 15 lines, line 6 from the timetable, no key requested or sent.

## Relay on AWS (2026-11-23)
- Deployed: stack `paris-metro-relay` in eu-west-3 (Lambda function URL, DynamoDB table 10/10, SSM SecureString `/paris-metro-relay/prim-api-key`, 14-day log group), from the `paris-metro` AWS profile (same account as `vega-honours` / `statarena`, root console session).
- URL: https://bml7tq677ufemquxeepkabhoiu0emdjx.lambda-url.eu-west-3.on.aws/ , set as the repository variable `REALTIME_URL`.
- Free tier checked on the account before creating anything (`aws freetier get-free-tier-usage`, 22 Nov): Lambda 27k / 400k GB-s and 107k / 1M requests used this month by other projects, CloudWatch 0.12 / 5 GB, KMS 5.9k / 20k requests, no DynamoDB table anywhere in eu-west-3. All offers reported as "Always Free"; the account predates the 2025 free/paid plans.
- Verified on AWS: stored key equals `.env`; cold first call 1.9 s (PRIM fetched in ~1 s), then ~0.2 s; key absent from body and headers; one CORS header; 405/404/204 as designed; 8 simultaneous requests on a due snapshot across 10 instances made exactly one PRIM request.
- Limit found: the account allows 10 concurrent Lambda executions in eu-west-3, so 12 simultaneous requests got one 429. The site now retries a failed relay request quietly twice (5 s, 10 s) before showing an error.
- Table size check: a 95 KB test item (twice a daytime snapshot) was written and read back on the 10/10 table, then deleted (93 write units from the unused-capacity reserve).
- Production checked 2026-11-23 01:07 on https://333rosky.github.io/paris-metro-map/?live with no key in the browser: relay mode, feed ok (178 journeys at end of service), 53 real-time trains on 14 lines, lines 6 and 7bis from the timetable, no key dialog, no `apikey` header, no console error; published scripts contain the relay address and not the key.
- CI: the line-view test read the train counter before the next frame (failed once on the runner); it now waits for it.
- AWS sign-in on this machine: `aws login --profile paris-metro --region us-east-2 --remote`, link opened in a private Chrome window, code pasted back by the user. The default flow (redirect to 127.0.0.1) cannot work from WSL here.

## 3D map and live by default (2026-11-23)
- User request: "la map en 3D, les trains aussi quand on clique dessus, pourquoi on ne peut pas suivre en direct ?"
- Why: following did work in production (probe 01:09: an rt train stayed selected and followed across 3 feed refreshes), but the site opened on the timetable at ×10, Direct had to be clicked. It now opens in Direct when a relay is set, unless the link pins a moment (`date`/`time`/`speed`/`paused`). The metro publishes no GPS: live positions remain rebuilt from per-stop predictions.
- 3D: map tilted (pitch 50, maxPitch 78), sky, OpenMapTiles buildings as fill-extrusion (render_height), 2D/3D button. Trains are fill-extrusion boxes along the track (width kept at a few px, length to scale, front end in the line's text colour). The selected train, from zoom 15.8, is a detailed model (cars, windows, livery stripe, roof, cab lights; real scale at zoom ≥ 18). Click flies the camera beside it (zoom 18.3, pitch 62).
- Found: MapLibre depth-tests all extrusions together, so buildings hid the train (the line runs under them). With a train open, buildings fade to opacity 0 between zoom 15.2 and 16.2 (MapLibre skips a layer at 0, depth included).
- Following now redraws every frame (was 10 fps in live mode) and pauses while the camera is moving.
- Not done: terrain relief. Real meshes per rolling stock: started below.

## Real rolling stock (2026-11-23)
- User request: "quand je dis 3D je pense qu'on peut faire les vrais trains en cliquant dessus et en le modélisant", then "Oui, la 14 d'abord": line 14 first, so the user can judge the look before the other lines.
- `src/stock.ts` says which line has a modelled stock (so far `"14"`: MP 14, 8 cars of 15.04 m). `src/train-mesh.ts` draws it: a three.js scene in the map's WebGL context (MapLibre custom layer, `renderingMode: "3d"`), fetched on the first click on such a train (separate chunk, 135 KB gzip); the extruded model stays as the stand-in while it loads or if it fails, and for every other line.
- The model is built in code, no asset: body lofted from a cross-section, livery and lit windows painted on canvases (side and front textures plus emissive maps), bogies on tyres, gangways, white LED frame at the head and red at the tail. Each car sits on its two bogie points along the track, so the train bends with the line; past the end of a shape it carries straight on (`pointBeyond`).
- Sourced (Wikipedia fr/en, read 2026-11-23): car length 15.04 m, width 2.45 m, 3 two-leaf doors a side, open gangways, white livery with silver band, sky-blue line along the roof and at the doors, flat front with LED strip. Not sourced, estimated: height (3.5 m), door width (1.65 m), window layout, roof units.
- Limit: the PRIM feed names no trainset or stock type (`VehicleFeatureRef` and `VehicleJourneyName` empty on the 624 metro journeys of the 22 Nov capture), so a train gets the stock of its line; on a line with several stocks it will be one of them.
- The map context now has antialiasing on (`canvasContextAttributes.antialias`), for the mesh edges. Under the mesh a flat dark footprint stays in `train-3d`: shadow and click target.
- Found while testing: three's hemisphere light points to +y by default; the scene's up is z. The roof came out grey until its position was set to (0, 0, 1).
- Not done (at the time): other stocks, MP 14 of lines 4 and 11.

## Rolling stock on every line (2026-11-23)
- User request: "faudrait faire ça sur tous les trains en vrai". Ownership of `src/stock.ts` / `src/train-mesh.ts` passed to the "3D map" session (the MP 14 session had closed).
- Fleet per line checked on fr/en Wikipedia (edited Aug–Nov 2026), Métropolitor, RATP/IDFM press: 1 MP 05 (6), 2/5 MF 01 (5, RATP livery), 9 MF 01 (STIF livery), 3/10/12 MF 67 (5; 3bis 3), 4 MP 14 (6), 6 MP 89 CC (5, last MP 73 ran 8 Jul 2026), 7/8 MF 77 (IDFM livery), 13 MF 77 (RATP jade), 7bis MF 88 (3, MF 19 from 14 Dec 2026), 11 MP 14 CC (5), 14 MP 14 (8).
- Decisions: line 4 has no majority stock (MP 89 CA 21, MP 14 20 + 4 ordered, MP 05 11): MP 14 drawn. Line 10 drawn as MF 67 (25) though MF 19 (7) is arriving. Line 8 drawn in IDFM livery (44 of 62 trains renovated).
- `train-mesh.ts` is now one builder driven by the spec in `stock.ts`: width, height, floor, upright or inclined sides, car pitch, doors (count, width), gangways or separate cars (walls + coupler), rubber tyres or steel wheels, raked windscreen (setback from the waist up), livery (skirt, bands, window strip, door colours, face mask, LED frame or painted outline). The MP 14 keeps its exact numbers.
- Sourced: lengths, widths, heights, door counts and widths (except MF 01 door width and MF 88 height), gangways, tyres. Estimated: livery colours and band heights (Wikipedia describes them in words only, some only from memory), nose rake, window layout. Check against photos before calling them exact.
- Checked: one train per line opens with its stock, car count and length (new E2E test); close-ups of each stock family looked at; extruded model still shown when the mesh chunk cannot load (test blocks it).
- Not done: MF 19 (lines 7bis from 14 Dec 2026, 10 from 2027), MP 89 CA / MP 05 mix of line 4, distinct MP 89 CC cab vs CA panoramic end, per-train stock (the feed does not say), a check on a phone.

## Status
- 29 E2E tests (desktop + mobile): map, real time against a real capture, relay against a fake PRIM, the rolling stock of every line.

## Next
- Mid-December 2026: switch 7bis to MF 19 (4 cars, IDFM livery); 2027: line 10.
- Later: RER/tram; PRIM disruptions on the line view.
- If the AWS session expires: sign in again with the `--remote` command above before running `relay/aws/deploy.sh`.
