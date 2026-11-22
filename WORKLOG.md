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
- AWS sign-in on this machine: `aws login --profile paris-metro --region us-east-2 --remote`, link opened in a private Chrome window, code pasted back by the user. The default flow (redirect to 127.0.0.1) cannot work from WSL here.

## Status
- 25 E2E tests (desktop + mobile): map, real time against a real capture, relay against a fake PRIM.

## Next
- Later: RER/tram; PRIM disruptions on the line view.
- If the AWS session expires: sign in again with the `--remote` command above before running `relay/aws/deploy.sh`.
