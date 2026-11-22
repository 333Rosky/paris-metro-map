import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import "./style.css";
import { measure, pointAt, type MeasuredShape } from "./geo";
import { DAY, Schedule, shiftDate, type TrainState } from "./schedule";
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

  const setDate = (d: string) => {
    date = d;
    schedule.tripsFor(date);
    if (selection?.kind === "train" && !schedule.findTrip(selection.id)) selection = null;
    dirty = true;
  };

  dateSel.addEventListener("change", () => {
    setDate(dateSel.value);
    syncControls();
  });
  slider.addEventListener("input", () => {
    scrubbing = true;
    t = +slider.value;
    dirty = true;
  });
  slider.addEventListener("change", () => (scrubbing = false));
  const togglePlay = () => {
    playing = !playing;
    syncControls();
  };
  playBtn.addEventListener("click", togglePlay);
  speedsEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-speed]");
    if (!b) return;
    speed = +b.dataset.speed!;
    playing = true;
    syncControls();
  });
  $("now").addEventListener("click", () => {
    const n = parisNow();
    setDate(nearestDate(n.date));
    t = n.t;
    speed = 1;
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

  let lastInfoRender = 0;
  function renderInfo(force = false) {
    const now = performance.now();
    if (!force && now - lastInfoRender < 400) return;
    lastInfoRender = now;
    info.hidden = !selection;
    if (!selection) return;

    if (selection.kind === "station") {
      const st = stations[selection.index];
      const events = schedule.board(selection.index, t);
      const rows = events
        .map((ev) => {
          const line = lines[ev.pattern.line];
          const atQuay = ev.arr <= t;
          return `<tr data-trip="${ev.trip.id}">
            <td>${badge(line, "sm")}</td>
            <td class="dir">${ev.terminus ? "Terminus" : escapeHtml(ev.pattern.headsign)}</td>
            <td class="num">${ev.origin ? "—" : hhmm(ev.arr)}</td>
            <td class="num">${ev.terminus ? "—" : hhmm(ev.dep)}</td>
            <td class="num wait">${atQuay ? "à quai" : countdown(ev.arr, t)}</td>
          </tr>`;
        })
        .join("");
      infoBody.innerHTML = `
        <header><h2>${escapeHtml(st.name)}</h2><div class="badges">${st.lines.map((l) => badge(lines[l], "sm")).join("")}</div></header>
        ${
          events.length
            ? `<div class="scroll"><table class="board"><thead><tr><th></th><th>Direction</th><th>Arr.</th><th>Dép.</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<p class="empty">Aucun passage d'ici la fin de service.</p>`
        }`;
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
    infoBody.innerHTML = `
      <header>${badge(line)}<h2>${escapeHtml(p.headsign)}</h2></header>
      <div class="status"><span>${status}</span>${state ? `<button id="follow" class="text-btn ${follow ? "on" : ""}" aria-pressed="${follow}">Suivre</button>` : ""}</div>
      <div class="scroll"><ol class="stops" style="--c:${line.color}">${items}</ol></div>`;
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

  function trainFeature(s: TrainState) {
    const [lon, lat] = pointAt(shapes[s.pattern.shape], s.dist);
    const line = lines[s.pattern.line];
    return {
      type: "Feature" as const,
      properties: {
        id: s.trip.id,
        color: line.color,
        text: line.text,
        label: line.id,
        sel: selection?.kind === "train" && selection.id === s.trip.id,
      },
      geometry: { type: "Point" as const, coordinates: [lon, lat] },
    };
  }

  function frame(now: number) {
    const dt = Math.min((now - lastFrame) / 1000, 1); // cap jumps after a background tab
    lastFrame = now;
    if (playing && !scrubbing) {
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

    if (dirty && ready) {
      dirty = false;
      const active = schedule.active(t).filter((s) => !hidden.has(s.pattern.line));
      const features = active.map(trainFeature);
      (map.getSource("trains") as GeoJSONSource).setData({ type: "FeatureCollection", features });
      count.textContent = String(active.length);
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

  // Inspection hook for tests, agents and the browser console.
  Object.assign(window, {
    metro: {
      map,
      schedule,
      select,
      get state() {
        return { date, t, playing, speed, hidden: [...hidden], selection, ready };
      },
    },
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML("beforeend", `<p class="fatal">Données indisponibles. Lancez <code>npm run data</code>.</p>`);
});
