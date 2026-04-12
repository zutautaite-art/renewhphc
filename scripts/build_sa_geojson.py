#!/usr/bin/env python3
"""
Excel → GeoJSON for Small Areas (CSO-style), without touching households.

Reads:
  - filter_config   — source of truth for labels, keys, map_field, status, kind
  - small_area_master — metric rows keyed by cso_code (joined to boundary GEOGID)

Does NOT read:
  - households_clean (remains point-only in the app)

Output:
  - GeoJSON FeatureCollection with original SA geometry + numeric properties m_<key>
    for each valid small_area_metric from config.
  - Optional sidecar JSON listing the same filters (labels from Excel only).

Usage
-----
  pip install pandas openpyxl

  # A) Fetch Ireland SA polygons from CSO GeoHive (paginated), merge workbook:
  python scripts/build_sa_geojson.py path/to/workbook.xlsx --fetch-boundaries \\
      -o public/small_areas_metrics.geojson

  # B) Use a local SA GeoJSON you already have (must have GEOGID on features):
  python scripts/build_sa_geojson.py path/to/workbook.xlsx \\
      --boundaries path/to/small_areas.geojson \\
      -o public/small_areas_metrics.geojson

  # Optional filter manifest (for the app to show labels without re-parsing Excel):
  python scripts/build_sa_geojson.py workbook.xlsx --fetch-boundaries \\
      -o public/small_areas_metrics.geojson --filters-json public/small_areas_metrics.filters.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    import pandas as pd
except ImportError:
    print("Install: pip install pandas openpyxl", file=sys.stderr)
    sys.exit(1)

# Same service as renewhphc/src/cso/arcgisGeoJson.ts
CSO_SA_QUERY = (
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/"
    "CensusHub2022_T1_1_SA/FeatureServer/0/query"
)

IRELAND_ENVELOPE_4326 = "-10.7,51.2,-5.3,55.5"


def norm_key(k: str) -> str:
    return re.sub(r"\s+", "_", str(k).replace("\ufeff", "").strip().lower())


def norm_geoprop(v: Any) -> str:
    if v is None or v == "":
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def parse_cell_number(v: Any) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if isinstance(v, float) and not v == v:  # NaN
            return None
        return float(v)
    s = str(v).strip()
    if not s or s == "-":
        return None
    s = s.replace("%", "").replace("\xa0", "").replace(" ", "")
    if re.match(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$", s):
        s = s.replace(",", "")
    elif re.match(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$", s):
        s = s.replace(".", "").replace(",", ".")
    elif re.match(r"^-?\d+,\d+$", s):
        s = s.replace(",", ".")
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n == n else None


def normalize_area_id(raw: Any) -> str:
    s = str(raw or "").strip()
    if not s:
        return ""
    u = s.upper()
    if u.startswith("SOURCE:") or u.startswith("NOTE:") or u == "IRELAND TOTAL":
        return ""
    m = re.search(r"\d{7,11}(?:/\d{1,4})?", s)
    if m:
        return m.group(0)
    return s


def alias_ids(id_str: str) -> list[str]:
    out: set[str] = set()
    t = id_str.strip()
    if not t:
        return []
    out.add(t)
    digits = re.sub(r"[^\d]", "", t)
    if digits:
        out.add(digits)
        stripped = digits.lstrip("0") or "0"
        out.add(stripped)
        if len(digits) < 9:
            out.add(digits.zfill(9))
        if len(digits) == 8:
            out.add("0" + digits)
    base = t.split("/")[0].strip()
    if base:
        out.add(base)
        bd = re.sub(r"[^\d]", "", base)
        if bd:
            out.add(bd)
            out.add(bd.lstrip("0") or "0")
            if len(bd) < 9:
                out.add(bd.zfill(9))
    return [x for x in out if x]


def row_lookup(row: dict[str, Any]) -> dict[str, Any]:
    return {norm_key(k): v for k, v in row.items()}


def get_first(lookup: dict[str, Any], keys: list[str]) -> Any:
    for key in keys:
        k = norm_key(key)
        if k not in lookup:
            continue
        v = lookup[k]
        if v is None or v == "":
            continue
        if isinstance(v, str) and not v.strip():
            continue
        return v
    return None


def status_excluded(status: str) -> bool:
    s = status.strip().lower()
    return s.startswith("no")


def infer_unit(map_field: str | None) -> str | None:
    if not map_field:
        return None
    f = norm_key(map_field)
    if "pct" in f or "percent" in f or "share" in f:
        return "%"
    return None


def parse_filter_config(df: pd.DataFrame) -> list[dict[str, Any]]:
    rows = df.fillna("").to_dict(orient="records")
    out: list[dict[str, Any]] = []
    for row in rows:
        lu = row_lookup(row)
        key = str(get_first(lu, ["key"]) or "").strip()
        group = str(get_first(lu, ["group"]) or "").strip()
        if not key or not group:
            continue
        label = str(get_first(lu, ["label"]) or key).strip()
        kind_raw = str(get_first(lu, ["kind"]) or "").strip().lower()
        if kind_raw not in ("household_boolean", "town_metric", "small_area_metric"):
            kind = "small_area_metric"
        else:
            kind = kind_raw
        out.append(
            {
                "group": group,
                "key": key,
                "label": label,
                "kind": kind,
                "source": str(get_first(lu, ["source"]) or "").strip() or None,
                "raw_field": str(get_first(lu, ["raw_field", "rawfield"]) or "").strip() or None,
                "map_field": str(get_first(lu, ["map_field", "mapfield"]) or "").strip() or None,
                "status": str(get_first(lu, ["status"]) or "").strip() or None,
            }
        )
    return out


def usable_sa_metrics(cfg: list[dict[str, Any]]) -> list[dict[str, Any]]:
    usable: list[dict[str, Any]] = []
    for c in cfg:
        if c.get("kind") != "small_area_metric":
            continue
        st = str(c.get("status") or "")
        if status_excluded(st):
            continue
        mf = c.get("map_field")
        if not mf:
            continue
        usable.append(c)
    return usable


def safe_metric_prop(key: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9_]+", "_", key.strip()).strip("_")
    return s or "metric"


def read_sheet(wb_path: Path, name: str) -> pd.DataFrame | None:
    try:
        return pd.read_excel(wb_path, sheet_name=name, dtype=object)
    except ValueError:
        return None


def fetch_sa_geojson_ireland(*, page_size: int = 5000, max_features: int = 50000) -> dict[str, Any]:
    all_features: list[dict[str, Any]] = []
    offset = 0
    while len(all_features) < max_features:
        params = {
            "f": "geojson",
            "outSR": "4326",
            "returnGeometry": "true",
            "where": "1=1",
            "geometry": IRELAND_ENVELOPE_4326,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "GEOGID,GEOGDESC,COUNTY,LOCAL_AUTHORITY",
            "resultRecordCount": str(page_size),
            "resultOffset": str(offset),
        }
        url = CSO_SA_QUERY + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "renewhphc-build_sa_geojson/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(str(data.get("error")))
        feats = data.get("features") or []
        if not feats:
            break
        all_features.extend(feats)
        offset += len(feats)
        if len(all_features) >= max_features:
            break
    return {"type": "FeatureCollection", "features": all_features}


def load_geojson(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ValueError(f"{path} is not a FeatureCollection")
    return data


def geogid_from_feature(feat: dict[str, Any]) -> str:
    props = feat.get("properties") or {}
    return norm_geoprop(props.get("GEOGID"))


def build_master_index(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Map every alias id -> full row lookup dict."""
    id_aliases_cols = [
        "cso_code",
        "cso code",
        "geogid",
        "cso_small_area_code",
        "small_area_code",
        "small_area",
        "sa_geogid",
        "sa_code",
        "cso_sa_code",
        "small_area_id",
    ]
    index: dict[str, dict[str, Any]] = {}
    for row in rows:
        lu = row_lookup(row)
        raw_id = get_first(lu, id_aliases_cols)
        nid = normalize_area_id(raw_id)
        if not nid:
            continue
        for aid in alias_ids(nid):
            index[aid] = lu
    return index


