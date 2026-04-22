"""
build_sa_geojson.py
-------------------
Reads cso_equivalent_from_final_master.xlsx, fetches all CSO small area
boundaries from ArcGIS, joins metrics, writes public/small_areas_metrics.geojson.

UPDATED: now bakes ED_Name, ED_Code, County into each feature's properties
so the SA hover tooltip can display them.

Run from your project root:
    python build_sa_geojson.py
"""

import json, math, re, time
from pathlib import Path
import pandas as pd
import requests

EXCEL_PATH  = "cso_equivalent_from_final_master.xlsx"
OUTPUT_PATH = "public/small_areas_metrics.geojson"

ARCGIS_CANDIDATES = [
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/ArcGIS/rest/services/SMALL_AREA_2022_Genralised_20m_view/FeatureServer/0/query",
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/CSO_Small_Areas_National_Statistical_Boundaries_2022_Ungeneralised_view/FeatureServer/0/query",
    "https://services1.arcgis.com/eNO7HHeQ3rUcBllm/arcgis/rest/services/Small_Areas_National_Statistical_Boundaries_2022/FeatureServer/0/query",
]
PAGE_SIZE = 1000

# --- HELPERS -----------------------------------------------------------------

def safe_float(v):
    if v is None: return None
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except: return None

def safe_num(v):
    f = safe_float(v)
    if f is None: return None
    return int(f) if f == int(f) else round(f, 4)

def normalise_key(raw: str) -> str:
    return str(raw or "").strip().lower().replace(" ", "")

def base_digits(raw: str) -> str:
    s = str(raw or "").strip().split("/")[0].strip()
    d = re.sub(r"\D", "", s)
    if not d: return ""
    return d[-9:].zfill(9) if len(d) >= 9 else d.zfill(9)

def rings_to_geojson(geom: dict):
    if not geom: return None
    rings = geom.get("rings")
    if not rings: return None
    return {"type": "Polygon", "coordinates": rings} if len(rings) == 1 \
        else {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}

def title_case(s: str) -> str:
    """Convert UPPERCASE CSO names to Title Case."""
    return str(s or "").strip().title()

# --- STEP 1: READ EXCEL ------------------------------------------------------

print("Reading Excel...")
xl  = pd.ExcelFile(EXCEL_PATH)
cfg = pd.read_excel(xl, sheet_name="filter_config")
cfg = cfg[cfg["kind"] == "small_area_metric"].copy()
cfg = cfg[cfg["status"].str.strip().str.lower() == "use"]
print(f"  {len(cfg)} usable metrics from filter_config")

sa = pd.read_excel(xl, sheet_name="small_area_master", dtype={"cso_code": str})
sa["county_raw"] = sa["county"].fillna("").astype(str)
print(f"  {len(sa)} rows in small_area_master")

# Build metric column map
metric_cols: dict[str, dict] = {}
for _, row in cfg.iterrows():
    key        = str(row["key"]).strip()
    rf         = str(row.get("raw_field",  "") or "").strip()
    mf         = str(row.get("map_field",  "") or "").strip()
    label      = str(row.get("label", key)).strip()
    is_phobal  = key == "phobal_score"
    colour_col = rf if rf and rf in sa.columns else None
    display_col= mf if mf and mf in sa.columns and mf != rf else None
    has_data   = bool(colour_col and sa[colour_col].notna().any())
    metric_cols[key] = {
        "label": label, "colour_col": colour_col,
        "display_col": display_col, "is_phobal": is_phobal, "has_data": has_data,
    }

# Build lookups
sa_lookup:        dict[str, dict] = {}
base_lookup:      dict[str, dict] = {}
component_lookup: dict[str, dict] = {}

for _, row in sa.iterrows():
    raw = str(row.get("cso_code", "")).strip()
    full_key = normalise_key(raw)
    entry: dict = {}
    for key, conf in metric_cols.items():
        if not conf["has_data"]: continue
        mv = safe_float(row.get(conf["colour_col"]))
        if mv is None: continue
        pv = safe_num(row.get(conf["display_col"])) if conf["display_col"] else None
        entry[key] = {"mapValue": mv, "pctValue": pv}
    if not entry: continue
    sa_lookup[full_key] = entry
    bc = base_digits(raw)
    if bc: base_lookup[bc] = entry
    for part in raw.split("/"):
        bp = base_digits(part.strip())
        if bp and len(re.sub(r"\D","",part.strip())) >= 6:
            component_lookup[bp] = entry

print(f"  Primary keys:   {len(sa_lookup)}")
print(f"  Base fallback:  {len(base_lookup)}")
print(f"  Component keys: {len(component_lookup)}")
print("\nMetric availability:")
for k, v in metric_cols.items():
    pct = v["display_col"] and sa[v["display_col"]].notna().any()
    tag = "HAS DATA" if v["has_data"] else "NO DATA - filter disabled"
    print(f"  {k:45s}  colour={v['colour_col'] or '-':25s}  pct={bool(pct)}  {tag}")

# --- STEP 2: FIND WORKING ARCGIS ENDPOINT ------------------------------------

def probe(url: str) -> bool:
    try:
        r = requests.get(url, params={"where":"1=1","outFields":"*",
            "returnGeometry":"false","resultRecordCount":1,"f":"json"}, timeout=15)
        r.raise_for_status()
        data = r.json()
        ok = "features" in data and "error" not in data and len(data["features"]) > 0
        if ok:
            attrs = data["features"][0].get("attributes", {})
            print(f"    Fields: {list(attrs.keys())[:8]}")
        return ok
    except Exception as e:
        print(f"    Error: {e}"); return False

