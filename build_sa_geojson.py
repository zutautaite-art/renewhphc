"""
build_sa_geojson.py
───────────────────
Fetches ALL CSO Small Area boundaries from ArcGIS, joins them with your
Excel metrics, and writes a single GeoJSON file that your map loads directly.

Run:
    pip install requests pandas openpyxl
    python build_sa_geojson.py

Output:
    public/small_areas_metrics.geojson   (drop into your Vite public/ folder)
"""

import json
import math
import re
import sys
import time
from pathlib import Path

import pandas as pd
import requests

# ─── CONFIG ──────────────────────────────────────────────────────────────────

EXCEL_PATH = "cso_map_data_audit_and_cleaned.xlsx"   # your workbook
OUTPUT_PATH = "public/small_areas_metrics.geojson"   # Vite serves from public/

# CSO ArcGIS REST endpoint for Small Areas 2022
ARCGIS_URL = (
    "https://services1.arcgis.com/eNO7HHeQ3rUcBllm/arcgis/rest/services"
    "/Small_Areas_National_Statistical_Boundaries_2022/FeatureServer/0/query"
)
PAGE_SIZE = 1000   # ArcGIS max per request

# ─── STEP 1: READ EXCEL ──────────────────────────────────────────────────────

print("Reading Excel…")
xl = pd.ExcelFile(EXCEL_PATH)

# filter_config tells us which columns are metrics and what to call them
cfg = pd.read_excel(xl, sheet_name="filter_config")
cfg = cfg[cfg["kind"] == "small_area_metric"].copy()
cfg = cfg[~cfg["status"].str.lower().str.startswith("no", na=False)]
print(f"  {len(cfg)} usable metric rows in filter_config")

# small_area_master has the actual numbers, keyed by cso_code
sa = pd.read_excel(xl, sheet_name="small_area_master", dtype={"cso_code": str})
# Normalise: strip whitespace, zero-pad to 9 digits
sa["cso_code"] = sa["cso_code"].str.strip().str.zfill(9)
print(f"  {len(sa)} rows in small_area_master")

# Build a lookup: cso_code → { metric_key: {mapValue, rawValue} }
metric_cols = {}   # key → {map_field, raw_field, label}
for _, row in cfg.iterrows():
    mf = str(row.get("map_field", "") or "").strip()
    rf = str(row.get("raw_field", "") or "").strip()
    if mf and mf in sa.columns:
        metric_cols[str(row["key"])] = {
            "label": str(row["label"]),
            "map_field": mf,
            "raw_field": rf if rf and rf in sa.columns else None,
        }

print(f"  Metrics to embed: {list(metric_cols.keys())}")

# Build per-SA dict
sa_lookup: dict[str, dict] = {}
for _, row in sa.iterrows():
    code = str(row["cso_code"]).zfill(9)
    entry = {}
    for key, conf in metric_cols.items():
        mv = row.get(conf["map_field"])
        rv = row.get(conf["raw_field"]) if conf["raw_field"] else None
        if mv is not None and not (isinstance(mv, float) and math.isnan(mv)):
            entry[key] = {
                "mapValue": float(mv),
                "rawValue": (None if rv is None or (isinstance(rv, float) and math.isnan(rv))
                             else (int(rv) if isinstance(rv, float) and rv == int(rv) else rv)),
            }
    if entry:
        sa_lookup[code] = entry

print(f"  {len(sa_lookup)} small areas have at least one metric value")

# ─── STEP 2: FETCH ALL BOUNDARIES FROM ARCGIS ────────────────────────────────

def fetch_page(offset: int) -> list[dict]:
    params = {
        "where": "1=1",
        "outFields": "GEOGID,GEOGDESC,COUNTY",
        "returnGeometry": "true",
        "outSR": "4326",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
        "f": "geojson",
    }
    for attempt in range(4):
        try:
            r = requests.get(ARCGIS_URL, params=params, timeout=30)
            r.raise_for_status()
            data = r.json()
            return data.get("features", [])
        except Exception as exc:
            print(f"    Retry {attempt+1}/4 (offset={offset}): {exc}")
            time.sleep(2 ** attempt)
    raise RuntimeError(f"Failed after 4 retries at offset={offset}")

print("\nFetching CSO small area boundaries from ArcGIS (this takes ~1–3 min)…")
all_features: list[dict] = []
offset = 0
while True:
    batch = fetch_page(offset)
    if not batch:
        break
    all_features.extend(batch)
    print(f"  Fetched {len(all_features)} features so far…", end="\r")
    if len(batch) < PAGE_SIZE:
        break
    offset += PAGE_SIZE

print(f"\n  Total boundary features: {len(all_features)}")

# ─── STEP 3: JOIN METRICS INTO FEATURES ──────────────────────────────────────

def geogid_to_code(geogid: str) -> str:
    """SA2017_017028001  →  017028001  (9-digit, zero-padded)"""
    m = re.match(r"^[A-Za-z]+\d{4}_(\d+)$", geogid or "")
    if m:
        return m.group(1).zfill(9)
    # fallback: strip non-digits
    digits = re.sub(r"\D", "", geogid or "")
    return digits[-9:].zfill(9) if len(digits) >= 9 else digits.zfill(9)

matched = 0
for feat in all_features:
    props: dict = feat.get("properties") or {}
    code = geogid_to_code(str(props.get("GEOGID", "")))
    metrics = sa_lookup.get(code, {})
    props["_metrics"] = metrics          # nested: { age_35_44: {mapValue, rawValue} }
    props["_cso_code"] = code
    props["_matched"] = bool(metrics)
    if metrics:
        matched += 1
    feat["properties"] = props

print(f"  Matched {matched} / {len(all_features)} features to Excel metrics")
unmatched = len(all_features) - matched
if unmatched > 0:
    print(f"  ⚠  {unmatched} features had no matching Excel row")

# ─── STEP 4: WRITE OUTPUT ────────────────────────────────────────────────────

out_path = Path(OUTPUT_PATH)
out_path.parent.mkdir(parents=True, exist_ok=True)

geojson = {
    "type": "FeatureCollection",
    "features": all_features,
    "_metricConfig": [
        {"key": k, "label": v["label"], "geography": "small_area"}
        for k, v in metric_cols.items()
    ],
}

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(geojson, f, separators=(",", ":"))   # compact — smaller file

size_mb = out_path.stat().st_size / 1_048_576
print(f"\n✅  Written: {out_path}  ({size_mb:.1f} MB)")
print("""
Next steps
──────────
1. Copy the file into your project's  public/  folder (Vite serves it automatically).
2. In MapView.tsx, replace the fetchSmallAreasIntersectingBounds() call with a
   one-time fetch of /small_areas_metrics.geojson (see snippet below).
3. In attachCombinedMetric(), read metric values from  props._metrics[metric.key]
   instead of looking them up by ID alias.

── MapView.tsx snippet ─────────────────────────────────────────────────────────

  // Replace the saFetch / saCacheRef logic with this single load at startup:
  useEffect(() => {
    fetch('/small_areas_metrics.geojson')
      .then(r => r.json())
      .then(data => setSaRaw(data))
      .catch(err => console.error('SA GeoJSON load error', err))
  }, [])

  // In attachCombinedMetric, change the lookup to:
  //   const hit = props._metrics?.[metric.key]
  // instead of aliasIds() → metric.values[k]

────────────────────────────────────────────────────────────────────────────────
""")
