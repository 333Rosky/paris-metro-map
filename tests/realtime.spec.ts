import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";

// Live mode against a simulated PRIM "estimated-timetable" response.
//
// The fake feed is derived from the timetable itself: every run of lines 1 and
// 14 in service at 08:30 on a Tue–Thu, delayed by DELAY seconds, with the
// remaining calls only (as PRIM sends them). Other lines are absent from the
// feed, so they must stay on scheduled positions.

const network = JSON.parse(readFileSync("public/data/network.json", "utf8"));
const timetable = JSON.parse(readFileSync("public/data/timetable.json", "utf8"));
const PRIM = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable**";
const DELAY = 120;
const FEED_LINES = ["1", "14"];

const date = Object.keys(timetable.days)
  .sort()
  .find((d) => {
    const day = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
    return day >= 2 && day <= 4;
  })!;

/** Epoch ms for HH:MM Paris time on `date`. */
function parisMs(seconds: number): number {
  const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`;
  const utcMidnight = Date.parse(iso);
  for (const offset of [1, 2]) {
    const ms = utcMidnight + (seconds - offset * 3600) * 1000;
    const hour = +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23" }).format(ms);
    if (hour === Math.floor(seconds / 3600) % 24) return ms;
  }
  throw new Error("cannot resolve Paris offset");
}

const NOW_T = 8 * 3600 + 30 * 60;
const NOW = parisMs(NOW_T);

const codeOf = new Map<number, string>();
for (const [code, station] of Object.entries(network.stopRefs) as [string, number][]) {
  if (!codeOf.has(station)) codeOf.set(station, code);
}

function fakeFeed() {
  const feedLines = new Set(FEED_LINES.map((id) => network.lines.findIndex((l: any) => l.id === id)));
  const journeys: any[] = [];
  for (const s of timetable.days[date]) {
    const flat: number[] = timetable.services[s];
    for (let i = 0; i < flat.length; i += 2) {
      const p = timetable.patterns[flat[i]];
      const start = flat[i + 1] + DELAY;
      if (!feedLines.has(p.line) || start > NOW_T || start + p.arr[p.arr.length - 1] < NOW_T) continue;
      const calls = p.stops
        .map((station: number, k: number) => ({
          StopPointRef: { value: `STIF:StopPoint:Q:${codeOf.get(station)}:` },
          ExpectedArrivalTime: new Date(parisMs(start + p.arr[k])).toISOString(),
          ExpectedDepartureTime: new Date(parisMs(start + p.dep[k])).toISOString(),
          DestinationDisplay: [{ value: p.headsign }],
        }))
        .filter((c: any) => Date.parse(c.ExpectedDepartureTime) >= NOW);
      journeys.push({
        LineRef: { value: `STIF:Line::${network.lines[p.line].ref}:` },
        DatedVehicleJourneyRef: { value: `TEST:${s}:${i}` },
        DestinationName: [{ value: p.headsign }],
        EstimatedCalls: { EstimatedCall: calls },
      });
    }
  }
  return {
    Siri: {
      ServiceDelivery: {
        ResponseTimestamp: new Date(NOW).toISOString(),
        EstimatedTimetableDelivery: [{ EstimatedJourneyVersionFrame: [{ EstimatedVehicleJourney: journeys }] }],
      },
    },
  };
}

async function setup(page: Page, opts: { key?: string; respond?: (route: Route) => Promise<void> }) {
  await page.clock.setFixedTime(NOW);
  if (opts.key) {
    await page.addInitScript((k) => localStorage.setItem("prim-api-key", k), opts.key);
  }
  const requests: Record<string, string>[] = [];
  await page.route(PRIM, async (route) => {
    requests.push(route.request().headers());
    if (opts.respond) return opts.respond(route);
    return route.fulfill({ json: fakeFeed(), headers: { "access-control-allow-origin": "*" } });
  });
  return requests;
}

const state = (page: Page) => page.evaluate(() => (window as any).metro.state);

test("without a key, Direct asks for one and can fall back to the timetable", async ({ page }) => {
  await setup(page, {});
  await page.goto("./?paused");
  await page.waitForFunction(() => (window as any).metro?.state.ready);
  await page.locator("#live").click();
  const dialog = page.locator("#key-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Horaires théoriques" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#clock")).toHaveText("08:30:00");
  const s = await state(page);
  expect(s.live).toBe(true);
  expect(s.realtime).toBe(false);
  expect(s.date).toBe(date);
});

test("with a key, trains of covered lines follow the real-time feed", async ({ page }, info) => {
  test.slow(); // live mode keeps rendering; screenshots are slow under software WebGL
  const requests = await setup(page, { key: "test-key" });
  await page.goto("./?live");
  await page.waitForFunction(() => (window as any).metro?.state.realtime, null, { timeout: 15_000 });
  expect(requests[0].apikey).toBe("test-key");
  await expect(page.locator("#live")).toHaveAttribute("data-state", "ok");
  await page.waitForFunction(() => Number(document.getElementById("count")!.textContent) > 0);

  const split = await page.evaluate(() => {
    const feats = (window as any).metro.map.getSource("trains").serialize().data.features;
    const rt = feats.filter((f: any) => !f.properties.est);
    return {
      rt: rt.length,
      rtLines: [...new Set(rt.map((f: any) => f.properties.label))].sort(),
      scheduled: feats.length - rt.length,
    };
  });
  expect(split.rtLines).toEqual(["1", "14"]);
  expect(split.rt).toBeGreaterThan(40); // ~40 on line 1 + ~48 on line 14 at the peak
  expect(split.scheduled).toBeGreaterThan(300);

  // Station board: real-time rows carry the 2-minute delay.
  await page.evaluate(() => {
    const m = (window as any).metro;
    m.select({ kind: "station", index: m.schedule.network.stations.findIndex((s: any) => s.name === "Châtelet") });
  });
  const rtRows = page.locator("#info tbody tr.rt");
  await expect(rtRows.first()).toBeVisible();
  await page.screenshot({ path: info.outputPath("live-station.png") });

  await rtRows.first().click();
  await expect(page.locator("#info .rt-tag")).toBeVisible();
  await expect(page.locator("#info .stops li")).not.toHaveCount(0);
  await page.screenshot({ path: info.outputPath("live-train.png") });
});

test("a refused key surfaces an actionable error", async ({ page }) => {
  await setup(page, {
    key: "bad-key",
    respond: (route) =>
      route.fulfill({ status: 401, json: { message: "Invalid authentication credentials" }, headers: { "access-control-allow-origin": "*" } }),
  });
  await page.goto("./?live");
  await expect(page.locator("#rt-error")).toBeVisible();
  await expect(page.locator("#rt-error")).toContainText("Clé API refusée");
  await expect(page.locator("#live")).toHaveAttribute("data-state", "error");
  await page.locator("#rt-error button").click();
  await expect(page.locator("#key-dialog")).toBeVisible();
  await expect(page.locator("#key-input")).toHaveValue("bad-key");
});

test("changing speed leaves live mode", async ({ page }) => {
  await setup(page, { key: "test-key" });
  await page.goto("./?live");
  await page.waitForFunction(() => (window as any).metro?.state.realtime, null, { timeout: 15_000 });
  await page.locator('#speeds button[data-speed="60"]').click();
  const s = await state(page);
  expect(s.live).toBe(false);
  expect(s.realtime).toBe(false);
  await expect(page.locator("#live")).toHaveAttribute("data-state", "off");
});
