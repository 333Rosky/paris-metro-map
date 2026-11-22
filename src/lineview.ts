// Schematic view of one line: stations top to bottom, branches side by side,
// and every train of the line riding beside the track (downward runs on the
// left, upward runs on the right).

import type { Network, Pattern, Timetable } from "./types";

const ROW = 26;
const PAD_TOP = 16;
const PAD_BOTTOM = 16;
const X0 = 34;
const LANE = 150;
/** Fits the info panel; only lines with three parallel branches would exceed it. */
const WIDTH = 330;
const LABEL_DX = 22;
const SIDE = 10;
const CHARS_NARROW = 17;
const CHARS_WIDE = 38;
const SVG_NS = "http://www.w3.org/2000/svg";

export interface LineTrain {
  id: string;
  pattern: Pattern;
  stop: number;
  dwelling: boolean;
  frac: number;
  est: boolean;
}

interface Node {
  x: number;
  y: number;
  lane: number;
  row: number;
}

export interface LineLayout {
  pos: Map<number, Node>;
  edges: [number, number][];
  width: number;
  height: number;
  /** Names of the stations where downward / upward runs end. */
  bottoms: number[];
  tops: number[];
}

/** Orders the stations of a line into rows and lanes from its scheduled runs. */
export function layoutLine(line: number, timetable: Timetable): LineLayout {
  // Distinct stop sequences with the number of trips running them, longest first.
  const trips = new Array<number>(timetable.patterns.length).fill(0);
  for (const flat of timetable.services) for (let i = 0; i < flat.length; i += 2) trips[flat[i]]++;
  const byKey = new Map<string, { stops: number[]; dir: number; weight: number }>();
  let total = 0;
  timetable.patterns.forEach((p, pi) => {
    if (p.line !== line) return;
    const key = p.stops.join(",");
    let seq = byKey.get(key);
    if (!seq) byKey.set(key, (seq = { stops: p.stops, dir: p.dir, weight: 0 }));
    seq.weight += trips[pi];
    total += trips[pi];
  });
  const seqs = [...byKey.values()].sort((a, b) => b.stops.length - a.stops.length);

  // Orient every sequence like the longest one, whatever its direction_id.
  const rank = new Map<number, number>();
  const refDir = seqs[0]?.dir ?? 0;
  const succ = new Map<number, Set<number>>();
  const pred = new Map<number, Set<number>>();
  const nodes: number[] = [];
  const touch = (s: number) => {
    if (!succ.has(s)) {
      succ.set(s, new Set());
      pred.set(s, new Set());
      nodes.push(s);
    }
  };
  const reaches = (from: number, to: number, skip?: [number, number]): boolean => {
    const stack = [from];
    const visited = new Set<number>([from]);
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of succ.get(n) ?? []) {
        if (skip && n === skip[0] && m === skip[1]) continue;
        if (m === to) return true;
        if (!visited.has(m)) {
          visited.add(m);
          stack.push(m);
        }
      }
    }
    return false;
  };

  const oriented: { stops: number[]; weight: number }[] = [];
  for (const seq of seqs) {
    let stops = seq.stops;
    let up = 0;
    let down = 0;
    let last: number | undefined;
    for (const s of stops) {
      const r = rank.get(s);
      if (r === undefined) continue;
      if (last !== undefined) r > last ? up++ : down++;
      last = r;
    }
    if (down > up || (up === 0 && down === 0 && rank.size > 0 && seq.dir !== refDir)) {
      stops = [...stops].reverse();
    }
    // Provisional ranks for newly met stations, next to their neighbours.
    stops.forEach((s, i) => {
      if (rank.has(s)) return;
      const before = i > 0 ? rank.get(stops[i - 1]) : undefined;
      if (before !== undefined) rank.set(s, before + 0.001);
      else {
        const next = stops.slice(i + 1).find((x) => rank.has(x));
        rank.set(s, next !== undefined ? rank.get(next)! - 0.001 * (stops.indexOf(next) - i) : rank.size ? -1 : i);
      }
    });
    oriented.push({ stops, weight: seq.weight });
  }
  // Links from the busiest runs first. A rare run (depot moves, service
  // tracks) only contributes the stations nobody else serves, so that it
  // cannot reroute the diagram.
  oriented.sort((a, b) => b.weight - a.weight);
  for (const { stops, weight } of oriented) {
    const rare = weight < total * 0.03;
    for (let i = 0; i + 1 < stops.length; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (rare && succ.has(a) && succ.has(b)) continue;
      touch(a);
      touch(b);
      if (succ.get(a)!.has(b) || reaches(b, a)) continue; // keep it acyclic
      succ.get(a)!.add(b);
      pred.get(b)!.add(a);
    }
  }
  // Drop shortcuts (a run skipping stations another run serves).
  for (const a of nodes) {
    for (const b of [...succ.get(a)!]) {
      if (reaches(a, b, [a, b])) {
        succ.get(a)!.delete(b);
        pred.get(b)!.delete(a);
      }
    }
  }

  // Longest path among `pool`, repeatedly: main trunk first, then branches.
  const longest = (pool: Set<number>): number[] => {
    const depth = new Map<number, number>();
    const next = new Map<number, number | undefined>();
    const visit = (n: number): number => {
      const known = depth.get(n);
      if (known !== undefined) return known;
      let best = 0;
      let via: number | undefined;
      for (const m of succ.get(n)!) {
        if (!pool.has(m)) continue;
        const d = visit(m);
        if (d > best) {
          best = d;
          via = m;
        }
      }
      depth.set(n, best + 1);
      next.set(n, via);
      return best + 1;
    };
    let start: number | undefined;
    let best = 0;
    for (const n of pool) {
      const d = visit(n);
      if (d > best) {
        best = d;
        start = n;
      }
    }
    const path: number[] = [];
    for (let n = start; n !== undefined; n = next.get(n)) path.push(n);
    return path;
  };

  const placed = new Map<number, { row: number; lane: number }>();
  const remaining = new Set(nodes);
  const laneSpans: [number, number][][] = [];
  let first = true;
  while (remaining.size) {
    const chain = longest(remaining);
    let rows: number[];
    if (first) {
      rows = chain.map((_, i) => i);
    } else {
      const above = [...pred.get(chain[0])!].map((n) => placed.get(n)).filter((x) => x !== undefined);
      const below = [...succ.get(chain[chain.length - 1])!].map((n) => placed.get(n)).filter((x) => x !== undefined);
      const top = above.length ? Math.max(...above.map((x) => x.row)) : undefined;
      const bottom = below.length ? Math.min(...below.map((x) => x.row)) : undefined;
      if (top !== undefined && bottom !== undefined && bottom > top) {
        rows = chain.map((_, i) => top + ((i + 1) * (bottom - top)) / (chain.length + 1));
      } else if (top !== undefined) {
        rows = chain.map((_, i) => top + 1 + i);
      } else if (bottom !== undefined) {
        rows = chain.map((_, i) => bottom - chain.length + i);
      } else {
        const max = Math.max(0, ...[...placed.values()].map((x) => x.row));
        rows = chain.map((_, i) => max + 1 + i);
      }
    }
    const span: [number, number] = [rows[0] - 0.6, rows[rows.length - 1] + 0.6];
    let lane = first ? 0 : 1;
    while (laneSpans[lane]?.some(([a, b]) => span[0] < b && span[1] > a)) lane++;
    (laneSpans[lane] ??= []).push(span);
    chain.forEach((n, i) => {
      placed.set(n, { row: rows[i], lane });
      remaining.delete(n);
    });
    first = false;
  }

  const minRow = Math.min(0, ...[...placed.values()].map((x) => x.row));
  const maxRow = Math.max(0, ...[...placed.values()].map((x) => x.row));
  const lanes = laneSpans.length || 1;
  const pos = new Map<number, Node>();
  for (const [n, { row, lane }] of placed) {
    pos.set(n, { x: X0 + lane * LANE, y: PAD_TOP + (row - minRow) * ROW, lane, row });
  }
  const edges: [number, number][] = [];
  for (const a of nodes) for (const b of succ.get(a)!) edges.push([a, b]);
  return {
    pos,
    edges,
    width: Math.max(WIDTH, X0 + lanes * LANE),
    height: PAD_TOP + (maxRow - minRow) * ROW + PAD_BOTTOM,
    tops: nodes.filter((n) => pred.get(n)!.size === 0),
    bottoms: nodes.filter((n) => succ.get(n)!.size === 0),
  };
}

