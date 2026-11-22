#!/usr/bin/env python3
"""Extract the Paris metro network and timetable from the IDFM GTFS feed.

Usage:
    python3 scripts/build_data.py [--gtfs IDFM-gtfs.zip] [--out public/data]

Without --gtfs, the feed is downloaded from the Île-de-France Mobilités open
data portal. Only the standard library is used.

Outputs (JSON, compact):
    network.json    lines, track geometry (shapes) and stations
    timetable.json  trip patterns, trips per service and the services active
                    on each date of the feed's validity window
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import tempfile
import time
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

GTFS_URL = "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip"
METRO_ROUTE_TYPE = "1"

# Local equirectangular projection around Paris. The frontend uses the same
# constants (src/geo.ts) so that distances along shapes match exactly.
LAT0 = 48.86
M_PER_DEG_LAT = 110_540.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

LINE_ORDER = ["1", "2", "3", "3B", "4", "5", "6", "7", "7B", "8", "9", "10", "11", "12", "13", "14"]


def log(msg: str) -> None:
    print(f"[build_data] {msg}", file=sys.stderr, flush=True)


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))


def parse_time(value: str) -> int:
    h, m, s = value.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def xy(lon: float, lat: float) -> tuple[float, float]:
    return lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT


def project_on_segment(p, a, b):
    """Return (squared distance, t in [0,1]) of point p projected on segment ab."""
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    seg2 = dx * dx + dy * dy
    t = 0.0 if seg2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg2))
    qx, qy = ax + t * dx, ay + t * dy
    return (px - qx) ** 2 + (py - qy) ** 2, t


def stop_distances(shape_xy, shape_cum, stops_xy):
    """Distance along the shape of each stop, monotonic in stop order.

    Dynamic programming over (stop, segment) minimises the total projection
    error while keeping stops in order, which handles loops (lines 7B, 10)
    where a greedy nearest-segment search would jump ahead.
    """
    nseg = len(shape_xy) - 1
    if nseg < 1:
        return [0.0] * len(stops_xy)
    proj = []
    for p in stops_xy:
        row = [project_on_segment(p, shape_xy[j], shape_xy[j + 1]) for j in range(nseg)]
        proj.append(row)

    inf = float("inf")
    cost_prev = [proj[0][j][0] for j in range(nseg)]
    back = []
    for i in range(1, len(stops_xy)):
        best, best_j = inf, 0
        cost = [0.0] * nseg
        arg = [0] * nseg
        for j in range(nseg):
            if cost_prev[j] < best:
                best, best_j = cost_prev[j], j
            cost[j] = best + proj[i][j][0]
            arg[j] = best_j
        back.append(arg)
        cost_prev = cost

    j = min(range(nseg), key=lambda k: cost_prev[k])
    chosen = [0] * len(stops_xy)
    chosen[-1] = j
    for i in range(len(stops_xy) - 1, 0, -1):
        j = back[i - 1][j]
        chosen[i - 1] = j

    out = []
    for i, j in enumerate(chosen):
        t = proj[i][j][1]
        out.append(shape_cum[j] + t * (shape_cum[j + 1] - shape_cum[j]))
    for i in range(1, len(out)):  # same-segment ordering guard
        out[i] = max(out[i], out[i - 1])
    return out


def simplify(points, tolerance):
    """Douglas-Peucker on projected coordinates; returns kept indices."""
    if len(points) < 3:
        return list(range(len(points)))
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    tol2 = tolerance * tolerance
    while stack:
        a, b = stack.pop()
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            d2, _ = project_on_segment(points[i], points[a], points[b])
            if d2 > best:
                best, idx = d2, i
        if best > tol2:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [i for i, k in enumerate(keep) if k]


def download(dest: Path) -> Path:
    log(f"downloading {GTFS_URL}")
    req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "paris-metro-map-data-builder"})
    with urllib.request.urlopen(req, timeout=600) as resp, open(dest, "wb") as fh:
        while chunk := resp.read(1 << 20):
            fh.write(chunk)
    log(f"downloaded {dest.stat().st_size / 1e6:.1f} MB")
    return dest


def build(gtfs_path: Path, out_dir: Path) -> None:
    started = time.time()
    zf = zipfile.ZipFile(gtfs_path)

    # Routes ---------------------------------------------------------------
    routes = {}
    for r in read_csv(zf, "routes.txt"):
        if r["route_type"] == METRO_ROUTE_TYPE:
            routes[r["route_id"]] = r
    names = sorted(
        {r["route_short_name"] for r in routes.values()},
        key=lambda n: LINE_ORDER.index(n) if n in LINE_ORDER else 99,
    )
    line_index = {n: i for i, n in enumerate(names)}
    lines = []
    for n in names:
        r = next(r for r in routes.values() if r["route_short_name"] == n)
        lines.append({
            "id": n,
            # SIRI LineRef is "STIF:Line::<ref>:"
            "ref": r["route_id"].split(":", 1)[-1],
            "name": f"Métro {n.replace('B', 'bis')}",
            "color": "#" + (r["route_color"] or "888888"),
            "text": "#" + (r["route_text_color"] or "FFFFFF"),
        })
    log(f"{len(lines)} metro lines: {', '.join(names)}")

    # Trips ----------------------------------------------------------------
    trips = {}
    for t in read_csv(zf, "trips.txt"):
        if t["route_id"] in routes:
            trips[t["trip_id"]] = t
    log(f"{len(trips)} metro trips")

    # Stop times (large file: streamed) -----------------------------------
    stop_times = defaultdict(list)
    for st in read_csv(zf, "stop_times.txt"):
        tid = st["trip_id"]
        if tid in trips:
            stop_times[tid].append((
                int(st["stop_sequence"]),
                st["stop_id"],
                parse_time(st["arrival_time"]),
                parse_time(st["departure_time"]),
            ))
    log(f"stop_times loaded ({time.time() - started:.0f}s)")

    # Stops -> stations (grouped by parent_station) ------------------------
    used_stops = {s[1] for v in stop_times.values() for s in v}
    stops = {}
    parents_needed = set()
    for s in read_csv(zf, "stops.txt"):
        if s["stop_id"] in used_stops:
            stops[s["stop_id"]] = s
            if s["parent_station"]:
                parents_needed.add(s["parent_station"])
    parents = {}
    if parents_needed:
        for s in read_csv(zf, "stops.txt"):
            if s["stop_id"] in parents_needed:
                parents[s["stop_id"]] = s

    station_index: dict[str, int] = {}
    stations = []

    def station_of(stop_id: str) -> int:
        s = stops[stop_id]
        key = s["parent_station"] or stop_id
        if key not in station_index:
            src = parents.get(key, s)
            station_index[key] = len(stations)
            stations.append({
                "id": key,
                "name": src["stop_name"] or s["stop_name"],
                "lon": round(float(src["stop_lon"] or s["stop_lon"]), 6),
                "lat": round(float(src["stop_lat"] or s["stop_lat"]), 6),
                "lines": set(),
            })
        return station_index[key]

    # Shapes ---------------------------------------------------------------
    shape_ids = {t["shape_id"] for t in trips.values()}
    raw_shapes = defaultdict(list)
    for p in read_csv(zf, "shapes.txt"):
        if p["shape_id"] in shape_ids:
            raw_shapes[p["shape_id"]].append(
                (int(p["shape_pt_sequence"]), float(p["shape_pt_lon"]), float(p["shape_pt_lat"]))
            )
    shape_line = {}
    for t in trips.values():
        shape_line[t["shape_id"]] = line_index[routes[t["route_id"]]["route_short_name"]]

    shape_index: dict[str, int] = {}
    shapes_out = []
    shapes_xy = []
    shapes_cum = []
    for sid in sorted(raw_shapes):
        pts = sorted(raw_shapes[sid])
        coords = [(round(lon, 5), round(lat, 5)) for _, lon, lat in pts]
        dedup = [coords[0]] + [c for prev, c in zip(coords, coords[1:]) if c != prev]
        proj = [xy(lon, lat) for lon, lat in dedup]
        kept = simplify(proj, 1.5)
        dedup = [dedup[i] for i in kept]
        proj = [proj[i] for i in kept]
        cum = [0.0]
        for a, b in zip(proj, proj[1:]):
            cum.append(cum[-1] + math.dist(a, b))
        shape_index[sid] = len(shapes_out)
        shapes_out.append({"line": shape_line[sid], "coords": [list(c) for c in dedup]})
        shapes_xy.append(proj)
        shapes_cum.append(cum)
    log(f"{len(shapes_out)} shapes, {sum(len(s['coords']) for s in shapes_out)} points")

    # Patterns -------------------------------------------------------------
    pattern_index: dict[tuple, int] = {}
    patterns = []
    dist_cache: dict[tuple, list[int]] = {}
    services: dict[str, list[tuple[int, int]]] = defaultdict(list)
    skipped = 0

    for tid, t in trips.items():
        sts = sorted(stop_times.get(tid, []))
        if len(sts) < 2:
            skipped += 1
            continue
        line = line_index[routes[t["route_id"]]["route_short_name"]]
        shp = shape_index[t["shape_id"]]
        st_idx = tuple(station_of(s[1]) for s in sts)
        for si in st_idx:
            stations[si]["lines"].add(line)
        start = sts[0][3]
        arr = tuple(s[2] - start for s in sts)
        dep = tuple(s[3] - start for s in sts)
        key = (line, shp, t["trip_headsign"], int(t["direction_id"] or 0), st_idx, arr, dep)
        pid = pattern_index.get(key)
        if pid is None:
            dkey = (shp, tuple(s[1] for s in sts))
            dists = dist_cache.get(dkey)
            if dists is None:
                stops_xy = [xy(float(stops[s[1]]["stop_lon"]), float(stops[s[1]]["stop_lat"])) for s in sts]
                dists = [round(d) for d in stop_distances(shapes_xy[shp], shapes_cum[shp], stops_xy)]
                dist_cache[dkey] = dists
            pid = len(patterns)
            pattern_index[key] = pid
            patterns.append({
                "line": line,
                "shape": shp,
                "headsign": t["trip_headsign"],
                "dir": int(t["direction_id"] or 0),
                "stops": list(st_idx),
                "dist": dists,
                "arr": list(arr),
                "dep": list(dep),
            })
        services[t["service_id"]].append((pid, start))
    log(f"{len(patterns)} patterns, {skipped} trips skipped (fewer than 2 stops)")

    # Calendar -------------------------------------------------------------
    service_ids = sorted(services)
    service_pos = {s: i for i, s in enumerate(service_ids)}
    active: dict[str, set[int]] = defaultdict(set)
    weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    for c in read_csv(zf, "calendar.txt"):
        if c["service_id"] not in service_pos:
            continue
        d = dt.datetime.strptime(c["start_date"], "%Y%m%d").date()
        end = dt.datetime.strptime(c["end_date"], "%Y%m%d").date()
        while d <= end:
            if c[weekdays[d.weekday()]] == "1":
                active[d.strftime("%Y%m%d")].add(service_pos[c["service_id"]])
            d += dt.timedelta(days=1)
    for c in read_csv(zf, "calendar_dates.txt"):
        if c["service_id"] not in service_pos:
            continue
        if c["exception_type"] == "1":
            active[c["date"]].add(service_pos[c["service_id"]])
        elif c["exception_type"] == "2":
            active[c["date"]].discard(service_pos[c["service_id"]])
    days = {d: sorted(v) for d, v in sorted(active.items()) if v}

    # Output ---------------------------------------------------------------
    for s in stations:
        s["lines"] = sorted(s["lines"])
    # SIRI StopPointRef "STIF:StopPoint:Q:<code>:" uses the numeric part of the
    # GTFS platform id; StopAreaRef uses the parent station's.
    stop_refs = {}
    for stop_id, s in stops.items():
        idx = station_index.get(s["parent_station"] or stop_id)
        if idx is None:
            continue
        stop_refs[stop_id.split(":")[-1]] = idx
        if s["parent_station"]:
            stop_refs.setdefault(s["parent_station"].split(":")[-1], idx)
    network = {"lines": lines, "shapes": shapes_out, "stations": stations, "stopRefs": stop_refs}
    timetable = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": GTFS_URL,
        "patterns": patterns,
        "services": [
            [x for pid, start in sorted(services[s], key=lambda p: p[1]) for x in (pid, start)]
            for s in service_ids
        ],
        "days": days,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, obj in (("network.json", network), ("timetable.json", timetable)):
        path = out_dir / name
        path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB)")
    first, last = (min(days), max(days)) if days else ("-", "-")
    log(f"{len(stations)} stations, {len(days)} days ({first} → {last}), done in {time.time() - started:.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gtfs", type=Path, help="local IDFM GTFS zip (downloaded when omitted)")
    ap.add_argument("--out", type=Path, default=Path("public/data"))
    args = ap.parse_args()
    if args.gtfs:
        build(args.gtfs, args.out)
    else:
        with tempfile.TemporaryDirectory() as tmp:
            build(download(Path(tmp) / "IDFM-gtfs.zip"), args.out)


if __name__ == "__main__":
    main()