def fetch_page(url: str, offset: int) -> list[dict]:
    params = {"where":"1=1","outFields":"*","returnGeometry":"true",
              "outSR":"4326","resultOffset":offset,
              "resultRecordCount":PAGE_SIZE,"f":"json"}
    for attempt in range(4):
        try:
            r = requests.get(url, params=params, timeout=45)
            r.raise_for_status()
            data = r.json()
            if "error" in data: raise ValueError(str(data["error"]))
            feats = []
            for item in data.get("features", []):
                attrs = item.get("attributes", {})
                geom  = rings_to_geojson(item.get("geometry"))

                # GEOGID
                geogid  = str(attrs.get("SA_GEOGID_2022") or attrs.get("GEOGID") or "")
                pub2011 = str(attrs.get("SA_PUB2011") or "").strip()
                pub2016 = str(attrs.get("SA_PUB2016") or "").strip()
                pub2022 = str(attrs.get("SA_PUB2022") or "").strip()

                # ── NEW: County, ED_Name, ED_Code from ArcGIS directly ──
                county  = title_case(
                    attrs.get("COUNTY_ENGLISH") or
                    attrs.get("COUNTY") or
                    attrs.get("LOCAL_AUTHORITY") or ""
                )
                ed_name = title_case(attrs.get("ED_ENGLISH") or "")
                ed_code = str(attrs.get("ED_ID_STR") or "").strip()

                feats.append({"type":"Feature","geometry":geom,"properties":{
                    "GEOGID":   geogid,
                    "GEOGDESC": str(attrs.get("GEOGDESC") or pub2022 or geogid),
                    "COUNTY":   county,
                    "ED_Name":  ed_name,
                    "ED_Code":  ed_code,
                    "_pub2011": pub2011,
                    "_pub2016": pub2016,
                    "_pub2022": pub2022,
                }})
            return feats
        except Exception as e:
            print(f"    Attempt {attempt+1}/4: {e}")
            time.sleep(2**attempt)
    raise RuntimeError(f"Failed at offset={offset}")

print("\nFinding ArcGIS endpoint...")
ARCGIS_URL = None
for candidate in ARCGIS_CANDIDATES:
    name = candidate.split("/services/")[1].split("/Feature")[0] if "/services/" in candidate else candidate
    print(f"  Trying: {name}")
    if probe(candidate):
        ARCGIS_URL = candidate
        print(f"  Works!")
        break
    print(f"  Failed")

if not ARCGIS_URL:
    print("ERROR: All ArcGIS endpoints failed."); exit(1)

# --- STEP 3: FETCH ALL BOUNDARIES --------------------------------------------

print(f"\nFetching boundaries (~1-3 min)...")
all_features, offset, first = [], 0, True
while True:
    batch = fetch_page(ARCGIS_URL, offset)
    if not batch: break
    all_features.extend(batch)
    if first:
        samples = [(f["properties"]["GEOGID"],
                    f["properties"]["COUNTY"],
                    f["properties"]["ED_Name"]) for f in batch[:3]]
        print(f"  Sample (GEOGID, County, ED_Name): {samples}")
        first = False
    print(f"  {len(all_features)} features...", end="\r")
    if len(batch) < PAGE_SIZE: break
    offset += PAGE_SIZE
print(f"\n  Total: {len(all_features)} features")

# --- STEP 4: JOIN METRICS ----------------------------------------------------

def find_metrics(props: dict) -> dict:
    pub2022 = str(props.get("_pub2022","")).strip()
    pub2011 = str(props.get("_pub2011","")).strip()
    pub2016 = str(props.get("_pub2016","")).strip()
    geogid  = str(props.get("GEOGID","")).strip()

    for candidate in [pub2022, pub2011, pub2016]:
        if candidate:
            k = normalise_key(candidate)
            if k in sa_lookup: return sa_lookup[k]

    for candidate in [pub2022, pub2011, pub2016, geogid]:
        if candidate:
            bc = base_digits(candidate)
            if bc in base_lookup: return base_lookup[bc]
            if bc in component_lookup: return component_lookup[bc]

    digits = re.sub(r"\D","",geogid)
    for variant in [digits, digits[-9:].zfill(9) if len(digits)>=9 else "",
                    digits.zfill(9), digits[1:] if len(digits)==10 else ""]:
        if variant and variant in base_lookup:
            return base_lookup[variant]
    return {}

matched = 0
unmatched_samples = []

for feat in all_features:
    props = feat.get("properties") or {}
    metrics = find_metrics(props)
    props["_metrics"]  = json.dumps(metrics) if metrics else "{}"
    props["_matched"]  = bool(metrics)
    if metrics:
        matched += 1
    elif len(unmatched_samples) < 3:
        unmatched_samples.append({"GEOGID":props.get("GEOGID",""),
                                   "PUB2011":props.get("_pub2011",""),
                                   "PUB2022":props.get("_pub2022","")})
    feat["properties"] = props

print(f"  Matched: {matched} / {len(all_features)} ({100*matched//len(all_features)}%)")
if unmatched_samples:
    print(f"  Sample unmatched: {unmatched_samples}")

# --- STEP 5: WRITE OUTPUT ----------------------------------------------------

out_path = Path(OUTPUT_PATH)
out_path.parent.mkdir(parents=True, exist_ok=True)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump({
        "type": "FeatureCollection",
        "features": all_features,
        "_metricConfig": [
            {"key":k,"label":v["label"],"geography":"small_area",
             "is_phobal":v["is_phobal"],"has_data":v["has_data"]}
            for k,v in metric_cols.items()
        ],
    }, f, separators=(",",":"))

mb = out_path.stat().st_size / 1_048_576
print(f"\nDone: {out_path}  ({mb:.1f} MB)")
print("County + ED_Name + ED_Code are now baked into every SA feature.")
print("Next: update MapView.tsx tooltip, then git add/commit/push.")
