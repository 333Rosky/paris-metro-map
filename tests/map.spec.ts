import { expect, test, type Page } from "@playwright/test";

// The deep link pins the simulated clock, so every check below is reproducible
// for a given timetable.json (see README: "npm run data").

async function pickWeekday(page: Page): Promise<string> {
  await page.goto("./?paused");
  await page.waitForFunction(() => (window as any).metro?.state.ready);
  const dates: string[] = await page.evaluate(() => (window as any).metro.schedule.dates);
  const weekday = dates.find((d) => {
    const day = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay();
    return day >= 2 && day <= 4; // Tue–Thu: avoids Monday/Friday variants
  });
  expect(weekday, "timetable covers at least one Tue–Thu").toBeTruthy();
  return weekday!;
}

async function open(page: Page, query: string) {
  await page.goto(`./?${query}`);
  await page.waitForFunction(() => (window as any).metro?.state.ready);
  await page.waitForFunction(() => Number(document.getElementById("count")!.textContent) > 0);
}

const count = async (page: Page) => Number(await page.locator("#count").textContent());

test("weekday rush hour shows the whole network in motion", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused`);

  await expect(page.locator("#clock")).toHaveText("08:30:00");
  const trains = await count(page);
  // RATP runs roughly 550–650 trains at the morning peak.
  expect(trains).toBeGreaterThan(400);
  expect(trains).toBeLessThan(800);
  await expect(page.locator(".line-btn")).toHaveCount(16);
  await page.waitForTimeout(1500); // let basemap tiles settle for the evidence screenshot
  await page.screenshot({ path: info.outputPath("rush-hour.png") });
});

test("a station board lists upcoming arrivals and departures", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused`);

  const index = await page.evaluate(() => {
    const m = (window as any).metro;
    const i = m.schedule.network.stations.findIndex((s: any) => s.name === "Châtelet");
    m.select({ kind: "station", index: i });
    return i;
  });
  expect(index).toBeGreaterThanOrEqual(0);
  const info$ = page.locator("#info");
  await expect(info$).toBeVisible();
  await expect(info$.locator("h2")).toHaveText("Châtelet");
  const rows = info$.locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(5);
  const firstDep = await rows.first().locator("td").nth(3).textContent();
  expect(firstDep! >= "08:30").toBeTruthy();
  await page.screenshot({ path: info.outputPath("station-board.png") });

  // Clicking a row opens that train with its stop list.
  await rows.first().click();
  await expect(info$.locator(".stops li")).not.toHaveCount(0);
  await page.screenshot({ path: info.outputPath("train-detail.png") });
});

test("clicking a train on the map opens its run", async ({ page }) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused`);
  await page.waitForTimeout(500);
  const point = await page.evaluate(() => {
    const m = (window as any).metro;
    const f = m.map.queryRenderedFeatures({ layers: ["trains"] })[0];
    const p = m.map.project(f.geometry.coordinates);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator("#info .stops li")).not.toHaveCount(0);
  await expect(page.locator("#info .status")).not.toBeEmpty();
});

test("playing advances the clock and moves trains", async ({ page }) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=12:00&speed=60&paused`);
  const positions = () =>
    page.evaluate(() =>
      JSON.stringify(
        (window as any).metro.map
          .getSource("trains")
          .serialize()
          .data.features.slice(0, 50)
          .map((f: any) => f.geometry.coordinates),
      ),
    );
  const before = await positions();
  const started = Date.now();
  await page.locator("#play").click();
  // ×60: one simulated minute per real second.
  await page.waitForFunction(() => (window as any).metro.state.t > 12 * 3600 + 60, null, { timeout: 15_000 });
  await page.locator("#play").click();
  const elapsed = (Date.now() - started) / 1000;
  const t = await page.evaluate(() => (window as any).metro.state.t);
  expect(t - 12 * 3600).toBeLessThanOrEqual(60 * elapsed + 60);
  expect(await positions()).not.toEqual(before);
});

