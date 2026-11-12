"""Sunday Drive configuration."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "sunday" / "raw"
OSM = ROOT / "data" / "osm"          # city extracts (.osm.pbf) from BBBike, shared by every project that needs them
OUT = ROOT / "site" / "public" / "data" / "sunday"

# (south, west, north, east)
REGIONS = {
    "victoria": {"name": "Greater Victoria", "bbox": (48.392, -123.578, 48.702, -123.25), "pbf": "Victoria", "center": [-123.39, 48.50], "zoom": 10.6,
                 "tree_cities": ["victoria", "esquimalt"]},
    "vancouver": {"name": "Greater Vancouver", "bbox": (49.00, -123.30, 49.416, -122.668), "pbf": "Vancouver", "center": [-123.03, 49.22], "zoom": 10.1,
                  "tree_cities": ["vancouver"]},
}