/** Point and heading (degrees, 0 = downwards) at fraction f of the link a -> b. */
function along(a: Node, b: Node, f: number): { x: number; y: number; angle: number } {
  if (a.x === b.x) {
    return { x: a.x, y: a.y + (b.y - a.y) * f, angle: b.y >= a.y ? 0 : 180 };
  }
  // Same S-curve as the drawn connector.
  const my = (a.y + b.y) / 2;
  const u = 1 - f;
  const x = u * u * u * a.x + 3 * u * u * f * a.x + 3 * u * f * f * b.x + f * f * f * b.x;
  const y = u * u * u * a.y + 3 * u * u * f * my + 3 * u * f * f * my + f * f * f * b.y;
  const dx = 6 * u * f * (b.x - a.x);
  const dy = 3 * u * u * (my - a.y) + 3 * f * f * (b.y - my);
  return { x, y, angle: (Math.atan2(-dx, dy) * 180) / Math.PI };
}

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

export class LineView {
  line: number | null = null;
  private layout: LineLayout | null = null;
  private layouts = new Map<number, LineLayout>();
  private trainLayer: SVGGElement | null = null;
  private glyphs = new Map<string, SVGGElement>();
  private counts = "";

  constructor(
    private root: HTMLElement,
    private network: Network,
    private timetable: Timetable,
    private badge: (line: number) => string,
  ) {}

