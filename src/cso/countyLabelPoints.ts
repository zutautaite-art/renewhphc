import type { Feature, FeatureCollection, Point } from 'geojson'
import { geometryBBox } from '../geoBounds'
import { normGeoProp } from './boundaryLookup'

/**
 * One Point per county — bbox centre of the full Polygon/MultiPolygon (not per island ring).
 * Avoids MapLibre placing a label on every part of a MultiPolygon (e.g. Mayo/Galway islands).
 * Dedupes by LOCAL_AUTHORITY (or COUNTY) if the source ever repeats a county.
 */
export function countyBoundariesToSingleLabelPoints(fc: FeatureCollection): FeatureCollection {
  const features: Feature<Point>[] = []
  const seen = new Set<string>()
  for (const f of fc.features) {
    const g = f.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const key = normGeoProp(p.LOCAL_AUTHORITY) || normGeoProp(p.COUNTY)
    if (key && seen.has(key)) continue

    const box = geometryBBox(g)
    if (!box) continue
    const [w, s, e, n] = box
    const lng = (w + e) / 2
    const lat = (s + n) / 2
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: { ...p },
    })
    if (key) seen.add(key)
  }
  return { type: 'FeatureCollection', features }
}

/** Attach `_hh_total` per label point from upload counts keyed by LOCAL_AUTHORITY (exact / case-insensitive / loose). */
export function attachHouseholdTotalsToCountyLabelPoints(
  labelFc: FeatureCollection,
  totalsByLa: Record<string, number> | undefined | null,
): FeatureCollection {
  const t = totalsByLa && Object.keys(totalsByLa).length > 0 ? totalsByLa : null
  const upper: Record<string, number> = {}
  if (t) {
    for (const [k, v] of Object.entries(t)) {
      upper[k.trim().toUpperCase()] = v
    }
  }

  function lookup(laRaw: string): number {
    if (!t) return 0
    const la = laRaw.trim()
    if (!la) return 0
    if (t[la] != null) return t[la]!
    const u = la.toUpperCase()
    if (upper[u] != null) return upper[u]!
    const laL = la.toLowerCase()
    for (const [k, v] of Object.entries(t)) {
      const kl = k.toLowerCase()
      if (kl === laL || laL.includes(kl) || kl.includes(laL)) return v
    }
    return 0
  }

  return {
    type: 'FeatureCollection',
    features: labelFc.features.map((f) => {
      const p = (f.properties as Record<string, unknown> | null) ?? {}
      const la = String(p.LOCAL_AUTHORITY ?? '').trim() || String(p.COUNTY ?? '').trim()
      const n = lookup(la)
      return { ...f, properties: { ...p, _hh_total: n } }
    }),
  }
}
