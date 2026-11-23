import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { METRO_LINES } from "../relay/core.mjs";
import { KEY, MAX_STALE_SECONDS, REFRESH_SECONDS, RELAY, SITE, UPSTREAM } from "./relay-env";

// The relay (relay/server.mjs) holds the PRIM key and serves the metro part of
// the feed to every visitor. Here it runs against tests/fake-prim.mjs, and the
// site under test is a second build whose VITE_REALTIME_URL points at it.
//
// Failure modes and expected outcomes:
//   - the key leaks                         -> never in a response body or header
//   - many visitors at once                 -> one upstream call per refresh window
//   - PRIM fails                            -> last snapshot served while recent,
//                                              then 503 naming the cause, no retry storm
//   - PRIM recovers                         -> fresh data on the next window
//   - a visitor has an old key in storage   -> it is not sent to the relay
//   - the relay refuses one request         -> retried quietly, no error shown
//   - the relay is down                     -> the map stays on the timetable and says so
//   - the relay stops answering later       -> trains return to the timetable within minutes
//   - the relay hands out an old snapshot   -> refused: old predictions misplace trains
//   - IDFM adds a metro line                -> the relay's list no longer matches the network

test.describe.configure({ mode: "serial" });

const network = JSON.parse(readFileSync("public/data/network.json", "utf8"));
const fixture = JSON.parse(readFileSync("tests/fixtures/prim-metro-20261122T184801Z.json", "utf8"));
const capturedAt = Date.parse(fixture.Siri.ServiceDelivery.ResponseTimestamp);
const journeysOf = (p: any) =>
  p.Siri.ServiceDelivery.EstimatedTimetableDelivery[0].EstimatedJourneyVersionFrame[0].EstimatedVehicleJourney;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextWindow = () => sleep(REFRESH_SECONDS * 1000 + 250);
const stats = async (request: APIRequestContext) => (await request.get(UPSTREAM + "__stats")).json();
const upstreamAnswers = (request: APIRequestContext, status: number) => request.get(`${UPSTREAM}__control?status=${status}`);

const unavailable = { status: 503, json: { error: "upstream_unavailable" }, headers: { "access-control-allow-origin": "*" } };
const timetableOnly = (page: Page) =>
  page.waitForFunction(() => {
    const m = (window as any).metro;
    return !m.state.realtime && m.running().length > 100 && m.running().every((r: any) => !r.id.startsWith("rt:"));
  });

test.beforeEach(async ({ request }) => {
  await upstreamAnswers(request, 200);
});

test("the relay serves the metro only, slimmed, and never the key", async ({ request }) => {
  const res = await request.get(RELAY);
  expect(res.status()).toBe(200);
  const headers = res.headers();
  expect(headers["access-control-allow-origin"]).toBe("*");
  expect(headers["content-type"]).toContain("application/json");
  expect(headers["cache-control"]).toBe("no-store");
  const body = await res.text();
  const payload = JSON.parse(body);

  // Exactly the metro journeys of the capture, reduced to the fields the map reads.
  expect(journeysOf(payload)).toEqual(journeysOf(fixture));
  expect(payload.Siri.ServiceDelivery.ResponseTimestamp).toBe(fixture.Siri.ServiceDelivery.ResponseTimestamp);
  expect(body + JSON.stringify(headers)).not.toContain(KEY);

  const s = await stats(request);
  expect(s.authorized).toBeGreaterThan(0);
  expect(s.unauthorized).toBe(0);

  // Clients that do not accept gzip get plain JSON.
  const plain = await request.get(RELAY, { headers: { "accept-encoding": "identity" } });
  expect(plain.headers()["content-encoding"]).toBeUndefined();
  expect(journeysOf(await plain.json())).toHaveLength(journeysOf(fixture).length);
});

