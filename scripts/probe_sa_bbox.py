import json
import urllib.parse
import urllib.request

BASE = (
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/"
    "SMALL_AREA_2022_Genralised_20m_view/FeatureServer/0/query"
)


def query(params: dict) -> dict:
    url = BASE + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read().decode())


def main() -> None:
    # Rough bbox around Maynooth in WGS84
    # Service native SR is EPSG:2157 (Irish Transverse Mercator)
    geom = "705000,730000,720000,738000"
    r = query(
        {
            "f": "geojson",
            "where": "1=1",
            "geometry": geom,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "2157",
            "spatialRel": "esriSpatialRelIntersects",
            "outSR": "4326",
            "returnGeometry": "true",
            "outFields": "GUID,GEOGID,GEOGDESC",
            "resultRecordCount": "500",
        }
    )
    fts = r.get("features") or []
    print("features", len(fts), "exceeded", r.get("properties", {}).get("exceededTransferLimit"))
    if r.get("error"):
        print("error", r["error"])


if __name__ == "__main__":
    main()
