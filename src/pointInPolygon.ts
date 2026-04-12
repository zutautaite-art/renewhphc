import type { MultiPolygon, Polygon } from 'geojson'

/** Ray casting; ring is [lng, lat][] (closed or not). */
export function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  if (ring.length < 3) return false
  let inside = false
  const n = ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i]![0]
    const yi = ring[i]![1]
    const xj = ring[j]![0]
    const yj = ring[j]![1]
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-30) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

export function pointInPolygonCoords(lng: number, lat: number, geom: Polygon | MultiPolygon): boolean {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates
    const outer = rings[0]
    if (!outer || !pointInRing(lng, lat, outer)) return false
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lng, lat, rings[h]!)) return false
    }
    return true
  }
  for (const poly of geom.coordinates) {
    const sub: Polygon = { type: 'Polygon', coordinates: poly }
    if (pointInPolygonCoords(lng, lat, sub)) return true
  }
  return false
}
