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

## Real time (2026-11-22)
- Source: PRIM `marketplace/estimated-timetable` (SIRI Lite JSON, `apikey` header, CORS `*` verified). No GPS for the metro: positions interpolated between previous and next call along GTFS shapes.
- Key handling: user's own PRIM key in localStorage (static Pages, no secret in repo). Optional `VITE_REALTIME_URL` for a key-holding proxy (not built yet).
- Lines missing from the feed fall back to scheduled positions, drawn translucent.
- Verified with a simulated feed (E2E). NOT yet verified against the live PRIM feed: needs a PRIM key; quota for recent tokens reportedly ~1000/day (docs blocked to bots, figure unconfirmed).

## Next
- Live check with a real PRIM key (payload size, metro coverage, StopPointRef codes).
- Shared proxy so visitors get real time without a key; RER/tram; train orientation.