test("a line badge opens the line view with its trains", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=18:00:40&paused`);
  const all = await count(page);

  const badge = page.locator('.line-btn[data-line="4"]'); // line 4
  await badge.click();
  await expect(badge).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#line-view h2")).toHaveText("Métro 4");
  const onLine = await count(page);
  expect(onLine).toBeGreaterThan(10);
  expect(onLine).toBeLessThan(all);
  // Every train of the line is drawn on the schematic, split by direction.
  await expect(page.locator("#line-view .lv-stops text")).toHaveCount(29);
  await expect(page.locator("#line-view .lv-train")).toHaveCount(onLine);
  const down = Number(await page.locator("#lv-down").textContent());
  const up = Number(await page.locator("#lv-up").textContent());
  expect(down + up).toBe(onLine);
  expect(Math.min(down, up)).toBeGreaterThan(3);
  await page.waitForTimeout(1200); // fitBounds animation, for the evidence screenshot
  await page.screenshot({ path: info.outputPath("line-view.png") });

  // A train on the schematic opens its run; back returns to the line.
  await page.locator("#line-view .lv-train").first().click();
  await expect(page.locator("#info .stops li")).not.toHaveCount(0);
  await page.locator("#back").click();
  await expect(page.locator("#line-view h2")).toBeVisible();

  await badge.click();
  await expect(page.locator("#info")).toBeHidden();
  await expect.poll(() => count(page)).toBe(all);
});

test("a branched line is laid out with its branches side by side @mobile", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:31:20&paused&line=13`);
  await expect(page.locator("#line-view h2")).toHaveText("Métro 13");
  const lanes = await page.evaluate(
    () => new Set([...document.querySelectorAll("#line-view .lv-stops circle")].map((c) => c.getAttribute("cx"))).size,
  );
  expect(lanes).toBe(2);
  await expect(page.locator("#line-view .lv-stops text")).toHaveCount(32);
  await page.locator("#info").screenshot({ path: info.outputPath("line-13.png") });
});

test("zoomed in, trains are drawn to scale along the track", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused#15.2/48.8584/2.3470`);
  await page.waitForTimeout(500);
  const bodies = await page.evaluate(() => {
    const m = (window as any).metro.map;
    const feats = m.getSource("train-bodies").serialize().data.features;
    const points = m.getSource("trains").serialize().data.features;
    const R = 6371000;
    const length = (c: number[][]) =>
      c.slice(1).reduce((sum, p, i) => {
        const dx = ((p[0] - c[i][0]) * Math.PI) / 180 * Math.cos((48.86 * Math.PI) / 180) * R;
        const dy = ((p[1] - c[i][1]) * Math.PI) / 180 * R;
        return sum + Math.hypot(dx, dy);
      }, 0);
    const byLine: Record<string, number[]> = {};
    for (const f of feats) (byLine[f.properties.label] ??= []).push(length(f.geometry.coordinates));
    const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    return { n: feats.length, points: points.length, l1: median(byLine["1"]), l14: median(byLine["14"]), l7: median(byLine["7"]) };
  });
  expect(bodies.n).toBe(bodies.points);
  expect(bodies.n).toBeGreaterThan(400);
  // 6-car, 8-car and 5-car trains.
  expect(bodies.l1).toBeGreaterThan(85);
  expect(bodies.l1).toBeLessThan(95);
  expect(bodies.l14).toBeGreaterThan(114);
  expect(bodies.l14).toBeLessThan(126);
  expect(bodies.l7).toBeGreaterThan(71);
  expect(bodies.l7).toBeLessThan(79);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: info.outputPath("train-bodies.png") });
});

test("late evening runs continue past midnight on the next day @mobile", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=00:30&paused`);
  expect(await count(page)).toBeGreaterThan(20); // trips of the previous service day
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("after-midnight.png") });
});
