export interface Line {
  id: string;
  /** IDFM route id without prefix, as in SIRI LineRef (e.g. "C01371"). */
  ref: string;
  name: string;
  color: string;
  text: string;
}

export interface Shape {
  line: number;
  coords: [number, number][];
}

export interface Station {
  id: string;
  name: string;
  lon: number;
  lat: number;
  lines: number[];
}

export interface Network {
  lines: Line[];
  shapes: Shape[];
  stations: Station[];
  /** Numeric SIRI stop code (platform or stop area) -> station index. */
  stopRefs: Record<string, number>;
  /** Station entrances: lon, lat, station index, name (street or place). */
  entrances: [number, number, number, string][];
}

/** A sequence of stops shared by many trips; times are offsets from the first departure. */
export interface Pattern {
  line: number;
  shape: number;
  headsign: string;
  dir: number;
  stops: number[];
  /** Distance along the shape of each stop, in metres. */
  dist: number[];
  arr: number[];
  dep: number[];
}

export interface Timetable {
  generated: string;
  source: string;
  patterns: Pattern[];
  /** Per service: flat [patternIndex, startSeconds, patternIndex, startSeconds, ...]. */
  services: number[][];
  /** YYYYMMDD -> active service indices. */
  days: Record<string, number[]>;
}

/** One scheduled run on the displayed calendar day; times in seconds since that day's midnight. */
export interface Trip {
  id: string;
  pattern: number;
  start: number;
  end: number;
}
