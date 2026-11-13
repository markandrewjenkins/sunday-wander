"""Sunday Wander: score every road and path for a relaxed outing, and rate a set of classic routes.

  python -m pipelines.sunday.build [region ...]

Per road segment (edge) the build measures, on a 0–100 scale:
  water    actual water views: line of sight over the Copernicus 30 m surface model (buildings and trees block it) to
           the sea or a lake or river larger than 2 ha, in 24 directions up to 2 km
  shore    next to the water (100 within 20 m, 0 beyond 250 m), ponds and wetlands excluded
  green    share of parks, forest and nature reserves within ~60 m
  farm     share of farmland, orchards and meadows within ~100 m
  trees    street trees within 20 m (city inventories), per 100 m of road
  sights   viewpoints, heritage places, landmarks, lighthouses and attractions within 120 m
  stops    ice cream, cafés, bakeries, farm stands, picnic sites, beaches and washrooms within 100 m
  road     "slower and wider": posted speed of 50 km/h or less on a two-lane road scores best
  flow     few traffic signals or stop signs per kilometre
  curve    gentle bends (how much longer the road is than a straight line)
  infra    cycle-friendliness (bike lanes, paths, quiet streets), for bikes
  quiet    walk-friendliness (paths and quiet streets), for walking
  busy     industrial land within ~80 m (counts against)
The page combines them with weights the viewer can change; DEFAULT_WEIGHTS below are the starting point and are
also used here to rate the preset routes.
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw
from scipy import ndimage
from sklearn.neighbors import KDTree

from pipelines.common import dem
from pipelines.common import roadgraph as rg

from .config import OUT, RAW, REGIONS
from .routes import ROUTES

RES = 15.0   # raster cell size, m
DEM_DIR = RAW.parents[1] / "dem"     # Copernicus GLO-30 tiles, shared
FEATURES = ["water", "shore", "green", "farm", "trees", "sights", "stops", "road", "flow", "curve", "infra", "quiet", "busy"]
DEFAULT_WEIGHTS = {
    "car": {"water": 3, "green": 2, "farm": 1.5, "trees": 1.5, "sights": 1.5, "stops": 1, "road": 2, "flow": 1, "curve": 1, "busy": -2},
    "bike": {"water": 2.5, "shore": 0.5, "green": 2, "farm": 1, "trees": 1.5, "sights": 1, "stops": 1, "infra": 3, "flow": 0.5, "busy": -1.5},
    "foot": {"water": 2.5, "shore": 1, "green": 2.5, "trees": 2, "sights": 2, "stops": 1.5, "quiet": 2.5, "busy": -1.5},
}
STOP_KINDS = {  # kind: (label, icon, weight as a stop, weight as a sight)
    "ice_cream": ("Ice cream", "🍦", 2.0, 0), "cafe": ("Café", "☕", 1.0, 0), "bakery": ("Bakery", "🥐", 1.0, 0),
    "farm": ("Farm stand", "🧺", 1.5, 0.5), "chocolate": ("Sweets", "🍫", 1.0, 0), "picnic_site": ("Picnic site", "🧺", 1.0, 0),
    "beach": ("Beach", "🏖️", 1.5, 1.0), "toilets": ("Washroom", "🚻", 0.5, 0), "viewpoint": ("Viewpoint", "📷", 1.0, 2.0),
    "lighthouse": ("Lighthouse", "🗼", 0.5, 2.0), "pier": ("Pier", "⚓", 0.5, 1.0), "museum": ("Museum", "🏛️", 0.3, 1.5),
    "attraction": ("Attraction", "⭐", 0.3, 1.5), "artwork": ("Public art", "🎨", 0, 0.5), "gallery": ("Gallery", "🖼️", 0.3, 0.8),
    "historic": ("Historic site", "🏛️", 0, 1.0), "rest_area": ("Rest area", "🅿️", 1.0, 0),
}


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, np.ndarray):
        return clean(o.tolist())
    if isinstance(o, (float, np.floating)):
        return None if not np.isfinite(o) else round(float(o), 4)
    if isinstance(o, np.integer):
        return int(o)
    return o


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(clean(obj), separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  wrote {path.relative_to(OUT)} ({path.stat().st_size / 1024:,.0f} KB)", flush=True)


# ============================================================================= rasters

class Raster:
    def __init__(self, G):
        s, w, n, e = G["bbox"]
        self.G = G
        x0, y0 = rg.project(G, w, s); x1, y1 = rg.project(G, e, n)
        self.x0, self.y1 = float(x0), float(y1)
        self.W, self.H = int((x1 - x0) / RES) + 1, int((y1 - y0) / RES) + 1

    def px(self, lon, lat):
        x, y = rg.project(self.G, np.asarray(lon), np.asarray(lat))
        return (x - self.x0) / RES, (self.y1 - y) / RES

    def blank(self):
        return Image.new("L", (self.W, self.H), 0)

    def at(self, arr, x, y):
        c = np.clip(((x - self.x0) / RES).astype(int), 0, self.W - 1)
        r = np.clip(((self.y1 - y) / RES).astype(int), 0, self.H - 1)
        return arr[r, c]


def _rings(el):
    """Outer rings (lists of (lon, lat)) of an Overpass `out geom` way or multipolygon relation."""
    if el["type"] == "way" and "geometry" in el:
        return [[(p["lon"], p["lat"]) for p in el["geometry"]]]
    if el["type"] == "relation":
        return [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in el.get("members", [])
                if m.get("role") in ("outer", "") and m.get("geometry")]
    return []


def scenery_rasters(R: Raster, elements):
    big_water = []
    layers = {k: R.blank() for k in ("water", "green", "farm", "busy")}
    draw = {k: ImageDraw.Draw(v) for k, v in layers.items()}
    for el in elements:
        t = el.get("tags", {})
        nat, lu, lei, ww = t.get("natural"), t.get("landuse"), t.get("leisure"), t.get("waterway")
        small = t.get("water") in ("pond", "basin", "wastewater", "reflecting_pool", "stormwater", "fountain")
        if (nat == "water" and not small) or ww == "riverbank":
            for ring in _rings(el):
                if len(ring) > 3:
                    big_water.append(ring)
        k = ("water" if (nat in ("water", "coastline", "beach") and not small) or ww in ("river", "riverbank") else
             "green" if nat in ("wood", "scrub", "heath", "grassland", "cliff") or lu in ("forest", "cemetery", "recreation_ground", "allotments")
             or lei in ("park", "nature_reserve", "garden", "golf_course") or t.get("boundary") in ("protected_area", "national_park") else
             "farm" if lu in ("farmland", "orchard", "vineyard", "meadow") else
             "busy" if lu in ("industrial", "railway") else None)
        if not k:
            continue
        for ring in _rings(el):
            if len(ring) < 2:
                continue
            xs, ys = R.px([p[0] for p in ring], [p[1] for p in ring])
            pts = list(zip(xs.tolist(), ys.tolist()))
            closed = ring[0] == ring[-1] and len(ring) > 3
            if nat == "coastline" or ww == "river" or not closed:
                draw[k].line(pts, fill=1, width=3)
            else:
                draw[k].polygon(pts, fill=1)
    arr = {k: np.asarray(v, dtype=np.uint8) for k, v in layers.items()}
    dist_water = ndimage.distance_transform_edt(arr["water"] == 0) * RES
    frac = lambda a, m: ndimage.uniform_filter(a.astype(np.float32), size=max(3, int(2 * m / RES) | 1))
    return {"water_d": dist_water, "green": frac(arr["green"], 60), "farm": frac(arr["farm"], 100), "busy": frac(arr["busy"], 80),
            "big_water": big_water}


def view_mask(G, big_water):
    """Surface heights and an open-water mask on the Copernicus 30 m grid: the sea (flattened to exactly 0 m in
    the model) plus lakes and rivers from OpenStreetMap larger than 2 ha. Ponds and wetlands don't count."""
    z, (lon0, lat0), (dlon, dlat) = dem.mosaic(G["bbox"], DEM_DIR, margin=0.03)
    lab, n = ndimage.label(z == 0.0)
    sizes = np.bincount(lab.ravel())
    sea = (lab > 0) & (sizes[lab] >= 20000)
    img = Image.new("L", (z.shape[1], z.shape[0]), 0)
    dr = ImageDraw.Draw(img)
    kx = 111320 * math.cos(math.radians((G["bbox"][0] + G["bbox"][2]) / 2))
    for ring in big_water:
        xs = [(p[0] - lon0) / dlon for p in ring]; ys = [(lat0 - p[1]) / dlat for p in ring]
        area = 0.5 * abs(sum(xs[i] * ys[i + 1] - xs[i + 1] * ys[i] for i in range(len(xs) - 1))) * dlon * kx * dlat * 110540
        if area >= 20000:
            dr.polygon(list(zip(xs, ys)), fill=1)
    water = sea | (np.asarray(img, dtype=np.uint8) > 0)
    return z, water, (lon0, lat0), (dlon, dlat), (dlon * kx, dlat * 110540)


