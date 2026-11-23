// Real rolling stock as three.js meshes, drawn in the map's own WebGL context
// through a MapLibre custom layer. This module is fetched on the first click on
// a train whose stock is modelled: three.js stays out of the page's download.
//
// One builder for every stock, driven by its spec in stock.ts: cross-section
// (width, height, upright or inclined sides), car pitch, doors, gangways or
// separate cars, rubber tyres or steel wheels, flat or raked face, livery.
// The MP 14 was the first model; its numbers come from its Wikipedia pages
// (fr, en). Sources and estimates for the others are noted in stock.ts.

import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MapLibreMap } from "maplibre-gl";
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { metresPerPixel, pointBeyond, type MeasuredShape } from "./geo";
import { stockLength, type Stock } from "./stock";

// Car frame: x forward along the car, y to its left, z up, in metres; the
// rail is at z = 0 and the car is centred on x = 0.

type P = readonly [number, number]; // (y, z) of a cross-section point
interface Section {
  x: number;
  /** Lateral scale, and scale of what is above the waist: shapes the nose. */
  sy: number;
  sz: number;
  /** Setback of the face at roof height (raked windscreen), from the waist up. */
  rake?: number;
}

const FOOT = 0.42;
const WAIST = 1.55;
const mirror = (pts: readonly P[]): P[] => pts.map(([y, z]) => [-y, z] as const);

/** Cross-section and side layout of one stock. */
interface Profile {
  stock: Stock;
  length: number;
  width: number;
  top: number;
  side: P[];
  roof: P[];
  ring: P[];
  arc: number[];
  arcTotal: number;
  arcAt(z: number): number;
  /** Door centres along a car, from its rear. */
  doors: number[];
  doorHalf: number;
}

function profile(stock: Stock): Profile {
  const w = stock.width / 2;
  const top = stock.height;
  // Heights above the waist follow the roof height (the MP 14 is the 3.5 m reference).
  const up = (z: number) => WAIST + ((z - WAIST) * (top - WAIST)) / (3.5 - WAIST);
  const side: P[] = stock.inclined
    ? [
        [w - 0.075, FOOT],
        [w - 0.025, 1.0],
        [w, WAIST],
        [w - 0.025, up(2.55)],
        [w - 0.125, up(3.08)],
        [w - 0.365, up(3.38)],
      ]
    : [
        [w - 0.05, FOOT],
        [w, 0.9],
        [w, WAIST],
        [w, up(2.75)],
        [w - 0.07, up(3.12)],
        [w - 0.33, up(3.38)],
      ];
  const shoulder = side[side.length - 1];
  const roof: P[] = [shoulder, [0.45, up(3.47)], [0, top], [-0.45, up(3.47)], [-shoulder[0], shoulder[1]]];
  const ring: P[] = [...side, ...roof.slice(1, -1), ...mirror(side).reverse()];
  const arc = side.map((_, j) => side.slice(1, j + 1).reduce((a, p, k) => a + Math.hypot(p[0] - side[k][0], p[1] - side[k][1]), 0));
  const arcTotal = arc[arc.length - 1];
  const length = stock.carLength;
  return {
    stock,
    length,
    width: stock.width,
    top,
    side,
    roof,
    ring,
    arc,
    arcTotal,
    arcAt(z: number) {
      for (let j = 1; j < side.length; j++) {
        if (z <= side[j][1]) return arc[j - 1] + ((z - side[j - 1][1]) / (side[j][1] - side[j - 1][1])) * (arc[j] - arc[j - 1]);
      }
      return arcTotal;
    },
    doors: Array.from({ length: stock.doors }, (_, i) => ((i + 0.5) * length) / stock.doors),
    doorHalf: stock.doorWidth / 2,
  };
}

// Geometry ------------------------------------------------------------------

function placer(top: number) {
  return (p: P, s: Section): [number, number, number] => {
    const z = p[1] <= WAIST ? p[1] : WAIST + (p[1] - WAIST) * s.sz;
    const x = s.rake ? s.x - (s.rake * Math.max(0, z - WAIST)) / (top - WAIST) : s.x;
    return [x, p[0] * s.sy, z];
  };
}
type Place = ReturnType<typeof placer>;

function finish(pos: number[], uv: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals(); // unindexed: one normal per face, the planes stay crisp
  return g;
}

