#!/usr/bin/env python3
"""
Offline mirror of in-app logic: read Excel, group similar county names, sum a numeric
measure by county and (when present) by small-area style columns.

Usage:
  pip install pandas openpyxl
  python scripts/aggregate_excel_households.py path/to/file.xlsx

This does not replace the map — use the renewhphc app for GeoHive placement.
"""
from __future__ import annotations

import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

try:
    import pandas as pd
except ImportError:
    print("Install dependencies: pip install pandas openpyxl", file=sys.stderr)
    sys.exit(1)


COUNTY_KEYS = [
    "county",
    "county_name",
    "local_authority",
    "la",
    "region",
    "area",
]

# Align with householdUploadParse.ts UPLOAD_METRIC_KEYS (first match wins).
METRIC_KEYS = [
    "value",
    "metric",
    "amount",
    "total",
    "score",
    "weight",
    "data",
    "data_value",
    "quantity",
    "sum",
    "potential_customers",
    "customers",
    "population",
    "kwh",
    "mwh",
]

SA_SUBSTRINGS = ("small_area", "geogid", "sa_code", "sa_geogid")

SKIP_METRIC_COLS = frozenset(
    {
        "id",
        "lat",
        "lon",
        "latitude",
        "longitude",
        "lng",
        "bua_code",
        "geogid",
        "cso_small_area_code",
        "small_area_code",
    }
)


def norm_county_label(s: object) -> str:
    t = str(s).strip().lower()
    for suffix in (
        " city and county council",
        " county council",
        " city council",
        " council",
        " co.",
        " county",
    ):
        if t.endswith(suffix):
            t = t[: -len(suffix)].strip()
    return t


def merge_similar_labels(labels: list[str], threshold: float = 0.86) -> dict[str, str]:
    """Map each normalised label to one canonical string (mutually similar names share one)."""
    labs = sorted(set(labels))
    if not labs:
        return {}
    parent = list(range(len(labs)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[find(parent[i])]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        pi, pj = find(i), find(j)
        if pi != pj:
            parent[pi] = pj

    for i in range(len(labs)):
        for j in range(i + 1, len(labs)):
            if SequenceMatcher(None, labs[i], labs[j]).ratio() >= threshold:
                union(i, j)

    root_rep: dict[int, str] = {}
    for i, lab in enumerate(labs):
        r = find(i)
        if r not in root_rep:
            root_rep[r] = lab

    return {lab: root_rep[find(i)] for i, lab in enumerate(labs)}


def pick_metric_column(df: pd.DataFrame) -> str | None:
    cols = [c for c in df.columns if c not in SKIP_METRIC_COLS and c not in COUNTY_KEYS]
    for key in METRIC_KEYS:
        if key in df.columns:
            return key
    # Fallback: first column that is mostly numeric
    best: tuple[float, str] | None = None
    for c in cols:
        s = pd.to_numeric(df[c], errors="coerce")
        ratio = float(s.notna().sum()) / max(len(df), 1)
        if ratio >= 0.55 and (best is None or ratio > best[0]):
            best = (ratio, c)
    return best[1] if best else None


def parse_number_series(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series.astype(str).str.replace(",", ".", regex=False), errors="coerce").fillna(0.0)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python aggregate_excel_households.py <file.xlsx>", file=sys.stderr)
        sys.exit(1)
    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"Not found: {path}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_excel(path, sheet_name=0)
    df.columns = [re.sub(r"\s+", "_", str(c).strip().lower()) for c in df.columns]

    county_col = next((c for c in COUNTY_KEYS if c in df.columns), None)
    metric_col = pick_metric_column(df)

    if county_col:
        raw_norm = df[county_col].map(lambda x: norm_county_label(x) if pd.notna(x) and str(x).strip() else "")
        nonempty = raw_norm[raw_norm != ""].unique().tolist()
        canon_map = merge_similar_labels(sorted(nonempty))
        df["_county_canon"] = raw_norm.map(lambda x: canon_map.get(x, x) if x else "")

        print("--- County groups (similar names merged, threshold 0.86) ---")
        for raw, canon in sorted(canon_map.items()):
            if raw != canon:
                print(f"  '{raw}' -> '{canon}'")
        print()

        if metric_col:
            sums = df[df["_county_canon"] != ""].groupby("_county_canon")[metric_col].apply(lambda s: parse_number_series(s).sum())
            print(f"--- Sum of '{metric_col}' by merged county ---")
            print(sums.sort_index().to_string())
        else:
            print("--- Row counts by merged county ---")
            print(df[df["_county_canon"] != ""].groupby("_county_canon").size().sort_index().to_string())
        print()

    sa_cols = [
        c
        for c in df.columns
        if any(sub in c for sub in SA_SUBSTRINGS) or c in ("geogid", "sa_geogid", "cso_small_area_code", "small_area_code")
    ]
    sa_cols = [c for c in sa_cols if c in df.columns and not str(c).startswith("_")]
    if sa_cols and metric_col:
        sc = sa_cols[0]
        sub = df[df[sc].astype(str).str.strip() != ""]
        w = parse_number_series(sub[metric_col])
        print(f"--- Sum of '{metric_col}' by '{sc}' (first small-area column) ---")
        out = sub.assign(_w=w).groupby(sc, dropna=False)["_w"].sum().sort_index()
        print(out.head(40).to_string())
        if len(out) > 40:
            print(f"... ({len(out)} areas total)")
        print()

    print("Total rows:", len(df))
    if metric_col:
        print(f"Measure column: {metric_col}")
    else:
        print("No measure column detected — using row counts where applicable.")


if __name__ == "__main__":
    main()
