import json
import urllib.parse
import urllib.request

BASE = (
    "https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/"
    "CensusHub2022_T1_1_LA/FeatureServer/0/query"
)


def query(params: dict) -> dict:
    url = BASE + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read().decode())


def main() -> None:
    r = query({"f": "json", "where": "1=1", "returnCountOnly": "true"})
    print("total", r.get("count"), r.get("error"))

    clauses = [
        "LOCAL_AUTHORITY <> '-'",
        "COUNTY <> '-' AND LA_CODE <> '-'",
        "GEOGDESC LIKE '%County Council%'",
        "GEOGDESC LIKE '%City%'",
    ]
    for w in clauses:
        r = query({"f": "json", "where": w, "returnCountOnly": "true"})
        print(w, "->", r.get("count"), r.get("error"))


if __name__ == "__main__":
    main()
