import type { Feature, FeatureCollection, Point } from 'geojson'
import { geometryBBox } from '../geoBounds'
import { normGeoProp } from './boundaryLookup'

/**
 * One label point per BUA that has upload rows inside it (spatial sum &gt; 0).
 * Empty collection when there is no upload — avoids thousands of town names at Ireland zoom.
 */
export function buaPolygonsToLabelPoints(
  buaFc: FeatureCollection,
  totalsByBuaCode: Record<string, number> | undefined | null,
): FeatureCollection {
  const features: Feature<Point>[] = []
  if (!totalsByBuaCode || Object.keys(totalsByBuaCode).length === 0) {
    return { type: 'FeatureCollection', features: [] }
  }
  const seen = new Set<string>()
  for (const f of buaFc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const box = geometryBBox(g)
    if (!box) continue
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const code = normGeoProp(p.BUA_CODE)
    if (code && seen.has(code)) continue

    const n = code ? (totalsByBuaCode[code] ?? 0) : 0
    if (n <= 0) continue

    const [w, s, e, nCoord] = box
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [(w + e) / 2, (s + nCoord) / 2] },
      properties: { ...p, _hh_total: n },
    })
    if (code) seen.add(code)
  }
  return { type: 'FeatureCollection', features }
}