test("one upstream call per refresh window, however many visitors ask", async ({ request }) => {
  await request.get(RELAY);
  await nextWindow();
  const before = (await stats(request)).hits;

  const burst = await Promise.all(Array.from({ length: 25 }, () => request.get(RELAY)));
  for (const r of burst) expect(r.status()).toBe(200);
  expect((await stats(request)).hits).toBe(before + 1);

  const again = await request.get(RELAY);
  expect((await stats(request)).hits).toBe(before + 1);
  const refreshIn = Number(again.headers()["x-refresh-in"]);
  expect(refreshIn).toBeGreaterThanOrEqual(0);
  expect(refreshIn).toBeLessThanOrEqual(REFRESH_SECONDS);
  expect(again.headers()["access-control-expose-headers"]).toContain("x-refresh-in");

  await nextWindow();
  await request.get(RELAY);
  expect((await stats(request)).hits).toBe(before + 2);
});

test("while PRIM fails the last snapshot is served, then the cause is reported, then it recovers", async ({ request }) => {
  expect((await request.get(RELAY)).status()).toBe(200);
  await upstreamAnswers(request, 500);
  await nextWindow();

  const stale = await request.get(RELAY);
  expect(stale.status()).toBe(200);
  expect(stale.headers()["x-refresh-in"]).toBe("0");
  expect(journeysOf(await stale.json())).toHaveLength(journeysOf(fixture).length);

  await sleep(MAX_STALE_SECONDS * 1000);
  for (const [status, error] of [
    [500, "upstream_unavailable"],
    [401, "upstream_auth"],
    [429, "upstream_quota"],
  ] as const) {
    await upstreamAnswers(request, status);
    await nextWindow();
    const before = (await stats(request)).hits;
    const res = await request.get(RELAY);
    expect(res.status(), `PRIM ${status}`).toBe(503);
    expect(res.headers()["access-control-allow-origin"]).toBe("*");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error });
    expect(body + JSON.stringify(res.headers())).not.toContain(KEY);
    // A failed attempt also uses up the window: no retry storm against PRIM.
    await Promise.all(Array.from({ length: 10 }, () => request.get(RELAY)));
    expect((await stats(request)).hits).toBe(before + 1);
  }

  await upstreamAnswers(request, 200);
  await nextWindow();
  expect((await request.get(RELAY)).status()).toBe(200);
});

test("only GET / is served", async ({ request }) => {
  expect((await request.post(RELAY)).status()).toBe(405);
  expect((await request.get(RELAY + "estimated-timetable")).status()).toBe(404);
  expect((await request.head(RELAY)).status()).toBe(200);
  const preflight = await request.fetch(RELAY, { method: "OPTIONS" });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()["access-control-allow-origin"]).toBe("*");
  expect((await request.get(RELAY + "health")).status()).toBe(200);
});

test("the relay's line list is the network's metro lines", () => {
  expect([...METRO_LINES].sort()).toEqual(network.lines.map((l: any) => l.ref).sort());
});

