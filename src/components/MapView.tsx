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

// ─── Types ────────────────────────────────────────────────────────────────────

type MetricValue = { mapValue: number; pctValue?: number | null; rawValue?: number | string }
type MetricStats  = { mean: number; std: number }

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
}

// ─── Constants ────────────────────────────────────────────────────────────────

const INITIAL_VIEW  = { center: [-8.1, 53.35] as [number, number], zoom: 6.8 }
const COUNTY_LINE   = '#2563eb'
const TOWN_LINE     = '#92400e'
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

function countyLabelPoints(fc: FeatureCollection): FeatureCollection {
  const feats: Feature<Point>[] = []
  const seen = new Set<string>()
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const name = String(p.COUNTY ?? p.LOCAL_AUTHORITY ?? '').trim()
    if (!name || seen.has(name)) continue
    const box = geometryBBox(g)
    if (!box) continue
    const [w, s, e, n] = box
    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] },
      properties: { COUNTY: name },
    })
    seen.add(name)
  }
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
    if (std > 0) out[key] = { mean, std }
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

        // All metrics including Phobal: z-score normalisation
        // HP_Score (mean≈0, std≈10) maps naturally:
        //   -20 → z=-2 → score=0 (lightest), 0 → score=0.5, +20 → z=+2 → score=1 (darkest)
        const s = stats[metric.key]
        if (!s) continue
        score += zNorm(hit.mapValue, s.mean, s.std)
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
      '#fecdd3',        // 0.0–0.2  below average
      0.2, '#fb7185',   // 0.2–0.4
      0.4, '#ef4444',   // 0.4–0.6  around average
      0.6, '#b91c1c',   // 0.6–0.8
      0.8, '#7f1d1d',   // 0.8–1.0  hotspot
    ],
  ]
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

  type Tooltip = {
    x: number; y: number; title: string; county: string
    rows: Array<{ key: string; label: string; no: string; pct: string }>
    simple?: string[]
    pointRows?: Array<{ label: string; value: string }>
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
        }
      })
      .catch((err) => { console.error('SA GeoJSON load failed:', err); setSaLoading(false) })
  }, [])

  // ── Update fill colour/opacity when metrics or stats change ───────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded() || !map.getLayer('cso-sa-fill')) return
    map.setPaintProperty('cso-sa-fill', 'fill-color',   redScoreExpression())
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
      map.addSource('cso-counties-selection',    { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-bua-selection',         { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-counties-label-points', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('households',    { type: 'geojson', data: toPointGeoJson([]) })
      map.addSource('ev-commercial', { type: 'geojson', data: toPointGeoJson([]) })

      // Fill layers
      map.addLayer({ id: 'cso-counties-fill', type: 'fill', source: 'cso-counties',    paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0 } })
      map.addLayer({ id: 'cso-bua-fill',      type: 'fill', source: 'cso-bua',         paint: { 'fill-color': redScoreExpression(), 'fill-opacity': SA_FILL_OPACITY } })
      map.addLayer({ id: 'cso-sa-fill',       type: 'fill', source: 'cso-small-areas', paint: { 'fill-color': redScoreExpression(), 'fill-opacity': SA_FILL_OPACITY } })

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
      map.addLayer({ id: 'cso-bua-line',      type: 'line', source: 'cso-bua',         paint: { 'line-color': TOWN_LINE,   'line-width': ['interpolate',['linear'],['zoom'],4,1.1,8,1.0,12,0.8], 'line-opacity': 0.95 } })
      map.addLayer({ id: 'cso-sa-line',       type: 'line', source: 'cso-small-areas', paint: { 'line-color': SA_LINE,     'line-width': ['interpolate',['linear'],['zoom'],4,0.5,6.8,0.7,9,0.8,12,0.65], 'line-opacity': ['interpolate',['linear'],['zoom'],4,0.4,8,0.65,12,0.5] } })

      // Labels
      map.addLayer({ id: 'cso-counties-label', type: 'symbol', source: 'cso-counties-label-points', minzoom: 4.2,
        layout: { 'text-field': ['get','COUNTY'], 'text-font': ['Open Sans Bold','Arial Unicode MS Bold'], 'text-size': ['interpolate',['linear'],['zoom'],4,10,7,12,10,13], 'text-anchor': 'center', 'text-allow-overlap': false },
        paint:  { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })

      // Point layers
      map.addLayer({ id: 'households-circle',    type: 'circle', source: 'households',    paint: { 'circle-color': '#ef4444', 'circle-radius': ['interpolate',['linear'],['zoom'],6,1.6,10,3.5,14,5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })
      map.addLayer({ id: 'ev-commercial-circle', type: 'circle', source: 'ev-commercial', paint: { 'circle-color': '#eab308', 'circle-radius': ['interpolate',['linear'],['zoom'],6,1.6,10,3.5,14,5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 } })

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

  // ── Visibility toggles ────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = (on?: boolean) => on === false ? 'none' : 'visible'
    if (map.getLayer('cso-counties-line'))     map.setLayoutProperty('cso-counties-line',     'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-counties-label'))    map.setLayoutProperty('cso-counties-label',    'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-bua-line'))          map.setLayoutProperty('cso-bua-line',          'visibility', vis(props.boundaryTownLinesVisible))
    if (map.getLayer('cso-sa-line'))           map.setLayoutProperty('cso-sa-line',           'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('cso-sa-fill'))           map.setLayoutProperty('cso-sa-fill',           'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('households-circle'))     map.setLayoutProperty('households-circle',     'visibility', vis(props.householdsLayerVisible))
    if (map.getLayer('ev-commercial-circle'))  map.setLayoutProperty('ev-commercial-circle',  'visibility', vis(props.evCommercialLayerVisible))
  }, [props.boundaryCountyLinesVisible, props.boundaryTownLinesVisible, props.boundarySmallAreaLinesVisible, props.householdsLayerVisible, props.evCommercialLayerVisible])

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

      setTooltip({ x: e.point.x + 16, y: e.point.y + 16, title: String(p._cso_code ?? p.GEOGID ?? ''), county: String(p.COUNTY ?? ''), rows })
    }

    const onPointMove = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0]
      if (!feature) return
      const p = (feature.properties ?? {}) as Record<string, unknown>
      const title = String(p.fullAddress || (p.dotType === 'yellow' ? 'EV Commercial' : 'Household'))
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
      setTooltip({ x: e.point.x + 16, y: e.point.y + 16, title, county: '', rows: [], simple, pointRows: tableRows })
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
          style={{ left: tooltip.x, top: tooltip.y, maxWidth: 340, pointerEvents: 'none' }}
        >
          {tooltip.rows.length > 0 || tooltip.county ? (
            <>
              <div className="mapHoverTooltipTitle">{tooltip.title}</div>
              {tooltip.county && (
                <div className="mapHoverTooltipLine" style={{ color: '#6b7280', marginBottom: 4 }}>
                  {tooltip.county}
                </div>
              )}
              {tooltip.rows.length > 0 && (
                <>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600, paddingRight: 8 }}>Metric (CSO 2022)</th>
                        <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600, paddingRight: 4 }}>No</th>
                        <th style={{ textAlign: 'right', borderBottom: '1px solid #e5e7eb', paddingBottom: 2, fontWeight: 600 }}>%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tooltip.rows.map((row, i) => (
                        <tr key={i}>
                          <td style={{ padding: '2px 8px 2px 0', borderBottom: '1px solid #f3f4f6', whiteSpace: 'nowrap' }}>{row.label}</td>
                          <td style={{ textAlign: 'right', borderBottom: '1px solid #f3f4f6', padding: '2px 4px' }}>{row.no}</td>
                          <td style={{ textAlign: 'right', borderBottom: '1px solid #f3f4f6', padding: '2px 0' }}>{row.pct}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          ) : (
            <>
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

      {/* Colour legend */}
      <div style={{
        position: 'absolute',
        bottom: 28,
        right: 8,
        zIndex: 10,
        background: 'rgba(255,255,255,0.95)',
        borderRadius: 6,
        boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
        fontSize: 11,
        minWidth: 150,
        userSelect: 'none',
      }}>
        {/* Header — always visible, click to collapse */}
        <div
          onClick={() => setLegendOpen(o => !o)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '5px 8px',
            cursor: 'pointer',
            fontWeight: 600,
            color: '#374151',
            borderBottom: legendOpen ? '1px solid #f3f4f6' : 'none',
          }}
        >
          <span>Potential Index</span>
          <span style={{ fontSize: 9, marginLeft: 8, color: '#9ca3af' }}>
            {legendOpen ? '▲' : '▼'}
          </span>
        </div>

        {/* Body — collapsible */}
        {legendOpen && (
          <div style={{ padding: '6px 8px 8px' }}>
            {[
              { color: '#7f1d1d', label: 'High Potential' },
              { color: '#b91c1c', label: 'Above Average' },
              { color: '#ef4444', label: 'Average' },
              { color: '#fb7185', label: 'Slightly Below Avg' },
              { color: '#fecdd3', label: 'Below Average' },
            ].map(({ color, label }) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: 2,
                  background: color, flexShrink: 0,
                  border: '1px solid rgba(0,0,0,0.08)',
                }} />
                <span style={{ color: '#374151' }}>{label}</span>
              </div>
            ))}
            <div style={{ marginTop: 5, color: '#9ca3af', fontSize: 10, borderTop: '1px solid #f3f4f6', paddingTop: 4 }}>
              Z-score · CSO 2022
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
