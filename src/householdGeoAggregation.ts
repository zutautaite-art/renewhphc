import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import type { HouseholdRecord } from './types/households'
import { geometryBBox } from './geoBounds'
import { householdUploadWeight } from './householdFilters'
import { pointInPolygonCoords } from './pointInPolygon'

function pointInBbox(lon: number, lat: number, box: [number, number, number, number]): boolean {
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3]
}

type BuaIndexed = { feature: Feature; bbox: [number, number, number, number]; geom: Polygon | MultiPolygon }

function indexBuaPolygons(buaFc: FeatureCollection | null | undefined): BuaIndexed[] {
  if (!buaFc?.features?.length) return []
  const out: BuaIndexed[] = []
  for (const f of buaFc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const bbox = geometryBBox(g)
    if (!bbox) continue
    out.push({ feature: f, bbox, geom: g as Polygon | MultiPolygon })
  }
  return out
}

/**
 * Sum households per CSO BUA_CODE by point-in-polygon against built-up area boundaries
 * (small-area–placed rows use SA centroids inside the correct town polygon).
 */
export function countHouseholdsPerBuaCode(
  list: HouseholdRecord[],
  buaFc: FeatureCollection | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!list.length) return out
  const indexed = indexBuaPolygons(buaFc)
  if (!indexed.length) return out

  for (const h of list) {
    const lon = h.lon
    const lat = h.lat
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    for (const { feature, bbox, geom } of indexed) {
      if (!pointInBbox(lon, lat, bbox)) continue
      if (pointInPolygonCoords(lon, lat, geom)) {
        const p = feature.properties as Record<string, unknown> | null
        const code = String(p?.BUA_CODE ?? '').trim()
        if (code) out[code] = (out[code] ?? 0) + householdUploadWeight(h)
        break
      }
    }
  }
  return out
}
