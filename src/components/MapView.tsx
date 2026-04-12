
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

type MetricValue = { mapValue: number; rawValue?: number | string }

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
  /** Pre-built SA polygons + `m_<key>` metrics from `public/small_areas_metrics.geojson` (built by scripts/build_sa_geojson.py). */
  smallAreasGeoJson: FeatureCollection
  /** True while `/small_areas_metrics.geojson` (or companion assets) are still loading in the parent. */
  smallAreasGeoJsonLoading?: boolean
  households?: HouseholdRecord[]
  householdsLayerVisible?: boolean
  boundaryCountyLinesVisible?: boolean
  boundaryTownLinesVisible?: boolean
  boundarySmallAreaLinesVisible?: boolean
  /** Click a small-area polygon (fill or outline) to pass feature properties to the app; click elsewhere to clear. */
  onSmallAreaSelect?: (properties: Record<string, unknown> | null) => void
}

const INITIAL_VIEW = { center: [-8.1, 53.35] as [number, number], zoom: 6.8 }
const COUNTY_LINE = '#2563eb'
const TOWN_LINE = '#92400e'
const SA_LINE = '#dc2626'

/** Plain object for React state (MapLibre may return frozen / odd prototypes on queried features). */
function plainProps(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    out[k] = (raw as Record<string, unknown>)[k]
  }
  return out
}

/** Matches `safe_metric_prop` in scripts/build_sa_geojson.py → property `m_<name>`. */
function metricGeoJsonPropertyName(metricKey: string): string {
  const safe = metricKey.trim().replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'metric'
  return `m_${safe}`
}

function selectionFeatureCollection(feature: Feature | null | undefined): FeatureCollection {
  if (!feature) return emptyFeatureCollection()
  return { type: 'FeatureCollection', features: [feature] }
}

function formatNumber(v: number | string | undefined): string {
  if (v === undefined) return '—'
  if (typeof v === 'string') return v
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function toHouseholdGeoJson(households: HouseholdRecord[]) {
  return {
    type: 'FeatureCollection' as const,
    features: households.map((h) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [h.lon, h.lat] as [number, number] },
      properties: { id: h.id, address: h.address ?? '', county: h.county ?? '', town: h.town ?? '' },
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
    feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + n) / 2] }, properties: { COUNTY: name } })
    seen.add(name)
  }
  return { type: 'FeatureCollection', features: feats }
}

function metricExtents(metrics: ActiveMetric[], geography: 'small_area' | 'town'): Record<string, { min: number; max: number }> {
  const out: Record<string, { min: number; max: number }> = {}
  for (const metric of metrics) {
    if (metric.geography !== geography) continue
    const vals = Object.values(metric.values).map((v) => v.mapValue).filter(Number.isFinite)
    if (!vals.length) continue
    out[metric.key] = { min: Math.min(...vals), max: Math.max(...vals) }
  }
  return out
}

function normalizeMetric(value: number, min: number, max: number): number {
  const span = max - min
  if (!Number.isFinite(value)) return 0
  if (span <= 1e-9) return 1
  return Math.max(0, Math.min(1, (value - min) / span))
}

function readNumericProp(props: Record<string, unknown>, prop: string): number | null {
  const raw = props[prop]
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(n) ? n : null
}

/** Town metrics: still use in-memory `values` keyed by BUA / town id. */
function attachCombinedMetricTown(fc: FeatureCollection, metrics: ActiveMetric[]): FeatureCollection {
  const relevant = metrics.filter((m) => m.geography === 'town')
  const extents = metricExtents(relevant, 'town')

  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const props = { ...((f.properties as Record<string, unknown> | null) ?? {}) }
      const key = normGeoProp(props.BUA_CODE || props.GEOGID)
      let score = 0
      let contributing = 0
      for (const metric of relevant) {
        const hit = metric.values[key]
        if (!hit) continue
        const extent = extents[metric.key]
        if (!extent) continue
        score += normalizeMetric(hit.mapValue, extent.min, extent.max)
        contributing += 1
      }
      const finalScore = contributing > 0 ? score / relevant.length : null
      return { ...f, properties: { ...props, _score: finalScore, _count: contributing } }
    }),
  }
}

