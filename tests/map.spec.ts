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
  // The counter follows on the next drawn frame, which a loaded machine delays.
  await expect.poll(() => count(page)).toBeLessThan(all);
  const onLine = await count(page);
  expect(onLine).toBeGreaterThan(10);
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

test("zoomed in, trains are 3D boxes drawn to scale along the track", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused#15.2/48.8584/2.3470/-30/60`);
  await page.waitForTimeout(500);
  const bodies = await page.evaluate(() => {
    const m = (window as any).metro.map;
    const feats = m.getSource("train-3d").serialize().data.features;
    const points = m.getSource("trains").serialize().data.features;
    const R = 6371000;
    const dist = (p: number[], q: number[]) =>
      Math.hypot(((q[0] - p[0]) * Math.PI) / 180 * Math.cos((48.86 * Math.PI) / 180) * R, ((q[1] - p[1]) * Math.PI) / 180 * R);
    // Each box is a ribbon along the track: perimeter = 2 × length + 2 × width.
    const byId = new Map<string, { label: string; perimeter: number; width: number; parts: number; top: number }>();
    for (const f of feats) {
      const ring = f.geometry.coordinates[0];
      const perimeter = ring.slice(1).reduce((s: number, p: number[], i: number) => s + dist(ring[i], p), 0);
      const width = dist(ring[0], ring[ring.length - 2]);
      const e = byId.get(f.properties.id) ?? { label: "", perimeter: 0, width, parts: 0, top: f.properties.top };
      e.perimeter += perimeter;
      e.parts++;
      byId.set(f.properties.id, e);
    }
    const label = new Map(points.map((p: any) => [p.properties.id, p.properties.label]));
    const byLine: Record<string, number[]> = {};
    for (const [id, e] of byId) (byLine[label.get(id) as string] ??= []).push(e.perimeter / 2 - e.parts * e.width);
    const median = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
    const any = [...byId.values()][0];
    return {
      n: byId.size,
      points: points.length,
      parts: any.parts,
      height: any.top,
      l1: median(byLine["1"]),
      l14: median(byLine["14"]),
      l7: median(byLine["7"]),
    };
  });
  expect(bodies.n).toBe(bodies.points);
  expect(bodies.n).toBeGreaterThan(400);
  expect(bodies.parts).toBe(2); // body and front end
  expect(bodies.height).toBeGreaterThan(0);
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

test("the map is tilted in 3D, can go flat, and a clicked train flies in as a detailed model", async ({ page }, info) => {
  test.slow(); // 3D under software WebGL
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused`);
  const m = () => page.evaluate(() => ({ pitch: (window as any).metro.map.getPitch(), zoom: (window as any).metro.map.getZoom() }));
  expect((await m()).pitch).toBeGreaterThan(30);
  await expect(page.locator("#view-3d")).toHaveText("2D");
  await page.locator("#view-3d").click();
  await expect.poll(async () => (await m()).pitch).toBeLessThan(1);
  await expect(page.locator("#view-3d")).toHaveText("3D");
  await page.locator("#view-3d").click();
  await expect.poll(async () => (await m()).pitch).toBeGreaterThan(30);

  const id = await page.evaluate(() => {
    const metro = (window as any).metro;
    // Line 7 has no rolling-stock mesh: its trains keep the extruded model.
    const line = metro.schedule.network.lines.findIndex((l: any) => l.id === "7");
    const r = metro.running().find((x: any) => x.line === line);
    metro.select({ kind: "train", id: r.id });
    return r.id;
  });
  await expect.poll(async () => (await m()).zoom, { timeout: 10_000 }).toBeGreaterThan(18);
  expect((await m()).pitch).toBeGreaterThan(55);
  const model = () =>
    page.evaluate((id) => {
      const feats = (window as any).metro.map.getSource("train-3d").serialize().data.features;
      const mine = feats.filter((f: any) => f.properties.id === id);
      return { parts: mine.length, floating: mine.filter((f: any) => f.properties.base > 0).length };
    }, id);
  // Cars, windows, stripe, roof, cab lights: far more than the two parts of a box.
  // The model comes with the frame after the camera gets close: under software
  // WebGL that frame can take over a second.
  await expect.poll(async () => (await model()).parts, { timeout: 15_000 }).toBeGreaterThan(30);
  expect((await model()).floating).toBeGreaterThan(20);
  expect(await page.evaluate(() => (window as any).metro.state.mesh)).toBeNull();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: info.outputPath("train-3d.png") });
});

// Real rolling stock. Expected, for a line whose stock is modelled (line 14, MP 14):
// - the mesh code is fetched on the first such click, not with the page;
// - the selected train becomes a mesh of 8 cars of 15.04 m, and its extruded
//   model goes away, leaving one flat part on the ground (shadow, click target);
// - the mesh is really drawn where the train is: its white body shows on the
//   dark map, far more than the white front end of the box it replaces;
// - clicking the mesh keeps the train selected; closing the panel removes it.
// Failure modes covered: mesh never loads (state.mesh stays null), mesh drawn
// off-screen or culled (no white pixels), mesh left behind after deselection.
test("a line 14 train opens as a real MP 14: eight cars, drawn as a mesh", async ({ page }, info) => {
  test.slow(); // 3D under software WebGL
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=08:30&paused`);
  const meshChunk = () => requested.filter((u) => /train-mesh[^/]*\.js/.test(u)).length;
  expect(meshChunk(), "three.js is not loaded with the page").toBe(0);

  // Light pixels (the white MP 14) on the map canvas, in a box around the train.
  const white = (id: string) =>
    page.evaluate(
      (id) =>
        new Promise<number>((resolve) => {
          const metro = (window as any).metro;
          const map = metro.map;
          map.once("render", () => {
            const r = metro.running().find((x: any) => x.id === id);
            const canvas = map.getCanvas() as HTMLCanvasElement;
            const gl = canvas.getContext("webgl2")!;
            const k = canvas.width / canvas.clientWidth;
            const c = map.project(metro.trainPosition(r.id));
            const half = 320;
            const x = Math.max(0, Math.round((c.x - half) * k));
            const y = Math.max(0, Math.round((canvas.clientHeight - c.y - half) * k));
            const w = Math.min(canvas.width - x, Math.round(2 * half * k));
            const h = Math.min(canvas.height - y, Math.round(2 * half * k));
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let n = 0;
            for (let i = 0; i < px.length; i += 4) if (px[i] > 150 && px[i + 1] > 150 && px[i + 2] > 150) n++;
            resolve(n);
          });
          map.triggerRepaint();
        }),
      id,
    );

  const id = await page.evaluate(() => {
    const metro = (window as any).metro;
    const line = metro.schedule.network.lines.findIndex((l: any) => l.id === "14");
    // A train in the middle of the line: all eight cars are on the track.
    const trains = metro.running().filter((x: any) => x.line === line).sort((a: any, b: any) => a.dist - b.dist);
    const r = trains[Math.floor(trains.length / 2)];
    metro.select({ kind: "train", id: r.id });
    return r.id;
  });
  const zoom = () => page.evaluate(() => (window as any).metro.map.getZoom());
  await expect.poll(zoom, { timeout: 10_000 }).toBeGreaterThan(18);
  await expect
    .poll(() => page.evaluate(() => (window as any).metro.state.mesh), { timeout: 20_000 })
    .toEqual({ id, stock: "MP 14", cars: 8, length: 120.32 });
  expect(meshChunk(), "the mesh code came with the click").toBeGreaterThan(0);

  const parts = () =>
    page.evaluate((id) => {
      const feats = (window as any).metro.map.getSource("train-3d").serialize().data.features;
      return feats.filter((f: any) => f.properties.id === id).length;
    }, id);
  await expect.poll(parts).toBe(1);
  await page.waitForFunction(() => !(window as any).metro.map.isMoving());
  await expect.poll(() => white(id), { timeout: 15_000 }).toBeGreaterThan(5000);
  const drawn = await white(id);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: info.outputPath("train-mp14.png") });

  // A click on a car away from the middle of the train keeps it selected.
  const spot = await page.evaluate((id) => {
    const metro = (window as any).metro;
    const p = metro.map.project(metro.trainPosition(id, 40));
    return { x: p.x, y: p.y };
  }, id);
  // The footprint under the mesh is what takes the click: wait until the map has it.
  await expect
    .poll(() =>
      page.evaluate(
        ({ spot, id }) => {
          const feats = (window as any).metro.map.queryRenderedFeatures([spot.x, spot.y], { layers: ["train-3d"] });
          return feats.some((f: any) => f.properties.id === id);
        },
        { spot, id },
      ),
    )
    .toBe(true);
  await page.mouse.click(spot.x, spot.y);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).metro.state.selection)).toEqual({ kind: "train", id });

  await page.locator("#close").click();
  await expect.poll(() => page.evaluate(() => (window as any).metro.state.mesh)).toBeNull();
  // Back to a box: only its front end is white (line 14 writes in white).
  await expect.poll(() => white(id)).toBeLessThan(drawn / 5);
});

test("late evening runs continue past midnight on the next day @mobile", async ({ page }, info) => {
  const date = await pickWeekday(page);
  await open(page, `date=${date}&time=00:30&paused`);
  expect(await count(page)).toBeGreaterThan(20); // trips of the previous service day
  await page.waitForTimeout(1500);
  await page.screenshot({ path: info.outputPath("after-midnight.png") });
});
