import type { FeatureCollection } from 'geojson'
import { normGeoProp } from './boundaryLookup'
import { expandCsoSmallAreaQueryIds } from './smallAreaCode'

/**
 * Attach `_hh` (household count) to each small-area feature for MapLibre fill-color.
 * Matches spreadsheet GEOGIDs to ArcGIS `GEOGID`, including base vs `NNNNNNNNN/SS` variants.
 */
export function mergeSmallAreaHouseholdCounts(
  fc: FeatureCollection,
  bySa: Record<string, number> | undefined | null,
): FeatureCollection {
  const table: Record<string, number> = {}
  if (bySa) {
    for (const [k, v] of Object.entries(bySa)) {
      const nk = normGeoProp(k)
      if (!nk) continue
      table[nk] = (table[nk] ?? 0) + v
    }
    /** Mirror aggregates to alternate spellings (e.g. base + slash) without double-counting polygons. */
    for (const k of Object.keys(table)) {
      const v = table[k]!
      for (const id of expandCsoSmallAreaQueryIds(k)) {
        if (table[id] === undefined) table[id] = v
      }
    }
  }

  function hhForPolygonGeogid(gidRaw: string): number {
    const gid = normGeoProp(gidRaw)
    if (!gid) return 0
    let best = 0
    if (table[gid] != null) best = Math.max(best, table[gid]!)
    const tail = gid.match(/(\d{7,11})$/)?.[1] ?? ''
    if (tail && table[tail] != null) best = Math.max(best, table[tail]!)
    for (const id of expandCsoSmallAreaQueryIds(gid)) {
      if (table[id] != null) best = Math.max(best, table[id]!)
    }
    return best
  }

  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const p = { ...((f.properties as Record<string, unknown> | null) ?? {}) }
      const gid = normGeoProp(p.GEOGID)
      const n = hhForPolygonGeogid(gid)
      return { ...f, properties: { ...p, _hh: n } }
    }),
  }
}