  show(line: number): void {
    if (this.line === line) return;
    this.line = line;
    let layout = this.layouts.get(line);
    if (!layout) this.layouts.set(line, (layout = layoutLine(line, this.timetable)));
    this.layout = layout;
    this.glyphs.clear();
    this.counts = "";

    const { stations, lines } = this.network;
    const color = lines[line].color;
    const svg = el("svg", {
      class: "lv-svg",
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: layout.width,
      height: layout.height,
      role: "img",
      "aria-label": lines[line].name,
    });
    svg.style.setProperty("--c", color);

    const track = el("g", { class: "lv-track" });
    for (const [a, b] of layout.edges) {
      const p = layout.pos.get(a)!;
      const q = layout.pos.get(b)!;
      const my = (p.y + q.y) / 2;
      const d = p.x === q.x ? `M${p.x} ${p.y}L${q.x} ${q.y}` : `M${p.x} ${p.y}C${p.x} ${my} ${q.x} ${my} ${q.x} ${q.y}`;
      track.append(el("path", { d }));
    }
    svg.append(track);

    // A label is squeezed when another lane runs to its right on the same rows.
    const byLane = new Map<number, Node[]>();
    for (const n of layout.pos.values()) {
      let list = byLane.get(n.lane);
      if (!list) byLane.set(n.lane, (list = []));
      list.push(n);
    }
    const lanes = byLane.size;
    const squeezed = (n: Node) => {
      for (const [lane, list] of byLane) {
        if (lane > n.lane && list.some((m) => Math.abs(m.row - n.row) < 1.5)) return true;
      }
      return false;
    };

    const stops = el("g", { class: "lv-stops" });
    for (const [s, n] of layout.pos) {
      const hub = stations[s].lines.length > 1;
      stops.append(el("circle", { cx: n.x, cy: n.y, r: hub ? 5.5 : 4, class: hub ? "hub" : "" }));
      const full = stations[s].name;
      const max = lanes > 1 && (squeezed(n) || n.lane === lanes - 1) ? CHARS_NARROW : CHARS_WIDE;
      const label = el("text", { x: n.x + LABEL_DX, y: n.y + 4, "data-station": s, tabindex: 0, role: "button" });
      label.textContent = full.length > max ? `${full.slice(0, max - 1).trimEnd()}…` : full;
      const title = el("title");
      title.textContent = full;
      label.append(title);
      stops.append(label);
    }
    svg.append(stops);

    this.trainLayer = el("g", { class: "lv-trains" });
    svg.append(this.trainLayer);

    const name = (list: number[]) => list.map((s) => stations[s].name).join(" / ");
    this.root.innerHTML = `
      <header>${this.badge(line)}<h2>${lines[line].name}</h2></header>
      <div class="lv-dirs">
        <span><b class="lv-arrow">↓</b> ${name(layout.bottoms)} <b id="lv-down" class="num"></b></span>
        <span><b class="lv-arrow">↑</b> ${name(layout.tops)} <b id="lv-up" class="num"></b></span>
      </div>
      <div class="scroll lv-scroll"></div>`;
    this.root.querySelector(".lv-scroll")!.append(svg);
  }

  /** Moves the train glyphs; cheap enough to call on every map refresh. */
  update(trains: LineTrain[], selected: string | null): void {
    const layout = this.layout;
    const layer = this.trainLayer;
    if (!layout || !layer) return;
    const alive = new Set<string>();
    let down = 0;
    let up = 0;
    for (const t of trains) {
      const stops = t.pattern.stops;
      const a = layout.pos.get(stops[t.stop]);
      const b = layout.pos.get(stops[Math.min(t.stop + 1, stops.length - 1)]) ?? a;
      const from = layout.pos.get(stops[0]);
      const to = layout.pos.get(stops[stops.length - 1]);
      if (!a || !b || !from || !to) continue;
      const goesDown = to.y >= from.y;
      goesDown ? down++ : up++;
      const p = along(a, b, t.dwelling ? 0 : t.frac);
      const angle = a === b || t.dwelling ? (goesDown ? 0 : 180) : p.angle;
      const x = p.x + (goesDown ? -SIDE : SIDE);

      let g = this.glyphs.get(t.id);
      if (!g) {
        g = el("g", { class: "lv-train", "data-trip": t.id, tabindex: 0, role: "button" });
        g.append(el("rect", { x: -10, y: -12, width: 20, height: 24, class: "lv-hit" }));
        g.append(el("path", { d: "M-4.2 -8.5H4.2V4L0 9.5L-4.2 4Z" }));
        layer.append(g);
        this.glyphs.set(t.id, g);
      }
      g.setAttribute("transform", `translate(${x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${angle.toFixed(0)})`);
      g.classList.toggle("est", t.est);
      g.classList.toggle("sel", t.id === selected);
      alive.add(t.id);
    }
    for (const [id, g] of this.glyphs) {
      if (alive.has(id)) continue;
      g.remove();
      this.glyphs.delete(id);
    }
    const counts = `${down}|${up}`;
    if (counts !== this.counts) {
      this.counts = counts;
      this.root.querySelector("#lv-down")!.textContent = String(down);
      this.root.querySelector("#lv-up")!.textContent = String(up);
    }
  }

  hide(): void {
    this.line = null;
    this.layout = null;
    this.trainLayer = null;
    this.glyphs.clear();
    this.root.innerHTML = "";
  }
}