/** Small-area metrics: read numeric `m_<key>` from GeoJSON (build_sa_geojson.py). */
function attachCombinedMetricSmallAreaFromGeoJson(fc: FeatureCollection, metrics: ActiveMetric[]): FeatureCollection {
  const relevant = metrics.filter((m) => m.geography === 'small_area')
  const extentMap: Record<string, { min: number; max: number }> = {}
  for (const m of relevant) {
    const prop = metricGeoJsonPropertyName(m.key)
    const vals: number[] = []
    for (const feat of fc.features) {
      const p = (feat.properties as Record<string, unknown> | null) ?? {}
      const n = readNumericProp(p, prop)
      if (n !== null) vals.push(n)
    }
    if (vals.length) extentMap[m.key] = { min: Math.min(...vals), max: Math.max(...vals) }
  }

  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const props = { ...((f.properties as Record<string, unknown> | null) ?? {}) }
      let score = 0
      let contributing = 0
      for (const metric of relevant) {
        const ext = extentMap[metric.key]
        if (!ext) continue
        const prop = metricGeoJsonPropertyName(metric.key)
        const num = readNumericProp(props, prop)
        if (num === null) continue
        score += normalizeMetric(num, ext.min, ext.max)
        contributing += 1
      }
      const finalScore = contributing > 0 ? score / relevant.length : null
      return { ...f, properties: { ...props, _score: finalScore, _count: contributing } }
    }),
  }
}

function redScoreExpression(): maplibregl.ExpressionSpecification {
  return [
    'case',
    ['!', ['has', '_score']], 'rgba(0,0,0,0)',
    ['==', ['get', '_score'], null], 'rgba(0,0,0,0)',
    ['interpolate', ['linear'], ['to-number', ['get', '_score']],
      0, '#fff1f2',
      0.25, '#fecdd3',
      0.5, '#fb7185',
      0.75, '#ef4444',
      1, '#7f1d1d',
    ],
  ]
}

/** CSO overlay sources are only added in `map.on('load')`; `isStyleLoaded()` can be true before that. */
function geoOverlaySourcesReady(map: MapLibreMap): boolean {
  return !!map.getSource('cso-small-areas')
}

