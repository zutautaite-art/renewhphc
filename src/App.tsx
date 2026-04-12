
import './App.css'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import * as XLSX from 'xlsx'
import type { FeatureCollection } from 'geojson'
import { FilterSection } from './components/FilterSection'
import { InformationTable, type SelectedSmallAreaPanel } from './components/InformationTable'
import { LocationCombobox } from './components/LocationCombobox'
import { MapView, type ActiveMetric } from './components/MapView'
import { MeasureRow } from './components/MeasureRow'
import type { BasemapMode } from './basemap'
import { fetchCsoCountyAndBuaGeoJson } from './cso/boundaryData'
import type { LocalAuthorityRow } from './cso/geohivePlaces'
import { linkBuaToLocalAuthorities, type LinkedTownOption } from './buaLaLink'
import { parseWorkbookData, type ParsedWorkbookData, type FilterConfigRow } from './workbookData'

const EMPTY_FC: FeatureCollection = { type: 'FeatureCollection', features: [] }
type MetricToggleState = Record<string, boolean>

/** Matches `safe_metric_prop` in scripts/build_sa_geojson.py. */
function metricGeoJsonPropertyName(metricKey: string): string {
  const safe = metricKey.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'metric'
  return `m_${safe}`
}

type StaticFilterManifestEntry = {
  key: string
  group: string
  label: string
  kind?: string
  map_field?: string
  unit?: string
}

function manifestEntryToFilterRow(e: StaticFilterManifestEntry): FilterConfigRow {
  const kindRaw = String(e.kind ?? 'small_area_metric').toLowerCase()
  const kind: FilterConfigRow['kind'] =
    kindRaw === 'town_metric' ? 'town_metric' : kindRaw === 'household_boolean' ? 'household_boolean' : 'small_area_metric'
  const key = String(e.key ?? '').trim()
  /** Labels come from generated `filters.json` only; fall back to `key` from the same file (never invented here). */
  const label = String(e.label ?? '').trim() || key
  return {
    group: String(e.group ?? '').trim() || 'Metrics',
    key,
    label,
    kind,
    mapField: e.map_field ? String(e.map_field) : undefined,
    status: '',
  }
}

function formatSaMetricCell(n: number, unit?: string): string {
  const s = n.toLocaleString(undefined, { maximumFractionDigits: 4 })
  return unit ? `${s} ${unit}`.trim() : s
}

function computeMetricAvailability(fc: FeatureCollection, keys: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const k of keys) out[k] = false
  for (const f of fc.features ?? []) {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    for (const k of keys) {
      if (out[k]) continue
      const v = p[metricGeoJsonPropertyName(k)]
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[k] = true
    }
  }
  return out
}

function computeMetricValueCounts(fc: FeatureCollection, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = 0
  for (const f of fc.features ?? []) {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    for (const k of keys) {
      const v = p[metricGeoJsonPropertyName(k)]
      const n = typeof v === 'number' ? v : Number(v)
      if (Number.isFinite(n)) out[k] += 1
    }
  }
  return out
}

function isUsableMetricFilter(row: FilterConfigRow): boolean {
  if (row.kind === 'household_boolean') return false
  const status = String(row.status ?? '').trim().toLowerCase()
  if (status.startsWith('no clean source')) return false
  if (status.startsWith('no ')) return false
  return true
}

