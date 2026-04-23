# RENEW HPHC — High-Potential Households and Communities Map (Handover)

**Repository name:** `renewhphc`  
**Live app:** `https://renew-map.vercel.app/` (Vercel)  
**Primary code:** React + TypeScript + Vite + MapLibre GL  

> This README is written for project handover. It is based on the current codebase and scripts. Any item that cannot be verified from code is marked **needs confirmation**.

---

## 1. Project title

RENEW HPHC — High-Potential Households and Communities Map

## 2. Project overview and purpose

This project is a browser-based interactive map of Ireland for exploring small-area metrics and uploaded point data (household and commercial/customer locations). It combines:

- A prebuilt small-area GeoJSON file for map shading/tooltip metrics (`public/small_areas_metrics.geojson`)
- Live boundary lookups for counties (local authorities) and towns (built-up areas) from CSO GeoHive ArcGIS REST endpoints
- An Excel workbook upload workflow (parsed client-side) with persistence (IndexedDB) and optional cloud sync (Vercel Blob)

## 3. Problem the app solves / project context

**Context:** Analytics Live / university-style project (**needs confirmation**: exact module requirements).  
**Problem:** provide a single interface to (a) visualise CSO Census 2022 boundary geographies, (b) overlay metric-based choropleths by small area or town/county context, and (c) overlay uploaded household/business points and interactively explore and annotate them (pins).

## 4. Key features

- **Interactive MapLibre map** with basemap switch (`terrain`/OSM raster and `satellite`/Esri imagery)
- **Small-area choropleth** driven by `public/small_areas_metrics.geojson`
- **Hover tooltip** showing small-area info and a metrics table (“Metric (CSO 2022)”, “No”, “%”)
- **Location filters**: county (CSO local authority) and town (CSO built-up areas) selection with zoom/focus behavior
- **Excel workbook upload** (client-side parsing with `xlsx`)
- **Cloud workbook sync**: upload to Vercel Blob via `/api/upload`; restore via `/api/workbook`
- **Local persistence**:
  - Workbook bytes cached in IndexedDB (`src/db.ts`)
  - Dropped pins persisted in IndexedDB (`src/db.ts`)
- **Dropped pins workflow** (household/business) with basic attributes (solar/ev/heat pump yes/no/unknown)

## 5. What makes this project distinctive

- Combines **precomputed small-area metrics GeoJSON** with **live GeoHive boundary queries** (counties/BUAs) for UI filtering and navigation
- Robust-ish upload parsing for coordinates and headers (see `src/householdUploadParse.ts` and `src/workbookData.ts`)
- Persists user work in-browser (workbook + pins), with optional multi-device workbook access through Vercel Blob

## 6. High-level architecture

- **Frontend (Vite + React)** renders the UI and the map, reads `public/` assets, fetches CSO boundaries, parses the uploaded Excel, and stores local state in IndexedDB.
- **Serverless API (Vercel)** provides:
  - `POST /api/upload` → writes the uploaded Excel bytes to Vercel Blob (`@vercel/blob`)
  - `GET /api/workbook` → finds the latest blob, fetches it, and streams it back as an XLSX attachment
- **External services**:
  - CSO GeoHive ArcGIS REST endpoints for LA/BUA/small-area boundary geometry/attributes (see `src/cso/arcgisGeoJson.ts`)
  - Vercel Blob storage for workbook bytes

## 7. Mermaid architecture diagram showing main app parts and data flow

```mermaid
flowchart LR
  U[User] -->|Browser| FE[React UI (Vite)]

  subgraph Frontend
    FE --> MV[MapView (MapLibre)]
    FE --> WB[Workbook parser (xlsx)]
    FE --> IDB[IndexedDB (workbook + pins)]
  end

  MV -->|GET /small_areas_metrics.geojson| PUB[public/ assets]
  MV -->|Fetch county/BUA boundaries| CSO[CSO GeoHive ArcGIS REST]

  FE -->|POST /api/upload (bytes)| APIU[Vercel API: api/upload.ts]
  APIU -->|put()| BLOB[Vercel Blob]

  FE -->|GET /api/workbook| APIW[Vercel API: api/workbook.ts]
  APIW -->|list() + fetch(blob)| BLOB
  APIW -->|stream XLSX bytes| FE

  FE -->|cache workbook| IDB
```

