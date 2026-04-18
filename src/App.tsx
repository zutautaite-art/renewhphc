
import './App.css'
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import * as XLSX from 'xlsx'
import { saveWorkbook, loadWorkbook, type StoredWorkbook } from './db'
import type { FeatureCollection } from 'geojson'
import { FilterSection } from './components/FilterSection'
import { InformationTable } from './components/InformationTable'
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

/** Default sidebar labels when no workbook is loaded; upload replaces with `filterConfig` from the file. */
const DEFAULT_FILTER_CONFIG: FilterConfigRow[] = [
  { group: 'Persona', key: 'age_35_44', label: 'Age 35–44', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'age_35_44_no', mapField: 'age_35_44_pct' },
  { group: 'Persona', key: 'families_children', label: 'Families with Children', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'couple_children_no', mapField: 'couple_children_pct' },
  { group: 'Persona', key: 'education_degree_plus', label: 'Education (Bachelors+)', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'degree_plus_no', mapField: 'degree_plus_pct' },
  { group: 'Persona', key: 'income_profile', label: 'Income', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'income_no', mapField: 'income_pct' },
  { group: 'Persona', key: 'phobal_score', label: 'Phobal', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'phobal_score', mapField: 'phobal_score' },
  { group: 'Persona', key: 'occupation_manager_professional', label: 'Occupation (Managers & Professionals)', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'manager_professional_no', mapField: 'manager_professional_pct' },
  { group: 'Metrics', key: 'electric_heating', label: 'Electric Heating', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'electric_no', mapField: 'electric_pct' },
  { group: 'Metrics', key: 'solar_panels', label: 'Solar', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'solar_no', mapField: 'solar_pct' },
  { group: 'Metrics', key: 'ev_households', label: 'EV Households', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'ev_households_no', mapField: 'ev_households_pct' },
  { group: 'Metrics', key: 'heat_pumps', label: 'Heat Pumps', kind: 'small_area_metric', status: 'Use', source: '', rawField: 'heat_pump_no', mapField: 'heat_pump_pct' },
]

