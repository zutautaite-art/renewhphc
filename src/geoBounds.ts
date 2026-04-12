import type { Geometry } from 'geojson'

/** Web Mercator / WGS84 ring: [lng, lat][] */
function extendRing(
  w: number,
  s: number,
  e: number,
  n: number,
  ring: number[][],
): [number, number, number, number] {
  let W = w
  let S = s
  let E = e
  let N = n
  for (const pt of ring) {
    const lng = pt[0]
    const lat = pt[1]
    if (typeof lng !== 'number' || typeof lat !== 'number') continue
    W = Math.min(W, lng)
    S = Math.min(S, lat)
    E = Math.max(E, lng)
    N = Math.max(N, lat)
  }
  return [W, S, E, N]
}

/** [west, south, east, north] in degrees, or null if not a polygonal geometry. */
export function geometryBBox(geom: Geometry): [number, number, number, number] | null {
  let W = Infinity
  let S = Infinity
  let E = -Infinity
  let N = -Infinity
  let any = false

  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) {
      any = true
      ;[W, S, E, N] = extendRing(W, S, E, N, ring)
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      for (const ring of poly) {
        any = true
        ;[W, S, E, N] = extendRing(W, S, E, N, ring)
      }
    }
  } else {
    return null
  }

  if (!any || !Number.isFinite(W)) return null
  return [W, S, E, N]
}

/** True if axis-aligned geographic bbox intersects the map view bounds. */
export function bboxIntersectsMapBounds(
  box: [number, number, number, number],
  view: { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number },
): boolean {
  const [w, s, e, n] = box
  return !(
    e < view.getWest() ||
    w > view.getEast() ||
    n < view.getSouth() ||
    s > view.getNorth()
  )
}
