"""Download raw inputs for Sunday Drive.

  python -m pipelines.sunday.fetch [osm|roads|scenery|stops|landmarks|trees|all|missing] [region ...]

osm        roads, scenery and stops from the city's OpenStreetMap extract (BBBike, weekly) — the default
roads      every road and path (OpenStreetMap via Overpass), with nodes, for the routable network (fallback)
scenery    water and coastline, parks and forest, farmland, industrial land (polygons and lines)
stops      ice cream, cafés, bakeries, farm stands, viewpoints, picnic sites, beaches, washrooms, lighthouses, piers,
           signals and stop signs (to measure stop-and-go)
landmarks  Wikidata places with a heritage designation or a Wikipedia article (names, photos)
trees      municipal street-tree inventories
Cached tile by tile under data/sunday/raw/<region>/, so reruns fetch only what's missing.
"""
from __future__ import annotations

import json
import sys

import pandas as pd

from pipelines.common import trees as treelib
from pipelines.common.http import get_json
from pipelines.common.osm import fetch_tiled
from pipelines.common.roadgraph import ROAD_SELECTOR

from pipelines.common import osm_pbf

from .config import OSM, RAW, REGIONS

SCENERY = ('way["natural"~"^(water|coastline|beach|wood|scrub|heath|grassland|wetland|cliff)$"]({bbox});'
           'relation["natural"~"^(water|wood|scrub|wetland)$"]({bbox});'
           'way["waterway"~"^(river|riverbank)$"]({bbox});'
           'way["leisure"~"^(park|nature_reserve|garden|golf_course)$"]({bbox});relation["leisure"~"^(park|nature_reserve)$"]({bbox});'
           'way["landuse"~"^(forest|meadow|farmland|orchard|vineyard|cemetery|industrial|railway|commercial|retail|recreation_ground|allotments)$"]({bbox});'
           'relation["landuse"~"^(forest|farmland|industrial)$"]({bbox});'
           'way["boundary"="protected_area"]({bbox});relation["boundary"~"^(protected_area|national_park)$"]({bbox});')
STOPS = ('nwr["amenity"~"^(ice_cream|cafe|bakery|toilets|drinking_water)$"]({bbox});'
         'nwr["shop"~"^(ice_cream|bakery|farm|confectionery|chocolate)$"]({bbox});'
         'nwr["tourism"~"^(viewpoint|picnic_site|attraction|museum|artwork|gallery)$"]({bbox});'
         'nwr["natural"="beach"]({bbox});nwr["man_made"~"^(lighthouse|pier)$"]({bbox});'
         'nwr["historic"]({bbox});nwr["heritage"]({bbox});nwr["highway"="rest_area"]({bbox});'
         'node["highway"~"^(traffic_signals|stop)$"]({bbox});')


def osm(key: str) -> None:
    """Roads, scenery and stops in one pass over the city's OpenStreetMap extract (the default source)."""
    r = REGIONS[key]
    d = osm_pbf.extract(osm_pbf.download(r["pbf"], OSM), r["bbox"])
    for name in ("roads", "scenery", "stops"):
        (RAW / key / f"{name}.json").write_text(json.dumps(d[name]), encoding="utf-8")


def roads(key: str) -> None:
    r = REGIONS[key]
    d = fetch_tiled(ROAD_SELECTOR, r["bbox"], RAW / key / "roads_tiles", step=0.1)
    (RAW / key / "roads.json").write_text(json.dumps(d), encoding="utf-8")
    print(f"  roads {key}: {sum(e['type'] == 'way' for e in d['elements']):,} ways", flush=True)


def scenery(key: str) -> None:
    d = fetch_tiled(SCENERY, REGIONS[key]["bbox"], RAW / key / "scenery_tiles", step=0.15, out="geom", recurse=False)
    (RAW / key / "scenery.json").write_text(json.dumps(d), encoding="utf-8")
    print(f"  scenery {key}: {len(d['elements']):,} features", flush=True)


def stops(key: str) -> None:
    d = fetch_tiled(STOPS, REGIONS[key]["bbox"], RAW / key / "stops_tiles", step=0.2, out="center tags", recurse=False)
    (RAW / key / "stops.json").write_text(json.dumps(d), encoding="utf-8")
    print(f"  stops {key}: {len(d['elements']):,} points", flush=True)


def landmarks(key: str) -> None:
    s, w, n, e = REGIONS[key]["bbox"]
    q = f"""SELECT ?item ?itemLabel ?coord ?image ?heritageLabel ?links WHERE {{
      SERVICE wikibase:box {{ ?item wdt:P625 ?coord .
        bd:serviceParam wikibase:cornerSouthWest "Point({w} {s})"^^geo:wktLiteral .
        bd:serviceParam wikibase:cornerNorthEast "Point({e} {n})"^^geo:wktLiteral . }}
      ?item wikibase:sitelinks ?links .
      OPTIONAL {{ ?item wdt:P1435 ?heritage . }}
      OPTIONAL {{ ?item wdt:P18 ?image . }}
      FILTER(BOUND(?heritage) || ?links >= 2)
      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }} }}"""
    d = get_json("https://query.wikidata.org/sparql", {"query": q, "format": "json"}, timeout=300)
    rows = []
    for b in d["results"]["bindings"]:
        lon, lat = b["coord"]["value"].replace("Point(", "").rstrip(")").split()
        rows.append({"id": b["item"]["value"].rsplit("/", 1)[-1], "name": b["itemLabel"]["value"], "lon": float(lon), "lat": float(lat),
                     "heritage": b.get("heritageLabel", {}).get("value"), "image": b.get("image", {}).get("value"),
                     "links": int(b["links"]["value"])})
    df = pd.DataFrame(rows).drop_duplicates("id")
    df.to_parquet(RAW / key / "landmarks.parquet", index=False)
    print(f"  landmarks {key}: {len(df):,} ({df.heritage.notna().sum():,} heritage-designated)", flush=True)


def trees(key: str) -> None:
    df = pd.concat([treelib.fetch(c) for c in REGIONS[key]["tree_cities"]], ignore_index=True)
    df.to_parquet(RAW / key / "trees.parquet", index=False)
    print(f"  trees {key}: {len(df):,}", flush=True)


def missing(key: str) -> None:
    """Daily mode: fetch only what isn't cached (the road network changes slowly)."""
    if not (RAW / key / "roads.json").exists():
        osm(key)
    for fn, f in [(landmarks, "landmarks.parquet"), (trees, "trees.parquet")]:
        if not (RAW / key / f).exists():
            fn(key)


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    keys = sys.argv[2:] or list(REGIONS)
    for k in keys:
        (RAW / k).mkdir(parents=True, exist_ok=True)
        print(f"{REGIONS[k]['name']}…", flush=True)
        if what == "missing":
            missing(k)
            continue
        for name, fn in [("osm", osm), ("landmarks", landmarks), ("trees", trees)]:
            if what in (name, "all"):
                fn(k)
        for name, fn in [("roads", roads), ("scenery", scenery), ("stops", stops)]:     # Overpass fallback, by name only
            if what == name:
                fn(k)