# ============================================================================= points

def load_points(key):
    st = json.loads((RAW / key / "stops.json").read_text(encoding="utf-8"))["elements"]
    stops, signals = [], set()
    for el in st:
        t = el.get("tags", {})
        if el["type"] == "node" and t.get("highway") in ("traffic_signals", "stop"):
            signals.add(el["id"])
            continue
        kind = (t.get("amenity") if t.get("amenity") in STOP_KINDS else t.get("shop") if t.get("shop") in ("ice_cream", "bakery", "farm", "chocolate") else
                "chocolate" if t.get("shop") == "confectionery" else t.get("tourism") if t.get("tourism") in STOP_KINDS else
                "beach" if t.get("natural") == "beach" else t.get("man_made") if t.get("man_made") in ("lighthouse", "pier") else
                "rest_area" if t.get("highway") == "rest_area" else "historic" if t.get("historic") or t.get("heritage") else None)
        if t.get("cuisine", "").find("ice_cream") >= 0 and kind in ("cafe", None):
            kind = "ice_cream"
        if not kind:
            continue
        lon, lat = (el.get("lon"), el.get("lat")) if el["type"] == "node" else ((el.get("center") or {}).get("lon"), (el.get("center") or {}).get("lat"))
        if lon is None:
            continue
        name = t.get("name") or STOP_KINDS[kind][0]
        # unnamed stops are only worth listing where the type alone is useful
        if not t.get("name") and kind not in ("toilets", "viewpoint", "picnic_site", "beach", "rest_area", "ice_cream", "lighthouse"):
            continue
        stops.append({"lon": lon, "lat": lat, "kind": kind, "name": name})
    S = pd.DataFrame(stops).drop_duplicates(["kind", "name", "lon", "lat"])
    lm = pd.read_parquet(RAW / key / "landmarks.parquet") if (RAW / key / "landmarks.parquet").exists() else pd.DataFrame()
    return S, signals, lm