def merge_workbook_into_features(
    fc: dict[str, Any],
    master_index: dict[str, dict[str, Any]],
    metrics_cfg: list[dict[str, Any]],
    header_set: set[str],
) -> tuple[list[str], int]:
    warnings: list[str] = []
    matched = 0
    for conf in metrics_cfg:
        mf = conf.get("map_field") or ""
        mk = norm_key(mf)
        if mk not in header_set:
            warnings.append(f'map field "{mf}" for filter key "{conf.get("key")}" not in small_area_master headers.')
    usable = [c for c in metrics_cfg if norm_key(str(c.get("map_field") or "")) in header_set]
    if not usable:
        warnings.append("No usable small_area_metric columns after header check.")

    for feat in fc.get("features") or []:
        gid = geogid_from_feature(feat)
        if not gid:
            continue
        lu = None
        for aid in alias_ids(gid):
            lu = master_index.get(aid)
            if lu:
                break
        props = dict(feat.get("properties") or {})
        if not lu:
            props["_wb_matched"] = False
            feat["properties"] = props
            continue
        matched += 1
        props["_wb_matched"] = True
        for conf in usable:
            key = conf["key"]
            mf = conf["map_field"] or ""
            mk = norm_key(mf)
            raw_val = lu.get(mk)
            num = parse_cell_number(raw_val)
            prop_name = "m_" + safe_metric_prop(key)
            if num is not None:
                props[prop_name] = num
        feat["properties"] = props

    return warnings, matched