## 8. Tech stack

- **Frontend**: React (`react`, `react-dom`), TypeScript, Vite
- **Mapping**: MapLibre GL (`maplibre-gl`)
- **Excel parsing**: `xlsx`
- **CSV parsing**: `papaparse` (present in deps; usage **needs confirmation**)
- **Cloud storage**: `@vercel/blob` via Vercel Serverless Functions (`api/`)
- **Linting**: ESLint + `typescript-eslint` (`eslint.config.js`)
- **Python utilities**: scripts in `scripts/` and a root `build_sa_geojson.py` for building GeoJSON from an Excel workbook

## 9. Prerequisites

- **Node.js**: **20+ recommended** (the installed `@vercel/blob` package declares `node >= 20` in `package-lock.json`)
- **npm**
- Optional for data build scripts: **Python 3** + `pandas` + `openpyxl`

## 10. Installation steps

```bash
git clone https://github.com/zutautaite-art/renewhphc.git
cd renewhphc
npm install
```

## 11. How to run locally

```bash
npm run dev
```

Vite is configured to use host mode and port 5173 (`vite.config.ts`). The app should open a browser automatically.

## 12. How to build for production

```bash
npm run build
```

This runs `tsc -b` and then `vite build` (see `package.json`).

## 13. How to deploy

Deployment is intended for **Vercel** (no `vercel.json` is present; Vercel auto-detects).

- **Frontend**: built by Vercel from the Vite project
- **API**: Vercel Serverless Functions from the `api/` directory

**needs confirmation:** whether any Vercel settings (rewrites, regions, build output directory) were customized in the Vercel dashboard.

## 14. Configuration

- Vite dev server settings: `vite.config.ts`
- ESLint configuration: `eslint.config.js`
- TypeScript projects:
  - App: `tsconfig.app.json` (includes `src/`)
  - Node/Vite config: `tsconfig.node.json` (includes `vite.config.ts`)

## 15. Environment variables

Required for Blob-backed workbook download in production (server-side):

- `BLOB_READ_WRITE_TOKEN`: used by `api/workbook.ts` to fetch the latest blob with an `Authorization: Bearer ...` header.

Local development convention: `.env.local` (ignored by git via `*.local` in `.gitignore`).

## 16. API keys / external services used

- **Vercel Blob** (`@vercel/blob`)
  - Token: `BLOB_READ_WRITE_TOKEN`
