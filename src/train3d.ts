// Trains as 3D extrusions (MapLibre fill-extrusion): every train is a box
// laid along the track; the selected one, seen up close, is a detailed model
// (cars, windows, livery stripe, roof, cab lights).
//
// MapLibre extrudes polygons in metres, so a real 2.45 m wide train would be
// invisible below zoom ~16. Cross-sections are widened to stay a few pixels
// wide on screen; lengths stay to scale.

import { metresPerPixel, ribbon, type MeasuredShape } from "./geo";

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
) {
  const ring = ribbon(shape, d0, d1, half);
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
) {
  const width = boxPixels(zoom) * metresPerPixel(zoom);
  const height = width * 0.75;
  const rear = dist - length / 2;
  const head = dist + length / 2;
  const nose = Math.max(6, length * 0.12);
  part(out, shape, rear, head - nose, width / 2, 0, height, color, id);
  part(out, shape, head - nose, head, width / 2, 0, height, front, id);
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
    part(out, shape, d0, d1, w(half), h(base), h(top), c, id);

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