def neighbour_weight(G, sx, sy, se, px, py, w, radius):
    """Sum of point weights within `radius` m of any sample of each edge (each point counted once per edge)."""
    out = np.zeros(len(G["geom"]))
    if not len(px):
        return out
    tree = KDTree(np.c_[sx, sy])
    hits = tree.query_radius(np.c_[px, py], r=radius)
    for j, h in enumerate(hits):
        for e in np.unique(se[h]):
            out[e] += w[j]
    return out


# ============================================================================= features

def features(key, G):
    R = Raster(G)
    print("  rasterising scenery…", flush=True)
    ras = scenery_rasters(R, json.loads((RAW / key / "scenery.json").read_text(encoding="utf-8"))["elements"])
    sx, sy, se = rg.sample_points(G, 20.0)
    E = len(G["geom"])
    agg = lambda v, how="mean": (pd.Series(v).groupby(se).mean() if how == "mean" else pd.Series(v).groupby(se).max()).reindex(range(E)).fillna(0).to_numpy()
    f = {}
    wd = R.at(ras["water_d"], sx, sy)
    near = np.clip(1 - (wd - 20) / 230, 0, 1)
    f["shore"] = 100 * (0.6 * agg(near) + 0.4 * agg(near, "max"))
    print("  water views (line of sight over the 30 m surface model)…", flush=True)
    z, water, (lon0, lat0), (dlon, dlat), cell_m = view_mask(G, ras["big_water"])
    vx, vy, ve = rg.sample_points(G, 40.0)
    lon0g, lat0g, kxg, kyg = G["proj"]
    vlon, vlat = vx / kxg + lon0g, vy / kyg + lat0g
    view = dem.water_view(z, water, (vlon - lon0) / dlon, (lat0 - vlat) / dlat, cell_m)
    vs = np.clip(view / 0.35, 0, 1)                 # a third of all directions with plenty of water in sight = full marks
    vser = pd.Series(vs).groupby(ve)
    f["water"] = 100 * (0.5 * vser.mean() + 0.5 * vser.max()).reindex(range(E)).fillna(0).to_numpy()
    f["water"][G["tunnel"]] = 0                     # the surface model can't tell a tunnel from the road over it
    f["shore"][G["tunnel"]] = 0
    f["green"] = 100 * np.clip(agg(R.at(ras["green"], sx, sy)) / 0.6, 0, 1)
    f["farm"] = 100 * np.clip(agg(R.at(ras["farm"], sx, sy)) / 0.5, 0, 1)
    f["busy"] = 100 * np.clip(agg(R.at(ras["busy"], sx, sy)) / 0.5, 0, 1)
    print("  street trees, sights and stops…", flush=True)
    L = np.maximum(G["length"], 20)
    tr = pd.read_parquet(RAW / key / "trees.parquet")
    tx, ty = rg.project(G, tr.lon.to_numpy(), tr.lat.to_numpy())
    trees = neighbour_weight(G, sx, sy, se, tx, ty, np.ones(len(tx)), 20)
    f["trees"] = 100 * np.clip(trees / L * 100 / 6, 0, 1)
    S, signals, lm = load_points(key)
    px, py = rg.project(G, S.lon.to_numpy(), S.lat.to_numpy())
    stop_w = S.kind.map(lambda k: STOP_KINDS[k][2]).to_numpy()
    sight_w = S.kind.map(lambda k: STOP_KINDS[k][3]).to_numpy()
    if len(lm):
        lx, ly = rg.project(G, lm.lon.to_numpy(), lm.lat.to_numpy())
        lw = np.where(lm.heritage.notna(), 1.5, 1.0) * np.where(lm.links >= 5, 1.5, 1.0)
        px, py, sight_w, stop_w = np.r_[px, lx], np.r_[py, ly], np.r_[sight_w, lw], np.r_[stop_w, np.zeros(len(lx))]
    f["sights"] = 100 * (1 - np.exp(-neighbour_weight(G, sx, sy, se, px, py, sight_w, 120) / 2))
    f["stops"] = 100 * (1 - np.exp(-neighbour_weight(G, sx, sy, se, px, py, stop_w, 100) / 2))
    # the road itself
    cls = np.array(rg.CLASSES)[G["cls"]]
    sp, lanes = G["speed"].astype(float), G["lanes"].astype(float)
    slow = np.interp(sp, [30, 50, 60, 70, 80, 90], [0.9, 1.0, 0.65, 0.4, 0.2, 0.0])
    wide = np.select([lanes <= 1, lanes == 2, lanes == 3, lanes == 4], [0.6, 1.0, 0.6, 0.25], 0.05)
    kind = np.select([np.isin(cls, ["motorway", "link"]), cls == "trunk", np.isin(cls, ["residential", "living_street", "service"]),
                      np.isin(cls, ["secondary", "tertiary", "unclassified"])], [0.0, 0.2, 0.75, 1.0], 0.8)
    sig = rg.signals_per_edge(G, signals)
    f["flow"] = 100 * np.exp(-sig / (L / 1000) / 3)
    chord = np.array([math.hypot((g[-1, 0] - g[0, 0]) * G["proj"][2], (g[-1, 1] - g[0, 1]) * G["proj"][3]) for g in G["geom"]])
    sinu = np.where(G["length"] > 100, G["length"] / np.maximum(chord, 1), 1)
    f["curve"] = 100 * np.clip((sinu - 1.02) / 0.15, 0, 1)
    # OpenStreetMap rarely records road width. Winding local roads through forest (the Highlands, Metchosin) are
    # usually narrow with no shoulder even when tagged two-lane, so they lose some of the "wide" credit.
    narrow = np.isin(cls, ["residential", "unclassified", "tertiary", "service"]) & (f["curve"] >= 50) & (f["green"] >= 50)
    wide = np.where(narrow, wide * 0.6, wide)
    f["road"] = 100 * slow * wide * kind
    f["narrow"] = 100 * narrow.astype(float)
    infra = np.select([G["bikeinfra"] | np.isin(cls, ["cycleway", "path"]), np.isin(cls, ["residential", "living_street", "service", "track"]),
                       cls == "unclassified", cls == "tertiary"], [1.0, 0.65, 0.5, 0.3], 0.05)
    f["infra"] = 100 * infra * np.where(G["unpaved"], 0.8, 1)
    quiet = np.select([np.isin(cls, ["footway", "path", "pedestrian", "steps", "track", "bridleway", "cycleway"]),
                       np.isin(cls, ["residential", "living_street", "service"]), cls == "unclassified", cls == "tertiary", cls == "secondary"],
                      [1.0, 0.8, 0.65, 0.45, 0.25], 0.1)
    f["quiet"] = 100 * quiet
    f["scenic_tag"] = 100 * G["scenic"].astype(float)
    return f, S, sig


