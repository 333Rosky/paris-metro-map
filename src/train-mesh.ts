// Real rolling stock as a three.js mesh, drawn in the map's own WebGL context
// through a MapLibre custom layer. This module is fetched on the first click on
// a train whose stock is modelled: three.js stays out of the page's download.
//
// One model so far, the MP 14 (Alstom, in service since 2020) in its white
// Île-de-France Mobilités livery. From its Wikipedia pages (fr, en): cars of
// 15.04 m, 2.45 m wide, three two-leaf doors a side, open gangways, body sides
// made of inclined planes, silver band at the foot of the body, sky-blue line
// along the roof and at the doors, flat front framed by an LED strip. Height,
// door width, window layout and roof equipment are not given there: estimates.

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
}

const LENGTH = 15.04;
const WIDTH = 2.45;
const FOOT = 0.42;
const WAIST = 1.55;
const TOP = 3.5;
/** Body side from its foot to the roof shoulder: the widest point is the waist. */
const SIDE: P[] = [
  [1.15, FOOT],
  [1.2, 1.0],
  [WIDTH / 2, WAIST],
  [1.2, 2.55],
  [1.1, 3.08],
  [0.86, 3.38],
];
const ROOF: P[] = [[0.86, 3.38], [0.45, 3.47], [0, TOP], [-0.45, 3.47], [-0.86, 3.38]];
const mirror = (pts: readonly P[]): P[] => pts.map(([y, z]) => [-y, z] as const);
const RING: P[] = [...SIDE, ...ROOF.slice(1, -1), ...mirror(SIDE).reverse()];

/** Distance along the side from its foot, for texture coordinates. */
const ARC = SIDE.map((_, j) => SIDE.slice(1, j + 1).reduce((a, p, k) => a + Math.hypot(p[0] - SIDE[k][0], p[1] - SIDE[k][1]), 0));
const ARC_TOTAL = ARC[ARC.length - 1];
function arcAt(z: number): number {
  for (let j = 1; j < SIDE.length; j++) {
    if (z <= SIDE[j][1]) return ARC[j - 1] + ((z - SIDE[j - 1][1]) / (SIDE[j][1] - SIDE[j - 1][1])) * (ARC[j] - ARC[j - 1]);
  }
  return ARC_TOTAL;
}

// Geometry ------------------------------------------------------------------

const place = (p: P, s: Section): [number, number, number] => [s.x, p[0] * s.sy, p[1] <= WAIST ? p[1] : WAIST + (p[1] - WAIST) * s.sz];

function finish(pos: number[], uv: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals(); // unindexed: one normal per face, the planes stay crisp
  return g;
}