export function MapView(props: MapViewProps) {
  const propsRef = useRef(props)
  useEffect(() => {
    propsRef.current = props
  }, [props])

  const onSmallAreaSelectRef = useRef(props.onSmallAreaSelect)
  useEffect(() => {
    onSmallAreaSelectRef.current = props.onSmallAreaSelect
  }, [props.onSmallAreaSelect])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRootRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const suppressAutoClearUntilRef = useRef(0)

  const [tooltip, setTooltip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null)

  const style = useMemo(() => getBasemapStyle() as StyleSpecification, [])
  const activeMetrics = props.activeMetrics ?? []
  const householdsGeo = useMemo(() => toHouseholdGeoJson(props.households ?? []), [props.households])
  const countiesData = useMemo(() => props.boundaries.counties ?? emptyFeatureCollection(), [props.boundaries.counties])
  const countyLabels = useMemo(() => countyLabelPoints(countiesData), [countiesData])
  const townsData = useMemo(
    () => attachCombinedMetricTown(props.boundaries.bua ?? emptyFeatureCollection(), activeMetrics),
    [props.boundaries.bua, activeMetrics],
  )
  const saRaw = props.smallAreasGeoJson ?? emptyFeatureCollection()
  const saData = useMemo(
    () => attachCombinedMetricSmallAreaFromGeoJson(saRaw, activeMetrics),
    [saRaw, activeMetrics],
  )

  const countiesDataRef = useRef(countiesData)
  const countyLabelsRef = useRef(countyLabels)
  const townsDataRef = useRef(townsData)
  const saDataRef = useRef(saData)
  const householdsGeoRef = useRef(householdsGeo)
  useEffect(() => {
    countiesDataRef.current = countiesData
  }, [countiesData])
  useEffect(() => {
    countyLabelsRef.current = countyLabels
  }, [countyLabels])
  useEffect(() => {
    townsDataRef.current = townsData
  }, [townsData])
  useEffect(() => {
    saDataRef.current = saData
  }, [saData])
  useEffect(() => {
    householdsGeoRef.current = householdsGeo
  }, [householdsGeo])

  useLayoutEffect(() => {
    const root = mapRootRef.current
    if (!root) return
    const margin = 12
    const updateDockPosition = () => {
      const edge = `${Math.max(margin, 0)}px`
      root.style.setProperty('--zoom-dock-top', edge)
      root.style.setProperty('--zoom-dock-right', edge)
    }
    updateDockPosition()
    const ro = new ResizeObserver(updateDockPosition)
    ro.observe(root)
    window.addEventListener('scroll', updateDockPosition, true)
    window.addEventListener('resize', updateDockPosition)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', updateDockPosition, true)
      window.removeEventListener('resize', updateDockPosition)
    }
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container || mapRef.current) return

    const map = new maplibregl.Map({
      container,
      style,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      attributionControl: { compact: true, customAttribution: `${BASEMAP_ATTRIBUTION} ${CSO_BOUNDARY_ATTRIBUTION}` },
      scrollZoom: true,
      dragRotate: false,
      touchZoomRotate: true,
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right')

    let mapTornDown = false

    /** Stable identity so `map.off('click', …)` always matches `map.on`. */
    const onSmallAreaMapClick = (e: maplibregl.MapMouseEvent) => {
      const cb = onSmallAreaSelectRef.current
      if (!cb) return
      const layers: string[] = []
      if (map.getLayer('cso-sa-fill')) layers.push('cso-sa-fill')
      if (map.getLayer('cso-sa-line')) layers.push('cso-sa-line')
      if (!layers.length) return

      const hits = map.queryRenderedFeatures(e.point, { layers })
      const hit = hits.find((h: { layer?: { id?: string } }) => {
        const id = h.layer?.id
        return id === 'cso-sa-fill' || id === 'cso-sa-line'
      })
      if (hit?.properties != null && typeof hit.properties === 'object') {
        cb(plainProps(hit.properties))
      } else {
        cb(null)
      }
    }

    map.on('load', () => {
      if (mapTornDown) return
      map.addSource('cso-counties', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-bua', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-small-areas', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-counties-selection', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-bua-selection', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('cso-counties-label-points', { type: 'geojson', data: emptyFeatureCollection() })
      map.addSource('households', { type: 'geojson', data: toHouseholdGeoJson([]) })

      map.addLayer({ id: 'cso-counties-fill', type: 'fill', source: 'cso-counties', paint: { 'fill-color': 'rgba(0,0,0,0)', 'fill-opacity': 0 } })
      map.addLayer({ id: 'cso-bua-fill', type: 'fill', source: 'cso-bua', paint: { 'fill-color': redScoreExpression(), 'fill-opacity': ['case', ['>', ['to-number', ['get', '_count']], 0], 0.18, 0] } })
      map.addLayer({ id: 'cso-sa-fill', type: 'fill', source: 'cso-small-areas', paint: { 'fill-color': redScoreExpression(), 'fill-opacity': ['case', ['>', ['to-number', ['get', '_count']], 0], 0.65, 0] } })
      map.addLayer({ id: 'cso-counties-line', type: 'line', source: 'cso-counties', paint: { 'line-color': COUNTY_LINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.4, 8, 2.0, 12, 1.6], 'line-opacity': 0.98 } })
      map.addLayer({ id: 'cso-bua-line', type: 'line', source: 'cso-bua', paint: { 'line-color': TOWN_LINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.1, 8, 1.0, 12, 0.8], 'line-opacity': 0.95 } })
      map.addLayer({ id: 'cso-sa-line', type: 'line', source: 'cso-small-areas', paint: { 'line-color': SA_LINE, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 6.8, 0.7, 9, 0.8, 12, 0.65], 'line-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 8, 0.65, 12, 0.5] } })
      map.addLayer({ id: 'cso-counties-label', type: 'symbol', source: 'cso-counties-label-points', minzoom: 4.2, layout: { 'text-field': ['get', 'COUNTY'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 7, 12, 10, 13], 'text-anchor': 'center', 'text-allow-overlap': false }, paint: { 'text-color': '#111827', 'text-halo-color': '#ffffff', 'text-halo-width': 2 } })
      map.addLayer({ id: 'households-circle', type: 'circle', source: 'households', paint: { 'circle-color': '#ef4444', 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 10, 3.5, 14, 5.5], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1 }, layout: { visibility: 'visible' } })

      ;(map.getSource('cso-counties') as maplibregl.GeoJSONSource).setData(countiesDataRef.current)
      ;(map.getSource('cso-counties-label-points') as maplibregl.GeoJSONSource).setData(countyLabelsRef.current)
      ;(map.getSource('cso-bua') as maplibregl.GeoJSONSource).setData(townsDataRef.current)
      ;(map.getSource('cso-small-areas') as maplibregl.GeoJSONSource).setData(saDataRef.current)
      ;(map.getSource('households') as maplibregl.GeoJSONSource).setData(householdsGeoRef.current)

      if (!mapTornDown) map.on('click', onSmallAreaMapClick)

      // First paint: container size may still settle; GeoJSON tiles need an explicit frame after `setData`.
      queueMicrotask(() => {
        if (mapTornDown) return
        map.resize()
        map.triggerRepaint()
      })
    })

    map.on('moveend', () => {
      const now = Date.now()
      if (now < suppressAutoClearUntilRef.current) return
      const current = mapRef.current
      if (!current) return
      const bounds = current.getBounds()
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

    return () => {
      mapTornDown = true
      map.off('click', onSmallAreaMapClick)
      map.remove()
      mapRef.current = null
    }
  }, [style])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const src = map.getSource(BASEMAP_SOURCE_ID) as maplibregl.RasterTileSource | undefined
    if (src?.setTiles) src.setTiles(basemapTileUrls(props.basemapMode))
  }, [props.basemapMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded() || !geoOverlaySourcesReady(map)) return
    ;(map.getSource('cso-counties') as maplibregl.GeoJSONSource).setData(countiesData)
    ;(map.getSource('cso-counties-label-points') as maplibregl.GeoJSONSource).setData(countyLabels)
    ;(map.getSource('cso-bua') as maplibregl.GeoJSONSource).setData(townsData)
    ;(map.getSource('cso-small-areas') as maplibregl.GeoJSONSource).setData(saData)
    ;(map.getSource('households') as maplibregl.GeoJSONSource).setData(householdsGeo)
    const stillThisMap = map
    queueMicrotask(() => {
      if (mapRef.current !== stillThisMap) return
      stillThisMap.triggerRepaint()
    })
  }, [countiesData, countyLabels, townsData, saData, householdsGeo])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const vis = (on?: boolean) => (on === false ? 'none' : 'visible')
    if (map.getLayer('cso-counties-line')) map.setLayoutProperty('cso-counties-line', 'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-counties-label')) map.setLayoutProperty('cso-counties-label', 'visibility', vis(props.boundaryCountyLinesVisible))
    if (map.getLayer('cso-bua-line')) map.setLayoutProperty('cso-bua-line', 'visibility', vis(props.boundaryTownLinesVisible))
    if (map.getLayer('cso-sa-line')) map.setLayoutProperty('cso-sa-line', 'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('cso-sa-fill')) map.setLayoutProperty('cso-sa-fill', 'visibility', vis(props.boundarySmallAreaLinesVisible))
    if (map.getLayer('households-circle')) map.setLayoutProperty('households-circle', 'visibility', vis(props.householdsLayerVisible))
  }, [props.boundaryCountyLinesVisible, props.boundaryTownLinesVisible, props.boundarySmallAreaLinesVisible, props.householdsLayerVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const code = (props.focusBuaCode ?? '').trim()
    const county = (props.focusCountyLa ?? '').trim()
    const countyFeature = county ? props.boundaries.counties.features.find((f) => normGeoProp((f.properties as Record<string, unknown> | null)?.LOCAL_AUTHORITY) === county) : null
    const buaFeature = code ? props.boundaries.bua.features.find((f) => normGeoProp((f.properties as Record<string, unknown> | null)?.BUA_CODE) === code || normGeoProp((f.properties as Record<string, unknown> | null)?.GEOGID) === code) : null
    ;(map.getSource('cso-counties-selection') as maplibregl.GeoJSONSource | undefined)?.setData(selectionFeatureCollection(countyFeature ?? buaFeature ?? null))
  }, [props.focusBuaCode, props.focusCountyLa, props.boundaries])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onMove = (e: maplibregl.MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      const feature = e.features?.[0]
      if (!feature) {
        setTooltip(null)
        return
      }
      const p = (feature.properties ?? {}) as Record<string, unknown>
      if (feature.layer.id === 'cso-sa-fill' || feature.layer.id === 'cso-sa-line') {
        const lines = activeMetrics
          .filter((m) => m.geography === 'small_area')
          .map((m) => {
            const prop = metricGeoJsonPropertyName(m.key)
            const n = readNumericProp(p, prop)
            return n !== null ? `${m.label}: ${formatNumber(n)}${m.unit ? ` ${m.unit}` : ''}` : null
          })
          .filter(Boolean) as string[]
        const code = String(p.GEOGID ?? '').trim()
        setTooltip({
          x: e.point.x + 14,
          y: e.point.y + 14,
          title: [String(p.GEOGDESC ?? '').trim(), code].filter(Boolean).join(' — ') || code || 'Small area',
          lines: code ? [`Code: ${code}`, ...lines] : lines,
        })
      } else if (feature.layer.id === 'households-circle') {
        setTooltip({ x: e.point.x + 14, y: e.point.y + 14, title: String(p.address || 'Household'), lines: [String(p.town || ''), String(p.county || '')].filter(Boolean) })
      }
    }
    const clear = () => setTooltip(null)
    map.on('mousemove', 'cso-sa-fill', onMove)
    map.on('mouseleave', 'cso-sa-fill', clear)
    map.on('mousemove', 'cso-sa-line', onMove)
    map.on('mouseleave', 'cso-sa-line', clear)
    map.on('mousemove', 'households-circle', onMove)
    map.on('mouseleave', 'households-circle', clear)
    return () => {
      map.off('mousemove', 'cso-sa-fill', onMove)
      map.off('mouseleave', 'cso-sa-fill', clear)
      map.off('mousemove', 'cso-sa-line', onMove)
      map.off('mouseleave', 'cso-sa-line', clear)
      map.off('mousemove', 'households-circle', onMove)
      map.off('mouseleave', 'households-circle', clear)
    }
  }, [activeMetrics])

  return (
    <div ref={mapRootRef} className="mapRoot">
      <div ref={containerRef} className="mapContainer" />
      {props.smallAreasGeoJsonLoading ? (
        <div style={{ position: 'absolute', bottom: 8, left: 8, background: 'rgba(255,255,255,0.85)', padding: '4px 10px', borderRadius: 4, fontSize: 12, color: '#374151' }}>
          Loading small areas…
        </div>
      ) : null}
      {tooltip ? (
        <div className="mapHoverTooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <div className="mapHoverTooltipTitle">{tooltip.title}</div>
          {tooltip.lines.map((line, i) => (
            <div key={i} className="mapHoverTooltipLine">
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
