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

## Status
- 24 E2E tests pass locally (desktop + mobile): map, real time against a real capture, relay against a fake PRIM.
- Relay not hosted yet. Both existing AWS profiles (`vega-honours`, `statarena`) are the same account with an expired session. `relay/lambda.mjs` and `relay/aws/` are written but never run on AWS: uncommitted until a deploy proves them.
- AWS sign-in from this machine (2026-11-22, not solved): the user's browser answered AWS's 400 page on every attempt. Verified: `aws login` (redirect to 127.0.0.1) cannot work here, Windows does not reach WSL ports on 127.0.0.1 (it does on the WSL address); a link cut at the first `&` reproduces that 400 page; the same links reach the sign-in page from WSL without cookies. Last attempt, outcome unknown: `aws login --profile paris-metro --region us-east-2 --remote` (the earlier working session was issued by us-east-2) opened in a private Chrome window. The user then answered "Non c bon" without a code: no session exists, sign-in stopped.

## Next
- Ask the user whether to continue with AWS or stop there. Nothing exists on AWS.
- If AWS: get a session (`--remote`, code pasted back), check the account's free-tier usage (`aws freetier get-free-tier-usage`) and existing DynamoDB tables in eu-west-3 before creating anything; then `AWS_PROFILE=paris-metro relay/aws/deploy.sh`, `gh variable set REALTIME_URL`, redeploy the site, check production without a key, commit the AWS files.
- Later: RER/tram; PRIM disruptions on the line view.