- **CSO GeoHive ArcGIS REST** (Census 2022) for boundaries and attributes (see `src/cso/arcgisGeoJson.ts`)
- **Basemap tiles**:
  - OpenStreetMap raster tiles (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`)
  - Esri World Imagery raster tiles (`https://server.arcgisonline.com/.../World_Imagery/...`)

## 17. Data sources / input files

- **Prebuilt small-area GeoJSON**: `public/small_areas_metrics.geojson`
  - Used directly by the app as `/small_areas_metrics.geojson` in `MapView` (`SA_GEOJSON_URL`)
- **Optional filter manifest**: `public/small_areas_metrics.filters.json` (**needs confirmation**: whether the app reads this at runtime)
- **Excel workbook input**: uploaded by the user
  - Parsed by `src/workbookData.ts` + `src/householdUploadParse.ts`
  - Persisted locally in IndexedDB (`src/db.ts`)
  - Uploaded to Vercel Blob via `api/upload.ts`

## 18. Project structure and explanation of important folders/files

```
renewhphc/
├── api/
│   ├── upload.ts                 # POST bytes → Vercel Blob put(workbook/<filename>)
│   └── workbook.ts               # GET latest blob → fetch + stream XLSX attachment
├── public/
│   ├── small_areas_metrics.geojson
│   ├── small_areas_metrics.filters.json
│   └── icons.svg
├── scripts/
│   ├── build_sa_geojson.py        # Build GeoJSON from workbook + GeoHive SA boundaries
│   ├── aggregate_excel_households.py
│   └── probe_*.py, peek-geojson-props.mjs
├── src/
│   ├── main.tsx                   # React entry
│   ├── App.tsx                    # Main UI, upload handling, state wiring, calls /api/*
│   ├── App.css                    # App styling including responsive layout
│   ├── components/MapView.tsx      # MapLibre map, layers, hover tooltip, pin UI
│   ├── db.ts                      # IndexedDB (workbook + pins)
│   └── cso/                        # GeoHive ArcGIS REST helpers + boundary lookup logic
└── build_sa_geojson.py             # Legacy/alternative GeoJSON build script (root-level)
```

## 19. Usage instructions for end users or researchers

- Open the app and let boundaries load (counties + built-up areas).
- Use the sidebar to toggle visibility of:
  - Boundary line layers (county/town/small area)
  - Uploaded point layers (households / commercial)
- Upload the Excel workbook using the upload UI in the sidebar.
- Hover over small areas to read the metrics tooltip.
- Optionally drop pins on the map and edit pin attributes.

## 20. Example workflows (filtering, map use, upload, drop pin, saving data)

- **Upload workbook**:
  - Upload file → parsed in-browser → cached in IndexedDB (`saveWorkbook`) → uploaded to Blob (`/api/upload`).
- **Restore workbook on next visit**:
  - Try IndexedDB first (`loadWorkbook`) → if missing, call `/api/workbook` and cache the streamed XLSX.
- **Explore by geography**:
  - Select a county/local authority → map zooms/focuses (**exact behavior needs confirmation**; implemented via `MapView` focus props)
  - Select a town/built-up area → map zooms/focuses (**needs confirmation**)
- **Hover + read metrics**:
  - Hover a small area polygon → tooltip table shows “Metric (CSO 2022)” with “No” and “%” columns.
- **Drop pins**:
  - Enable pin mode → click map to add a pin → persists in IndexedDB (`savePinToDb`).

## 21. Screenshots

Add screenshots here (placeholders):

- `docs/screenshots/01-home.png` (**not present; needs confirmation**)
- `docs/screenshots/02-tooltip.png` (**not present; needs confirmation**)
- `docs/screenshots/03-upload.png` (**not present; needs confirmation**)

## 22. Testing

No automated test framework or `npm test` script is present in `package.json`. (**needs confirmation**: any external/manual test checklist.)

## 23. Known issues / limitations

- **Type checking coverage**: `tsconfig.app.json` includes only `src/`, so `api/` TypeScript is not compiled by `npm run build` (Vercel compiles serverless functions separately).
- **Blob security model**: `api/upload.ts` writes blobs with `access: 'public'`, but `api/workbook.ts` fetches with an Authorization header. Whether blobs should be public or private is **needs confirmation**.
- **Large GeoJSON**: `public/small_areas_metrics.geojson` may be large; expect slower initial load on low-memory devices (**needs confirmation**: current file size in the deployed build output).

## 24. To-do / future improvements

- Add automated tests (at least parser unit tests for `workbookData.ts` and `householdUploadParse.ts`).
- Add CI (lint + typecheck) and ensure API functions are typechecked in CI.
- Consider a stricter and documented Blob access strategy (private blobs + signed URLs or server proxy only).
- Document the expected Excel workbook schema (sheets + columns) explicitly for end users.

## 25. Maintenance / handover notes for the next developer

- Start with `src/App.tsx` (state + upload + wiring) and `src/components/MapView.tsx` (map logic).
- The workbook parsing contract is centralized in `src/workbookData.ts` and `src/householdUploadParse.ts`.
- Rebuilding small-area metrics GeoJSON can be done via `scripts/build_sa_geojson.py` (see docstring for usage).
- Keep `.env.local` out of git; use Vercel Environment Variables for production.

## 26. Contributors / maintainers

- **Primary author/maintainer:** **needs confirmation** (name appears in older README variants in this repo)

## 27. Links to related documentation or external references

- CSO: `https://www.cso.ie/`
- Vercel Blob: `https://vercel.com/docs/storage/vercel-blob`
- MapLibre GL JS: `https://maplibre.org/maplibre-gl-js/docs/`
- GeoHive (ArcGIS REST): **needs confirmation** (links to the specific Census Hub layers used in `src/cso/arcgisGeoJson.ts`)

## 28. License

No license file is present in this repository. **needs confirmation**: whether this should be MIT/Apache/etc. or restricted to university submission use.
