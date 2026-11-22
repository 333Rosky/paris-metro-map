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

test("line toggles hide and restore trains", async ({ page }) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=18:00&paused`);
  const all = await count(page);
  await page.locator('.line-btn[data-line="0"]').click();
  await expect(page.locator('.line-btn[data-line="0"]')).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => count(page)).toBeLessThan(all);
  await page.locator('.line-btn[data-line="0"]').click();
  await expect.poll(() => count(page)).toBe(all);
});

test("late evening runs continue past midnight on the next day @mobile", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=00:30&paused`);
  expect(await count(page)).toBeGreaterThan(20); // trips of the previous service day
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("after-midnight.png") });
});
