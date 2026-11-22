// Ports and timings shared by playwright.config.ts and tests/relay.spec.ts.
export const SITE = "http://localhost:4174/"; // site built with VITE_REALTIME_URL = RELAY
export const RELAY = "http://localhost:4175/";
export const UPSTREAM = "http://localhost:4176/"; // tests/fake-prim.mjs
export const KEY = "test-relay-key";
export const REFRESH_SECONDS = 2;
export const MAX_STALE_SECONDS = 5;
