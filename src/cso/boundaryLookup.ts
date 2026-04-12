import type { Feature, FeatureCollection } from 'geojson'
import { geometryBBox } from '../geoBounds'

/** Normalise ArcGIS / GeoJSON property values for id comparison. */
export function normGeoProp(v: unknown): string {
  if (v == null || v === '') return ''
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return String(v).trim()
}

export function findBuaFeatureByCode(
  fc: FeatureCollection | null | undefined,
  code: string,
): Feature | undefined {
  if (!fc?.features?.length || !code.trim()) return undefined
  const want = code.trim()
  return fc.features.find((f) => {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const bc = normGeoProp(p.BUA_CODE)
    const gid = normGeoProp(p.GEOGID)
    return bc === want || gid === want
  })
}

export function findCountyFeatureByLa(
  fc: FeatureCollection | null | undefined,
  la: string,
): Feature | undefined {
  if (!fc?.features?.length || !la.trim()) return undefined
  const want = la.trim()
  return fc.features.find((f) => {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    return normGeoProp(p.LOCAL_AUTHORITY) === want
  })
}

export function bboxForBuaCode(
  fc: FeatureCollection | null | undefined,
  code: string,
): [number, number, number, number] | null {
  const f = findBuaFeatureByCode(fc, code)
  if (!f?.geometry) return null
  return geometryBBox(f.geometry)
}

export function bboxForCountyLa(
  fc: FeatureCollection | null | undefined,
  la: string,
): [number, number, number, number] | null {
  const f = findCountyFeatureByLa(fc, la)
  if (!f?.geometry) return null
  return geometryBBox(f.geometry)
}

/** Strip "County", "Co." prefixes and council suffixes so file labels like "Meath" match CSO polygons. */
function normalizeCountySearchHint(hint: string): string {
  let s = normGeoProp(hint).toLowerCase()
  s = s.replace(/^county\s+/i, '').replace(/\s+county$/i, '')
  s = s.replace(/^co\.?\s+/i, '')
  return s.trim()
}

/** CSO LOCAL_AUTHORITY string with council suffix removed — comparable to a bare county name from spreadsheets. */
function squashCouncilSuffix(la: string): string {
  return la
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+city and county council$/i, '')
    .replace(/\s+county council$/i, '')
    .replace(/\s+city council$/i, '')
    .replace(/\s+council$/i, '')
}

/** Match county polygon by COUNTY label (e.g. "Meath") or LOCAL_AUTHORITY (e.g. "Meath County Council"). */
export function findCountyFeatureByCountyHint(
  fc: FeatureCollection | null | undefined,
  hint: string,
): Feature | undefined {
  if (!fc?.features?.length || !hint.trim()) return undefined
  const w = normGeoProp(hint).toLowerCase()
  const wNorm = normalizeCountySearchHint(hint)

  const exactLa = fc.features.find(
    (f) => normGeoProp((f.properties as Record<string, unknown> | null)?.LOCAL_AUTHORITY).toLowerCase() === w,
  )
  if (exactLa) return exactLa

  for (const f of fc.features) {
    const la = normGeoProp((f.properties as Record<string, unknown> | null)?.LOCAL_AUTHORITY)
    const squashed = squashCouncilSuffix(la)
    if (squashed === wNorm || squashed === w) return f
  }

  return fc.features.find((f) => {
    const p = (f.properties as Record<string, unknown> | null) ?? {}
    const c = normGeoProp(p.COUNTY).toLowerCase()
    const la = normGeoProp(p.LOCAL_AUTHORITY).toLowerCase()
    return (
      c === w ||
      c === wNorm ||
      la.includes(w) ||
      la.includes(wNorm) ||
      c.includes(wNorm) ||
      la.includes(w)
    )
  })
}

export function bboxForCountyHint(
  fc: FeatureCollection | null | undefined,
  hint: string,
): [number, number, number, number] | null {
  const f = findCountyFeatureByCountyHint(fc, hint) ?? findCountyFeatureByLa(fc, hint)
  if (!f?.geometry) return null
  return geometryBBox(f.geometry)
}