/** Skin stretched over `pts` from one section to the next. */
function strip(place: Place, sections: Section[], pts: readonly P[], uv: (x: number, j: number) => [number, number] = () => [0, 0]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const put = (s: Section, j: number) => {
    pos.push(...place(pts[j], s));
    uvs.push(...uv(s.x, j));
  };
  for (let i = 0; i + 1 < sections.length; i++) {
    for (let j = 0; j + 1 < pts.length; j++) {
      const a = sections[i];
      const b = sections[i + 1];
      put(a, j);
      put(b, j);
      put(b, j + 1);
      put(a, j);
      put(b, j + 1);
      put(a, j + 1);
    }
  }
  return finish(pos, uvs);
}

/** Flat face closing the body at a section. */
function cap(place: Place, ring: readonly P[], s: Section, uv: (p: P) => [number, number] = () => [0, 0]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const centre: P = [0, 1.9];
  for (let j = 0; j < ring.length; j++) {
    for (const p of [centre, ring[j], ring[(j + 1) % ring.length]]) {
      pos.push(...place(p, s));
      uvs.push(...uv(p));
    }
  }
  return finish(pos, uvs);
}

function box(x: number, y: number, z: number, lx: number, ly: number, lz: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(lx, ly, lz).toNonIndexed().translate(x, y, z);
}

// Livery, painted on canvases ---------------------------------------------

const GLASS = "#141b25";

interface Paint {
  /** Rectangle from (x0, z0) to (x1, z1), in metres; `r` rounds its corners. */
  rect(x0: number, x1: number, z0: number, z1: number, fill: string | CanvasGradient, r?: number): void;
  frame(x0: number, x1: number, z0: number, z1: number, stroke: string, width: number, r: number): void;
  gradient(z0: number, z1: number, bottom: string, top: string): CanvasGradient;
  canvas: HTMLCanvasElement;
}

function paint(w: number, h: number, X: (m: number) => number, Y: (z: number) => number, base: string): Paint {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  const scale = Math.abs(X(1) - X(0));
  const path = (x0: number, x1: number, z0: number, z1: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(X(x0), Y(z1), X(x1) - X(x0), Y(z0) - Y(z1), r * scale);
  };
  return {
    canvas,
    rect(x0, x1, z0, z1, fill, r = 0) {
      ctx.fillStyle = fill;
      path(x0, x1, z0, z1, r);
      ctx.fill();
    },
    frame(x0, x1, z0, z1, stroke, width, r) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * scale;
      path(x0, x1, z0, z1, r);
      ctx.stroke();
    },
    gradient(z0, z1, bottom, top) {
      const g = ctx.createLinearGradient(0, Y(z0), 0, Y(z1));
      g.addColorStop(0, bottom);
      g.addColorStop(1, top);
      return g;
    },
  };
}

/** Heights of the openings, following the floor and the roof of the stock. */
function openings(pr: Profile) {
  const { floor } = pr.stock;
  const lift = floor - 1.1; // the MP 14 floor is the reference
  const roofDrop = 3.5 - pr.top;
  return {
    doorBottom: floor + 0.02,
    doorTop: 3.0 - roofDrop,
    windowBottom: 1.72 + lift,
    windowTop: 2.78 - roofDrop,
    doorGlassBottom: 1.55 + lift,
    doorGlassTop: 2.82 - roofDrop,
  };
}

