import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import { measure, pointAt, type MeasuredShape } from "./geo";
import { DAY, Schedule, shiftDate, type TrainState } from "./schedule";
import {
  PRIM_URL,
  RealtimeFeed,
  Track,
  loadKey,
  locate,
  rtBoard,
  saveKey,
  trainAt,
  type RtJourney,
  type RtTrain,
} from "./realtime";
import type { Line, Network, Timetable } from "./types";

// MapLibre 6 resolves its worker at runtime; let Vite emit it as an asset.
maplibregl.setWorkerUrl(workerUrl);

const SPEEDS = [1, 10, 60, 300];
const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";
const FONT = ["Noto Sans Regular"];

type Selection = { kind: "train"; id: string } | { kind: "station"; index: number } | null;

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

  // State ------------------------------------------------------------------
  const nearestDate = (d: string) =>
    schedule.dates.includes(d)
      ? d
      : d < schedule.dates[0]
        ? schedule.dates[0]
        : schedule.dates[schedule.dates.length - 1];
  // Optional deep link: ?date=YYYYMMDD&time=HH:MM[:SS]&speed=60&paused
  const params = new URLSearchParams(location.search);
  const start = parisNow();
  const timeParam = params.get("time")?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  let date = nearestDate(params.get("date") ?? start.date);
  let t = timeParam ? +timeParam[1] * 3600 + +timeParam[2] * 60 + +(timeParam[3] ?? 0) : start.t;
  let playing = !params.has("paused");
  let speed = SPEEDS.includes(Number(params.get("speed"))) ? Number(params.get("speed")) : 10;
  let hidden = new Set<number>();
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
  const track = new Track(timetable);
  const feed = new RealtimeFeed(network, import.meta.env.VITE_REALTIME_URL || PRIM_URL, loadKey(), () => {
    syncLive();
    dirty = true;
  });
  /** Lines the feed currently covers; others keep scheduled positions. */
  let rtLines = new Set<number>();
  let rtById = new Map<string, RtJourney>();
  const realtime = () => live && feed.journeys.length > 0;
  /** Epoch ms -> seconds since midnight of the displayed day (live mode only). */
  const msToT = (ms: number) => t + (ms - Date.now()) / 1000;

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
        `<button class="line-btn" data-line="${i}" aria-pressed="true" aria-label="${escapeHtml(l.name)}">${badge(l)}</button>`,
    )
    .join("");

  const syncControls = () => {
    dateSel.value = date;
    playBtn.classList.toggle("paused", !playing);
    playBtn.setAttribute("aria-label", playing ? "Pause" : "Lecture");
    for (const b of speedsEl.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-checked", String(+b.dataset.speed! === speed));
    }
    for (const b of linesEl.querySelectorAll<HTMLButtonElement>("button")) {
      b.setAttribute("aria-pressed", String(!hidden.has(+b.dataset.line!)));
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
        ? `Temps réel · ${st.journeys} missions · ${new Date(st.at).toLocaleTimeString("fr-FR")}`
        : st.kind === "error"
          ? st.message
          : feed.configured
            ? "Connexion au temps réel…"
            : "Horaires théoriques";
    const showError = live && st.kind === "error";
    rtError.hidden = !showError;
    if (showError) {
      rtError.querySelector("span")!.textContent = st.message;
    }
    rtLines = new Set(feed.journeys.map((j) => j.line));
    rtById = new Map(feed.journeys.map((j) => [`rt:${j.id}`, j]));
  }

  function enterLive() {
    const n = parisNow();
    setDate(nearestDate(n.date));
    t = n.t;
    anchor = { ms: Date.now(), t, date };
    speed = 1;
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
      feed.stop();
      feed.journeys = [];
      feed.status = { kind: "off" };
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
    if (e.shiftKey || e.altKey) {
      // Solo: show only this line, or everything again if it already was alone.
      const solo = hidden.size === lines.length - 1 && !hidden.has(i);
      hidden = solo ? new Set() : new Set(lines.map((_, j) => j).filter((j) => j !== i));
    } else if (hidden.has(i)) hidden.delete(i);
    else hidden.add(i);
    applyLineFilter();
    syncControls();
    dirty = true;
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      e.preventDefault();
      togglePlay();
    }
  });
  syncControls();

  // Map --------------------------------------------------------------------
  const map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [2.3415, 48.8586],
    zoom: window.innerWidth < 640 ? 10.8 : 11.8,
    hash: true,
    attributionControl: {
      compact: true,
      customAttribution:
        'Horaires théoriques © <a href="https://data.iledefrance-mobilites.fr/explore/dataset/offre-horaires-tc-gtfs-idfm/" target="_blank" rel="noopener">Île-de-France Mobilités</a> (ODbL)',
    },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");

  const applyLineFilter = () => {
    if (!map.getLayer("lines")) return;
    const filter = ["!", ["in", ["get", "line"], ["literal", [...hidden]]]] as maplibregl.FilterSpecification;
    map.setFilter("lines", filter);
    const stationFilter = [
      "any",
      ...lines.map((_, i) => (hidden.has(i) ? false : ["in", `,${i},`, ["get", "lines"]])),
    ] as maplibregl.FilterSpecification;
    map.setFilter("stations", stationFilter);
    map.setFilter("station-labels", stationFilter);
  };

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
    map.addSource("trains", { type: "geojson", data: { type: "FeatureCollection", features: [] } });

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
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 9, 15, 18],
        "circle-color": ["get", "color"],
        "circle-opacity": 0.28,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: "trains",
      type: "circle",
      source: "trains",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3, 13, 5.5, 16, 9],
        "circle-color": ["get", "color"],
        "circle-opacity": ["case", ["get", "est"], 0.4, 1],
        "circle-stroke-opacity": ["case", ["get", "est"], 0.4, 1],
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
        "text-size": 9,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": ["get", "text"] },
    });

    for (const layer of ["trains", "stations"]) {
      map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
    }
    map.on("click", (e) => {
      const r = 8;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [e.point.x - r, e.point.y - r],
        [e.point.x + r, e.point.y + r],
      ];
      const feats = map.queryRenderedFeatures(box, { layers: ["trains", "stations"] });
      const pick = (layer: string) => feats.filter((f: MapGeoJSONFeature) => f.layer.id === layer);
      const train = pick("trains")[0];
      const station = pick("stations")[0];
      if (train) select({ kind: "train", id: train.properties.id });
      else if (station) select({ kind: "station", index: station.properties.index });
      else select(null);
    });
    map.on("dragstart", () => {
      if (follow) {
        follow = false;
        renderInfo(true);
      }
    });

    applyLineFilter();
    ready = true;
    dirty = true;
  });

  // Info panel ---------------------------------------------------------------
  const info = $("info");
  const infoBody = $("info-body");
  $("close").addEventListener("click", () => select(null));

  function select(s: Selection) {
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

  let lastInfoRender = 0;
  function renderInfo(force = false) {
    const now = performance.now();
    if (!force && now - lastInfoRender < 400) return;
    lastInfoRender = now;
    info.hidden = !selection;
    if (!selection) return;

    if (selection.kind === "station") {
      const st = stations[selection.index];
      type Row = { id: string; line: number; dest: string; arr: number | null; dep: number | null; rt: boolean };
      const rows: Row[] = [];
      if (realtime()) {
        for (const r of rtBoard(feed.journeys, selection.index, Date.now())) {
          rows.push({
            id: `rt:${r.journey.id}`,
            line: r.journey.line,
            dest: r.terminus ? "Terminus" : r.journey.destination,
            arr: msToT(r.arr),
            dep: r.terminus ? null : msToT(r.dep),
            rt: true,
          });
        }
      }
      for (const ev of schedule.board(selection.index, t)) {
        if (realtime() && rtLines.has(ev.pattern.line)) continue;
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
          return `<tr data-trip="${escapeHtml(r.id)}" class="${r.rt ? "rt" : ""}">
            <td>${badge(lines[r.line], "sm")}</td>
            <td class="dir">${escapeHtml(r.dest)}</td>
            <td class="num">${r.arr === null ? "—" : hhmm(r.arr)}</td>
            <td class="num">${r.dep === null ? "—" : hhmm(r.dep)}</td>
            <td class="num wait">${first <= t ? "à quai" : countdown(first, t)}</td>
          </tr>`;
        })
        .join("");
      setInfo(`
        <header><h2>${escapeHtml(st.name)}</h2><div class="badges">${st.lines.map((l) => badge(lines[l], "sm")).join("")}</div></header>
        ${
          rows.length
            ? `<div class="scroll"><table class="board"><thead><tr><th></th><th>Direction</th><th>Arr.</th><th>Dép.</th><th></th></tr></thead><tbody>${html}</tbody></table></div>`
            : `<p class="empty">Aucun passage d'ici la fin de service.</p>`
        }`);
      return;
    }

    if (selection.id.startsWith("rt:")) {
      const j = rtById.get(selection.id);
      if (!j) {
        selection = null;
        info.hidden = true;
        return;
      }
      renderRtTrain(j);
      return;
    }

    const trip = schedule.findTrip(selection.id);
    if (!trip) {
      selection = null;
      info.hidden = true;
      return;
    }
    const p = timetable.patterns[trip.pattern];
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
      <header>${badge(line)}<h2>${escapeHtml(p.headsign)}</h2></header>
      <div class="status"><span>${status}</span>${state ? `<button id="follow" class="text-btn ${follow ? "on" : ""}" aria-pressed="${follow}">Suivre</button>` : ""}</div>
      <div class="scroll"><ol class="stops" style="--c:${line.color}">${items}</ol></div>`);
  }

  function renderRtTrain(j: RtJourney) {
    const line = lines[j.line];
    const now = Date.now();
    const state = trainAt(j, track, now);
    const next = state ? state.next : j.calls.findIndex((c) => c.dep >= now);
    const items: string[] = [];
    if (state?.from != null && state.from !== j.calls[0].station && next === 0) {
      items.push(
        `<li class="past" data-station="${state.from}"><span class="dot"></span><span class="name">${escapeHtml(stations[state.from].name)}</span><span class="num"></span></li>`,
      );
    }
    j.calls.forEach((c, k) => {
      const cls = k < next ? "past" : k === next && state?.dwelling ? "here" : "";
      const arr = msToT(c.arr);
      const dep = msToT(c.dep);
      const time = Math.floor(arr / 60) === Math.floor(dep / 60) || k === j.calls.length - 1 ? hhmm(arr) : `${hhmm(arr)}–${hhmm(dep)}`;
      items.push(
        `<li class="${cls}" data-station="${c.station}"><span class="dot"></span><span class="name">${escapeHtml(stations[c.station].name)}</span><span class="num">${time}</span></li>`,
      );
    });
    const target = j.calls[Math.max(0, next)];
    const status = !state
      ? "Hors service"
      : state.dwelling
        ? `À quai · ${escapeHtml(stations[target.station].name)}`
        : `Vers ${escapeHtml(stations[target.station].name)} · ${countdown(msToT(target.arr), t)}`;
    setInfo(`
      <header>${badge(line)}<h2>${escapeHtml(j.destination)}</h2><span class="rt-tag">Temps réel</span></header>
      <div class="status"><span>${status}</span>${state ? `<button id="follow" class="text-btn ${follow ? "on" : ""}" aria-pressed="${follow}">Suivre</button>` : ""}</div>
      <div class="scroll"><ol class="stops" style="--c:${line.color}">${items.join("")}</ol></div>`);
  }

  infoBody.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el.closest("#follow")) {
      follow = !follow;
      renderInfo(true);
      return;
    }
    const row = el.closest<HTMLElement>("[data-trip]");
    if (row) return select({ kind: "train", id: row.dataset.trip! });
    const stop = el.closest<HTMLElement>("[data-station]");
    if (stop) select({ kind: "station", index: +stop.dataset.station! });
  });

  // Animation ----------------------------------------------------------------
  const clock = $("clock");
  const count = $("count");
  let lastShown = -1;
  let lastFrame = performance.now();
  let lastPush = 0;

  function feature(id: string, lineIndex: number, shape: number, dist: number, est: boolean) {
    const [lon, lat] = pointAt(shapes[shape], dist);
    const line = lines[lineIndex];
    return {
      type: "Feature" as const,
      properties: {
        id,
        color: line.color,
        text: line.text,
        label: line.id,
        est,
        sel: selection?.kind === "train" && selection.id === id,
      },
      geometry: { type: "Point" as const, coordinates: [lon, lat] },
    };
  }
  const scheduledFeature = (s: TrainState, est: boolean) =>
    feature(s.trip.id, s.pattern.line, s.pattern.shape, s.dist, est);
  const rtFeature = (s: RtTrain) => feature(`rt:${s.id}`, s.line, s.shape, s.dist, false);

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
      let features;
      if (realtime()) {
        const rt = locate(feed.journeys, track, Date.now()).filter((s) => !hidden.has(s.line));
        const scheduled = schedule
          .active(t)
          .filter((s) => !hidden.has(s.pattern.line) && !rtLines.has(s.pattern.line));
        features = [...scheduled.map((s) => scheduledFeature(s, true)), ...rt.map(rtFeature)];
      } else {
        features = schedule
          .active(t)
          .filter((s) => !hidden.has(s.pattern.line))
          .map((s) => scheduledFeature(s, false));
      }
      (map.getSource("trains") as GeoJSONSource).setData({ type: "FeatureCollection", features });
      count.textContent = String(features.length);
      if (follow && selection?.kind === "train") {
        const f = features.find((x) => x.properties.sel);
        if (f) map.setCenter(f.geometry.coordinates as [number, number]);
      }
      renderInfo();
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
  syncLive();
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
      get state() {
        return { date, t, playing, speed, hidden: [...hidden], selection, ready, live, realtime: realtime() };
      },
    },
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="fatal">Données indisponibles. Lancez <code>npm run data</code>.</p>`);
});
