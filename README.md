# RENEW HPHC — High-Potential Households and Communities Map

**Course:** Analytics Live  
**Student:** Ausra Zutautaite  
**Live App:** https://renew-map.vercel.app/  
**Repository:** https://github.com/zutautaite-art/renewhphc

---

## What This Project Does

An interactive map of Ireland identifying high-potential households and communities for participation in Sustainable Energy Communities (SECs). The app visualises CSO 2022 small area statistics — including solar panel adoption, EV households, heat pumps, electric heating, education, income and deprivation (Pobal HP Index) — overlaid on a national small area boundary map. It also displays household and commercial customer locations as dot layers, and includes composite RENEW Potential and Commercial Readiness scores per small area.

---

## How the App Works (Data Flow)

1. **Static map layer** — Small-area polygons and built-in scores load from `public/small_areas_metrics.geojson` (and CSO county / built-up area boundaries from ArcGIS in the browser).

2. **Excel workbook (your upload)** — Expected sheets include `households_clean`, `ev_commercial_clean`, `small_area_master`, `filter_config`, etc. (see `workbookData.ts`). Parsed rows drive **household** (red) and **commercial** (yellow) point layers and metric joins.

3. **Where the workbook is stored**
   - **This browser only:** `IndexedDB` saves the raw file bytes so a reload on the *same* device and browser keeps the workbook without uploading again.
   - **All devices (when deployed on Vercel with Blob):** The same file is also uploaded to **Vercel Blob** at a fixed path (`renewhphc/workbook.xlsx`). On open, the app tries **Blob first**, then falls back to IndexedDB. That way a phone can load the workbook after someone uploaded it on a PC (same deployment / same Blob store).

4. **Manual “dropped” pins** — Separate from Excel dots: pin mode saves markers in IndexedDB. Uploading a **new** Excel clears dropped-pin storage for the *next* reload (session behaviour is described in the UI). Workbook customer dots are unaffected by that logic.

5. **API routes (Vercel only)** — `api/handle-blob-upload.ts` issues client-upload tokens; `api/workbook-remote.ts` returns the public URL of the shared workbook (if present). `vercel.json` rewrites non-`/api/*` routes to the SPA so the API is reachable.

---

## Tech Stack

- **Frontend:** React + TypeScript, Vite  
- **Map:** MapLibre GL JS  
- **Data:** CSO boundaries (ArcGIS REST API), pre-built `small_areas_metrics.geojson`, Excel workbook  
- **Persistence:** IndexedDB (`src/db.ts`); optional **Vercel Blob** for a single shared workbook across devices (`src/workbookBlob.ts`, `api/*`)  
- **Deployment:** Vercel (Git push → build → static `dist/` + serverless `api/`)  
- **Data build script:** Python 3 (`build_sa_geojson.py`)

---

## Repository Structure

```
renewhphc/
├── api/
│   ├── handle-blob-upload.ts   # Vercel: client-upload token handler (@vercel/blob)
│   └── workbook-remote.ts      # Vercel: JSON { url } for shared workbook blob
├── src/
│   ├── App.tsx                  # Shell, filters, upload, restore order (Blob → IDB)
│   ├── App.css
│   ├── workbookBlob.ts          # Client upload + fetch helpers for Vercel Blob
│   ├── components/
│   │   ├── MapView.tsx          # MapLibre, layers, tooltips, pin mode
│   │   └── …
│   ├── cso/
│   ├── db.ts                    # IndexedDB (workbook + dropped pins)
│   ├── workbookData.ts          # Excel parser
│   ├── householdUploadParse.ts
│   └── …
├── public/
│   └── small_areas_metrics.geojson
├── vercel.json                  # SPA rewrites (don’t send /api/* to index.html)
├── build_sa_geojson.py
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
git clone https://github.com/zutautaite-art/renewhphc.git
cd renewhphc
npm install
npm run dev
```

Open http://localhost:5173 (or the URL Vite prints).

**Note:** `npm run dev` serves only the Vite app. **`/api/*` is not available** unless you use **`vercel dev`** (runs the app + Vercel functions). Locally, workbook persistence is **IndexedDB only**; cloud sync is optional on the deployed site.

---

## How to Use the App