/** One side of a car: what is painted, and what glows (the lit saloon behind the glass). */
function sideCanvases(pr: Profile): { map: HTMLCanvasElement; glow: HTMLCanvasElement } {
  const { length, doors, doorHalf } = pr;
  const lv = pr.stock.livery;
  const o = openings(pr);
  const w = 2048;
  const h = 512;
  const X = (m: number) => (m / length) * w;
  const Y = (z: number) => (1 - pr.arcAt(z) / pr.arcTotal) * h;
  const map = paint(w, h, X, Y, lv.body);
  const glow = paint(w, h, X, Y, "#000");
  const glass = (x0: number, x1: number, z0: number, z1: number) => {
    map.rect(x0 - 0.05, x1 + 0.05, z0 - 0.05, z1 + 0.05, "#0b0e13", 0.14);
    map.rect(x0, x1, z0, z1, map.gradient(z0, z1, GLASS, "#243243"), 0.1);
    // The saloon seen through the glass: seats in shadow, ceiling lights above.
    glow.rect(x0, x1, z0, z1, glow.gradient(z0, z1, "#4d4433", "#fff1d8"), 0.1);
  };

  map.rect(0, length, FOOT, lv.skirtTop, map.gradient(FOOT, lv.skirtTop, lv.skirt[0], lv.skirt[1]));
  for (const b of lv.bands) map.rect(0, length, b.z0, b.z1, b.color);
  // Window bays between the doors, the long ones split by a pillar.
  const edges = [0, ...doors.flatMap((c) => [c - doorHalf, c + doorHalf]), length];
  for (let i = 0; i < edges.length; i += 2) {
    const x0 = edges[i] + (i === 0 ? 0.4 : 0.24);
    const x1 = edges[i + 1] - (i === edges.length - 2 ? 0.4 : 0.24);
    if (x1 - x0 < 0.4) continue;
    if (lv.windowStrip) map.rect(x0 - 0.12, x1 + 0.12, o.windowBottom - 0.12, o.windowTop + 0.1, lv.windowStrip, 0.05);
    if (x1 - x0 > 2) {
      const mid = (x0 + x1) / 2;
      glass(x0, mid - 0.07, o.windowBottom, o.windowTop);
      glass(mid + 0.07, x1, o.windowBottom, o.windowTop);
    } else glass(x0, x1, o.windowBottom, o.windowTop);
  }
  for (const c of doors) {
    map.rect(c - doorHalf - 0.03, c + doorHalf + 0.03, o.doorBottom - 0.02, o.doorTop + 0.02, lv.doorFrame, 0.06);
    map.rect(c - doorHalf, c + doorHalf, o.doorBottom, o.doorTop, lv.door, 0.05);
    if (lv.doorStripe) map.rect(c - 0.07, c + 0.07, o.doorBottom, o.doorTop, lv.doorStripe);
    map.rect(c - 0.008, c + 0.008, o.doorBottom, o.doorTop, "#3a4350");
    glass(c - doorHalf + 0.13, c - 0.17, o.doorGlassBottom, o.doorGlassTop);
    glass(c + 0.17, c + doorHalf - 0.13, o.doorGlassBottom, o.doorGlassTop);
  }
  return { map: map.canvas, glow: glow.canvas };
}

/** The end of the train: windscreen (with its mask or LED frame), lamps below. */
function frontCanvases(pr: Profile, light: string): { map: HTMLCanvasElement; glow: HTMLCanvasElement } {
  const lv = pr.stock.livery;
  const W = pr.width;
  const top = pr.top;
  const size = 512;
  const X = (y: number) => (y / W + 0.5) * size;
  const Y = (z: number) => (1 - (z - FOOT) / (top - FOOT)) * size;
  const map = paint(size, size, X, Y, lv.face);
  const glow = paint(size, size, X, Y, "#000");
  const g = W / 2 - 0.295; // windscreen half-width (0.93 m on the MP 14)
  const z0 = 1.5 + (pr.stock.floor - 1.1);
  const z1 = top - 0.4;
  map.rect(-W / 2, W / 2, FOOT, lv.skirtTop, map.gradient(FOOT, lv.skirtTop, lv.skirt[0], lv.skirt[1]));
  if (lv.mask) map.rect(-W / 2 + 0.06, W / 2 - 0.06, z0 - 0.35, z1 + 0.12, lv.mask, 0.25);
  map.rect(-g, g, z0, z1, map.gradient(z0, z1, "#0c1016", "#1d2835"), 0.2);
  if (lv.frame) map.frame(-g - 0.05, g + 0.05, z0 - 0.05, z1 + 0.05, lv.frame, 0.07, 0.22);
  if (lv.ledFrame) {
    map.frame(-g - 0.04, g + 0.04, z0 - 0.04, z1 + 0.04, light, 0.05, 0.22);
    glow.frame(-g - 0.04, g + 0.04, z0 - 0.04, z1 + 0.04, light, 0.05, 0.22);
  }
  for (const y of [-W / 2 + 0.3, W / 2 - 0.6]) {
    map.rect(y, y + 0.3, z0 - 0.4, z0 - 0.24, light, 0.05);
    glow.rect(y, y + 0.3, z0 - 0.4, z0 - 0.24, light, 0.05);
  }
  return { map: map.canvas, glow: glow.canvas };
}