def score(f, mode, idx=None):
    """Weighted index, 0–1. Mirrors scoreEdges() in site/src/sunday/main.js."""
    w = DEFAULT_WEIGHTS[mode]
    pos = sum(v for v in w.values() if v > 0)
    s = sum(wt * (f[k] if idx is None else f[k][idx]) / 100 for k, wt in w.items()) / pos
    s = s + 0.15 * ((f["scenic_tag"] if idx is None else f["scenic_tag"][idx]) / 100)
    return np.clip(s, 0, 1)


# ============================================================================= routes

def rate_routes(key, G, f, S, infos):
    out = []
    secs = {}
    for mode in rg.MODES:
        kmh = {"bike": 16, "foot": 4.8}.get(mode)
        speed = (np.minimum(G["speed"], 90) * 0.85 if kmh is None else np.full(len(G["length"]), kmh)) / 3.6
        secs[mode] = G["length"] / speed
    for r in [r for r in ROUTES if r["region"] == key]:
        mode = r["mode"]
        s = score(f, mode)
        cost = secs[mode] * (1 + 2.0 * (1 - s) ** 1.5)
        M, look = rg.router(G, mode, cost)
        path = rg.route(G, mode, M, look, r["waypoints"])
        if not path:
            print(f"    !! could not route {r['name']}", flush=True)
            continue
        idx = np.array([e for e, _ in path])
        m = G["length"][idx].sum()
        sc = float((s[idx] * G["length"][idx]).sum() / m)
        water_km = float(G["length"][idx][f["water"][idx] >= 50].sum() / 1000)
        green_km = float(G["length"][idx][f["green"][idx] >= 50].sum() / 1000)
        out.append({**{k: r[k] for k in ("id", "name", "mode", "blurb", "waypoints")}, "region": key, "km": float(m / 1000),
                    "minutes": float(secs[mode][idx].sum() / 60), "score": sc, "water_km": water_km, "green_km": green_km,
                    "steps": rg.file_steps(infos[mode], path)})
        print(f"    {mode:4s} {r['name']:44s} {m / 1000:5.1f} km  {secs[mode][idx].sum() / 60:4.0f} min  score {sc:.2f}", flush=True)
    return out


