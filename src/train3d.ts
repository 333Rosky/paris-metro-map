// Trains as 3D extrusions (MapLibre fill-extrusion): every train is a box
// laid along the track; the selected one, seen up close, is a detailed model
// (cars, windows, livery stripe, roof, cab lights).
//
// MapLibre extrudes polygons in metres, so a real 2.45 m wide train would be
// invisible below zoom ~16. Cross-sections are widened to stay a few pixels
// wide on screen; lengths stay to scale.

import { M_PER_DEG_LAT, M_PER_DEG_LON, metresPerPixel, ribbon, type MeasuredShape } from "./geo";

export interface PartProps {
  id: string;
  color: string;
  base: number;
  top: number;
}

export type PartFeature = {
  type: "Feature";
  properties: PartProps;
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
};

/** From this zoom the selected train is drawn as a detailed model. */
export const MODEL_ZOOM = 15.8;
const CAR_LENGTH = 15;
const REAL_WIDTH = 2.45;

/** Screen width (px) of a train box at `zoom`, same ramp as the former flat bodies. */
function boxPixels(zoom: number): number {
  const stops: [number, number][] = [
    [12.5, 4.5],
    [15, 7.5],
    [17, 10],
  ];
  if (zoom <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [z1, p1] = stops[i];
    const [z0, p0] = stops[i - 1];
    if (zoom <= z1) return p0 + ((zoom - z0) / (z1 - z0)) * (p1 - p0);
  }
  return stops[stops.length - 1][1];
}

/** Width of a train box, in metres. */
export const boxWidth = (zoom: number) => boxPixels(zoom) * metresPerPixel(zoom);

/** How much a real cross-section is widened so that a train stays ~8 px wide. */
export const widen = (zoom: number) => Math.max(1, (8 * metresPerPixel(zoom)) / REAL_WIDTH);

/**
 * Trains run on the right: each direction has its own track, this far right of
 * the line's centre line (1.75 m, half the distance between two tracks, widened
 * like the trains; boxes sit side by side).
 */
export const trackSide = (zoom: number, meshed: boolean) => (meshed ? 1.75 * widen(zoom) : boxWidth(zoom) * 0.62);

/** Blend a #rrggbb colour towards `to` by `w` (0..1). */
export function mix(color: string, to: string, w: number): string {
  const a = parseInt(color.slice(1), 16);
  const b = parseInt(to.slice(1), 16);
  const ch = (v: number, s: number) => (v >> s) & 255;
  const c = (s: number) => Math.round(ch(a, s) * (1 - w) + ch(b, s) * w);
  return `#${((c(16) << 16) | (c(8) << 8) | c(0)).toString(16).padStart(6, "0")}`;
}

function part(
  out: PartFeature[],
  shape: MeasuredShape,
  d0: number,
  d1: number,
  half: number,
  base: number,
  top: number,
  color: string,
  id: string,
  side = 0,
) {
  const ring = ribbon(shape, d0, d1, half, side);
  if (ring.length < 4) return;
  out.push({ type: "Feature", properties: { id, color, base, top }, geometry: { type: "Polygon", coordinates: [ring] } });
}

/**
 * A train seen from afar: one box in the line colour, its front end in the
 * line's text colour so the direction of travel reads at a glance.
 */
export function trainBox(
  out: PartFeature[],
  shape: MeasuredShape,
  dist: number,
  length: number,
  zoom: number,
  color: string,
  front: string,
  id: string,
  side = 0,
) {
  const width = boxWidth(zoom);
  const height = width * 0.75;
  const rear = dist - length / 2;
  const head = dist + length / 2;
  const nose = Math.max(6, length * 0.12);
  part(out, shape, rear, head - nose, width / 2, 0, height, color, id, side);
  part(out, shape, head - nose, head, width / 2, 0, height, front, id, side);
}

/**
 * What stays on the ground under a train drawn as a mesh (train-mesh.ts): a
 * footprint in a dark shade of the line colour, which reads as its shadow,
 * tells the line, and keeps the train clickable.
 */
export function trainFootprint(
  out: PartFeature[],
  shape: MeasuredShape,
  dist: number,
  length: number,
  zoom: number,
  color: string,
  id: string,
  side = 0,
) {
  part(out, shape, dist - length / 2 - 0.4, dist + length / 2 + 0.4, 1.5 * widen(zoom), 0, 0.03, color, id, side);
}

