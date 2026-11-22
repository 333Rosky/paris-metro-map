import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import { measure, pointAt, sliceAlong, type MeasuredShape } from "./geo";
import { LineView } from "./lineview";
import { PRIM_URL, RealtimeFeed, loadKey, rtState, saveKey, type RtTrain } from "./realtime";
import { DAY, Schedule, shiftDate } from "./schedule";
import type { Line, Network, Pattern, Timetable } from "./types";

// MapLibre 6 resolves its worker at runtime; let Vite emit it as an asset.
maplibregl.setWorkerUrl(workerUrl);

const SPEEDS = [1, 10, 60, 300];
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const FONT = ["Noto Sans Regular"];
/** Train length in metres by line (cars × ~15 m); bodies are drawn to scale. */
const TRAIN_LENGTH: Record<string, number> = { "1": 90, "4": 90, "14": 120, "3B": 45, "7B": 45 };
const DEFAULT_TRAIN_LENGTH = 75;
/** Below this zoom a train is shorter than its dot: bodies are not built. */
const BODY_ZOOM = 12.5;

type Selection = { kind: "train"; id: string } | { kind: "station"; index: number } | null;

/** A train on the map, whether it comes from the timetable or the live feed. */
interface Running {
  id: string;
  line: number;
  pattern: Pattern;
  stop: number;
  dwelling: boolean;
  dist: number;
  frac: number;
  /** Scheduled stand-in for a line the live feed does not cover. */
  est: boolean;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function parisNow(): { date: string; t: number } {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}${parts.month}${parts.day}`,
    t: +parts.hour * 3600 + +parts.minute * 60 + +parts.second + now.getMilliseconds() / 1000,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
function hhmm(seconds: number): string {
  const s = ((Math.floor(seconds) % DAY) + DAY) % DAY;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}`;
}
function hhmmss(seconds: number): string {
  const s = Math.floor(seconds);
  return `${hhmm(s)}:${pad(s % 60)}`;
}
function countdown(target: number, t: number): string {
  const m = Math.floor((target - t) / 60);
  return m < 1 ? "< 1 min" : `${m} min`;
}
function dateLabel(date: string): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8)));
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function badge(line: Line, size = ""): string {
  return `<span class="badge ${size}" style="--c:${line.color};--t:${line.text}">${line.id.replace("B", "<small>bis</small>")}</span>`;
}