# ============================================================================= main

def build_region(key):
    reg = REGIONS[key]
    print(f"{reg['name']}…", flush=True)
    els = json.loads((RAW / key / "roads.json").read_text(encoding="utf-8"))["elements"]
    G = rg.build(els, reg["bbox"])
    f, S, sig = features(key, G)
    feat = {k: f[k] for k in FEATURES + ["scenic_tag"]}
    meta, infos = {}, {}
    for mode in rg.MODES:
        info = infos[mode] = rg.write(G, mode, OUT / f"graph_{key}_{mode}.json", feat)
        s = score(f, mode, info["index"])
        L = G["length"][info["index"]]
        order = np.argsort(s)
        cum = np.cumsum(L[order]) / L.sum()
        meta[mode] = {"edges": info["edges"], "kb": info["kb"], "km": float(L.sum() / 1000),
                      "pct": {str(p): float(s[order][np.searchsorted(cum, p / 100)]) for p in (50, 70, 85, 95)}}
        print(f"  {mode}: {info['edges']:,} edges, {meta[mode]['km']:,.0f} km, {info['kb']:,} KB", flush=True)
    stops = [[round(r.lon, 5), round(r.lat, 5), r.kind, r.name] for r in S.itertuples()]
    routes = rate_routes(key, G, f, S, infos)
    return {"name": reg["name"], "center": reg["center"], "zoom": reg["zoom"], "bbox": reg["bbox"], "modes": meta,
            "stops": stops, "routes": routes, "n_stops": int(len(S)), "signals": int((sig > 0).sum())}


def main(keys):
    gen = datetime.now(timezone.utc).isoformat(timespec="minutes")
    regions = {}
    for k in keys:
        regions[k] = build_region(k)
    path = OUT / "sunday.json"
    old = json.loads(path.read_text(encoding="utf-8"))["regions"] if path.exists() else {}
    old.update(regions)
    # tiers for the preset routes, by score within each region and mode
    for reg in old.values():
        for mode in rg.MODES:
            rs = sorted([r for r in reg["routes"] if r["mode"] == mode], key=lambda r: -r["score"])
            for i, r in enumerate(rs):
                q = i / max(1, len(rs) - 1)
                r["tier"] = "S" if i == 0 or q < 0.2 else "A" if q < 0.45 else "B" if q < 0.75 else "C"
    dump(path, {"generated": gen, "features": FEATURES, "weights": DEFAULT_WEIGHTS,
                "stop_kinds": {k: {"label": v[0], "icon": v[1]} for k, v in STOP_KINDS.items()}, "regions": old})


if __name__ == "__main__":
    main(sys.argv[1:] or list(REGIONS))