function isUsableMetricFilter(row: FilterConfigRow): boolean {
  if (row.kind === 'household_boolean') return false
  const status = String(row.status ?? '').trim().toLowerCase()
  if (status && status !== 'use') return false
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
  const [evCommercialLayerOn, setEvCommercialLayerOn] = useState(true)
  const [boundaryCountyLinesOn, setBoundaryCountyLinesOn] = useState(true)
  const [boundaryTownLinesOn, setBoundaryTownLinesOn] = useState(true)
  const [boundarySmallAreaLinesOn, setBoundarySmallAreaLinesOn] = useState(true)

  const [loadedData, setLoadedData] = useState<ParsedWorkbookData | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadDetailLines, setUploadDetailLines] = useState<string[]>([])
  const [importSummary, setImportSummary] = useState<{ sheetName: string; rowsImported: number; detail: string }[] | null>(null)
  const [loadedFileName, setLoadedFileName] = useState<string | null>(null)
  const [activeMetricKeys, setActiveMetricKeys] = useState<MetricToggleState>({})
  const [geoJsonReady, setGeoJsonReady] = useState(false)
  const [statsReadyAt, setStatsReadyAt] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const hasWorkbookMetrics = useMemo(
    () => !!(loadedData && Object.keys(loadedData.metricsByKey).length > 0),
    [loadedData],
  )

  // ── Restore from IndexedDB on mount ────────────────────────────────────────
  useEffect(() => {
    loadWorkbook().then((stored: StoredWorkbook | null) => {
      if (!stored) return
      try {
        const wb     = XLSX.read(stored.buffer, { type: 'array' })
        const parsed = parseWorkbookData(wb)
        setLoadedData(parsed)
        setImportSummary(parsed.importSummary)
        setUploadDetailLines(parsed.warnings)
        setUploadError(null)
        setLoadedFileName(stored.name)
      } catch (err) {
        console.warn('IndexedDB restore failed:', err)
      }
    }).catch(() => { /* ignore */ })
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

  const effectiveFilterConfig =
    loadedData?.filterConfig?.length ? loadedData.filterConfig : DEFAULT_FILTER_CONFIG

  const metricFilters = useMemo(
    () => effectiveFilterConfig.filter((f) => isUsableMetricFilter(f) && (f.kind === 'small_area_metric' || f.kind === 'town_metric')),
    [effectiveFilterConfig],
  )

  const groupedFilters = useMemo(() => {
    const out: Record<string, FilterConfigRow[]> = {}
    for (const f of metricFilters) (out[f.group] ??= []).push(f)
    return out
  }, [metricFilters])

  const filtersReady = geoJsonReady || !!loadedData

  const households = useMemo(() => loadedData?.households ?? [], [loadedData])
  const evCommercial = useMemo(() => loadedData?.evCommercial ?? [], [loadedData])

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
          unit: fromWorkbook?.unit,
          values: fromWorkbook?.values ?? {},
        }
      })
  // statsReadyAt: GeoJSON stats can arrive after toggles; bump forces new `activeMetrics` reference for MapView
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional bump when MapView stats are ready
  }, [loadedData, metricFilters, activeMetricKeys, statsReadyAt])

  useEffect(() => {
    // Lightweight debugging hook for DevTools: lets you inspect what the app is using after upload.
    ;(window as unknown as Record<string, unknown>).__activeMetrics = activeMetrics
    ;(window as unknown as Record<string, unknown>).__households = households
  }, [activeMetrics, households])

  const householdFilterAvailable = loadedData ? households.length > 0 : undefined
  const metricAvailable = (_key: string) => filtersReady

  function setMetric(key: string, on: boolean) {
    setActiveMetricKeys((prev) => ({ ...prev, [key]: on }))
  }

  async function handleWorkbook(file: File) {
    try {
      const buffer = await file.arrayBuffer()
      const wb     = XLSX.read(buffer, { type: 'array' })
      const parsed = parseWorkbookData(wb)
      setLoadedData(parsed)
      setImportSummary(parsed.importSummary)
      setUploadDetailLines(parsed.warnings)
      setUploadError(null)
      setLoadedFileName(file.name)
      // Save raw bytes to IndexedDB — restored on next page load
      saveWorkbook(file.name, buffer).catch((e: unknown) => console.warn('IndexedDB save failed:', e))
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

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void handleWorkbook(file)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(true)
  }

  function handleDragLeave() {
    setDragOver(false)
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

            <FilterSection sectionId="customers" titleBold="Customers:">
              <MeasureRow switchId="households-layer" dataOn={householdsLayerOn} onDataOnChange={setHouseholdsLayerOn} dataAvailable={householdFilterAvailable}>
                <strong>Households</strong>
              </MeasureRow>
              <MeasureRow
                switchId="ev-commercial-layer"
                dataOn={evCommercialLayerOn}
                onDataOnChange={setEvCommercialLayerOn}
                dataAvailable={loadedData ? (loadedData.evCommercial?.length ?? 0) > 0 : undefined}
              >
                <strong>EV Commercial</strong>
              </MeasureRow>
            </FilterSection>

            <section className="basemapBlock">
              <div className="filterBlockTitle">Filter actions</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="filterActionBtn"
                  disabled={!filtersReady}
                  style={{ opacity: filtersReady ? 1 : 0.45, cursor: filtersReady ? 'pointer' : 'not-allowed' }}
                  onClick={() => {
                    const next: MetricToggleState = {}
                    if (hasWorkbookMetrics && loadedData) {
                      for (const row of metricFilters) {
                        next[row.key] = !!loadedData.metricsByKey[row.key]
                      }
                    } else {
                      for (const row of metricFilters) {
                        next[row.key] = true
                      }
                    }
                    setActiveMetricKeys(next)
                  }}
                >
                  Load All
                </button>
                <button
                  type="button"
                  className="filterActionBtn"
                  onClick={() => {
                    const next: MetricToggleState = {}
                    for (const row of metricFilters) next[row.key] = false
                    setActiveMetricKeys(next)
                  }}
                >
                  Clear All
                </button>
              </div>
            </section>

            {Object.entries(groupedFilters).map(([group, rows]) => (
              <Fragment key={group}>
                <div style={{ display: 'flex', gap: 6, margin: '4px 0 2px' }}>
                  <button
                    type="button"
                    className="filterActionBtn"
                    disabled={!filtersReady}
                    style={{ opacity: filtersReady ? 1 : 0.45, cursor: filtersReady ? 'pointer' : 'not-allowed' }}
                    onClick={() => {
                      const next = { ...activeMetricKeys }
                      if (hasWorkbookMetrics && loadedData) {
                        for (const row of rows) next[row.key] = !!loadedData.metricsByKey[row.key]
                      } else {
                        for (const row of rows) next[row.key] = true
                      }
                      setActiveMetricKeys(next)
                    }}
                  >
                    {group} All On
                  </button>
                  <button
                    type="button"
                    className="filterActionBtn"
                    onClick={() => {
                      const next = { ...activeMetricKeys }
                      for (const row of rows) next[row.key] = false
                      setActiveMetricKeys(next)
                    }}
                  >
                    {group} All Off
                  </button>
                </div>

                <FilterSection sectionId={`group-${group}`} titleBold={`${group}:`}>
                  {rows.map((f) => (
                    <MeasureRow
                      key={f.key}
                      switchId={`metric-${f.key}`}
                      dataOn={!!activeMetricKeys[f.key]}
                      onDataOnChange={(on) => setMetric(f.key, on)}
                      dataAvailable={metricAvailable(f.key)}
                    >
                      <strong>{f.label}</strong>
                    </MeasureRow>
                  ))}
                </FilterSection>
              </Fragment>
            ))}

            <InformationTable
              activeMetrics={activeMetrics.map((m) => ({ key: m.key, label: m.label, geography: m.geography, loadedAreas: Object.keys(m.values).length, unit: m.unit }))}
              households={households}
              evCommercial={evCommercial}
              loadedFileName={loadedFileName}
              warnings={uploadDetailLines}
              importSummary={importSummary ?? []}
              uploadError={uploadError}
            />

            <div className="uploadFooterInScroll">
              <div className="uploadFooterTitle">
                <div className="panelHeader">Upload</div>
                <div className="uploadFooterMeta">
                  {loadedFileName
                    ? <>Loaded: <strong>{loadedFileName}</strong> — stays until a new file is uploaded.</>
                    : 'Drop or click to load a data file. Persists across page reloads.'}
                </div>
              </div>
              <div
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  marginTop: 8,
                  border: `2px dashed ${dragOver ? '#2563eb' : '#d1d5db'}`,
                  borderRadius: 6,
                  padding: '12px 10px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  background: dragOver ? '#eff6ff' : '#f9fafb',
                  color: dragOver ? '#1d4ed8' : '#6b7280',
                  fontSize: 12,
                  transition: 'all 0.15s',
                }}
              >
                {dragOver ? '📂 Drop to load…' : '📁 Drag & drop xlsx here, or click to browse'}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                style={{ display: 'none' }}
                onChange={handleUploadChange}
              />
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
          onGeoJsonReady={() => setGeoJsonReady(true)}
          onStatsReady={() => setStatsReadyAt(Date.now())}
          activeMetrics={activeMetrics}
          households={households}
          householdsLayerVisible={householdsLayerOn}
          boundaryCountyLinesVisible={boundaryCountyLinesOn}
          boundaryTownLinesVisible={boundaryTownLinesOn}
          boundarySmallAreaLinesVisible={boundarySmallAreaLinesOn}
          evCommercial={loadedData?.evCommercial ?? []}
          evCommercialLayerVisible={evCommercialLayerOn}
        />
      </main>
    </div>
  )
}
