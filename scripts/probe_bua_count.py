import json
import urllib.parse
import urllib.request

BASE = (
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/"
    "CensusHub2022_T1_1_BUA/FeatureServer/0/query"
)


def query(params: dict) -> dict:
    url = BASE + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read().decode())


def main() -> None:
    r = query({"f": "json", "where": "1=1", "returnCountOnly": "true"})
    print("BUA total", r.get("count"), r.get("error"))
    # BUA polygons only (not small areas) - try BUA_NAME populated
    r2 = query({"f": "json", "where": "BUA_NAME <> '-'", "returnCountOnly": "true"})
    print("BUA_NAME <> '-'", r2.get("count"), r2.get("error"))


if __name__ == "__main__":
    main()
