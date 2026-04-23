import type { Feature, FeatureCollection, Point } from 'geojson'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import maplibregl, { type Map as MapLibreMap, type StyleSpecification } from 'maplibre-gl'
import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_SOURCE_ID,
  type BasemapMode,
  basemapTileUrls,
  getBasemapStyle,
} from '../basemap'
import { CSO_BOUNDARY_ATTRIBUTION, emptyFeatureCollection } from '../cso/arcgisGeoJson'
import { bboxForBuaCode, bboxForCountyLa, normGeoProp } from '../cso/boundaryLookup'
import { geometryBBox } from '../geoBounds'
import type { HouseholdRecord } from '../types/households'
import { type DroppedPin, savePinToDb, loadAllPinsFromDb, updatePinInDb, clearAllPinsFromDb } from '../db'

// ─── Types ────────────────────────────────────────────────────────────────────

type YesNoUnknown = 'Yes' | 'No' | 'Unknown'
type PinTownOption = { label: string; county: string }
type PinFormState = {
  type: 'Household' | 'Business'
  houseNo: string; street: string; town: string; county: string
  solar: YesNoUnknown; ev: YesNoUnknown; heatPump: YesNoUnknown
}
const defaultPinForm = (): PinFormState => ({ type: 'Household', houseNo: '', street: '', town: '', county: '', solar: 'Unknown', ev: 'Unknown', heatPump: 'Unknown' })

type MetricValue = { mapValue: number; pctValue?: number | null; rawValue?: number | string }
type MetricStats  = { mean: number; std: number; min: number; max: number }

export type ActiveMetric = {
  key: string
  label: string
  geography: 'small_area' | 'town'
  unit?: string
  values: Record<string, MetricValue>
}

export type MapViewProps = {
  boundaries: { counties: FeatureCollection; bua: FeatureCollection }
  basemapMode: BasemapMode
  focusBuaCode?: string
  focusCountyLa?: string
  onLocationFilterAutoClear?: () => void
  activeMetrics?: ActiveMetric[]
  households?: HouseholdRecord[]
  evCommercial?: HouseholdRecord[]
  householdsLayerVisible?: boolean
  evCommercialLayerVisible?: boolean
  boundaryCountyLinesVisible?: boolean
  boundaryTownLinesVisible?: boolean
  boundarySmallAreaLinesVisible?: boolean
  onGeoJsonReady?: () => void
  /** After embedded-metric stats are ready; parent can bump deps so `activeMetrics` re-evaluates. */
  onStatsReady?: () => void
  towns?: PinTownOption[]
  /** Increment to trigger a full pin clear (called on manual clear). */
  clearPinsSignal?: number
  /** Increment to wipe pins from IndexedDB only — pins survive this session but not next reload. */
  sessionOnlyPinsSignal?: number
  /** Show RENEW Potential Score as an independent fill layer (never affects z-score). */
  renewScoreVisible?: boolean
  /** Show Commercial Readiness Score as an independent fill layer (never affects z-score). */
  commercialScoreVisible?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_VIEW  = { center: [-8.1, 53.35] as [number, number], zoom: 6.8 }
const COUNTY_LINE   = '#2563eb'
const SA_LINE       = '#dc2626'
const SA_GEOJSON_URL = '/small_areas_metrics.geojson'

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function selectionFC(feature: Feature | null | undefined): FeatureCollection {
  if (!feature) return emptyFeatureCollection()
  return { type: 'FeatureCollection', features: [feature] }
}

function toPointGeoJson(points: HouseholdRecord[]) {
  return {
    type: 'FeatureCollection' as const,
    features: (points ?? []).map((h) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.lon, h.lat] as [number, number] },
      properties: {
        fullAddress:  (h as any).fullAddress  ?? h.address ?? '',
        customerType: (h as any).customerType ?? '',
        dotType:      (h as any).dotType      ?? 'red',
        solar:        h.solar     != null ? String(h.solar)     : '',
        ev:           h.ev        != null ? String(h.ev)        : '',
        heat_pump:    h.heat_pump != null ? String(h.heat_pump) : '',
        open_hours:   (h as any).open_hours ?? '',
      },
    })),
  }
}

// Manual coordinate overrides for counties whose bbox centroid lands off-centre
// (e.g. irregular shapes, lakes pulling the bbox off the land mass)
const COUNTY_LABEL_OVERRIDES: Record<string, [number, number]> = {
  'OFFALY':  [-7.56, 53.27],
}

function countyLabelPoints(fc: FeatureCollection): FeatureCollection {
  // Merge ALL bbox extents per county name so counties split across multiple
  // council-area features (e.g. Cork City + Cork County both COUNTY="Cork")
  // each get one label at the centroid of their combined bounding box.
  const merged: Record<string, [number, number, number, number]> = {}
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const name = String(p.COUNTY ?? p.LOCAL_AUTHORITY ?? '').trim()
    if (!name) continue
    const box = geometryBBox(g)
    if (!box) continue
    if (!merged[name]) {
      merged[name] = [box[0], box[1], box[2], box[3]]
    } else {
      const b = merged[name]
      if (box[0] < b[0]) b[0] = box[0]
      if (box[1] < b[1]) b[1] = box[1]
      if (box[2] > b[2]) b[2] = box[2]
      if (box[3] > b[3]) b[3] = box[3]
    }
  }
  const feats: Feature<Point>[] = Object.entries(merged).map(([name, [w, s, e, n]]) => {
    const override = COUNTY_LABEL_OVERRIDES[name.toUpperCase()]
    const coords = override ?? [(w + e) / 2, (s + n) / 2]
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties: { COUNTY: name },
    }
  })
  return { type: 'FeatureCollection', features: feats }
}

function aliasIds(raw: string): string[] {
  const out = new Set<string>()
  const s   = String(raw ?? '').trim()
  if (!s) return []
  out.add(s)
  const withUnderscore = s.match(/^[A-Za-z]+\d{4}_(\d+)$/)
  if (withUnderscore) {
    const code = withUnderscore[1]
    out.add(code.padStart(9, '0'))
    out.add(code.replace(/^0+/, ''))
  }
  const digits = s.replace(/[^\d]/g, '')
  if (digits) {
    out.add(digits)
    out.add(digits.replace(/^0+/, ''))
    if (digits.length < 9)    out.add(digits.padStart(9, '0'))
    if (digits.length === 8)  out.add('0' + digits)
    if (digits.length === 10) out.add(digits.slice(1))
  }
  return [...out].filter(Boolean)
}

// ─── Statistics ───────────────────────────────────────────────────────────────

// Compute mean/std from GeoJSON embedded _metrics values.
// This is the ONLY source of truth for z-score stats — ensures stats and
// colour values are always on the same scale (counts, not pct).
function computeStatsFromFeatures(
  fc: FeatureCollection,
  metricKeys: string[],
): Record<string, MetricStats> {
  const buckets: Record<string, number[]> = {}
  for (const f of fc.features) {
    const p = (f.properties ?? {}) as Record<string, unknown>
    let embedded: Record<string, { mapValue: number }> = {}
    try {
      const raw = p._metrics
      embedded = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
    } catch {}
    for (const key of metricKeys) {
      const hit = embedded[key]
      if (hit?.mapValue != null && Number.isFinite(hit.mapValue)) {
        ;(buckets[key] ??= []).push(hit.mapValue)
      }
    }
  }
  const out: Record<string, MetricStats> = {}
  for (const [key, vals] of Object.entries(buckets)) {
    if (vals.length < 2) continue
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    const std  = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length)
    let min = vals[0], max = vals[0]
    for (const v of vals) { if (v < min) min = v; if (v > max) max = v }
    if (std > 0) out[key] = { mean, std, min, max }
  }
  return out
}

function zNorm(value: number, mean: number, std: number): number {
  const z = (value - mean) / std
  return (Math.max(-2, Math.min(2, z)) + 2) / 4
}

// ─── Core colour computation ──────────────────────────────────────────────────