def write_filters_json(path: Path, metrics_cfg: list[dict[str, Any]], header_set: set[str]) -> None:
    usable = [c for c in metrics_cfg if norm_key(str(c.get("map_field") or "")) in header_set]
    payload = [
        {
            "key": c["key"],
            "group": c["group"],
            "label": c["label"],
            "kind": "small_area_metric",
            "map_field": c["map_field"],
            "unit": infer_unit(c.get("map_field")),
        }
        for c in usable
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build small_areas_metrics.geojson from workbook + SA boundaries.")
    ap.add_argument("workbook", type=Path, help="Path to .xlsx workbook")
    ap.add_argument("-o", "--output", type=Path, default=Path("public/small_areas_metrics.geojson"))
    ap.add_argument("--boundaries", type=Path, help="Local SA FeatureCollection GeoJSON (features need GEOGID)")
    ap.add_argument(
        "--fetch-boundaries",
        action="store_true",
        help="Download Ireland SA polygons from CSO GeoHive (same layer as the app)",
    )
    ap.add_argument(
        "--filters-json",
        type=Path,
        help="Optional path to write filter manifest (labels from filter_config only)",
    )
    ap.add_argument("--max-features", type=int, default=50000, help="Cap when fetching boundaries")
    args = ap.parse_args()

    if bool(args.boundaries) == bool(args.fetch_boundaries):
        ap.error("Provide exactly one of: --boundaries FILE  OR  --fetch-boundaries")

    wb_path = args.workbook.expanduser().resolve()
    if not wb_path.is_file():
        print(f"Workbook not found: {wb_path}", file=sys.stderr)
        sys.exit(1)

    cfg_df = read_sheet(wb_path, "filter_config")
    if cfg_df is None or cfg_df.empty:
        print("filter_config sheet missing or empty.", file=sys.stderr)
        sys.exit(1)

    master_df = read_sheet(wb_path, "small_area_master")
    if master_df is None or master_df.empty:
        print("small_area_master sheet missing or empty.", file=sys.stderr)
        sys.exit(1)

    filter_rows = parse_filter_config(cfg_df)
    metrics_cfg = usable_sa_metrics(filter_rows)
    if not metrics_cfg:
        print("No usable small_area_metric rows in filter_config (check status / map_field / kind).", file=sys.stderr)
        sys.exit(1)

    master_rows = master_df.fillna("").to_dict(orient="records")
    header_set = {norm_key(str(c)) for c in master_df.columns}

    master_index = build_master_index(master_rows)

    if args.fetch_boundaries:
        print("Fetching SA boundaries from GeoHive (Ireland envelope)…", file=sys.stderr)
        fc = fetch_sa_geojson_ireland(max_features=args.max_features)
    else:
        fc = load_geojson(args.boundaries.expanduser().resolve())

    print(f"Features: {len(fc.get('features') or [])}  |  Master rows indexed: {len(master_index)}", file=sys.stderr)

    warnings, matched = merge_workbook_into_features(fc, master_index, metrics_cfg, header_set)
    for w in warnings:
        print(f"Warning: {w}", file=sys.stderr)
    print(f"Polygons matched to workbook rows: {matched}", file=sys.stderr)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc), encoding="utf-8")
    print(f"Wrote {args.output.resolve()}", file=sys.stderr)

    if args.filters_json:
        write_filters_json(args.filters_json, metrics_cfg, header_set)
        print(f"Wrote {args.filters_json.resolve()}", file=sys.stderr)


if __name__ == "__main__":
    main()
