import type { Feature, FeatureCollection } from 'geojson'
import type { LngLatBounds } from 'maplibre-gl'
import { normGeoProp } from './boundaryLookup'

/** GeoHive / CSO ArcGIS REST endpoints (Census 2022). */
export const CSO_ARCGIS = {
  /** 31 administrative counties / local authorities (polygon boundaries). */
  localAuthoritiesQuery:
    'https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/CensusHub2022_T1_1_LA/FeatureServer/0/query',
  /** Built-up areas (~867) — Census “town / urban area” geography. */
  builtUpAreasQuery:
    'https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/CensusHub2022_T1_1_BUA/FeatureServer/0/query',
  /** Small areas — use spatial query + GeoJSON (WGS84). */
  smallAreasQuery:
    'https://services-eu1.arcgis.com/BuS9rtTsYEV5C0xh/arcgis/rest/services/CensusHub2022_T1_1_SA/FeatureServer/0/query',
} as const

export const CSO_BOUNDARY_ATTRIBUTION =
  'Statistical boundaries: <a href="https://www.cso.ie/">CSO</a> / Tailte Éireann, Census 2022 (GeoHive ArcGIS REST).'

function emptyFc(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

export async function fetchArcgisGeoJson(
  queryUrl: string,
  params: Record<string, string>,
): Promise<FeatureCollection> {
  const u = new URL(queryUrl)
  const merged: Record<string, string> = {
    f: 'geojson',
    outSR: '4326',
    returnGeometry: 'true',
    ...params,
  }
  Object.entries(merged).forEach(([k, v]) => u.searchParams.set(k, v))

  const res = await fetch(u.toString())
  const data = (await res.json()) as FeatureCollection & {
    error?: { message?: string; details?: string[] }
  }

  if (!res.ok || (data as { error?: unknown }).error) {
    const msg =
      (data as { error?: { message?: string; details?: string[] } }).error?.message ||
      (data as { error?: { details?: string[] } }).error?.details?.join('; ') ||
      `HTTP ${res.status}`
    throw new Error(msg)
  }

  if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Unexpected ArcGIS GeoJSON response')
  }

  return data
}

export function boundsToArcgisEnvelope(bounds: LngLatBounds): string {
  const w = bounds.getWest()
  const s = bounds.getSouth()
  const e = bounds.getEast()
  const n = bounds.getNorth()
  return `${w},${s},${e},${n}`
}

/** Paginate until no more features or safety cap (avoids huge responses). */
export async function fetchSmallAreasIntersectingBounds(
  bounds: LngLatBounds,
  options?: { pageSize?: number; maxFeatures?: number },
): Promise<FeatureCollection> {
  const maxFeatures = options?.maxFeatures ?? 40000
  /** Larger pages = fewer sequential round-trips to GeoHive (major latency win for Ireland-wide bbox). */
  const pageSize =
    options?.pageSize ?? (maxFeatures >= 12000 ? 5000 : 2000)
  const geom = boundsToArcgisEnvelope(bounds)

  const all: FeatureCollection['features'] = []
  let offset = 0

  for (;;) {
    const fc = await fetchArcgisGeoJson(CSO_ARCGIS.smallAreasQuery, {
      where: '1=1',
      geometry: geom,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'GEOGID,GEOGDESC,COUNTY,LOCAL_AUTHORITY',
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
    })

    const batch = fc.features ?? []
    all.push(...batch)

    /** GeoJSON pagination metadata is inconsistent; continue while batches are full. */
    const done = batch.length === 0 || batch.length < pageSize
    offset += batch.length

    if (done || all.length >= maxFeatures) break
  }

  return { type: 'FeatureCollection', features: all }
}

export function emptyFeatureCollection(): FeatureCollection {
  return emptyFc()
}

/** ArcGIS WHERE GEOGID IN (...) — keep chunks modest for URL length; concurrency batches requests. */
const SA_CHUNK = 120
const SA_GEOGID_FETCH_CONCURRENCY = 8

async function fetchSmallAreaChunkGeogids(chunk: string[]): Promise<Map<string, Feature>> {
  const out = new Map<string, Feature>()
  const quoted = chunk.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',')
  const fc = await fetchArcgisGeoJson(CSO_ARCGIS.smallAreasQuery, {
    where: `GEOGID IN (${quoted})`,
    outFields: 'GEOGID,GEOGDESC,COUNTY,LOCAL_AUTHORITY',
    resultRecordCount: String(Math.max(chunk.length, 1)),
  })
  for (const f of fc.features ?? []) {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const gid = normGeoProp(p.GEOGID)
    if (!gid) continue
    out.set(gid, f)
    const tail = gid.match(/(\d{7,11})$/)
    if (tail?.[1] && tail[1] !== gid) out.set(tail[1], f)
  }
  return out
}

/**
 * Load CSO Small Area polygons by GEOGID (Census 2022 SA layer on GeoHive).
 * Used when spreadsheets list "CSO Small Area Code" instead of lat/lon.
 * Chunks run in parallel (limited concurrency) — sequential was a major bottleneck for ~18k IDs.
 */
export async function fetchSmallAreaFeaturesByGeogids(geogids: string[]): Promise<Map<string, Feature>> {
  const unique = [...new Set(geogids.map((g) => String(g).trim()).filter(Boolean))]
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += SA_CHUNK) {
    chunks.push(unique.slice(i, i + SA_CHUNK))
  }

  const out = new Map<string, Feature>()
  for (let i = 0; i < chunks.length; i += SA_GEOGID_FETCH_CONCURRENCY) {
    const batch = chunks.slice(i, i + SA_GEOGID_FETCH_CONCURRENCY)
    const maps = await Promise.all(batch.map((c) => fetchSmallAreaChunkGeogids(c)))
    for (const m of maps) {
      for (const [k, v] of m) {
        out.set(k, v)
      }
    }
  }
  return out
}
