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

## Status
- 15 E2E tests pass (desktop + mobile), including a real PRIM capture fixture.

## Next
- Shared proxy so visitors get real time without a key; RER/tram; PRIM disruptions on the line view.
