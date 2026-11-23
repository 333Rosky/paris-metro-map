import { defineConfig, devices } from "@playwright/test";
import { KEY, MAX_STALE_SECONDS, REFRESH_SECONDS, RELAY, SITE, UPSTREAM } from "./tests/relay-env";

const port = (url: string) => new URL(url).port;

export default defineConfig({
  testDir: "tests",
  timeout: 60_000,
  // Every page renders 3D in software (SwiftShader, itself multi-threaded): more
  // than a few browsers at once starve each other. CI keeps Playwright's default.
  workers: process.env.CI ? undefined : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173/",
    screenshot: "on",
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: "npm run build && npx vite preview --port 4173 --strictPort",
      url: "http://localhost:4173/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // tests/relay.spec.ts: a stand-in for PRIM, the relay in front of it, and
    // the site built to read its real time from that relay.
    {
      command: "node tests/fake-prim.mjs",
      url: UPSTREAM + "__stats",
      env: { PORT: port(UPSTREAM), FAKE_PRIM_KEY: KEY },
      reuseExistingServer: false,
    },
    {
      command: "node relay/server.mjs",
      url: RELAY + "health",
      env: {
        PORT: port(RELAY),
        PRIM_API_KEY: KEY,
        PRIM_URL: UPSTREAM + "estimated-timetable",
        REFRESH_SECONDS: String(REFRESH_SECONDS),
        MAX_STALE_SECONDS: String(MAX_STALE_SECONDS),
      },
      reuseExistingServer: false,
    },
    {
      command: `npx vite build --outDir dist-relay && npx vite preview --outDir dist-relay --port ${port(SITE)} --strictPort`,
      url: SITE,
      env: { VITE_REALTIME_URL: RELAY },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