1. Open the deployed URL (e.g. https://renew-map.vercel.app/).
2. **Upload the Excel file** in the sidebar. That loads metrics and customer dots. The file is saved in **this browser** (IndexedDB). If **Vercel Blob** is configured, it is also saved to the cloud so **other devices** opening the same site can load it automatically.
3. Toggle **Persona / Metrics** to colour small areas; toggle **RENEW Potential** / **Commercial Readiness** score layers as needed.
4. Use **Location** (town / county) to zoom.
5. Hover small areas for tooltips.
6. **Pin mode** for extra markers; note the in-app reminder about session behaviour when you replace the Excel file.

---

## Wire up Vercel Blob (cross-device workbook)

This is done in the **Vercel dashboard** (not in Git). The app already includes `api/` routes and client code; they only work after a Blob store is linked.

1. Open [Vercel](https://vercel.com) → your **project** (the one that serves this app).  
2. Go to the **Storage** tab → **Create** (or **Connect**) a **Blob** store.  
3. When prompted, **link** that store to this project. Vercel injects **`BLOB_READ_WRITE_TOKEN`** into the project environment (Production / Preview).  
4. **Redeploy** the latest commit (e.g. **Deployments → … → Redeploy**, or push an empty commit) so new env vars are picked up.  
5. Open the **live site** (not `localhost` from `npm run dev` alone — that does not run `/api/*`). Under **Upload**, the grey hint should switch from “Blob is not linked” to **“Cloud storage is ready…”** once the token exists, then to nothing after the first successful upload.

**How you know it’s working**

- **`GET /api/workbook-remote`** returns JSON: `blobConfigured: false` until the token exists; then `noFileYet: true` until someone uploads; then `url` points at the shared file.  
- The UI shows a short **setup hint** under the upload area when Blob is missing or you’re on local dev.  
- **`POST /api/handle-blob-upload`** returns **503** with a clear message if the token is still missing.

After Blob works: **one upload** replaces `renewhphc/workbook.xlsx`; every device that opens the **same deployment URL** loads that file on startup (and still caches a copy in IndexedDB for faster reloads on that device).

### Troubleshooting “linked Blob but file won’t load”

1. On the **live** site, scroll the sidebar to **Upload** → **Run Blob / API diagnostics**. That calls **`GET /api/blob-troubleshoot`** and prints JSON: token present, `head` status, whether the server can read the first byte of the blob, and short hints (no secrets).  
2. Or open these URLs directly in the browser: **`/api/blob-troubleshoot`**, **`/api/workbook-remote`**, **`/api/workbook-download`** (download returns a file only after an upload).  
3. **Redeploy** after linking storage so `api/*` functions receive `BLOB_READ_WRITE_TOKEN`.  
4. **Project root** — Vercel **Root Directory** must be the repo root so **`api/`** is deployed.  
5. **HTML instead of JSON** on `/api/*` — wrong root, wrong project, or old deploy without `api/` routes.  
6. Very large workbooks may hit **serverless response size limits** on **`/api/workbook-download`**; the client then falls back to the public blob `url` when possible.

---

## Deployment

The app deploys on Vercel when you push to the connected branch.

1. Fork or clone the repo and import it in [Vercel](https://vercel.com).  
2. Framework preset: **Vite**; build command `npm run build`; output **`dist`**.  
3. Add **Blob** storage and env as above if you want cross-device workbook sync.  
4. Push to deploy.

---

## Data Protection (Including “Without a Password”)

**Today’s default:** the shared workbook blob is **public** (anyone who obtains the blob URL can download it). The `/api/workbook-remote` endpoint only needs to run on your deployment; the returned URL is unauthenticated.

There is **no strong “lock” without some secret or identity check**. A **password** is one form of secret; others include:

| Approach | “No user password?” | Notes |
|----------|---------------------|--------|
| **Private blob + server proxy** | You can avoid *per-user* passwords by using a **static API key** or **signed cookies** checked only in serverless routes — that is still a **shared secret** (not magic). | Client never sees the blob URL; `GET /api/workbook` streams bytes after checking `Authorization: Bearer …` from env. |
| **Obfuscated pathname** | Slightly harder to guess; **not** real security if the URL leaks. | Random path + store path in env / Edge Config. |
| **Vercel Deployment Protection** | Protects the **whole site** with Vercel’s access gate (may feel like a password for visitors). | Good for internal previews. |
| **IP allowlist / VPN** | No app password | Enterprise-style network controls; not a small-app default. |

**Bottom line:** to materially protect the Excel **without** a classic user login, the usual pattern is **private storage + serverless that reads a secret from the environment** (API key or signed token), not exposing a permanent public blob URL to the browser.

---

## Rebuilding the GeoJSON (Data Update)

The GeoJSON file in `public/` is pre-built. To regenerate after data changes:

```bash
pip install pandas requests openpyxl
python build_sa_geojson.py
```

This fetches CSO small area boundaries from ArcGIS, joins scores, and writes `public/small_areas_metrics.geojson` (roughly 1–3 minutes).

---

## Large Data Files

| File | Description | Location |
|---|---|---|
| `public/small_areas_metrics.geojson` | ~49 MB — small area boundaries + index scores | GitHub repo |
| `cso_equivalent_from_final_master.xlsx` | Master workbook (metrics + customers) | May be shared outside repo |

---

## Recent Changes (Summary)

- **Vercel Blob:** optional shared workbook at `renewhphc/workbook.xlsx`; `api/handle-blob-upload.ts`, `api/workbook-remote.ts`, `src/workbookBlob.ts`, `vercel.json`.  
- **Load order:** try cloud workbook, then IndexedDB.  
- **Upload:** still parses immediately; saves IndexedDB; then uploads to Blob when possible.  
- **Blob wiring UX:** `/api/workbook-remote` reports `blobConfigured` / `noFileYet`; upload area shows setup hints; upload handler returns **503** if the token is missing.  
- **ESLint:** `api/` ignored (Node serverless vs browser globals).
