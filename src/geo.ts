// Same local projection as scripts/build_data.py, so that stop distances
// computed by the data pipeline line up with the shapes measured here.
const LAT0 = 48.86;
const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

export interface MeasuredShape {
  coords: [number, number][];
  cum: Float64Array;
}

export function measure(coords: [number, number][]): MeasuredShape {
  const cum = new Float64Array(coords.length);
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * M_PER_DEG_LON;
    const dy = (coords[i][1] - coords[i - 1][1]) * M_PER_DEG_LAT;
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return { coords, cum };
}

/** Point at `d` metres along the shape, plus the bearing of travel in degrees. */
export function pointAt(shape: MeasuredShape, d: number): [number, number, number] {
  const { coords, cum } = shape;
  const n = coords.length;
  if (d <= 0) return [coords[0][0], coords[0][1], bearing(coords[0], coords[1])];
  if (d >= cum[n - 1]) return [coords[n - 1][0], coords[n - 1][1], bearing(coords[n - 2], coords[n - 1])];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (d - cum[lo]) / span : 0;
  const a = coords[lo];
  const b = coords[hi];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, bearing(a, b)];
}

function bearing(a: [number, number], b: [number, number]): number {
  const dx = (b[0] - a[0]) * M_PER_DEG_LON;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/** Coordinates of the shape between distances d0 and d1 (metres), clamped to its ends. */
export function sliceAlong(shape: MeasuredShape, d0: number, d1: number): [number, number][] {
  const { coords, cum } = shape;
  const total = cum[cum.length - 1];
  const a = Math.max(0, Math.min(total, d0));
  const b = Math.max(a, Math.min(total, d1));
  const start = pointAt(shape, a);
  const end = pointAt(shape, b);
  const out: [number, number][] = [[start[0], start[1]]];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= a) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < cum.length && cum[i] < b; i++) out.push(coords[i]);
  out.push([end[0], end[1]]);
  return out;
}