function texture(canvas: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

// A train ---------------------------------------------------------------------

/** Cars from the rear of the train to its head, each centred on its own origin. */
function buildTrain(stock: Stock, anisotropy: number): THREE.Group[] {
  const pr = profile(stock);
  const { length, width, top, side, roof: roofPts, ring, arc, arcTotal } = pr;
  const lv = stock.livery;
  const place = placer(top);
  const sides = sideCanvases(pr);
  const lit = (c: { map: HTMLCanvasElement; glow: HTMLCanvasElement }, intensity: number) =>
    new THREE.MeshStandardMaterial({
      map: texture(c.map, anisotropy),
      emissiveMap: texture(c.glow, anisotropy),
      emissive: 0xffffff,
      emissiveIntensity: intensity,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
  const plain = (color: string | number, roughness: number) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05, side: THREE.DoubleSide });
  const skin = lit(sides, 0.7);
  const roof = plain(lv.roof, 0.8);
  const units = plain(0xaab0b9, 0.8);
  const dark = plain(0x1b1d22, 0.9);
  const wall = plain(lv.body, 0.7);
  const face = { head: lit(frontCanvases(pr, "#fff6dc"), 1.4), tail: lit(frontCanvases(pr, "#ff2d20"), 1.4) };

  const half = length / 2;
  // With gangways the body stops short of the car pitch and a bellows bridges
  // the rest; separate cars end in a wall, with a coupler across the gap.
  const coupled = stock.gangway ? half - 0.3 : half - 0.45;
  const straight = (x: number): Section => ({ x, sy: 1, sz: 1 });
  const sideUv = (x: number, j: number): [number, number] => [(x + half) / length, arc[j] / arcTotal];
  const frontUv = (p: P): [number, number] => [p[0] / width + 0.5, (p[1] - FOOT) / (top - FOOT)];

  const join = (x: number, out: number): { geo: THREE.BufferGeometry[]; walls: THREE.BufferGeometry[] } => {
    if (!stock.gangway) return { geo: [box(x + out * 0.225, 0, 0.75, 0.5, 0.3, 0.25)], walls: [cap(place, ring, straight(x))] };
    const ends = [x, x + out * 0.42].sort((a, b) => a - b).map((v) => ({ x: v, sy: 0.86, sz: 0.94 }));
    return { geo: [cap(place, ring, straight(x)), strip(place, ends, [...ring, ring[0]])], walls: [] };
  };
  // Running gear: two bogies (rubber tyres outside the rails, or steel wheels),
  // equipment cases between them.
  const bogieAt = half - 2.52;
  const wheel = stock.tyres ? { r: 0.49, y: 0.99, t: 0.3 } : { r: 0.43, y: 0.74, t: 0.14 };
  const gear = (): THREE.BufferGeometry[] => {
    const parts = [box(0, 0, 0.42, length - 8.6, width - 0.45, 0.3)];
    for (const bogie of [-bogieAt, bogieAt]) {
      parts.push(box(bogie, 0, 0.42, 2.9, 1.6, 0.34));
      for (const dx of [-1, 1]) {
        for (const y of [-wheel.y, wheel.y]) {
          parts.push(new THREE.CylinderGeometry(wheel.r, wheel.r, wheel.t, 16).toNonIndexed().translate(bogie + dx, y, wheel.r));
        }
      }
    }
    return parts;
  };
  const car = (sections: Section[], nose: keyof typeof face | null): THREE.Group => {
    const g = new THREE.Group();
    const add = (parts: THREE.BufferGeometry[], material: THREE.Material) => {
      if (!parts.length) return;
      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      mesh.frustumCulled = false;
      g.add(mesh);
    };
    add([strip(place, sections, side, sideUv), strip(place, sections, mirror(side), sideUv)], skin);
    add([strip(place, sections, roofPts)], roof);
    add([box(-length * 0.226, 0, top + 0.05, 2.8, 1.5, 0.16), box(length * 0.226, 0, top + 0.05, 2.8, 1.5, 0.16)], units);
    const rear = join(-coupled, -1);
    const under = [strip(place, sections, [mirror(side)[0], side[0]]), ...gear(), ...rear.geo];
    const walls = [...rear.walls];
    if (nose) add([cap(place, ring, sections[sections.length - 1], frontUv)], face[nose]);
    else {
      const front = join(coupled, 1);
      under.push(...front.geo);
      walls.push(...front.walls);
    }
    add(under, dark);
    add(walls, wall);
    return g;
  };

  const middle = [straight(-coupled), straight(coupled)];
  // The nose: a flat face rounded off over its last 90 cm (MP 14), or a
  // windscreen raked back from the waist (`rake` metres at roof height).
  const r = stock.rake;
  const x0 = half - 0.9 - r;
  const ramp = (x: number) => (r ? (r * (x - x0)) / (half - x0) : 0);
  const nose = [
    straight(-coupled),
    straight(x0),
    { x: half - 0.35, sy: 0.985, sz: 1, rake: ramp(half - 0.35) },
    { x: half - 0.1, sy: 0.955, sz: 0.99, rake: ramp(half - 0.1) },
    { x: half, sy: 0.9, sz: 0.975, rake: r },
  ];
  const out: THREE.Group[] = [];
  for (let i = 0; i < stock.cars; i++) out.push(i === 0 ? car(nose, "tail") : i === stock.cars - 1 ? car(nose, "head") : car(middle, null));
  return out;
}

// The map layer ---------------------------------------------------------------

export interface Shown {
  id: string;
  stock: string;
  cars: number;
  length: number;
}

export class TrainMeshLayer implements CustomLayerInterface {
  readonly id = "train-mesh";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** The train currently drawn as a mesh, if any. */
  shown: Shown | null = null;

  private map!: MapLibreMap;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly key = new THREE.DirectionalLight(0xffffff, 2.1);
  private readonly trains = new Map<string, THREE.Group[]>();
  private cars: THREE.Group[] = [];
  private anchor = new MercatorCoordinate(0, 0, 0);
  private unit = 1;

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
    const sky = new THREE.HemisphereLight(0xffffff, 0x565c68, 1.7);
    sky.position.set(0, 0, 1); // the scene's up is z, three's default is y
    this.scene.add(sky, this.key, this.key.target);
  }

  /** Lays the train of `stock` along `shape`, centred on `dist` and heading towards larger distances. */
  show(id: string, stock: Stock, shape: MeasuredShape, dist: number, zoom: number) {
    let cars = this.trains.get(stock.model);
    if (!cars) {
      cars = buildTrain(stock, this.renderer.capabilities.getMaxAnisotropy());
      this.trains.set(stock.model, cars);
    }
    if (cars !== this.cars) {
      this.scene.remove(...this.cars);
      this.scene.add(...cars);
      this.cars = cars;
    }
    const length = stockLength(stock);
    this.anchor = MercatorCoordinate.fromLngLat(pointBeyond(shape, dist), 0);
    this.unit = this.anchor.meterInMercatorCoordinateUnits();
    const local = (d: number): [number, number] => {
      const m = MercatorCoordinate.fromLngLat(pointBeyond(shape, d), 0);
      return [(m.x - this.anchor.x) / this.unit, (this.anchor.y - m.y) / this.unit];
    };
    // Like the extruded model, the cross-section is widened when the real one
    // would be thinner than ~8 px; from zoom 18 the train is to scale.
    const k = Math.max(1, (8 * metresPerPixel(zoom)) / stock.width);
    const pivot = stock.carLength / 2 - 2.52; // each car sits on its two bogies
    cars.forEach((car, i) => {
      const d = dist - length / 2 + (i + 0.5) * stock.carLength;
      const a = local(d - pivot);
      const b = local(d + pivot);
      car.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0);
      car.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]) + (i === 0 ? Math.PI : 0);
      car.scale.set(1, k, Math.sqrt(k));
    });
    this.shown = { id, stock: stock.name, cars: stock.cars, length };
    this.map.triggerRepaint();
  }

  hide() {
    if (!this.shown) return;
    this.shown = null;
    this.map.triggerRepaint();
  }

  render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.shown) return;
    // Scene in metres around the train (x east, y north, z up), carried into
    // the map's mercator space: mercator y points south.
    const local = new THREE.Matrix4()
      .makeTranslation(this.anchor.x, this.anchor.y, this.anchor.z)
      .scale(new THREE.Vector3(this.unit, -this.unit, this.unit));
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as number[]).multiply(local);
    // Key light from the viewer's side, a little to the left, so the side in view is lit.
    const from = ((this.map.getBearing() + 180 - 35) * Math.PI) / 180;
    this.key.position.set(Math.sin(from), Math.cos(from), 1.1);
    const canvas = this.map.getCanvas();
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, canvas.width, canvas.height); // three does not follow the map's resizes
    this.renderer.render(this.scene, this.camera);
  }
}