export default function App() {
  const [boundaries, setBoundaries] = useState<{ counties: FeatureCollection; bua: FeatureCollection }>({ counties: EMPTY_FC, bua: EMPTY_FC })
  const [laRows, setLaRows] = useState<LocalAuthorityRow[]>([])
  const [towns, setTowns] = useState<LinkedTownOption[]>([])
  const [placesLoading, setPlacesLoading] = useState(true)
  const [placesError, setPlacesError] = useState<string | null>(null)

  const [basemapMode, setBasemapMode] = useState<BasemapMode>('terrain')
  const [selectedTownCode, setSelectedTownCode] = useState('')
  const [selectedCountyLa, setSelectedCountyLa] = useState('')
  const [householdsLayerOn, setHouseholdsLayerOn] = useState(true)
  const [boundaryCountyLinesOn, setBoundaryCountyLinesOn] = useState(true)
  const [boundaryTownLinesOn, setBoundaryTownLinesOn] = useState(true)
  const [boundarySmallAreaLinesOn, setBoundarySmallAreaLinesOn] = useState(true)

  const [loadedData, setLoadedData] = useState<ParsedWorkbookData | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadDetailLines, setUploadDetailLines] = useState<string[]>([])
  const [importSummary, setImportSummary] = useState<{ sheetName: string; rowsImported: number; detail: string }[] | null>(null)
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null)
  const [activeMetricKeys, setActiveMetricKeys] = useState<MetricToggleState>({})
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [staticFilterManifest, setStaticFilterManifest] = useState<StaticFilterManifestEntry[] | null>(null)
  const [staticSaGeoJson, setStaticSaGeoJson] = useState<FeatureCollection | null>(null)
  const [staticAssetsLoading, setStaticAssetsLoading] = useState(true)
  const [staticAssetsError, setStaticAssetsError] = useState<string | null>(null)
  const [metricUnitsByKey, setMetricUnitsByKey] = useState<Record<string, string | undefined>>({})
  const staticFiltersInitializedRef = useRef(false)
  const [selectedSaProps, setSelectedSaProps] = useState<Record<string, unknown> | null>(null)

  const onSmallAreaSelect = useCallback((props: Record<string, unknown> | null) => {
    setSelectedSaProps(props)
  }, [])

  useEffect(() => {
    let alive = true
    setStaticAssetsLoading(true)
    setStaticAssetsError(null)
    void Promise.all([
      fetch('/small_areas_metrics.filters.json').then((r) => {
        if (!r.ok) throw new Error(`filters.json HTTP ${r.status}`)
        return r.json() as Promise<unknown>
      }),
      fetch('/small_areas_metrics.geojson').then((r) => {
        if (!r.ok) throw new Error(`geojson HTTP ${r.status}`)
        return r.json() as Promise<FeatureCollection>
      }),
    ])
      .then(([filterJson, fc]) => {
        if (!alive) return
        if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
          throw new Error('small_areas_metrics.geojson is not a FeatureCollection')
        }
        const rawList = Array.isArray(filterJson) ? filterJson : []
        const manifest = rawList.filter((x): x is StaticFilterManifestEntry => {
          if (!x || typeof x !== 'object') return false
          const o = x as StaticFilterManifestEntry
          if (typeof o.key !== 'string' || !String(o.key).trim()) return false
          if (typeof o.group !== 'string' || !String(o.group).trim()) return false
          const kind = String(o.kind ?? 'small_area_metric').toLowerCase()
          return kind === 'small_area_metric' || kind === 'town_metric'
        })
        setStaticSaGeoJson(fc)
        setStaticFilterManifest(manifest)
        const units: Record<string, string | undefined> = {}
        for (const e of manifest) units[e.key] = e.unit
        setMetricUnitsByKey(units)
      })
      .catch((err) => {
        if (!alive) return
        console.warn('Static SA assets not loaded; falling back to workbook filters if available.', err)
        setStaticAssetsError(err instanceof Error ? err.message : String(err))
        setStaticFilterManifest(null)
        setStaticSaGeoJson(null)
        setMetricUnitsByKey({})
      })
      .finally(() => {
        if (alive) setStaticAssetsLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setPlacesLoading(true)
    fetchCsoCountyAndBuaGeoJson()
      .then(({ counties, bua }) => {
        if (!alive) return
        setBoundaries({ counties, bua })
        const linked = linkBuaToLocalAuthorities(counties, bua)
        setTowns(linked.towns)
        setLaRows(linked.laRows)
        setPlacesError(null)
      })
      .catch((err) => {
        if (!alive) return
        setPlacesError(err instanceof Error ? err.message : 'Failed to load CSO boundaries')
      })
      .finally(() => {
        if (alive) setPlacesLoading(false)
      })
    return () => { alive = false }
  }, [])

  const townOptions = useMemo(() => {
    const filtered = selectedCountyLa ? towns.filter((t) => t.localAuthority === selectedCountyLa) : towns
    return filtered.map((t) => ({ value: t.buaCode, label: t.label }))
  }, [towns, selectedCountyLa])

  const countyOptions = useMemo(() => laRows.map((r) => ({ value: r.localAuthority, label: r.localAuthority })), [laRows])

  const metricFilters = useMemo(() => {
    if (staticFilterManifest?.length) {
      return staticFilterManifest.map(manifestEntryToFilterRow).filter((f) => f.kind === 'small_area_metric' || f.kind === 'town_metric')
    }
    return (loadedData?.filterConfig ?? []).filter((f) => isUsableMetricFilter(f))
  }, [staticFilterManifest, loadedData])

  const staticMetricKeys = useMemo(() => metricFilters.map((f) => f.key).filter(Boolean), [metricFilters])

  const metricDataAvailability = useMemo(() => {
    if (staticSaGeoJson && staticFilterManifest?.length) return computeMetricAvailability(staticSaGeoJson, staticMetricKeys)
    return null as Record<string, boolean> | null
  }, [staticSaGeoJson, staticFilterManifest, staticMetricKeys])

  const metricValueCounts = useMemo(() => {
    if (staticSaGeoJson && staticFilterManifest?.length) return computeMetricValueCounts(staticSaGeoJson, staticMetricKeys)
    return null as Record<string, number> | null
  }, [staticSaGeoJson, staticFilterManifest, staticMetricKeys])

  const groupedFilters = useMemo(() => {
    const out: Record<string, FilterConfigRow[]> = {}
    for (const f of metricFilters) (out[f.group] ??= []).push(f)
    return out
  }, [metricFilters])

  useEffect(() => {
    if (!staticFilterManifest?.length || !staticSaGeoJson || staticFiltersInitializedRef.current) return
    staticFiltersInitializedRef.current = true
    const avail = computeMetricAvailability(staticSaGeoJson, staticMetricKeys)
    setActiveMetricKeys((prev) => {
      const next = { ...prev }
      for (const f of metricFilters) {
        if (!f.key || f.kind === 'household_boolean') continue
        next[f.key] = !!avail[f.key]
      }
      return next
    })
  }, [staticFilterManifest, staticSaGeoJson, staticMetricKeys, metricFilters])

  const households = useMemo(() => loadedData?.households ?? [], [loadedData])

  const activeMetrics = useMemo<ActiveMetric[]>(() => {
    return metricFilters
      .filter((f) => activeMetricKeys[f.key])
      .map((f) => {
        const fromWorkbook = loadedData?.metricsByKey[f.key]
        const geography: 'small_area' | 'town' = f.kind === 'town_metric' ? 'town' : 'small_area'
        return {
          key: f.key,
          label: f.label,
          geography,
          unit: metricUnitsByKey[f.key] ?? fromWorkbook?.unit,
          values: fromWorkbook?.values ?? {},
        }
      })
  }, [loadedData, metricFilters, activeMetricKeys, metricUnitsByKey])

  const selectedSmallAreaPanel = useMemo((): SelectedSmallAreaPanel | null => {
    if (!selectedSaProps) return null
    const code = String(selectedSaProps.GEOGID ?? '').trim()
    const name = String(selectedSaProps.GEOGDESC ?? '').trim()
    const activeMetricRows = activeMetrics
      .filter((m) => m.geography === 'small_area')
      .map((m) => {
        const prop = metricGeoJsonPropertyName(m.key)
        const raw = selectedSaProps[prop]
        const n = typeof raw === 'number' ? raw : Number(raw)
        const has = Number.isFinite(n)
        return {
          label: m.label,
          valueDisplay: has ? formatSaMetricCell(n, m.unit) : '—',
        }
      })
    return { name, code, activeMetricRows }
  }, [selectedSaProps, activeMetrics])

  useEffect(() => {
    // Lightweight debugging hook for DevTools: lets you inspect what the app is using after upload.
    ;(window as unknown as Record<string, unknown>).__activeMetrics = activeMetrics
    ;(window as unknown as Record<string, unknown>).__households = households
  }, [activeMetrics, households])

  const householdFilterAvailable = households.length > 0
  const metricAvailable = (key: string) => {
    if (metricDataAvailability) return !!metricDataAvailability[key]
    return !!loadedData?.metricsByKey[key]
  }

  function setMetric(key: string, on: boolean) {
    setActiveMetricKeys((prev) => ({ ...prev, [key]: on }))
  }

  async function handleWorkbook(file: File) {
    try {
      const buffer = await file.arrayBuffer()
      const wb = XLSX.read(buffer, { type: 'array' })
      const parsed = parseWorkbookData(wb)
      setSelectedSaProps(null)
      setLoadedData(parsed)
      setImportSummary(parsed.importSummary)
      setUploadDetailLines(parsed.warnings)
      setUploadError(null)
      setLoadedFileName(file.name)

      if (!staticFilterManifest?.length) {
        const next: MetricToggleState = {}
        for (const row of parsed.filterConfig) {
          if (!isUsableMetricFilter(row)) continue
          next[row.key] = !!parsed.metricsByKey[row.key]
        }
        setActiveMetricKeys(next)
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to read workbook')
    }
  }

  function handleUploadChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    void handleWorkbook(file)
  }

  function onTownChange(nextCode: string) {
    setSelectedTownCode(nextCode)
    const town = towns.find((t) => t.buaCode === nextCode)
    setSelectedCountyLa(town?.localAuthority ?? '')
  }

  function onCountyChange(nextLa: string) {
    setSelectedCountyLa(nextLa)
    if (!nextLa) return
    const town = towns.find((t) => t.buaCode === selectedTownCode)
    if (town && town.localAuthority !== nextLa) setSelectedTownCode('')
  }

  return (
    <div className="appShell">
      <header className="topBar">
        <div>
          <div className="brandTitle">RENEW HPHC</div>
          <div className="brandSubtitle">High-Potential Households and Communities for Participation in Sustainable Energy Community</div>
        </div>
      </header>
      <main className="main">
        <aside className="leftPanel">
          <div className="leftPanelScroll">
            <div className="panelHeader">Filters</div>
            {staticAssetsError ? (
              <p className="locationBlockError" role="status">
                Small-area bundle not loaded ({staticAssetsError}). Place <code>public/small_areas_metrics.geojson</code> and{' '}
                <code>public/small_areas_metrics.filters.json</code> (run <code>scripts/build_sa_geojson.py</code>).
              </p>
            ) : null}

            <section className="basemapBlock">
              <div className="filterBlockTitle">Basemap</div>
              <MeasureRow switchId="basemap-terrain" dataOn={basemapMode === 'terrain'} onDataOnChange={(on) => on && setBasemapMode('terrain')}>
                <div className="measureRowLabelOnly"><strong>OpenStreetMap</strong> (standard)</div>
              </MeasureRow>
              <MeasureRow switchId="basemap-satellite" dataOn={basemapMode === 'satellite'} onDataOnChange={(on) => on && setBasemapMode('satellite')}>
                <div className="measureRowLabelOnly"><strong>Satellite imagery</strong></div>
              </MeasureRow>
            </section>

            <section className="basemapBlock">
              <div className="filterBlockTitle">Administrative boundaries <span className="filterTitleRest">(CSO)</span></div>
              <MeasureRow switchId="county-boundaries" dataOn={boundaryCountyLinesOn} onDataOnChange={setBoundaryCountyLinesOn}>
                <div className="measureRowLabelOnly"><strong>County</strong> (outlines &amp; labels)</div>
              </MeasureRow>
              <MeasureRow switchId="town-boundaries" dataOn={boundaryTownLinesOn} onDataOnChange={setBoundaryTownLinesOn}>
                <div className="measureRowLabelOnly"><strong>Town</strong> (built-up area)</div>
              </MeasureRow>
              <MeasureRow switchId="sa-boundaries" dataOn={boundarySmallAreaLinesOn} onDataOnChange={setBoundarySmallAreaLinesOn}>
                <div className="measureRowLabelOnly"><strong>Small area</strong> (mesh)</div>
              </MeasureRow>
            </section>

            <section className="locationBlock">
              <div className="filterBlockTitle">Location</div>
              <p className="locationBlockHint">Type a town to jump to that town. Choosing a town also sets the matching county. If you pan or zoom away, the location filters clear automatically.</p>
              <LocationCombobox label="Town (built-up area)" placeholder="Type or scroll to choose a built-up area..." options={townOptions} value={selectedTownCode} onChange={onTownChange} loading={placesLoading} allowEmptyOptions />
              <LocationCombobox label="County (CSO local authority)" placeholder="Type or scroll to choose a county..." options={countyOptions} value={selectedCountyLa} onChange={onCountyChange} loading={placesLoading} allowEmptyOptions />
              {placesError ? <p className="locationBlockError">{placesError}</p> : null}
            </section>

            <FilterSection sectionId="household" titleBold="Household">
              <MeasureRow switchId="households-layer" dataOn={householdsLayerOn} onDataOnChange={setHouseholdsLayerOn} dataAvailable={householdFilterAvailable}>
                <div className="measureRowLabelOnly"><strong>Identified Potential Customer</strong></div>
              </MeasureRow>
            </FilterSection>

            {Object.entries(groupedFilters).map(([group, rows]) => (
              <FilterSection key={group} sectionId={`group-${group}`} titleBold={group}>
                {rows.map((f) => (
                  <MeasureRow key={f.key} switchId={`metric-${f.key}`} dataOn={!!activeMetricKeys[f.key]} onDataOnChange={(on) => setMetric(f.key, on)} dataAvailable={metricAvailable(f.key)}>
                    <div className="measureRowLabelOnly"><strong>{f.label}</strong></div>
                  </MeasureRow>
                ))}
              </FilterSection>
            ))}

            <InformationTable
              activeMetrics={activeMetrics.map((m) => ({
                label: m.label,
                geography: m.geography,
                loadedAreas: metricValueCounts?.[m.key] ?? Object.keys(m.values).length,
                unit: m.unit,
              }))}
              selectedSmallArea={selectedSmallAreaPanel}
              households={households}
              loadedFileName={loadedFileName}
              warnings={uploadDetailLines}
              importSummary={importSummary ?? []}
              uploadError={uploadError}
            />

            <div className="uploadFooterInScroll">
              <div className="uploadFooterTitle">
                <div className="panelHeader">Upload</div>
                <div className="uploadFooterMeta">Data stays loaded until a new file is loaded successfully.</div>
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleUploadChange} />
            </div>
          </div>
        </aside>

        <MapView
          boundaries={boundaries}
          basemapMode={basemapMode}
          focusBuaCode={selectedTownCode || undefined}
          focusCountyLa={selectedCountyLa || undefined}
          onLocationFilterAutoClear={() => {
            setSelectedTownCode('')
            setSelectedCountyLa('')
          }}
          activeMetrics={activeMetrics}
          smallAreasGeoJson={staticSaGeoJson ?? EMPTY_FC}
          smallAreasGeoJsonLoading={staticAssetsLoading}
          households={households}
          householdsLayerVisible={householdsLayerOn}
          boundaryCountyLinesVisible={boundaryCountyLinesOn}
          boundaryTownLinesVisible={boundaryTownLinesOn}
          boundarySmallAreaLinesVisible={boundarySmallAreaLinesOn}
          onSmallAreaSelect={onSmallAreaSelect}
        />
      </main>
    </div>
  )
}