/** The selected train up close: one model per car, front car at `dist + length / 2`. */
export function trainModel(
  out: PartFeature[],
  shape: MeasuredShape,
  dist: number,
  length: number,
  zoom: number,
  color: string,
  id: string,
  side = 0,
) {
  // Widen the cross-section when the real one would be thinner than ~8 px;
  // heights grow more gently so cars do not turn into towers.
  const k = Math.max(1, (8 * metresPerPixel(zoom)) / REAL_WIDTH);
  const kv = Math.sqrt(k);
  const w = (m: number) => m * k;
  const h = (m: number) => m * kv;
  const cars = Math.max(1, Math.round(length / CAR_LENGTH));
  const carLen = length / cars;
  const gap = 0.9;
  const rear = dist - length / 2;

  const BODY = "#e8e9ee";
  const GLASS = "#121a24";
  const UNDER = "#24262c";
  const ROOF = "#aeb3bc";
  const add = (d0: number, d1: number, half: number, base: number, top: number, c: string) =>
    part(out, shape, d0, d1, w(half), h(base), h(top), c, id, side);

  for (let c = 0; c < cars; c++) {
    const s = rear + c * carLen + gap / 2;
    const e = s + carLen - gap;
    add(s + 1.2, e - 1.2, 1.0, 0.15, 0.95, UNDER); // underframe and bogies
    add(s, e, 1.225, 0.95, 3.2, BODY); // body shell
    add(s, e, 1.26, 1.55, 1.85, color); // livery stripe
    // Side windows between doors.
    const pitch = 2.3;
    const n = Math.floor((e - s - 1.2) / pitch);
    const start = s + (e - s - n * pitch) / 2;
    for (let i = 0; i < n; i++) add(start + i * pitch + 0.25, start + (i + 1) * pitch - 0.25, 1.26, 1.95, 2.75, GLASS);
    add(s + 0.4, e - 0.4, 1.0, 3.2, 3.5, ROOF);
  }
  // Cab ends: windscreen, then headlights at the front and tail lights at the back.
  const head = rear + length;
  add(head - gap / 2 - 0.45, head - gap / 2, 1.27, 1.95, 2.95, GLASS);
  add(head - gap / 2 - 0.3, head - gap / 2, 1.27, 1.05, 1.3, "#fff4c8");
  add(rear + gap / 2, rear + gap / 2 + 0.45, 1.27, 1.95, 2.95, GLASS);
  add(rear + gap / 2, rear + gap / 2 + 0.3, 1.27, 1.05, 1.3, "#ff3b30");
}

/**
 * A street entrance: a stairwell going down (dark opening and its railing,
 * open on the side away from the station) and the yellow "M" totem at its
 * head. Real sizes about 1.8 m by 4.5 m, totem 3.6 m; widened by `k`. The
 * feed gives the entrance point only: the stairs are turned towards the station.
 */
export function entranceModel(out: PartFeature[], lon: number, lat: number, toLon: number, toLat: number, k: number) {
  const ex = (toLon - lon) * M_PER_DEG_LON;
  const ey = (toLat - lat) * M_PER_DEG_LAT;
  const l = Math.hypot(ex, ey) || 1;
  const [ux, uy] = [ex / l, ey / l]; // towards the station
  const [vx, vy] = [-uy, ux];
  const pt = (a: number, b: number): [number, number] => [lon + (ux * a + vx * b) / M_PER_DEG_LON, lat + (uy * a + vy * b) / M_PER_DEG_LAT];
  const rect = (a0: number, a1: number, b0: number, b1: number, base: number, top: number, color: string) => {
    const ring = [pt(a0 * k, b0 * k), pt(a1 * k, b0 * k), pt(a1 * k, b1 * k), pt(a0 * k, b1 * k), pt(a0 * k, b0 * k)];
    out.push({ type: "Feature", properties: { id: "", color, base, top }, geometry: { type: "Polygon", coordinates: [ring] } });
  };
  const kv = Math.sqrt(k);
  rect(0, 4.5, -0.9, 0.9, 0, 0.05, "#08090b"); // the stairwell
  rect(0, 4.5, -1.0, -0.9, 0, 1.0 * kv, "#2f5d50"); // railing, both sides and the far end
  rect(0, 4.5, 0.9, 1.0, 0, 1.0 * kv, "#2f5d50");
  rect(4.4, 4.5, -1.0, 1.0, 0, 1.0 * kv, "#2f5d50");
  rect(-0.35, -0.2, 0.95, 1.1, 0, 3.0 * kv, "#7d828a"); // totem pole
  rect(-0.55, 0, 0.75, 1.3, 3.0 * kv, 3.6 * kv, "#ffcd00"); // the yellow M sign
}