test("with a relay, the site opens in Direct: real time for every visitor, with no key asked or sent", async ({ page }, info) => {
  test.slow(); // live mode keeps rendering; screenshots are slow under software WebGL
  await page.clock.setFixedTime(capturedAt);
  // A key saved in this browser before the relay existed must stay in the browser.
  await page.addInitScript(() => localStorage.setItem("prim-api-key", "visitor-own-key"));
  const relayRequests: Record<string, string>[] = [];
  const primRequests: string[] = [];
  await page.route(RELAY + "**", (route) => {
    relayRequests.push(route.request().headers());
    return route.continue();
  });
  await page.route("https://prim.iledefrance-mobilites.fr/**", (route) => {
    primRequests.push(route.request().url());
    return route.abort();
  });

  // No ?live: a plain visit starts in live mode.
  await page.goto(SITE);
  await page.waitForFunction(() => (window as any).metro?.state.realtime, null, { timeout: 15_000 });
  await expect(page.locator("#key-dialog")).toBeHidden();
  await expect(page.locator("#live")).toHaveAttribute("data-state", "ok");

  const result = await page.evaluate(() => {
    const m = (window as any).metro;
    const lines = m.schedule.network.lines;
    const perLine: Record<string, { rt: number; scheduled: number }> = {};
    for (const l of lines) perLine[l.id] = { rt: 0, scheduled: 0 };
    for (const r of m.running()) perLine[lines[r.line].id][r.id.startsWith("rt:") ? "rt" : "scheduled"]++;
    return { perLine, calls: m.feed.calls.length };
  });
  await info.attach("trains-per-line.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });

  // Same expectations as the direct-to-PRIM test on this capture (realtime.spec.ts).
  expect(result.calls).toBeGreaterThan(2700);
  const covered = Object.entries(result.perLine).filter(([id]) => id !== "6");
  for (const [id, n] of covered) expect(n.rt, `line ${id} has real-time trains`).toBeGreaterThan(0);
  const total = covered.reduce((sum, [, n]) => sum + n.rt, 0);
  expect(total).toBeGreaterThan(200);
  expect(total).toBeLessThan(320);

  expect(relayRequests.length).toBeGreaterThan(0);
  for (const headers of relayRequests) expect(headers.apikey).toBeUndefined();
  expect(primRequests).toEqual([]);

  // Already live: the button has no key to manage.
  await page.locator("#live").click();
  await expect(page.locator("#key-dialog")).toBeHidden();
  expect(await page.evaluate(() => (window as any).metro.state.live)).toBe(true);
  await page.screenshot({ path: info.outputPath("relay-live.png") });
});

test("with a relay, a link to a given moment stays on the timetable", async ({ page }) => {
  await page.goto(SITE + "?time=08:30&paused");
  await page.waitForFunction(() => (window as any).metro?.state.ready);
  const s = await page.evaluate(() => (window as any).metro.state);
  expect(s.live).toBe(false);
  expect(s.playing).toBe(false);
});

test("a single refused request is retried quietly", async ({ page }) => {
  test.slow(); // the retry adds five seconds to a live page under software WebGL
  // What AWS answers when more requests arrive at once than the account may run.
  await page.clock.setFixedTime(capturedAt);
  let requests = 0;
  await page.route(RELAY + "**", (route) =>
    requests++ === 0
      ? route.fulfill({ status: 429, json: { Message: "Rate Exceeded." }, headers: { "access-control-allow-origin": "*" } })
      : route.continue(),
  );
  await page.goto(SITE + "?live");
  await page.waitForFunction(() => (window as any).metro?.state.realtime, null, { timeout: 20_000 });
  expect(requests).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#rt-error")).toBeHidden();
  await expect(page.locator("#live")).toHaveAttribute("data-state", "ok");
});

test("when the relay is unavailable the map stays on the timetable and says so", async ({ page }, info) => {
  test.slow(); // two quiet retries come before the error
  await page.clock.setFixedTime(capturedAt);
  await page.route(RELAY + "**", (route) => route.fulfill(unavailable));
  await page.goto(SITE + "?live");
  // Two quiet retries (5 s, then 10 s) come before the error is shown.
  await expect(page.locator("#rt-error")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#rt-error")).toContainText("Temps réel indisponible");
  await expect(page.locator("#rt-error button")).toBeHidden();
  await expect(page.locator("#live")).toHaveAttribute("data-state", "error");
  await page.waitForFunction(() => Number(document.getElementById("count")!.textContent) > 100);
  const s = await page.evaluate(() => (window as any).metro.state);
  expect(s.live).toBe(true);
  expect(s.realtime).toBe(false);
  await page.screenshot({ path: info.outputPath("relay-down.png") });
});

test("when the relay stops answering, trains return to the timetable", async ({ page }) => {
  test.slow();
  await page.clock.install({ time: capturedAt });
  await page.goto(SITE + "?live");
  await page.waitForFunction(() => (window as any).metro?.state.realtime, null, { timeout: 15_000 });

  await page.route(RELAY + "**", (route) => route.fulfill(unavailable));
  await page.clock.fastForward("04:30");
  await expect(page.locator("#rt-error")).toContainText("Temps réel indisponible", { timeout: 30_000 });
  await timetableOnly(page);
});

test("a snapshot that is too old is not shown as real time", async ({ page }) => {
  // The relay serves the capture; for this visitor it was taken ten minutes ago.
  await page.clock.setFixedTime(capturedAt + 10 * 60_000);
  await page.goto(SITE + "?live");
  await expect(page.locator("#rt-error")).toContainText("Temps réel indisponible");
  await timetableOnly(page);
});