/** Skin stretched over `pts` from one section to the next. */
function strip(sections: Section[], pts: readonly P[], uv: (x: number, j: number) => [number, number] = () => [0, 0]): THREE.BufferGeometry {
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
function cap(s: Section, uv: (p: P) => [number, number] = () => [0, 0]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const centre: P = [0, 1.9];
  for (let j = 0; j < RING.length; j++) {
    for (const p of [centre, RING[j], RING[(j + 1) % RING.length]]) {
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

const WHITE = "#f4f5f7";
const SILVER = "#a9afb8";
const SKY = "#6cc4ee";
const GLASS = "#141b25";
/** Three doors a side, evenly spaced along the train. */
const DOORS = [LENGTH / 6, LENGTH / 2, (5 * LENGTH) / 6];
const DOOR_HALF = 0.825;

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

/** One side of a car: what is painted, and what glows (the lit saloon behind the glass). */
function sideCanvases(): { map: HTMLCanvasElement; glow: HTMLCanvasElement } {
  const w = 2048;
  const h = 512;
  const X = (m: number) => (m / LENGTH) * w;
  const Y = (z: number) => (1 - arcAt(z) / ARC_TOTAL) * h;
  const map = paint(w, h, X, Y, WHITE);
  const glow = paint(w, h, X, Y, "#000");
  const glass = (x0: number, x1: number, z0: number, z1: number) => {
    map.rect(x0 - 0.05, x1 + 0.05, z0 - 0.05, z1 + 0.05, "#0b0e13", 0.14);
    map.rect(x0, x1, z0, z1, map.gradient(z0, z1, GLASS, "#243243"), 0.1);
    // The saloon seen through the glass: seats in shadow, ceiling lights above.
    glow.rect(x0, x1, z0, z1, glow.gradient(z0, z1, "#4d4433", "#fff1d8"), 0.1);
  };

  map.rect(0, LENGTH, FOOT, 0.98, map.gradient(FOOT, 0.98, "#8d939c", SILVER));
  map.rect(0, LENGTH, 0.98, 1.0, "#7d838c");
  map.rect(0, LENGTH, 3.1, 3.2, SKY);
  // Window bays between the doors, the long ones split by a pillar.
  const edges = [0, ...DOORS.flatMap((c) => [c - DOOR_HALF, c + DOOR_HALF]), LENGTH];
  for (let i = 0; i < edges.length; i += 2) {
    const x0 = edges[i] + (i === 0 ? 0.4 : 0.24);
    const x1 = edges[i + 1] - (i === edges.length - 2 ? 0.4 : 0.24);
    if (x1 - x0 > 2) {
      const mid = (x0 + x1) / 2;
      glass(x0, mid - 0.07, 1.72, 2.78);
      glass(mid + 0.07, x1, 1.72, 2.78);
    } else glass(x0, x1, 1.72, 2.78);
  }
  for (const c of DOORS) {
    map.rect(c - DOOR_HALF - 0.03, c + DOOR_HALF + 0.03, 1.1, 3.02, "#c9ced6", 0.06);
    map.rect(c - DOOR_HALF, c + DOOR_HALF, 1.12, 3.0, "#fafbfc", 0.05);
    map.rect(c - 0.07, c + 0.07, 1.12, 3.0, SKY);
    map.rect(c - 0.008, c + 0.008, 1.12, 3.0, "#3a4350");
    glass(c - DOOR_HALF + 0.13, c - 0.17, 1.55, 2.82);
    glass(c + 0.17, c + DOOR_HALF - 0.13, 1.55, 2.82);
  }
  return { map: map.canvas, glow: glow.canvas };
}

/** The flat end of the train: windscreen framed by its LED strip, lamps below. */
function frontCanvases(light: string): { map: HTMLCanvasElement; glow: HTMLCanvasElement } {
  const size = 512;
  const X = (y: number) => (y / WIDTH + 0.5) * size;
  const Y = (z: number) => (1 - (z - FOOT) / (TOP - FOOT)) * size;
  const map = paint(size, size, X, Y, WHITE);
  const glow = paint(size, size, X, Y, "#000");
  map.rect(-WIDTH / 2, WIDTH / 2, FOOT, 0.98, SILVER);
  map.rect(-0.93, 0.93, 1.5, 3.1, map.gradient(1.5, 3.1, "#0c1016", "#1d2835"), 0.2);
  map.frame(-0.97, 0.97, 1.46, 3.14, light, 0.05, 0.22);
  glow.frame(-0.97, 0.97, 1.46, 3.14, light, 0.05, 0.22);
  for (const y of [-0.92, 0.62]) {
    map.rect(y, y + 0.3, 1.1, 1.26, light, 0.05);
    glow.rect(y, y + 0.3, 1.1, 1.26, light, 0.05);
  }
  return { map: map.canvas, glow: glow.canvas };
}

function texture(canvas: HTMLCanvasElement, anisotropy: number): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  return t;
}

// The MP 14 -----------------------------------------------------------------

/** Cars from the rear of the train to its head, each centred on its own origin. */
function buildMp14(cars: number, anisotropy: number): THREE.Group[] {
  const sides = sideCanvases();
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
  const plain = (color: number, roughness: number) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05, side: THREE.DoubleSide });
  const skin = lit(sides, 0.7);
  const roof = plain(0xd3d7dd, 0.8);
  const units = plain(0xaab0b9, 0.8);
  const dark = plain(0x1b1d22, 0.9);
  const face = { head: lit(frontCanvases("#fff6dc"), 1.4), tail: lit(frontCanvases("#ff2d20"), 1.4) };

  const half = LENGTH / 2;
  const coupled = half - 0.3; // the body stops short of the car pitch; a gangway bridges the rest
  const straight = (x: number): Section => ({ x, sy: 1, sz: 1 });
  const sideUv = (x: number, j: number): [number, number] => [(x + half) / LENGTH, ARC[j] / ARC_TOTAL];
  const frontUv = (p: P): [number, number] => [p[0] / WIDTH + 0.5, (p[1] - FOOT) / (TOP - FOOT)];

  const gangway = (x: number, out: number): THREE.BufferGeometry[] => {
    const ends = [x, x + out * 0.42].sort((a, b) => a - b).map((v) => ({ x: v, sy: 0.86, sz: 0.94 }));
    return [cap(straight(x)), strip(ends, [...RING, RING[0]])];
  };
  // Running gear: two bogies on rubber tyres, equipment cases between them.
  const gear = (): THREE.BufferGeometry[] => {
    const parts = [box(0, 0, 0.42, 6.4, 2.0, 0.3)];
    for (const bogie of [-5, 5]) {
      parts.push(box(bogie, 0, 0.42, 2.9, 1.6, 0.34));
      for (const dx of [-1, 1]) {
        for (const y of [-0.99, 0.99]) parts.push(new THREE.CylinderGeometry(0.49, 0.49, 0.3, 16).toNonIndexed().translate(bogie + dx, y, 0.49));
      }
    }
    return parts;
  };
  const car = (sections: Section[], nose: keyof typeof face | null): THREE.Group => {
    const g = new THREE.Group();
    const add = (parts: THREE.BufferGeometry[], material: THREE.Material) => {
      const mesh = new THREE.Mesh(mergeGeometries(parts), material);
      mesh.frustumCulled = false;
      g.add(mesh);
    };
    add([strip(sections, SIDE, sideUv), strip(sections, mirror(SIDE), sideUv)], skin);
    add([strip(sections, ROOF)], roof);
    add([box(-3.4, 0, 3.55, 2.8, 1.5, 0.16), box(3.4, 0, 3.55, 2.8, 1.5, 0.16)], units);
    const under = [strip(sections, [mirror(SIDE)[0], SIDE[0]]), ...gear(), ...gangway(-coupled, -1)];
    if (nose) add([cap(sections[sections.length - 1], frontUv)], face[nose]);
    else under.push(...gangway(coupled, 1));
    add(under, dark);
    return g;
  };

  const middle = [straight(-coupled), straight(coupled)];
  // The front edge is rounded off over the last 90 cm, then the face is flat.
  const end = [
    straight(-coupled),
    straight(half - 0.9),
    { x: half - 0.35, sy: 0.985, sz: 1 },
    { x: half - 0.1, sy: 0.955, sz: 0.99 },
    { x: half, sy: 0.9, sz: 0.975 },
  ];
  const out: THREE.Group[] = [];
  for (let i = 0; i < cars; i++) out.push(i === 0 ? car(end, "tail") : i === cars - 1 ? car(end, "head") : car(middle, null));
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
      cars = buildMp14(stock.cars, this.renderer.capabilities.getMaxAnisotropy());
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
    const k = Math.max(1, (8 * metresPerPixel(zoom)) / WIDTH);
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
