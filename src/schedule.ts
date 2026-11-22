import type { Network, Pattern, Timetable, Trip } from "./types";

export const DAY = 86_400;

export interface TrainState {
  trip: Trip;
  pattern: Pattern;
  /** Distance along the shape, metres. */
  dist: number;
  /** Index of the last stop reached. */
  stop: number;
  /** True while dwelling at `stop`. */
  dwelling: boolean;
}

export interface StationEvent {
  trip: Trip;
  pattern: Pattern;
  arr: number;
  dep: number;
  /** First stop of the run (departure only) or terminus (arrival only). */
  origin: boolean;
  terminus: boolean;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + days));
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

/** Accelerate out of a station and brake into the next one; monotonic on [0, 1]. */
function ease(f: number): number {
  return f - Math.sin(2 * Math.PI * f) / (2 * Math.PI);
}

export class Schedule {
  readonly dates: string[];
  private byStation = new Map<number, { pattern: number; index: number }[]>();
  private date = "";
  private trips: Trip[] = [];
  private tripsByPattern = new Map<number, Trip[]>();

  constructor(
    readonly network: Network,
    readonly timetable: Timetable,
  ) {
    this.dates = Object.keys(timetable.days).sort();
    timetable.patterns.forEach((p, pi) => {
      p.stops.forEach((s, index) => {
        let list = this.byStation.get(s);
        if (!list) this.byStation.set(s, (list = []));
        list.push({ pattern: pi, index });
      });
    });
  }

  /** Runs touching calendar day `date`: its own services plus after-midnight runs of the previous day. */
  tripsFor(date: string): Trip[] {
    if (date === this.date) return this.trips;
    const trips: Trip[] = [];
    const add = (day: string, offset: number) => {
      for (const s of this.timetable.days[day] ?? []) {
        const flat = this.timetable.services[s];
        for (let i = 0; i < flat.length; i += 2) {
          const pattern = flat[i];
          const p = this.timetable.patterns[pattern];
          const start = flat[i + 1] + offset;
          const end = start + p.arr[p.arr.length - 1];
          if (end < 0) continue;
          trips.push({ id: `${day}:${s}:${i}`, pattern, start, end });
        }
      }
    };
    add(shiftDate(date, -1), -DAY);
    add(date, 0);
    trips.sort((a, b) => a.start - b.start);
    this.date = date;
    this.trips = trips;
    this.tripsByPattern = new Map();
    for (const t of trips) {
      let list = this.tripsByPattern.get(t.pattern);
      if (!list) this.tripsByPattern.set(t.pattern, (list = []));
      list.push(t);
    }
    return trips;
  }

  state(trip: Trip, t: number): TrainState | null {
    if (t < trip.start || t > trip.end) return null;
    const pattern = this.timetable.patterns[trip.pattern];
    const tau = t - trip.start;
    const { arr, dep, dist } = pattern;
    let k = 0;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= tau) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (tau <= dep[k] || k === arr.length - 1) {
      return { trip, pattern, dist: dist[k], stop: k, dwelling: true };
    }
    const span = arr[k + 1] - dep[k];
    const f = span > 0 ? ease((tau - dep[k]) / span) : 1;
    return { trip, pattern, dist: dist[k] + (dist[k + 1] - dist[k]) * f, stop: k, dwelling: false };
  }

  active(t: number): TrainState[] {
    const out: TrainState[] = [];
    for (const trip of this.trips) {
      if (trip.start > t) break;
      const s = this.state(trip, t);
      if (s) out.push(s);
    }
    return out;
  }

  findTrip(id: string): Trip | undefined {
    return this.trips.find((t) => t.id === id);
  }

  /** Next arrivals/departures at a station from time `t`, soonest first. */
  board(station: number, t: number, limit = 14): StationEvent[] {
    const events: StationEvent[] = [];
    for (const { pattern, index } of this.byStation.get(station) ?? []) {
      const p = this.timetable.patterns[pattern];
      for (const trip of this.tripsByPattern.get(pattern) ?? []) {
        const arr = trip.start + p.arr[index];
        const dep = trip.start + p.dep[index];
        if (dep < t) continue;
        events.push({ trip, pattern: p, arr, dep, origin: index === 0, terminus: index === p.stops.length - 1 });
      }
    }
    events.sort((a, b) => a.arr - b.arr);
    return events.slice(0, limit);
  }
}
