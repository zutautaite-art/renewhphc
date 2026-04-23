# RENEW HPHC — High-Potential Households and Communities Map

**Course:** Analytics Live  
**Student:** Ausra Zutautaite  
**Live App:** https://renew-map.vercel.app/  
**Repository:** https://github.com/zutautaite-art/renewhphc

---

## What This Project Does

An interactive map of Ireland identifying high-potential households and communities for participation in Sustainable Energy Communities (SECs). The app visualises CSO 2022 small area statistics — including solar panel adoption, EV households, heat pumps, electric heating, education, income and deprivation (Pobal HP Index) — overlaid on a national small area boundary map. It also displays household and commercial customer locations as dot layers, and includes composite RENEW Potential and Commercial Readiness scores per small area.

---

## Tech Stack

- **Frontend:** React 18 + TypeScript, Vite
- **Map:** MapLibre GL JS
- **Data:** CSO Small Area boundaries (ArcGIS REST API), Excel workbook (IndexedDB persistence)
- **Deployment:** Vercel (auto-deploys on git push)
- **Data build script:** Python 3 (`build_sa_geojson.py`)

---

## Repository Structure

```
renewhphc/
├── src/
│   ├── App.tsx                  # Main app shell, sidebar, filter state
│   ├── App.css                  # All styles
│   ├── components/
│   │   ├── MapView.tsx          # MapLibre map, layers, tooltip, pin mode
│   │   ├── FilterSection.tsx    # Sidebar filter group wrapper
│   │   ├── MeasureRow.tsx       # Toggle switch row component
│   │   ├── InformationTable.tsx # Import summary panel
│   │   └── LocationCombobox.tsx # Town/county search combobox
│   ├── cso/                     # CSO boundary fetch + lookup helpers
│   ├── types/                   # TypeScript type definitions
│   ├── db.ts                    # IndexedDB (workbook + pins persistence)
│   ├── workbookData.ts          # Excel parser (households, metrics, config)
│   ├── householdUploadParse.ts  # Household/commercial row parser
│   ├── basemap.ts               # MapLibre basemap config
│   ├── buaLaLink.ts             # BUA ↔ Local Authority linking
│   └── filterAvailability.ts   # Filter availability helpers
├── public/
│   └── small_areas_metrics.geojson  # Built GeoJSON (geometry + index scores)
├── build_sa_geojson.py          # Python script to rebuild GeoJSON
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- npm

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/zutautaite-art/renewhphc.git
cd renewhphc

# 2. Install dependencies
npm install

# 3. Start development server
npm run dev
```

Open http://localhost:5173 in your browser.

---

## How to Use the App

1. **Open** https://renew-map.vercel.app/ (no install needed)
2. **Upload the Excel data file** using the drag & drop area at the bottom of the sidebar — this loads household/commercial dots and SA metric values. The file persists across page reloads via IndexedDB.
3. **Toggle metrics** in the sidebar (Persona / Metrics groups) to colour small areas by that metric
4. **Toggle index layers** (RENEW Potential Score, Commercial Readiness Score) for composite scoring
5. **Search by town or county** using the Location filters to zoom to an area
6. **Hover over any small area** to see a tooltip with all metric values, ED name, county and scores
7. **Drop pins** using the pin mode button to mark household or commercial locations

---

## Rebuilding the GeoJSON (Data Update)

The GeoJSON boundary file is pre-built and committed. To rebuild it after data changes:

### Prerequisites
```bash
pip install pandas requests openpyxl
```

### Run
```bash
python build_sa_geojson.py
```

This fetches ~19,000 CSO small area boundaries from ArcGIS, joins the index scores, and writes `public/small_areas_metrics.geojson`. Takes 1–3 minutes.

---

## Large Data Files

The following files are **not included** in the ZIP submission due to size but are available via the links below:

| File | Description | Location |
|---|---|---|
| `public/small_areas_metrics.geojson` | 49 MB — CSO small area boundaries with index scores | Committed to GitHub repo |
| `cso_equivalent_from_final_master.xlsx` | Master data file with SA metrics, household and commercial data | Shared separately with mentor |

---

## Deployment

The app is deployed on Vercel and auto-deploys on every push to the `main` branch. No manual build step is needed.

To deploy your own instance:
1. Fork the repository
2. Connect to Vercel at https://vercel.com
3. Import the repo — Vercel detects Vite automatically
4. Push to deploy