// For each SA feature:
//   1. Parse _metrics JSON (GeoJSON embedded values = counts)
//   2. For each active metric find the value (embedded first, aliasId fallback)
//   3. Z-score normalise using pre-computed stats
//   4. Average normalised scores → _score (0-1)
//   5. _count = how many active metrics found a value (drives opacity)
//
// KEY FIX: _score divides by `contributing` not `relevant.length`.
// This means a single active metric with data gives full colour range.
// An SA with no data for ANY active metric gets _count=0 → transparent.
function attachCombinedMetric(
  fc: FeatureCollection,
  metrics: ActiveMetric[],
  geography: 'small_area' | 'town',
  stats: Record<string, MetricStats>,
): FeatureCollection {
  const relevant = metrics.filter((m) => m.geography === geography)

  // No active metrics → set all features to _count=0 (transparent)
  if (relevant.length === 0) {
    return {
      type: 'FeatureCollection',
      features: fc.features.map((f) => ({
        ...f,
        properties: {
          ...((f.properties as Record<string, unknown> | null) ?? {}),
          _score: null, _count: 0, _phobal_value: null,
        },
      })),
    }
  }

  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const props = { ...((f.properties as Record<string, unknown> | null) ?? {}) }

      let embedded: Record<string, { mapValue: number; pctValue?: number | null }> = {}
      try {
        const raw = props._metrics
        embedded = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
      } catch {}

      let score = 0, contributing = 0
      const isSingleMetric = relevant.length === 1

      for (const metric of relevant) {
        // Primary: GeoJSON embedded value
        let hit = embedded[metric.key] as MetricValue | undefined
        // Fallback: workbook aliasId lookup
        if (!hit) {
          for (const k of aliasIds(normGeoProp(props.GEOGID as string))) {
            if (metric.values?.[k]) { hit = metric.values[k]; break }
          }
        }
        if (!hit) continue

        const s = stats[metric.key]
        if (!s) continue

        if (isSingleMetric && s.max > s.min) {
          // Single metric: linear normalization so _score bands match legend bands exactly
          score += Math.max(0, Math.min(1, (hit.mapValue - s.min) / (s.max - s.min)))
        } else {
          // Multiple metrics: z-score normalization, averaged equally
          score += zNorm(hit.mapValue, s.mean, s.std)
        }
        contributing++
      }

      return {
        ...f,
        properties: {
          ...props,
          _score:  contributing > 0 ? score / contributing : null,
          _count:  contributing,
        },
      }
    }),
  }
}

// ─── Index score helper ───────────────────────────────────────────────────────
// Normalises a 0-100 score to 0-1 so it drives the same fill-color expression.
// Completely independent of attachCombinedMetric — never feeds into _score or
// z-score calculations. Each index metric lives in its own GeoJSON source.
function attachSingleIndexScore(
  fc: FeatureCollection,
  scoreKey: string,
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const props = { ...((f.properties as Record<string, unknown> | null) ?? {}) }
      let embedded: Record<string, { mapValue: number }> = {}
      try {
        const raw = props._metrics
        embedded = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})
      } catch {}
      const val = embedded[scoreKey]?.mapValue
      const hasVal = val != null && Number.isFinite(val)
      return {
        ...f,
        properties: {
          ...props,
          // Null or missing score → treated as 0 (lightest band) not transparent
          _score: hasVal ? Math.max(0, Math.min(1, (val as number) / 100)) : 0,
          _count: 1,
        },
      }
    }),
  }
}

// ─── MapLibre expressions ─────────────────────────────────────────────────────
const SA_FILL_OPACITY: maplibregl.ExpressionSpecification = [
  'case',
  ['>', ['coalesce', ['to-number', ['get', '_count']], 0], 0], 0.72, 0,
]

function redScoreExpression(): maplibregl.ExpressionSpecification {
  return [
    'case',
    ['!', ['has', '_count']], 'rgba(0,0,0,0)',
    ['<=', ['coalesce', ['to-number', ['get', '_count']], 0], 0], 'rgba(0,0,0,0)',
    [
      'step', ['coalesce', ['to-number', ['get', '_score']], 0],
      '#fde8e6',        // 0.0–0.2  lowest band
      0.2, '#f9b8b1',   // 0.2–0.4
      0.4, '#f1948a',   // 0.4–0.6
      0.6, '#e74c3c',   // 0.6–0.8
      0.8, '#c0392b',   // 0.8–1.0  highest band
    ],
  ]
}

// For index score layers — same step breakpoints but floor band is more visible
// so low-scoring areas don't look transparent (score 0 = lightest band, not invisible)
function indexScoreExpression(): maplibregl.ExpressionSpecification {
  return [
    'step', ['coalesce', ['to-number', ['get', '_score']], 0],
    '#fcc9c0',        // 0.0–0.2  Very Low  (more visible than #fde8e6)
    0.2, '#f1948a',   // 0.2–0.4  Low
    0.4, '#e74c3c',   // 0.4–0.6  Medium
    0.6, '#c0392b',   // 0.6–0.8  High
    0.8, '#7f1d1d',   // 0.8–1.0  Very High
  ]
}

// ─── Filter icons ─────────────────────────────────────────────────────────────