async function main() {
  const base = import.meta.env.BASE_URL;
  const [network, timetable] = (await Promise.all([
    fetch(`${base}data/network.json`).then((r) => r.json()),
    fetch(`${base}data/timetable.json`).then((r) => r.json()),
  ])) as [Network, Timetable];

  const schedule = new Schedule(network, timetable);
  const shapes: MeasuredShape[] = network.shapes.map((s) => measure(s.coords));
  const { lines, stations } = network;
  const { patterns } = timetable;
  const lineBadgeButton = (i: number, size = "") =>
    `<button class="badge-btn" data-line="${i}" aria-label="${escapeHtml(lines[i].name)}">${badge(lines[i], size)}</button>`;

  // State ------------------------------------------------------------------
  const nearestDate = (d: string) =>
    schedule.dates.includes(d)
      ? d
      : d < schedule.dates[0]
        ? schedule.dates[0]
        : schedule.dates[schedule.dates.length - 1];
  // Optional deep link: ?date=YYYYMMDD&time=HH:MM[:SS]&speed=60&paused&line=4&live
  const params = new URLSearchParams(location.search);
  const start = parisNow();
  const timeParam = params.get("time")?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  let date = nearestDate(params.get("date") ?? start.date);
  let t = timeParam ? +timeParam[1] * 3600 + +timeParam[2] * 60 + +(timeParam[3] ?? 0) : start.t;
  let playing = !params.has("paused");
  let speed = SPEEDS.includes(Number(params.get("speed"))) ? Number(params.get("speed")) : 10;
  /** Line shown on its own, with its schematic; null = whole network. */
  let focus: number | null = null;
  let selection: Selection = null;
  let follow = false;
  let scrubbing = false;
  let dirty = true;
  let ready = false;
  schedule.tripsFor(date);

  // Real time ----------------------------------------------------------------
  // Live mode pins the clock to Paris time and, when a PRIM feed answers,
  // positions trains from predicted passage times instead of the timetable.
  let live = false;
  let anchor = { ms: Date.now(), t, date };
  const feed = new RealtimeFeed(network, timetable, import.meta.env.VITE_REALTIME_URL || PRIM_URL, loadKey(), () => {
    syncLive();
    dirty = true;
  });
  const realtime = () => live && feed.trains.length > 0;
  /** Epoch ms -> seconds since midnight of the displayed day (live mode only). */
  const msToT = (ms: number) => t + (ms - Date.now()) / 1000;
  const rtTrain = (id: string): RtTrain | undefined => (id.startsWith("rt:") ? feed.train(id.slice(3)) : undefined);

  function running(): Running[] {
    const out: Running[] = [];
    const rt = realtime();
    if (rt) {
      const now = Date.now();
      for (const tr of feed.trains) {
        const s = rtState(tr, patterns, now);
        if (s) out.push({ id: `rt:${tr.id}`, line: tr.line, pattern: patterns[tr.pattern], ...s, est: false });
      }
    }
    for (const s of schedule.active(t)) {
      if (rt && feed.lines.has(s.pattern.line)) continue;
      out.push({ ...s, id: s.trip.id, line: s.pattern.line, est: rt });
    }
    return out;
  }

  // Controls ---------------------------------------------------------------
  const dateSel = $<HTMLSelectElement>("date");
  dateSel.innerHTML = schedule.dates.map((d) => `<option value="${d}">${dateLabel(d)}</option>`).join("");
  const slider = $<HTMLInputElement>("slider");
  const playBtn = $<HTMLButtonElement>("play");
  const speedsEl = $("speeds");
  speedsEl.innerHTML = SPEEDS.map(
    (s) => `<button role="radio" data-speed="${s}">×${s}</button>`,
  ).join("");
  const linesEl = $("lines");
  linesEl.innerHTML = lines
    .map(
      (l, i) =>
        `<button class="line-btn" data-line="${i}" aria-pressed="false" aria-label="${escapeHtml(l.name)}">${badge(l)}</button>`,
    )
    .join("");

  const syncControls = () => {
    dateSel.value = date;
    playBtn.classList.toggle("paused", !playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Lecture");
    for (const b of speedsEl.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-checked", String(!live && +b.dataset.speed! === speed));
    }
    linesEl.classList.toggle("focused", focus !== null);
    for (const b of linesEl.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(+b.dataset.line! === focus));
    }
  };

  const liveBtn = $<HTMLButtonElement>("live");
  const rtError = $("rt-error");
  const keyDialog = $<HTMLDialogElement>("key-dialog");
  const keyInput = $<HTMLInputElement>("key-input");

  function syncLive() {
    const st = feed.status;
    liveBtn.classList.toggle("on", live);
    liveBtn.dataset.state = !live ? "off" : st.kind === "ok" ? "ok" : st.kind === "error" ? "error" : feed.configured ? "loading" : "off";
    liveBtn.title = !live
      ? "Revenir à l'heure actuelle"
      : st.kind === "ok"
        ? `Temps réel · ${st.trains} rames · ${new Date(st.at).toLocaleTimeString("fr-FR")}`
        : st.kind === "error"
          ? st.message
          : feed.configured
            ? "Connexion au temps réel…"
            : "Horaires théoriques";
    const showError = live && st.kind === "error";
    rtError.hidden = !showError;
    if (showError) rtError.querySelector("span")!.textContent = st.message;
  }

  function enterLive() {
    const n = parisNow();
    setDate(nearestDate(n.date));
    t = n.t;
    anchor = { ms: Date.now(), t, date };
    playing = true;
    live = true;
    if (feed.configured) feed.start();
    syncControls();
    syncLive();
  }

  function exitLive() {
    if (!live) return;
    live = false;
    feed.stop();
    if (selection?.kind === "train" && selection.id.startsWith("rt:")) selection = null;
    syncControls();
    syncLive();
    renderInfo(true);
  }

  function openKeyDialog() {
    keyInput.value = feed.key;
    keyDialog.querySelector<HTMLButtonElement>("#key-forget")!.hidden = !feed.key;
    keyDialog.showModal();
  }

  keyDialog.addEventListener("close", () => {
    const action = keyDialog.returnValue;
    if (action === "save" && keyInput.value.trim()) {
      feed.key = keyInput.value.trim();
      saveKey(feed.key);
      if (live) feed.restart();
      else enterLive();
    } else if (action === "forget") {
      feed.key = "";
      saveKey("");
      feed.clear();
      syncLive();
    } else if (action === "schedule") {
      enterLive();
    }
    dirty = true;
  });

  liveBtn.addEventListener("click", () => {
    if (live || !feed.configured) openKeyDialog();
    else enterLive();
  });
  rtError.querySelector("button")!.addEventListener("click", openKeyDialog);

  const setDate = (d: string) => {
    date = d;
    schedule.tripsFor(date);
    if (selection?.kind === "train" && !selection.id.startsWith("rt:") && !schedule.findTrip(selection.id)) selection = null;
    dirty = true;
  };

  dateSel.addEventListener("change", () => {
    exitLive();
    setDate(dateSel.value);
    syncControls();
  });
  slider.addEventListener("input", () => {
    exitLive();
    scrubbing = true;
    t = +slider.value;
    dirty = true;
  });
  slider.addEventListener("change", () => (scrubbing = false));
  const togglePlay = () => {
    exitLive();
    playing = !playing;
    syncControls();
  };
  playBtn.addEventListener("click", togglePlay);
  speedsEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-speed]");
    if (!b) return;
    exitLive();
    speed = +b.dataset.speed!;
    playing = true;
    syncControls();
  });
  linesEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-line]");
    if (!b) return;
    const i = +b.dataset.line!;
    setFocus(focus === i ? null : i);
  });
  window.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (e.code === "Space" && !el.closest("input, select, button, dialog, [role=button]")) {
      e.preventDefault();
      togglePlay();
    }
  });

  // Map --------------------------------------------------------------------
  const mobile = () => window.innerWidth <= 640;
  const map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [2.3415, 48.8586],
    zoom: mobile() ? 10.8 : 11.8,
    hash: true,
    attributionControl: {
      compact: true,
      customAttribution:
        'Horaires et temps réel © <a href="https://data.iledefrance-mobilites.fr/explore/dataset/offre-horaires-tc-gtfs-idfm/" target="_blank" rel="noopener">Île-de-France Mobilités</a> (ODbL)',
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  const applyFocus = () => {
    if (!map.getLayer("lines")) return;
    map.setPaintProperty(
      "lines",
      "line-opacity",
      // Several shapes overlap on each line, so opacities stack: keep the dimmed value very low.
      focus === null ? 0.55 : ["case", ["==", ["get", "line"], focus], 0.95, 0.035],
    );
    const stationFilter = (focus === null ? null : ["in", `,${focus},`, ["get", "lines"]]) as maplibregl.FilterSpecification | null;
    map.setFilter("stations", stationFilter);
    map.setFilter("station-labels", stationFilter);
  };

  function setFocus(line: number | null, fit = true) {
    if (line === focus) return;
    focus = line;
    selection = null;
    follow = false;
    applyFocus();
    syncControls();
    if (line === null) lineView.hide();
    else {
      lineView.show(line);
      if (fit) {
        const bounds = new maplibregl.LngLatBounds();
        for (const s of stations) if (s.lines.includes(line)) bounds.extend([s.lon, s.lat]);
        const padding = mobile()
          ? { top: 230, bottom: Math.round(window.innerHeight * 0.5), left: 24, right: 24 }
          : { top: 48, bottom: 48, left: 390, right: 410 };
        map.fitBounds(bounds, { padding, duration: 700, maxZoom: 14.5 });
      }
    }
    renderInfo(true);
    dirty = true;
  }

  map.on("load", () => {
    // Quieter basemap labels so the network stays the focus.
    for (const layer of map.getStyle().layers) {
      if (layer.type === "symbol") map.setPaintProperty(layer.id, "text-opacity", 0.5);
    }
    document.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    map.addSource("lines", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: network.shapes.map((s, i) => ({
          type: "Feature",
          id: i,
          properties: { line: s.line, color: lines[s.line].color },
          geometry: { type: "LineString", coordinates: s.coords },
        })),
      },
    });
    map.addSource("stations", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: stations.map((s, i) => ({
          type: "Feature",
          properties: { index: i, name: s.name, lines: `,${s.lines.join(",")},`, hub: s.lines.length > 1 },
          geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        })),
      },
    });
    const empty = { type: "FeatureCollection" as const, features: [] };
    map.addSource("trains", { type: "geojson", data: empty });
    map.addSource("train-bodies", { type: "geojson", data: empty });
    map.addSource("train-heads", { type: "geojson", data: empty });

    map.addLayer({
      id: "lines",
      type: "line",
      source: "lines",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": 0.55,
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.4, 13, 3, 16, 6],
      },
    });
    map.addLayer({
      id: "stations",
      type: "circle",
      source: "stations",
      minzoom: 11,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, ["case", ["get", "hub"], 2.4, 1.6], 15, ["case", ["get", "hub"], 6, 4.5]],
        "circle-color": "#15161b",
        "circle-stroke-color": ["interpolate", ["linear"], ["zoom"], 12, "#7d7f88", 14, "#d9dae0"],
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 11, 0.7, 15, 1.6],
      },
    });
    map.addLayer({
      id: "station-labels",
      type: "symbol",
      source: "stations",
      minzoom: 13,
      layout: {
        "text-field": ["get", "name"],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 13],
        "text-offset": [0, 1.1],
        "text-anchor": "top",
        "text-max-width": 8,
      },
      paint: { "text-color": "#c9cad1", "text-halo-color": "#0c0d10", "text-halo-width": 1.4 },
    });
    map.addLayer({
      id: "train-halo",
      type: "circle",
      source: "trains",
      filter: ["==", ["get", "sel"], true],
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 15, 22, 17, 44],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.25,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 1.5,
      },
    });
    // From BODY_ZOOM up, trains are drawn to scale along the track; the dot
    // fades out but stays as the click target and label anchor.
    const bodyOpacity = ["case", ["get", "est"], 0.4, 1] as maplibregl.ExpressionSpecification;
    map.addLayer({
      id: "train-casing",
      type: "line",
      source: "train-bodies",
      minzoom: BODY_ZOOM,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#ffffff",
        "line-opacity": bodyOpacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], BODY_ZOOM, 6.5, 15, 10, 17, 17],
      },
    });
    map.addLayer({
      id: "train-body",
      type: "line",
      source: "train-bodies",
      minzoom: BODY_ZOOM,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["get", "color"],
        "line-opacity": bodyOpacity,
        "line-width": ["interpolate", ["linear"], ["zoom"], BODY_ZOOM, 4.5, 15, 7.5, 17, 14],
      },
    });
    map.addLayer({
      id: "train-head",
      type: "circle",
      source: "train-heads",
      minzoom: 13.5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 13.5, 1.4, 15, 2.2, 17, 4],
        "circle-color": ["get", "text"],
        "circle-opacity": ["case", ["get", "est"], 0.4, 0.95],
      },
    });
    const dotOpacity = (est: number, full: number) =>
      ["interpolate", ["linear"], ["zoom"], 12.8, ["case", ["get", "est"], est, full], 13.6, 0.01] as maplibregl.ExpressionSpecification;
    map.addLayer({
      id: "trains",
      type: "circle",
      source: "trains",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5.5, 16, 9],
        "circle-color": ["get", "color"],
        "circle-opacity": dotOpacity(0.4, 1),
        "circle-stroke-opacity": dotOpacity(0.4, 1),
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 1.4],
      },
    });
    map.addLayer({
      id: "train-labels",
      type: "symbol",
      source: "trains",
      minzoom: 14.5,
      layout: {
        "text-field": ["get", "label"],
        "text-font": FONT,
        "text-size": ["interpolate", ["linear"], ["zoom"], 14.5, 8, 17, 12],
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": ["get", "text"] },
    });

    for (const layer of ["trains", "train-body", "stations", "lines"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    map.on("click", (e) => {
      const r = 8;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - r, e.point.y - r],
        [e.point.x + r, e.point.y + r],
      ];
      const feats = map.queryRenderedFeatures(box, { layers: ["trains", "train-body", "stations", "lines"] });
      const pick = (...ids: string[]) => feats.find((f: MapGeoJSONFeature) => ids.includes(f.layer.id));
      const train = pick("trains", "train-body");
      const station = pick("stations");
      const line = pick("lines");
      if (train) select({ kind: "train", id: train.properties.id });
      else if (station) select({ kind: "station", index: station.properties.index });
      else if (line && line.properties.line !== focus) setFocus(line.properties.line);
      else select(null);
    });
    map.on("dragstart", () => {
      if (follow) {
        follow = false;
        renderInfo(true);
      }
    });
    map.on("zoom", () => (dirty = true));

    applyFocus();
    ready = true;
    dirty = true;
  });

  // Info panel ---------------------------------------------------------------
  const info = $("info");
  const infoBody = $("info-body");
  const lineView = new LineView($("line-view"), network, timetable, (i) => badge(lines[i]));
  $("close").addEventListener("click", () => {
    selection = null;
    if (focus !== null) setFocus(null);
    else {
      renderInfo(true);
      dirty = true;
    }
  });

  const lineOfTrain = (id: string): number | undefined => {
    const rt = rtTrain(id);
    if (rt) return rt.line;
    const trip = schedule.findTrip(id);
    return trip ? patterns[trip.pattern].line : undefined;
  };

  function select(s: Selection) {
    if (s?.kind === "train" && focus !== null) {
      const line = lineOfTrain(s.id);
      if (line !== undefined && line !== focus) setFocus(line, false);
    }
    selection = s;
    follow = false;
    if (s?.kind === "station") {
      const st = stations[s.index];
      map.easeTo({ center: [st.lon, st.lat], duration: 500 });
    }
    renderInfo(true);
    dirty = true;
  }

  // Only touch the DOM when the content changes: rebuilding rows under the
  // pointer would swallow clicks while the clock runs.
  let lastInfoHtml = "";
  function setInfo(html: string) {
    if (html === lastInfoHtml) return;
    lastInfoHtml = html;
    infoBody.innerHTML = html;
  }
  const backButton = () =>
    focus === null ? "" : `<button id="back" class="back" aria-label="Retour à ${escapeHtml(lines[focus].name)}">‹</button>`;

  let lastInfoRender = 0;
  function renderInfo(force = false) {
    const now = performance.now();
    if (!force && now - lastInfoRender < 400) return;
    lastInfoRender = now;
    const mode = selection ? selection.kind : focus !== null ? "line" : "none";
    info.hidden = mode === "none";
    $("line-view").hidden = mode !== "line";
    infoBody.hidden = mode === "line" || mode === "none";
    if (!selection) return;

    if (selection.kind === "station") return renderStation(selection.index);
    const rt = rtTrain(selection.id);
    if (rt && renderRtTrain(rt)) return;
    if (!selection.id.startsWith("rt:") && renderScheduledTrain(selection.id)) return;
    // The train is gone (run finished, feed refreshed): fall back.
    selection = null;
    renderInfo(true);
  }

  function renderStation(index: number) {
    const st = stations[index];
    type Row = { id: string; line: number; dest: string; arr: number | null; dep: number | null; rt: boolean };
    const rows: Row[] = [];
    const rt = realtime();
    if (rt) {
      const now = Date.now();
      for (const c of feed.calls) {
        if (c.station !== index || c.dep < now - 15_000) continue;
        const terminus = c.dest === c.station;
        rows.push({
          id: c.train ? `rt:${c.train}` : "",
          line: c.line,
          dest: terminus ? "Terminus" : c.destName || stations[c.dest].name,
          arr: msToT(c.arr),
          dep: terminus ? null : msToT(c.dep),
          rt: true,
        });
      }
    }
    for (const ev of schedule.board(index, t)) {
      if (rt && feed.lines.has(ev.pattern.line)) continue;
      rows.push({
        id: ev.trip.id,
        line: ev.pattern.line,
        dest: ev.terminus ? "Terminus" : ev.pattern.headsign,
        arr: ev.origin ? null : ev.arr,
        dep: ev.terminus ? null : ev.dep,
        rt: false,
      });
    }
    rows.sort((a, b) => (a.arr ?? a.dep!) - (b.arr ?? b.dep!));
    const html = rows
      .slice(0, 14)
      .map((r) => {
        const first = r.arr ?? r.dep!;
        return `<tr ${r.id ? `data-trip="${escapeHtml(r.id)}"` : ""} class="${r.rt ? "rt" : ""}">
          <td>${badge(lines[r.line], "sm")}</td>
          <td class="dir">${escapeHtml(r.dest)}</td>
          <td class="num">${r.arr === null ? "—" : hhmm(r.arr)}</td>
          <td class="num">${r.dep === null ? "—" : hhmm(r.dep)}</td>
          <td class="num wait">${first <= t ? "à quai" : countdown(first, t)}</td>
        </tr>`;
      })
      .join("");
    setInfo(`
      <header>${backButton()}<h2>${escapeHtml(st.name)}</h2><div class="badges">${st.lines.map((l) => lineBadgeButton(l, "sm")).join("")}</div></header>
      ${
        rows.length
          ? `<div class="scroll"><table class="board"><thead><tr><th></th><th>Direction</th><th>Arr.</th><th>Dép.</th><th></th></tr></thead><tbody>${html}</tbody></table></div>`
          : `<p class="empty">Aucun passage d'ici la fin de service.</p>`
      }`);
  }

  function renderScheduledTrain(id: string): boolean {
    const trip = schedule.findTrip(id);
    if (!trip) return false;
    const p = patterns[trip.pattern];
    const line = lines[p.line];
    const state = schedule.state(trip, t);
    const current = state ? state.stop : t < trip.start ? -1 : p.stops.length;
    const items = p.stops
      .map((si, k) => {
        const arr = trip.start + p.arr[k];
        const dep = trip.start + p.dep[k];
        const cls = k < current || (k === current && !state?.dwelling) ? "past" : k === current ? "here" : "";
        const time = k === 0 ? hhmm(dep) : k === p.stops.length - 1 || arr === dep ? hhmm(arr) : `${hhmm(arr)}–${hhmm(dep)}`;
        return `<li class="${cls}" data-station="${si}"><span class="dot"></span><span class="name">${escapeHtml(stations[si].name)}</span><span class="num">${time}</span></li>`;
      })
      .join("");
    const status = !state
      ? t < trip.start
        ? `Départ dans ${countdown(trip.start, t)}`
        : "Arrivé"
      : state.dwelling
        ? `À quai · ${escapeHtml(stations[p.stops[state.stop]].name)}`
        : `Vers ${escapeHtml(stations[p.stops[state.stop + 1]].name)} · ${countdown(trip.start + p.arr[state.stop + 1], t)}`;
    setInfo(`
      <header>${backButton()}${lineBadgeButton(p.line)}<h2>${escapeHtml(p.headsign)}</h2></header>
      <div class="status"><span>${status}</span>${state ? `<button id="follow" class="text-btn ${follow ? "on" : ""}" aria-pressed="${follow}">Suivre</button>` : ""}</div>
      <div class="scroll"><ol class="stops" style="--c:${line.color}">${items}</ol></div>`);
    return true;
  }

  function renderRtTrain(train: RtTrain): boolean {
    const now = Date.now();
    const state = rtState(train, patterns, now);
    if (!state) return false;
    const p = patterns[train.pattern];
    const line = lines[train.line];
    // Predicted passage where PRIM gives one for this train, timetable-based estimate elsewhere.
    const predicted = new Map<number, number>();
    for (const c of train.calls) {
      const known = predicted.get(c.station);
      if (known === undefined || c.arr < known) predicted.set(c.station, c.arr);
    }
    const when = (k: number) => {
      const real = predicted.get(p.stops[k]);
      return real !== undefined && real > now - 60_000
        ? { t: msToT(real), real: true }
        : { t: msToT(now + (p.arr[k] - state.tau) * 1000), real: false };
    };
    const items: string[] = [];
    for (let k = state.stop; k < p.stops.length; k++) {
      const passed = k === state.stop && !state.dwelling;
      const w = when(k);
      const cls = passed ? "past" : k === state.stop ? "here" : "";
      const time = passed ? "" : w.real ? hhmm(w.t) : `<span class="approx">~${hhmm(w.t)}</span>`;
      items.push(
        `<li class="${cls}" data-station="${p.stops[k]}"><span class="dot"></span><span class="name">${escapeHtml(stations[p.stops[k]].name)}</span><span class="num">${time}</span></li>`,
      );
    }
    const nextStop = Math.min(state.stop + 1, p.stops.length - 1);
    const status = state.dwelling
      ? `À quai · ${escapeHtml(stations[p.stops[state.stop]].name)}`
      : `Vers ${escapeHtml(stations[p.stops[nextStop]].name)} · ${countdown(when(nextStop).t, t)}`;
    setInfo(`
      <header>${backButton()}${lineBadgeButton(train.line)}<h2>${escapeHtml(train.destName || stations[train.dest].name)}</h2><span class="rt-tag">Temps réel</span></header>
      <div class="status"><span>${status}</span><button id="follow" class="text-btn ${follow ? "on" : ""}" aria-pressed="${follow}">Suivre</button></div>
      <div class="scroll"><ol class="stops" style="--c:${line.color}">${items.join("")}</ol></div>`);
    return true;
  }

  info.addEventListener("click", (e) => {
    const el = e.target as Element;
    if (el.closest("#follow")) {
      follow = !follow;
      renderInfo(true);
      return;
    }
    if (el.closest("#back")) return select(null);
    const lineBtn = el.closest<HTMLElement>(".badge-btn[data-line]");
    if (lineBtn) return setFocus(+lineBtn.dataset.line!);
    const trip = el.closest<HTMLElement | SVGElement>("[data-trip]");
    if (trip) return select({ kind: "train", id: trip.dataset.trip! });
    const stop = el.closest<HTMLElement | SVGElement>("[data-station]");
    if (stop) select({ kind: "station", index: +stop.dataset.station! });
  });
  info.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && (e.target as Element).matches("[role=button]")) {
      e.preventDefault();
      (e.target as Element).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  });

  // Animation ----------------------------------------------------------------
  const clock = $("clock");
  const count = $("count");
  let lastShown = -1;
  let lastFrame = performance.now();
  let lastPush = 0;
  let bodiesShown = false;

  function draw() {
    const all = running();
    const visible = focus === null ? all : all.filter((r) => r.line === focus);
    const selected = selection?.kind === "train" ? selection.id : null;
    const withBodies = map.getZoom() >= BODY_ZOOM;
    const points = [];
    const bodies = [];
    const heads = [];
    let followed: [number, number] | null = null;
    for (const r of visible) {
      const shape = shapes[r.pattern.shape];
      const [lon, lat] = pointAt(shape, r.dist);
      const line = lines[r.line];
      const properties = { id: r.id, color: line.color, text: line.text, label: line.id, est: r.est, sel: r.id === selected };
      points.push({ type: "Feature" as const, properties, geometry: { type: "Point" as const, coordinates: [lon, lat] } });
      if (r.id === selected) followed = [lon, lat];
      if (withBodies) {
        const half = (TRAIN_LENGTH[line.id] ?? DEFAULT_TRAIN_LENGTH) / 2;
        bodies.push({
          type: "Feature" as const,
          properties,
          geometry: { type: "LineString" as const, coordinates: sliceAlong(shape, r.dist - half, r.dist + half) },
        });
        const head = pointAt(shape, r.dist + half - 6);
        heads.push({ type: "Feature" as const, properties, geometry: { type: "Point" as const, coordinates: [head[0], head[1]] } });
      }
    }
    (map.getSource("trains") as GeoJSONSource).setData({ type: "FeatureCollection", features: points });
    if (withBodies || bodiesShown) {
      (map.getSource("train-bodies") as GeoJSONSource).setData({ type: "FeatureCollection", features: bodies });
      (map.getSource("train-heads") as GeoJSONSource).setData({ type: "FeatureCollection", features: heads });
      bodiesShown = withBodies;
    }
    count.textContent = String(visible.length);
    if (follow && followed) map.setCenter(followed);
    if (focus !== null && !selection) lineView.update(visible, selected);
    renderInfo();
  }

  function frame(now: number) {
    const dt = Math.min((now - lastFrame) / 1000, 1); // cap jumps after a background tab
    lastFrame = now;
    if (live) {
      t = anchor.t + (Date.now() - anchor.ms) / 1000;
      dirty = true;
      if (t >= DAY || Date.now() - anchor.ms > 60_000) {
        const n = parisNow();
        if (n.date !== date) setDate(nearestDate(n.date));
        t = n.t;
        anchor = { ms: Date.now(), t, date };
        syncControls();
      }
    } else if (playing && !scrubbing) {
      t += dt * speed;
      dirty = true;
      if (t >= DAY) {
        const next = shiftDate(date, 1);
        if (schedule.dates.includes(next)) {
          t -= DAY;
          setDate(next);
          syncControls();
        } else {
          t = DAY - 1;
          playing = false;
          syncControls();
        }
      }
    }

    // At low speed trains move under a pixel per frame: refresh positions less
    // often to spare the CPU (matters for long live sessions on laptops/phones).
    const minInterval = live || speed === 1 ? 100 : speed <= 10 ? 33 : 0;
    if (dirty && ready && now - lastPush >= minInterval) {
      lastPush = now;
      dirty = false;
      draw();
    }

    const shown = Math.floor(t);
    if (shown !== lastShown) {
      lastShown = shown;
      clock.textContent = hhmmss(t);
      if (!scrubbing) slider.value = String(shown);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  syncControls();
  syncLive();

  const lineParam = params.get("line")?.toUpperCase().replace("BIS", "B");
  const lineIndex = lines.findIndex((l) => l.id === lineParam);
  if (lineIndex >= 0) map.once("load", () => setFocus(lineIndex));
  if (params.has("live")) {
    if (feed.configured) enterLive();
    else openKeyDialog();
  }

  // Inspection hook for tests, agents and the browser console.
  Object.assign(window, {
    metro: {
      map,
      schedule,
      feed,
      select,
      focus: setFocus,
      running,
      get state() {
        return { date, t, playing, speed, focus, selection, ready, live, realtime: realtime() };
      },
    },
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="fatal">Données indisponibles. Lancez <code>npm run data</code>.</p>`);
});