const FILTER_ICONS: Record<string, string> = {
  age_35_44:                       '🧑',
  families_children:               '👨‍👩‍👧‍👦',
  education_degree_plus:           '🎓',
  occupation_manager_professional: '💼',
  phobal_score:                    '🏘️',
  electric_heating:                '⚡',
  solar_panels:                    '☀️',
  ev_households:                   '🚗',
  heat_pumps:                      '🔥',
  income:                          '💰',
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MapView(props: MapViewProps) {
  const propsRef = useRef(props)
  useEffect(() => { propsRef.current = props }, [props])

  const containerRef  = useRef<HTMLDivElement | null>(null)
  const mapRootRef    = useRef<HTMLDivElement | null>(null)
  const mapRef        = useRef<MapLibreMap | null>(null)
  const suppressRef   = useRef(0)
  const hoveredFeatureIdRef = useRef<string | number | null>(null)

  const saRawLoadedRef = useRef<FeatureCollection>(emptyFeatureCollection())
  const statsRef       = useRef<Record<string, MetricStats>>({})
  const [saRaw,       setSaRaw]       = useState<FeatureCollection>(emptyFeatureCollection())
  const [saLoading,   setSaLoading]   = useState(true)
  const [statsReady,  setStatsReady]  = useState(false)
  const [legendOpen, setLegendOpen] = useState(true)
  const [legendNoteOpen, setLegendNoteOpen] = useState(false)

  // ── Pin mode state ─────────────────────────────────────────────────────────
  const [pinModeActive, setPinModeActive] = useState(false)
  const [droppedPins, setDroppedPins] = useState<DroppedPin[]>([])
  const [newPinCoords, setNewPinCoords] = useState<{ lat: number; lng: number } | null>(null)
  const [pinForm, setPinForm] = useState<PinFormState>(defaultPinForm())
  const [townSearch, setTownSearch] = useState('')
  const [townDropdownOpen, setTownDropdownOpen] = useState(false)
  const [editingPinId, setEditingPinId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ solar: YesNoUnknown; ev: YesNoUnknown; heatPump: YesNoUnknown }>({ solar: 'Unknown', ev: 'Unknown', heatPump: 'Unknown' })
  const pinModeRef = useRef(false)
  const droppedPinsRef = useRef<DroppedPin[]>([])

  type Tooltip = {
    x: number; y: number; title: string; county: string
    edName?: string; saCode?: string
    rows: Array<{ key: string; label: string; no: string; pct: string }>
    simple?: string[]
    pointRows?: Array<{ label: string; value: string }>
    indexRows?: Array<{ label: string; value: string }>
    combinedScore?: { band: string; pct: string } | null
  }
  const [tooltip, setTooltip] = useState<Tooltip | null>(null)

  const style         = useMemo(() => getBasemapStyle() as StyleSpecification, [])
  const activeMetrics = props.activeMetrics ?? []

  const householdsGeo   = useMemo(() => toPointGeoJson(props.households   ?? []), [props.households])
  const evCommercialGeo = useMemo(() => toPointGeoJson(props.evCommercial ?? []), [props.evCommercial])
  const countiesData    = useMemo(() => props.boundaries.counties ?? emptyFeatureCollection(), [props.boundaries.counties])
  const countyLabels    = useMemo(() => countyLabelPoints(countiesData), [countiesData])
  const townsData       = useMemo(() => attachCombinedMetric(props.boundaries.bua ?? emptyFeatureCollection(), activeMetrics, 'town', statsRef.current), [props.boundaries.bua, activeMetrics, statsReady])
  const saData          = useMemo(() => attachCombinedMetric(saRaw, activeMetrics, 'small_area', statsRef.current), [saRaw, activeMetrics, statsReady])

  const countiesDataRef    = useRef(countiesData)
  const countyLabelsRef    = useRef(countyLabels)
  const townsDataRef       = useRef(townsData)
  const saDataRef          = useRef(saData)
  const householdsGeoRef   = useRef(householdsGeo)
  const evCommercialGeoRef = useRef(evCommercialGeo)
  useEffect(() => { countiesDataRef.current    = countiesData    }, [countiesData])
  useEffect(() => { countyLabelsRef.current    = countyLabels    }, [countyLabels])
  useEffect(() => { townsDataRef.current       = townsData       }, [townsData])
  useEffect(() => { saDataRef.current          = saData          }, [saData])
  useEffect(() => { householdsGeoRef.current   = householdsGeo   }, [householdsGeo])
  useEffect(() => { evCommercialGeoRef.current = evCommercialGeo }, [evCommercialGeo])

  // ── Pin mode effects ───────────────────────────────────────────────────────
  useEffect(() => { loadAllPinsFromDb().then(setDroppedPins).catch(() => {}) }, [])
  useEffect(() => { pinModeRef.current = pinModeActive }, [pinModeActive])
  useEffect(() => { droppedPinsRef.current = droppedPins }, [droppedPins])

  // Clear all pins when signal is bumped (manual "Clear pins" button — wipes state + DB)
  useEffect(() => {
    if (!props.clearPinsSignal) return
    setDroppedPins([])
    clearAllPinsFromDb().catch(() => {})
  }, [props.clearPinsSignal])

  // On new Excel upload: wipe pins from IndexedDB only — pins stay visible this session
  // but won't restore if page is reloaded
  useEffect(() => {
    if (!props.sessionOnlyPinsSignal) return
    clearAllPinsFromDb().catch(() => {})
  }, [props.sessionOnlyPinsSignal])

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (droppedPinsRef.current.length > 0) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const src = map.getSource('dropped-pins') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    src.setData({ type: 'FeatureCollection', features: droppedPins.map(p => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] }, properties: { id: p.id, pinType: p.type } })) })
  }, [droppedPins])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (pinModeActive) {
      map.getCanvas().style.cursor = 'crosshair'
    } else {
      map.getCanvas().style.cursor = ''
    }
  }, [pinModeActive])

  // ── Pin mode handlers ──────────────────────────────────────────────────────
  function handleSavePin() {
    if (!newPinCoords) return
    const pin: DroppedPin = {
      id: `pin_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      lat: newPinCoords.lat, lng: newPinCoords.lng,
      type: pinForm.type, houseNo: pinForm.houseNo, street: pinForm.street,
      town: pinForm.town, county: pinForm.county,
      solar: pinForm.solar, ev: pinForm.ev, heatPump: pinForm.heatPump,
      createdAt: Date.now(),
    }
    setDroppedPins(prev => [...prev, pin])
    savePinToDb(pin).catch(e => console.warn('savePinToDb failed:', e))
    setNewPinCoords(null)
  }

  function handleSaveEdit() {
    if (!editingPinId) return
    setDroppedPins(prev => prev.map(p => p.id === editingPinId ? { ...p, ...editForm } : p))
    updatePinInDb(editingPinId, editForm).catch(e => console.warn('updatePinInDb failed:', e))
    setEditingPinId(null)
  }

  function downloadPinsCSV() {
    if (droppedPins.length === 0) return
    const header = ['customer_type', 'dot_type', 'Full_Address', 'latitude_clean', 'longitude_clean', 'solar', 'ev', 'heat_pump', 'coord_issue', 'date_time']
    const rows = droppedPins.map(p => {
      const customerType = p.type === 'Household' ? 'households' : 'commercial'
      const dotType = p.type === 'Household' ? 'red' : 'yellow'
      const fullAddress = [p.houseNo, p.street, p.town, p.county].filter(Boolean).join(', ')
      const d = new Date(p.createdAt)
      const pad = (n: number) => String(n).padStart(2, '0')
      const dateTime = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      return [customerType, dotType, fullAddress, String(p.lat), String(p.lng), p.solar, p.ev, p.heatPump, '', dateTime]
    })
    const csv = [header, ...rows].map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n')
    const filename = `pins_${new Date().toISOString().slice(0, 10)}.csv`
    // Use Web Share API on mobile if available (iOS Safari, Android Chrome)
    if (navigator.share && /Mobi|Android|iPad|iPhone/i.test(navigator.userAgent)) {
      const file = new File([csv], filename, { type: 'text/csv' })
      navigator.share({ files: [file], title: 'Pins CSV' }).catch(() => {
        // Fallback if share fails
        fallbackDownload(csv, filename)
      })
    } else {
      fallbackDownload(csv, filename)
    }
  }

  function fallbackDownload(csv: string, filename: string) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // ── Load GeoJSON once ──────────────────────────────────────────────────────
  useEffect(() => {
    setSaLoading(true)
    fetch(SA_GEOJSON_URL)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then((data: FeatureCollection) => {
        // Compute stats from ALL metric keys present in embedded _metrics
        const allKeys = new Set<string>()
        for (const f of data.features) {
          try {
            const p = (f.properties ?? {}) as Record<string, unknown>
            const m = typeof p._metrics === 'string' ? JSON.parse(p._metrics) : (p._metrics ?? {})
            for (const k of Object.keys(m)) if (k !== '_county') allKeys.add(k)
          } catch {}
        }
        statsRef.current = computeStatsFromFeatures(data, [...allKeys])
        setStatsReady(true)   // triggers saData recompute with correct stats
        propsRef.current.onStatsReady?.()

        saRawLoadedRef.current = data
        setSaRaw(data)
        setSaLoading(false)
        propsRef.current.onGeoJsonReady?.()

        // If map already loaded, push immediately
        const map = mapRef.current
        if (map?.isStyleLoaded()) {
          const processed = attachCombinedMetric(data, propsRef.current.activeMetrics ?? [], 'small_area', statsRef.current)
          ;(map.getSource('cso-small-areas') as maplibregl.GeoJSONSource | undefined)?.setData(processed)
          ;(map.getSource('cso-sa-renew')      as maplibregl.GeoJSONSource | undefined)?.setData(attachSingleIndexScore(data, 'renew_score'))
          ;(map.getSource('cso-sa-commercial') as maplibregl.GeoJSONSource | undefined)?.setData(attachSingleIndexScore(data, 'commercial_score'))
        }
      })
      .catch((err) => { console.error('SA GeoJSON load failed:', err); setSaLoading(false) })
  }, [])

  // ── Update fill opacity when stats change (fill-color handled by effect below) ──
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded() || !map.getLayer('cso-sa-fill')) return
    map.setPaintProperty('cso-sa-fill', 'fill-opacity', SA_FILL_OPACITY)
  }, [activeMetrics, statsReady])

  // ── Fly to selected town / county ─────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (props.focusBuaCode) {
      const b = bboxForBuaCode(props.boundaries.bua, props.focusBuaCode)
      if (b) { suppressRef.current = Date.now() + 2500; map.fitBounds([[b[0],b[1]],[b[2],b[3]]], { padding: 40, maxZoom: 14, duration: 800 }) }
    } else if (props.focusCountyLa) {
      const b = bboxForCountyLa(props.boundaries.counties, props.focusCountyLa)
      if (b) { suppressRef.current = Date.now() + 2500; map.fitBounds([[b[0],b[1]],[b[2],b[3]]], { padding: 40, maxZoom: 10, duration: 800 }) }
    }
  }, [props.focusBuaCode, props.focusCountyLa, props.boundaries])

  useLayoutEffect(() => {
    const root = mapRootRef.current
    if (!root) return
    const update = () => { root.style.setProperty('--zoom-dock-top','12px'); root.style.setProperty('--zoom-dock-right','12px') }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(root)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => { ro.disconnect(); window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update) }
  }, [])

  // ── Map init ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return

    const map = new maplibregl.Map({
      container, style,
      center: INITIAL_VIEW.center, zoom: INITIAL_VIEW.zoom,
      attributionControl: { compact: true, customAttribution: `${BASEMAP_ATTRIBUTION} ${CSO_BOUNDARY_ATTRIBUTION}` },
      scrollZoom: true, dragRotate: false, touchZoomRotate: true,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right')

    // Default arrow cursor, not grab
    map.getCanvas().style.cursor = 'default'
    map.on('dragstart', () => { map.getCanvas().style.cursor = 'grabbing' })
    map.on('dragend',   () => { map.getCanvas().style.cursor = 'default'  })

    map.on('load', () => {
      // Sources
      map.addSource('cso-counties',              { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-bua',                   { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-small-areas',           { type: 'geojson', data: emptyFeatureCollection(), generateId: true })
      map.addSource('cso-sa-renew',              { type: 'geojson', data: emptyFeatureCollection(), generateId: true })
      map.addSource('cso-sa-commercial',         { type: 'geojson', data: emptyFeatureCollection(), generateId: true })
      map.addSource('cso-counties-selection',    { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-bua-selection',         { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-counties-label-points', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('households',    { type: 'geojson', data: toPointGeoJson([]) })
      map.addSource('ev-commercial', { type: 'geojson', data: toPointGeoJson([]) })

      // Fill layers
      map.addLayer({ id: 'cso-counties-fill', type: 'fill', source: 'cso-counties',    paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0 } })
      map.addLayer({ id: 'cso-bua-fill',      type: 'fill', source: 'cso-bua',         paint: { 'fill-color': redScoreExpression(), 'fill-opacity': SA_FILL_OPACITY } })
      map.addLayer({ id: 'cso-sa-fill',       type: 'fill', source: 'cso-small-areas', paint: { 'fill-color': redScoreExpression(), 'fill-opacity': SA_FILL_OPACITY } })

      // Index score layers — completely independent fill layers, never part of z-score
      map.addLayer({ id: 'cso-sa-renew-fill',      type: 'fill', source: 'cso-sa-renew',      paint: { 'fill-color': indexScoreExpression(), 'fill-opacity': 0.78 }, layout: { visibility: 'none' } })
      map.addLayer({ id: 'cso-sa-commercial-fill', type: 'fill', source: 'cso-sa-commercial', paint: { 'fill-color': indexScoreExpression(), 'fill-opacity': 0.78 }, layout: { visibility: 'none' } })

      map.addLayer({
        id: 'cso-sa-hover-line',
        type: 'line',
        source: 'cso-small-areas',
        paint: {
          'line-color': '#16a34a',
          'line-width': 5,
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'hovered'], false],
            1,
            0,
          ],
        },
      })

      // Line layers
      map.addLayer({ id: 'cso-counties-line', type: 'line', source: 'cso-counties',    paint: { 'line-color': COUNTY_LINE, 'line-width': ['interpolate',['linear'],['zoom'],4,2.4,8,2.0,12,1.6], 'line-opacity': 0.98 } })
      // Town border: orange outer casing drawn first (wider), dark brown inner on top — visible on all basemaps
      map.addLayer({ id: 'cso-bua-line-casing', type: 'line', source: 'cso-bua', paint: { 'line-color': '#f97316', 'line-width': ['interpolate',['linear'],['zoom'],4,4.5,8,4.0,12,3.2], 'line-opacity': 0.9 } })
      map.addLayer({ id: 'cso-bua-line',        type: 'line', source: 'cso-bua', paint: { 'line-color': '#431407', 'line-width': ['interpolate',['linear'],['zoom'],4,2.0,8,1.8,12,1.4], 'line-opacity': 1.0 } })
      map.addLayer({ id: 'cso-sa-line',       type: 'line', source: 'cso-small-areas', paint: { 'line-color': SA_LINE,     'line-width': ['interpolate',['linear'],['zoom'],4,0.5,6.8,0.7,9,0.8,12,0.65], 'line-opacity': ['interpolate',['linear'],['zoom'],4,0.4,8,0.65,12,0.5] } })

      // Point layers
      map.addLayer({ id: 'households-circle',    type: 'circle', source: 'households',    paint: { 'circle-color': '#ef4444', 'circle-radius': ['interpolate',['linear'],['zoom'],6,1.6,10,3.5,14,5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })
      map.addLayer({ id: 'ev-commercial-circle', type: 'circle', source: 'ev-commercial', paint: { 'circle-color': '#eab308', 'circle-radius': ['interpolate',['linear'],['zoom'],6,1.6,10,3.5,14,5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })

      // Dropped pins layer
      map.addSource('dropped-pins', { type: 'geojson', data: emptyFeatureCollection() })
      map.addLayer({ id: 'dropped-pins-outer', type: 'circle', source: 'dropped-pins', paint: { 'circle-color': '#ef4444', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 3.5, 14, 5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })
      map.addLayer({ id: 'dropped-pins-cross', type: 'symbol', source: 'dropped-pins', layout: { 'text-field': '+', 'text-size': ['interpolate', ['linear'], ['zoom'], 6, 5, 10, 9, 14, 13], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-anchor': 'center', 'text-allow-overlap': true }, paint: { 'text-color': '#ffffff' } })

      // County labels last — floats above all dots visually; symbol layers don't block fill mouse events
      map.addLayer({ id: 'cso-counties-label', type: 'symbol', source: 'cso-counties-label-points', minzoom: 4.2,
        layout: { 'text-field': ['get','COUNTY'], 'text-font': ['Open Sans Bold','Arial Unicode MS Bold'], 'text-size': ['interpolate',['linear'],['zoom'],4,11,7,13,10,15], 'text-anchor': 'center', 'text-allow-overlap': false },
        paint:  { 'text-color': '#1d4ed8', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })

      // Seed dropped pins if already loaded
      if (droppedPinsRef.current.length > 0) {
        ;(map.getSource('dropped-pins') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: droppedPinsRef.current.map(p => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [p.lng, p.lat] }, properties: { id: p.id, pinType: p.type } })) })
      }

      // Map click handler for pin mode
      map.on('click', (e) => {
        if (!pinModeRef.current) return
        const features = map.queryRenderedFeatures(e.point, { layers: ['dropped-pins-outer'] })
        if (features.length > 0) {
          const pinId = String(features[0].properties?.id ?? '')
          const pin = droppedPinsRef.current.find(p => p.id === pinId)
          if (pin) {
            setEditingPinId(pin.id)
            setEditForm({ solar: pin.solar, ev: pin.ev, heatPump: pin.heatPump })
            setNewPinCoords(null)
            return
          }
        }
        // Auto-fill town + county from map layers at click point
        const saFeats = map.queryRenderedFeatures(e.point, { layers: ['cso-sa-fill'] })
        const buaFeats = map.queryRenderedFeatures(e.point, { layers: ['cso-bua-fill'] })
        const toTitle = (s: string) => s.toLowerCase().replace(/(?:^|[\s-])\w/g, (c: string) => c.toUpperCase())
        let autoCounty = ''
        let autoTown = ''
        if (saFeats.length > 0) {
          const sp = saFeats[0].properties ?? {}
          const raw = String(sp.COUNTY_ENGLISH ?? sp.COUNTY ?? '').trim()
          if (raw) autoCounty = 'Co. ' + toTitle(raw)
        }
        if (buaFeats.length > 0) {
          const bp = buaFeats[0].properties ?? {}
          const rawTown = String(bp.BUA_NAME ?? bp.GEOGDESC ?? bp.NAME ?? '').trim()
          if (rawTown) autoTown = toTitle(rawTown)
        }
        setNewPinCoords({ lat: e.lngLat.lat, lng: e.lngLat.lng })
        const form = defaultPinForm()
        form.county = autoCounty
        form.town = autoTown
        setPinForm(form)
        setTownSearch(autoTown)
        setTownDropdownOpen(false)
        setEditingPinId(null)
      })

      // Cursor styles
      map.on('mouseenter', 'cso-sa-fill',          () => { map.getCanvas().style.cursor = 'crosshair' })
      map.on('mouseleave', 'cso-sa-fill',          () => { map.getCanvas().style.cursor = 'default'   })
      map.on('mouseenter', 'households-circle',    () => { map.getCanvas().style.cursor = 'pointer'   })
      map.on('mouseleave', 'households-circle',    () => { map.getCanvas().style.cursor = 'default'   })
      map.on('mouseenter', 'ev-commercial-circle', () => { map.getCanvas().style.cursor = 'pointer'   })
      map.on('mouseleave', 'ev-commercial-circle', () => { map.getCanvas().style.cursor = 'default'   })

      // Seed sources from refs
      ;(map.getSource('cso-counties')              as maplibregl.GeoJSONSource).setData(countiesDataRef.current)
      ;(map.getSource('cso-counties-label-points') as maplibregl.GeoJSONSource).setData(countyLabelsRef.current)
      ;(map.getSource('cso-bua')                   as maplibregl.GeoJSONSource).setData(townsDataRef.current)
      ;(map.getSource('households')                as maplibregl.GeoJSONSource).setData(householdsGeoRef.current)
      ;(map.getSource('ev-commercial')             as maplibregl.GeoJSONSource).setData(evCommercialGeoRef.current)

      // SA: use loaded GeoJSON if already fetched, otherwise empty
      if (saRawLoadedRef.current.features.length > 0) {
        const processed = attachCombinedMetric(saRawLoadedRef.current, propsRef.current.activeMetrics ?? [], 'small_area', statsRef.current)
        ;(map.getSource('cso-small-areas') as maplibregl.GeoJSONSource).setData(processed)
        ;(map.getSource('cso-sa-renew')      as maplibregl.GeoJSONSource).setData(attachSingleIndexScore(saRawLoadedRef.current, 'renew_score'))
        ;(map.getSource('cso-sa-commercial') as maplibregl.GeoJSONSource).setData(attachSingleIndexScore(saRawLoadedRef.current, 'commercial_score'))
      } else {
        ;(map.getSource('cso-small-areas') as maplibregl.GeoJSONSource).setData(saDataRef.current)
      }
    })

    // Auto-clear location filter when user pans away
    map.on('moveend', () => {
      const now = Date.now()
      if (now < suppressRef.current) return
      const m = mapRef.current
      if (!m) return
      const bounds = m.getBounds()
      let keep = false
      const p = propsRef.current
      if (p.focusBuaCode) {
        const b = bboxForBuaCode(p.boundaries.bua, p.focusBuaCode)
        keep = !!b && !(bounds.getEast() < b[0] || bounds.getWest() > b[2] || bounds.getNorth() < b[1] || bounds.getSouth() > b[3])
      } else if (p.focusCountyLa) {
        const b = bboxForCountyLa(p.boundaries.counties, p.focusCountyLa)
        keep = !!b && !(bounds.getEast() < b[0] || bounds.getWest() > b[2] || bounds.getNorth() < b[1] || bounds.getSouth() > b[3])
      }
      if ((p.focusBuaCode || p.focusCountyLa) && !keep) p.onLocationFilterAutoClear?.()
    })

    return () => { map.remove(); mapRef.current = null }
  }, [style])

  // ── Basemap swap ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource(BASEMAP_SOURCE_ID) as maplibregl.RasterTileSource | undefined
    if (src?.setTiles) src.setTiles(basemapTileUrls(props.basemapMode))
  }, [props.basemapMode])

  // ── Sync sources ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    ;(map.getSource('cso-counties')              as maplibregl.GeoJSONSource | undefined)?.setData(countiesData)
    ;(map.getSource('cso-counties-label-points') as maplibregl.GeoJSONSource | undefined)?.setData(countyLabels)
    ;(map.getSource('cso-bua')                   as maplibregl.GeoJSONSource | undefined)?.setData(townsData)
    ;(map.getSource('cso-small-areas')           as maplibregl.GeoJSONSource | undefined)?.setData(saData)
    ;(map.getSource('households')                as maplibregl.GeoJSONSource | undefined)?.setData(householdsGeo)
    ;(map.getSource('ev-commercial')             as maplibregl.GeoJSONSource | undefined)?.setData(evCommercialGeo)
  }, [countiesData, countyLabels, townsData, saData, householdsGeo, evCommercialGeo])

  // ── Update fill colour expression when metrics change ───────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const saMetrics = activeMetrics.filter(m => m.geography === 'small_area')
    // Use lighter palette for 0 or 1 active metrics; dark only for 2+
    const isSingle = saMetrics.length <= 1
    const colours = isSingle
      ? ['#c0392b', '#e74c3c', '#f1948a', '#f9b8b1', '#fde8e6']
      : ['#7f1d1d', '#b91c1c', '#ef4444', '#fb7185', '#fecdd3']
    const expr: maplibregl.ExpressionSpecification = [
      'case',
      ['!', ['has', '_count']], 'rgba(0,0,0,0)',
      ['<=', ['coalesce', ['to-number', ['get', '_count']], 0], 0], 'rgba(0,0,0,0)',
      [
        'step', ['coalesce', ['to-number', ['get', '_score']], 0],
        colours[4],
        0.2, colours[3],
        0.4, colours[2],
        0.6, colours[1],
        0.8, colours[0],
      ],
    ]
    if (map.getLayer('cso-sa-fill'))  map.setPaintProperty('cso-sa-fill',  'fill-color', expr)
    if (map.getLayer('cso-bua-fill')) map.setPaintProperty('cso-bua-fill', 'fill-color', expr)
  }, [activeMetrics])

  // ── Visibility toggles ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = (on?: boolean) => on === false ? 'none' : 'visible'
    if (map.getLayer('cso-counties-line'))        map.setLayoutProperty('cso-counties-line',        'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-counties-label'))       map.setLayoutProperty('cso-counties-label',       'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-bua-line-casing'))      map.setLayoutProperty('cso-bua-line-casing',      'visibility', vis(props.boundaryTownLinesVisible))
    if (map.getLayer('cso-bua-line'))             map.setLayoutProperty('cso-bua-line',             'visibility', vis(props.boundaryTownLinesVisible))
    if (map.getLayer('cso-sa-line'))              map.setLayoutProperty('cso-sa-line',              'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('cso-sa-fill'))              map.setLayoutProperty('cso-sa-fill',              'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('households-circle'))        map.setLayoutProperty('households-circle',        'visibility', vis(props.householdsLayerVisible))
    if (map.getLayer('ev-commercial-circle'))     map.setLayoutProperty('ev-commercial-circle',     'visibility', vis(props.evCommercialLayerVisible))
    // Index layers — independent visibility, never linked to any other toggle
    if (map.getLayer('cso-sa-renew-fill'))        map.setLayoutProperty('cso-sa-renew-fill',        'visibility', vis(props.renewScoreVisible))
    if (map.getLayer('cso-sa-commercial-fill'))   map.setLayoutProperty('cso-sa-commercial-fill',   'visibility', vis(props.commercialScoreVisible))
  }, [props.boundaryCountyLinesVisible, props.boundaryTownLinesVisible, props.boundarySmallAreaLinesVisible, props.householdsLayerVisible, props.evCommercialLayerVisible, props.renewScoreVisible, props.commercialScoreVisible])

  // ── Selection highlight ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const code   = (props.focusBuaCode  ?? '').trim()
    const county = (props.focusCountyLa ?? '').trim()
    const cf = county ? props.boundaries.counties.features.find((f) => normGeoProp((f.properties as any)?.LOCAL_AUTHORITY) === county) : null
    const bf = code   ? props.boundaries.bua.features.find((f) => normGeoProp((f.properties as any)?.BUA_CODE) === code || normGeoProp((f.properties as any)?.GEOGID) === code) : null
    ;(map.getSource('cso-counties-selection') as maplibregl.GeoJSONSource | undefined)?.setData(selectionFC(cf ?? bf ?? null))
  }, [props.focusBuaCode, props.focusCountyLa, props.boundaries])

  // ── Hover handlers ────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const onSaMove = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0]
      if (!feature) return

      const mapInst = mapRef.current
      if (mapInst && feature.id !== undefined) {
        if (hoveredFeatureIdRef.current !== null) {
          mapInst.setFeatureState(
            { source: 'cso-small-areas', id: hoveredFeatureIdRef.current },
            { hovered: false },
          )
        }
        hoveredFeatureIdRef.current = feature.id
        mapInst.setFeatureState(
          { source: 'cso-small-areas', id: feature.id },
          { hovered: true },
        )
      }

      const p = (feature.properties ?? {}) as Record<string, unknown>
      let embedded: Record<string, { mapValue: number; pctValue?: number | null }> = {}
      try { embedded = JSON.parse(String(p._metrics || '{}')) } catch {}

      const rows = (propsRef.current.activeMetrics ?? [])
        .filter((m) => m.geography === 'small_area')
        .map((m) => {
          const hit = embedded[m.key]
          const rawNo = hit?.mapValue != null ? hit.mapValue : null

          // Format No column — large numbers get K suffix
          let noDisplay = '—'
          if (rawNo != null) {
            noDisplay = rawNo >= 1000
              ? `${(rawNo / 1000).toFixed(1)}K`
              : String(Math.round(rawNo))
          }

          // pctValue: GeoJSON embedded first, then fall back to uploaded workbook values
          let pctValue: number | null | undefined = hit?.pctValue
          if (pctValue == null) {
            const geogid = String(p._cso_code ?? p.GEOGID ?? p._pub2022 ?? '')
            for (const alias of aliasIds(geogid)) {
              const wbHit = m.values?.[alias]
              if (wbHit?.pctValue != null) { pctValue = wbHit.pctValue; break }
            }
          }

          return {
            key: m.key,
            label: m.label,
            no:  noDisplay,
            pct: pctValue != null ? `${Number(pctValue).toFixed(1)}%` : '—',
          }
        })

      const rawGeogid = String(p._cso_code ?? p.GEOGID ?? p._pub2022 ?? '')
      const saCode = rawGeogid.replace(/^[A-Za-z]/, '')
      const edName = String(p.ED_Name ?? p.GEOGDESC ?? '')
      const county = String(p.COUNTY ?? '')

      // Index score rows — only added when the respective toggle is on
      const indexRows: Array<{ label: string; value: string }> = []
      if (propsRef.current.renewScoreVisible) {
        const val = embedded['renew_score']?.mapValue
        indexRows.push({ label: 'RENEW Potential Score', value: val != null && Number.isFinite(val) ? `${Number(val).toFixed(1)} / 100` : '—' })
      }
      if (propsRef.current.commercialScoreVisible) {
        const val = embedded['commercial_score']?.mapValue
        indexRows.push({ label: 'Commercial Readiness', value: val != null && Number.isFinite(val) ? `${Number(val).toFixed(1)} / 100` : '—' })
      }

      // Combined z-score band — only shown when 2+ SA metrics are active
      const saMetricCount = (propsRef.current.activeMetrics ?? []).filter(m => m.geography === 'small_area').length
      let combinedScore: { band: string; pct: string } | null = null
      if (saMetricCount >= 2) {
        const rawScore = typeof p._score === 'number' ? p._score : (p._score != null ? Number(p._score) : null)
        if (rawScore != null && Number.isFinite(rawScore)) {
          const band = rawScore >= 0.8 ? 'High Potential'
            : rawScore >= 0.6 ? 'Above Average'
            : rawScore >= 0.4 ? 'Moderate'
            : rawScore >= 0.2 ? 'Developing'
            : 'Low Potential'
          combinedScore = { band, pct: String(Math.round(rawScore * 100)) }
        }
      }

      setTooltip({ x: e.point.x + 16, y: e.point.y + 16, title: rawGeogid, saCode, county, edName, rows, indexRows, combinedScore })
    }

    const onPointMove = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0]
      if (!feature) return
      const p = (feature.properties ?? {}) as Record<string, unknown>
      const isCommercial = p.dotType === 'yellow'
      const dotLabel = isCommercial ? 'Commercial' : 'Household'
      const title = String(p.fullAddress || dotLabel)
      const yesNo = (val: unknown) => {
        const s = String(val ?? '').trim().toLowerCase()
        if (s === 'yes' || s === 'true') return '✅ Yes'
        if (s === 'no'  || s === 'false') return '❌ No'
        return '❓ Unknown'
      }
      const tableRows = [
        { label: 'Solar',      value: yesNo(p.solar) },
        { label: 'EV Charger', value: yesNo(p.ev) },
        { label: 'Heat Pump',  value: yesNo(p.heat_pump) },
      ]
      const simple: string[] = []
      setTooltip({ x: e.point.x + 16, y: e.point.y + 16, title, county: '', edName: dotLabel, saCode: isCommercial ? 'commercial' : 'household', rows: [], simple, pointRows: tableRows })
    }

    const clear = () => setTooltip(null)
    const onSaLeave = () => {
      const mapInst = mapRef.current
      if (mapInst && hoveredFeatureIdRef.current !== null) {
        mapInst.setFeatureState(
          { source: 'cso-small-areas', id: hoveredFeatureIdRef.current },
          { hovered: false },
        )
        hoveredFeatureIdRef.current = null
      }
      setTooltip(null)
    }
    map.on('mousemove',  'cso-sa-fill',          onSaMove)
    map.on('mouseleave', 'cso-sa-fill',          onSaLeave)
    const onDroppedPinMove = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0]
      if (!feature) return
      const pinId = String(feature.properties?.id ?? '')
      const pin = droppedPinsRef.current.find(p => p.id === pinId)
      if (!pin) return
      const address = [pin.houseNo, pin.street, pin.town, pin.county].filter(Boolean).join(', ')
      const yesNo = (v: string) => v === 'Yes' ? '✅ Yes' : v === 'No' ? '❌ No' : '❓ Unknown'
      setTooltip({
        x: e.point.x + 16, y: e.point.y + 16,
        title: address || 'Dropped pin',
        county: '', edName: pin.type, saCode: 'droppedpin', rows: [],
        simple: [],
        pointRows: [
          { label: 'Solar', value: yesNo(pin.solar) },
          { label: 'EV', value: yesNo(pin.ev) },
          { label: 'Heat Pump', value: yesNo(pin.heatPump) },
        ],
      })
    }
    map.on('mouseenter', 'dropped-pins-outer', () => { map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', 'dropped-pins-outer', () => { map.getCanvas().style.cursor = pinModeRef.current ? 'crosshair' : '' })
    map.on('mousemove',  'dropped-pins-outer', onDroppedPinMove)
    map.on('mouseleave', 'dropped-pins-outer', clear)
    map.on('mousemove',  'households-circle',    onPointMove)
    map.on('mouseleave', 'households-circle',    clear)
    map.on('mousemove',  'ev-commercial-circle', onPointMove)
    map.on('mouseleave', 'ev-commercial-circle', clear)
    return () => {
      map.off('mousemove',  'cso-sa-fill',          onSaMove)
      map.off('mouseleave', 'cso-sa-fill',          onSaLeave)
      map.off('mousemove',  'households-circle',    onPointMove)
      map.off('mouseleave', 'households-circle',    clear)
      map.off('mousemove',  'ev-commercial-circle', onPointMove)
      map.off('mouseleave', 'ev-commercial-circle', clear)
      map.off('mousemove',  'dropped-pins-outer',   onDroppedPinMove)
      map.off('mouseleave', 'dropped-pins-outer',   clear)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div ref={mapRootRef} className="mapRoot">
      <div ref={containerRef} className="mapContainer" />

      {saLoading && (
        <div style={{ position:'absolute', bottom:8, left:8, zIndex:10, background:'rgba(255,255,255,0.88)', padding:'4px 10px', borderRadius:4, fontSize:12, color:'#374151' }}>
          Loading small areas…
        </div>
      )}

      {tooltip && (
        <div
          className="mapHoverTooltip"
          style={{ position: 'absolute', left: Math.min(tooltip.x, window.innerWidth - 320 - 8), top: tooltip.y, maxWidth: 'min(320px, calc(100vw - 16px))', fontSize: 11, wordBreak: 'break-word', pointerEvents: 'none' }}
        >
          {tooltip.rows.length > 0 || tooltip.county || (tooltip.indexRows && tooltip.indexRows.length > 0) ? (
            <>
              {/* 1 — Area name always at top */}
              {(tooltip.edName || tooltip.saCode || tooltip.county) && (
                <div style={{ display: 'flex', alignItems: 'center', fontSize: 13, marginBottom: 4, flexWrap: 'wrap', gap: '0 4px' }}>
                  {tooltip.edName && <span style={{ color: '#15803d', fontWeight: 700 }}>{tooltip.edName}</span>}
                  {tooltip.edName && tooltip.county && <span style={{ color: '#15803d' }}>|</span>}
                  {tooltip.county && <span style={{ color: '#15803d', fontWeight: 400 }}>{tooltip.county}</span>}
                  {(tooltip.edName || tooltip.county) && tooltip.saCode && <span style={{ color: '#9ca3af' }}>|</span>}
                  {tooltip.saCode && <span style={{ color: '#9ca3af', fontWeight: 400, fontSize: 11 }}>SA: {tooltip.saCode}</span>}
                </div>
              )}

              {/* 2 — Always show all active metric rows with No + % */}
              {tooltip.rows.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600, paddingRight: 8, flex: 1, minWidth: 0 }}>Metric (CSO 2022)</th>
                      <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600, paddingRight: 4, width: 36, flexShrink: 0, whiteSpace: 'nowrap' }}>No</th>
                      <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600, width: 48, flexShrink: 0, whiteSpace: 'nowrap' }}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tooltip.rows.map((row, i) => (
                      <tr key={i}>
                        <td style={{ padding: '2px 8px 2px 0', borderBottom: '1px solid #f3f4f6', flex: 1, minWidth: 0 }}>{FILTER_ICONS[row.key] ? `${FILTER_ICONS[row.key]} ${row.label}` : row.label}</td>
                        <td style={{ textAlign: 'right', borderBottom: '1px solid #f3f4f6', padding: '2px 4px', width: 36, flexShrink: 0, whiteSpace: 'nowrap' }}>{row.no}</td>
                        <td style={{ textAlign: 'right', borderBottom: '1px solid #f3f4f6', padding: '2px 0', width: 48, flexShrink: 0, whiteSpace: 'nowrap' }}>{row.pct}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {/* 3 — Combined Z-Score (multi-metric only) */}
              {tooltip.combinedScore && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, paddingTop: 4, borderTop: '1px solid #f3f4f6', fontSize: 11 }}>
                  <span style={{ fontWeight: 700, color: '#b91c1c' }}>{tooltip.combinedScore.band}</span>
                  <span style={{ color: '#9ca3af' }}>·</span>
                  <span style={{ color: '#6b7280' }}>Z-Score: {tooltip.combinedScore.pct} / 100</span>
                </div>
              )}

              {/* 4 — Index scores at bottom */}
              {tooltip.indexRows && tooltip.indexRows.length > 0 && (
                <div style={{ marginTop: 6, borderTop: '1px solid #e5e7eb', paddingTop: 5 }}>
                  {tooltip.indexRows.map((row, i) => (
                    <div key={i} style={{ marginBottom: i < tooltip.indexRows!.length - 1 ? 3 : 0 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: i === 0 ? '#ea580c' : '#7c3aed', background: i === 0 ? '#fff7ed' : '#f5f3ff', borderRadius: 3, padding: '1px 6px', border: `1px solid ${i === 0 ? '#fed7aa' : '#ddd6fe'}`, whiteSpace: 'nowrap' }}>
                        {i === 0 ? '♻️' : '🎯'} {row.label}: {row.value}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {tooltip.saCode === 'commercial' && (
                <div style={{ fontSize: 12, color: '#92400e', fontWeight: 700, marginBottom: 4 }}>Commercial</div>
              )}
              {tooltip.saCode === 'household' && (
                <div style={{ fontSize: 12, color: '#15803d', fontWeight: 700, marginBottom: 4 }}>Household</div>
              )}
              {tooltip.saCode === 'droppedpin' && (
                <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 700, marginBottom: 4 }}>{tooltip.edName}</div>
              )}
              <div className="mapHoverTooltipTitle">{tooltip.title}</div>
              {(tooltip.simple ?? []).map((line, i) => (
                <div key={i} className="mapHoverTooltipLine">{line}</div>
              ))}
              {(tooltip.pointRows ?? []).length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 4 }}>
                  <tbody>
                    {(tooltip.pointRows ?? []).map((row, i) => (
                      <tr key={i}>
                        <td style={{ padding: '2px 12px 2px 0', color: '#6b7280', whiteSpace: 'nowrap' }}>{row.label}</td>
                        <td style={{ padding: '2px 0', whiteSpace: 'nowrap' }}>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}

      {/* Pin mode button + CSV button */}
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 15, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={() => { setPinModeActive(a => !a); setNewPinCoords(null); setEditingPinId(null) }}
          style={{ padding: '6px 12px', borderRadius: 6, border: `1px solid ${pinModeActive ? '#15803d' : '#d1d5db'}`, background: pinModeActive ? '#15803d' : '#fff', color: pinModeActive ? '#fff' : '#374151', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.15)', whiteSpace: 'nowrap' }}
        >
          <svg width="11" height="14" viewBox="0 0 11 14" fill="none"><circle cx="5.5" cy="5" r="3" stroke="currentColor" strokeWidth="1.4"/><path d="M5.5 8 L5.5 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
          {pinModeActive ? 'Pin mode on' : 'Enable pin mode'}
        </button>
        {droppedPins.length > 0 && (
          <button onClick={downloadPinsCSV}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.15)', whiteSpace: 'nowrap' }}>
            ↓ Download pins ({droppedPins.length})
          </button>
        )}
      </div>

      {/* New pin form */}
      {newPinCoords && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 16, width: 300, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 4px 20px rgba(0,0,0,0.22)' }}>
            <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', borderBottom: '1px solid #f3f4f6', paddingBottom: 8, marginBottom: 12 }}>New pin</div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Type</label>
              <select value={pinForm.type} onChange={e => setPinForm(f => ({ ...f, type: e.target.value as 'Household' | 'Business' }))} style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827', boxSizing: 'border-box' }}>
                <option value="Household">Household</option>
                <option value="Business">Business</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>House No</label>
                <input type="text" value={pinForm.houseNo} onChange={e => setPinForm(f => ({ ...f, houseNo: e.target.value }))} placeholder="e.g. 14" style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827', boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 2 }}>
                <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Street</label>
                <input type="text" value={pinForm.street} onChange={e => setPinForm(f => ({ ...f, street: e.target.value }))} placeholder="Street name" style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827', boxSizing: 'border-box' }} />
              </div>
            </div>
            <div style={{ marginBottom: 10, position: 'relative' }}>
              <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>Town</label>
              <input type="text" value={townSearch} onChange={e => { setTownSearch(e.target.value); setTownDropdownOpen(true); if (!e.target.value) setPinForm(f => ({ ...f, town: '', county: '' })) }} onFocus={() => setTownDropdownOpen(true)} placeholder="Type to search..." style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827', boxSizing: 'border-box' }} />
              {townDropdownOpen && townSearch.length >= 1 && (
                <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, zIndex: 30, maxHeight: 160, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.12)' }}>
                  {(props.towns ?? []).filter(t => t.label.toLowerCase().includes(townSearch.toLowerCase())).slice(0, 8).map(t => (
                    <div key={t.label + t.county} onMouseDown={() => { setPinForm(f => ({ ...f, town: t.label, county: t.county })); setTownSearch(t.label); setTownDropdownOpen(false) }} style={{ padding: '6px 10px', fontSize: 13, cursor: 'pointer', color: '#111827', borderBottom: '1px solid #f9fafb' }} onMouseOver={e => (e.currentTarget.style.background = '#f9fafb')} onMouseOut={e => (e.currentTarget.style.background = '#fff')}>
                      {t.label} <span style={{ color: '#9ca3af', fontSize: 11 }}>{t.county}</span>
                    </div>
                  ))}
                  {(props.towns ?? []).filter(t => t.label.toLowerCase().includes(townSearch.toLowerCase())).length === 0 && (
                    <div style={{ padding: '6px 10px', fontSize: 13, color: '#9ca3af' }}>No towns found</div>
                  )}
                </div>
              )}
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>County</label>
              <input type="text" value={pinForm.county} readOnly style={{ width: '100%', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
              {(['solar', 'ev', 'heatPump'] as const).map(field => (
                <div key={field}>
                  <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>{field === 'heatPump' ? 'Heat pump' : field === 'ev' ? 'EV' : 'Solar'}</label>
                  <select value={pinForm[field]} onChange={e => setPinForm(f => ({ ...f, [field]: e.target.value as YesNoUnknown }))} style={{ width: '100%', fontSize: 13, padding: '6px 4px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827' }}>
                    <option>Unknown</option><option>Yes</option><option>No</option>
                  </select>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setNewPinCoords(null)} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #dc2626', background: 'transparent', color: '#dc2626', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/></svg>
                Cancel
              </button>
              <button onClick={handleSavePin} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #15803d', background: 'transparent', color: '#15803d', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6L5 9L10 3" stroke="#15803d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Save pin
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit pin form */}
      {editingPinId && (() => {
        const pin = droppedPins.find(p => p.id === editingPinId)
        if (!pin) return null
        return (
          <div style={{ position: 'absolute', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.25)' }}>
            <div style={{ background: '#fff', borderRadius: 10, padding: 16, width: 280, boxShadow: '0 4px 20px rgba(0,0,0,0.22)' }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: '#111827', borderBottom: '1px solid #f3f4f6', paddingBottom: 8, marginBottom: 8 }}>Edit pin</div>
              <div style={{ fontSize: 13, color: '#374151', marginBottom: 2 }}>{[pin.houseNo, pin.street, pin.town].filter(Boolean).join(' ')}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>{pin.type}{pin.county ? ` · ${pin.county}` : ''}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 14 }}>
                {(['solar', 'ev', 'heatPump'] as const).map(field => (
                  <div key={field}>
                    <label style={{ fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4 }}>{field === 'heatPump' ? 'Heat pump' : field === 'ev' ? 'EV' : 'Solar'}</label>
                    <select value={editForm[field]} onChange={e => setEditForm(f => ({ ...f, [field]: e.target.value as YesNoUnknown }))} style={{ width: '100%', fontSize: 13, padding: '6px 4px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: '#111827' }}>
                      <option>Unknown</option><option>Yes</option><option>No</option>
                    </select>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEditingPinId(null)} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #dc2626', background: 'transparent', color: '#dc2626', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2L10 10M10 2L2 10" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  No change
                </button>
                <button onClick={handleSaveEdit} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #15803d', background: 'transparent', color: '#15803d', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6L5 9L10 3" stroke="#15803d" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Save
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Single merged legend panel — bottom right */}
      {(() => {
        const COLOURS = ['#c0392b', '#e74c3c', '#f1948a', '#f9b8b1', '#fde8e6']
        const INDEX_COLOURS = ['#7f1d1d', '#c0392b', '#e74c3c', '#f1948a', '#fcc9c0']
        const saMetrics    = activeMetrics.filter(m => m.geography === 'small_area')
        const showIndex    = props.renewScoreVisible || props.commercialScoreVisible
        const showIndexBands = showIndex && saMetrics.length === 0
        const showComposite = saMetrics.length > 0
        if (!showIndex && !showComposite) return null
        const isSingle = saMetrics.length === 1
        const isPobal  = isSingle && saMetrics[0].key === 'phobal_score'

        // Composite bands
        let rangeBands: { color: string; label: string }[] = []
        if (isSingle && !isPobal) {
          const key = saMetrics[0].key
          const vals: number[] = []
          for (const f of saRaw.features) {
            try {
              const p = (f.properties ?? {}) as Record<string, unknown>
              const m = typeof p._metrics === 'string' ? JSON.parse(p._metrics) : (p._metrics ?? {})
              const v = m[key]?.mapValue
              if (v != null && Number.isFinite(v)) vals.push(v)
            } catch {}
          }
          if (vals.length > 0) {
            vals.sort((a, b) => a - b)
            const rawMin = vals[0]; const rawMax = vals[vals.length - 1]
            const max = Math.round(rawMax)
            const breakPts = [0, 0.2, 0.4, 0.6, 0.8].map(t => Math.round(rawMin + t * (rawMax - rawMin)))
            const bands5 = Array.from({ length: 5 }, (_, i) => ({ lo: breakPts[i], hi: i === 4 ? max : breakPts[i + 1] - 1 }))
            rangeBands = COLOURS.map((color, i) => { const b = bands5[4 - i]; return { color, label: b.lo === b.hi ? `${b.lo}` : `${b.lo} – ${b.hi}` } })
          }
        }
        const pobalBands = [
          { color: '#7f1d1d', label: 'Very Affluent',      range: '+10 to +35' },
          { color: '#b91c1c', label: 'Above Average',      range: '0 to +10'   },
          { color: '#ef4444', label: 'Average',            range: '-10 to 0'   },
          { color: '#fb7185', label: 'Disadvantaged',      range: '-20 to -10' },
          { color: '#fecdd3', label: 'Very Deprived',      range: '-35 to -20' },
        ]
        const multiLabels = [
          { color: '#7f1d1d', label: 'High Potential'  },
          { color: '#b91c1c', label: 'Above Average'   },
          { color: '#ef4444', label: 'Moderate'        },
          { color: '#fb7185', label: 'Developing'      },
          { color: '#fecdd3', label: 'Low Potential'   },
        ]
        const compositeTitle = isPobal ? 'Pobal HP Index' : isSingle ? (saMetrics[0].label ?? 'Legend') : 'Potential'
        const compositeBands = isPobal ? pobalBands.map(b => ({ color: b.color, label: `${b.range}  ${b.label}` })) : isSingle && rangeBands.length > 0 ? rangeBands : multiLabels

        const indexBands = [
          { color: INDEX_COLOURS[0], label: '81 – 100', desc: 'Very High' },
          { color: INDEX_COLOURS[1], label: '61 – 80',  desc: 'High'      },
          { color: INDEX_COLOURS[2], label: '41 – 60',  desc: 'Medium'    },
          { color: INDEX_COLOURS[3], label: '21 – 40',  desc: 'Low'       },
          { color: INDEX_COLOURS[4], label: '0 – 20',   desc: 'Very Low'  },
        ]

        return (
          <div style={{ position: 'absolute', bottom: 28, right: 8, zIndex: 10, background: 'rgba(255,255,255,0.95)', borderRadius: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.18)', fontSize: 11, minWidth: 170, maxWidth: 230, userSelect: 'none' }}>

            {/* ── Composite section ── */}
            {showComposite && (
              <>
                <div onClick={() => setLegendOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 8px', cursor: 'pointer', fontWeight: 600, color: '#374151', borderBottom: legendOpen ? '1px solid #f3f4f6' : 'none' }}>
                  <span>{compositeTitle}</span>
                  <span style={{ fontSize: 9, marginLeft: 8, color: '#9ca3af' }}>{legendOpen ? '▲' : '▼'}</span>
                </div>
                {legendOpen && (
                  <div style={{ padding: '6px 8px 8px' }}>
                    {compositeBands.map(({ color, label }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 2, background: color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.08)' }} />
                        <span style={{ color: '#374151' }}>{label}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 5, borderTop: '1px solid #f3f4f6', paddingTop: 4 }}>
                      {isSingle ? <span style={{ color: '#9ca3af', fontSize: 10 }}>CSO 2022</span> : (
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <span style={{ color: '#9ca3af', fontSize: 10 }}>Z-score · CSO 2022</span>
                            <button onClick={e => { e.stopPropagation(); setLegendNoteOpen(o => !o) }} style={{ background: 'none', border: '1px solid #d1d5db', borderRadius: '50%', width: 14, height: 14, fontSize: 9, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 }} title="How is this calculated?">*</button>
                          </div>
                          {legendNoteOpen && (
                            <div style={{ marginTop: 6, fontSize: 10, color: '#6b7280', lineHeight: 1.5 }}>
                              For each selected metric, every small area is scored 0–1 based on how it compares to the national average. Scores are averaged equally. Darker red = higher combined potential.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Index section ── */}
            {showIndex && (
              <>
                <div style={{ padding: '5px 8px 4px', borderTop: showComposite ? '2px solid #e5e7eb' : 'none', borderBottom: showIndexBands ? '1px solid #f3f4f6' : 'none' }}>
                </div>
                {showIndexBands && (
                  <div style={{ padding: '5px 8px 6px' }}>
                    {indexBands.map(({ color, label, desc }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <div style={{ width: 14, height: 14, borderRadius: 2, background: color, flexShrink: 0, border: '1px solid rgba(0,0,0,0.08)' }} />
                        <span style={{ color: '#374151', fontWeight: 500 }}>{label}</span>
                        <span style={{ color: '#9ca3af', marginLeft: 'auto' }}>{desc}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 4, borderTop: '1px solid #f3f4f6', paddingTop: 3, fontSize: 10, color: '#9ca3af' }}>Score / 100 · independent layer</div>
                  </div>
                )}
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
