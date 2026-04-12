import type { Feature } from 'geojson'

/**
 * Normalise CSO Small Area / GEOGID cells from Excel or CSV for GeoHive queries.
 *
 * - Excel often supplies 9-digit codes as numbers (sometimes near-floats).
 * - Some files use "NNNNNNNNN/SS" where the Census 2022 SA layer GEOGID is usually the base digits only.
 * - Scientific notation strings (e.g. "2.68E+08") are converted to integer strings when unambiguous.
 */
export function expandCsoSmallAreaQueryIds(raw: unknown): string[] {
  if (raw == null || raw === '') return []

  let s: string
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const r = Math.round(raw)
    if (!Number.isSafeInteger(r) || Math.abs(raw - r) > 1e-5) return []
    s = String(r)
  } else {
    s = String(raw).trim()
  }

  const compact = s.replace(/\u00a0/g, '').replace(/\s/g, '')
  if (!compact) return []

  if (/^-?[\d.]+[eE][+-]?\d+$/.test(compact)) {
    const n = Number(compact)
    if (!Number.isFinite(n)) return []
    const r = Math.round(n)
    if (!Number.isSafeInteger(r)) return []
    s = String(r)
  } else {
    s = compact
  }

  // Optional spreadsheet prefix e.g. SA2022_268098009
  const prefixed = s.match(/^SA\d{4}_(\d{7,11}(?:\/\d{1,4})?)$/i)
  if (prefixed) {
    s = prefixed[1]!
  }

  const m = s.match(/^(\d{7,11})(\/(\d{1,4}))?$/)
  if (m) {
    const base = m[1]!
    const sub = m[3]
    if (sub) {
      const composite = `${base}/${sub}`
      return [...new Set([composite, base])]
    }
    return [base]
  }

  const digitsOnly = s.replace(/[^\d/]/g, '')
  const m2 = digitsOnly.match(/^(\d{7,11})(\/(\d{1,4}))?$/)
  if (m2) {
    const base = m2[1]!
    const sub = m2[3]
    if (sub) return [...new Set([`${base}/${sub}`, base])]
    return [base]
  }

  return [s]
}

export function findSmallAreaFeatureInMap(saMap: Map<string, Feature>, rawCell: unknown): Feature | undefined {
  for (const id of expandCsoSmallAreaQueryIds(rawCell)) {
    const f = saMap.get(id)
    if (f?.geometry) return f
  }
  return undefined
}

export function formatSmallAreaLookupHint(rawCell: unknown): string {
  const ids = expandCsoSmallAreaQueryIds(rawCell)
  return ids.length ? ids.join(' / ') : String(rawCell).trim() || '(empty)'
}

/** True if the cell looks like a CSO small-area id — not a council name (avoids LA column duplicating SA codes). */
export function cellLooksLikeCsoSaCode(s: string): boolean {
  const t = String(s).trim().replace(/\u00a0/g, '')
  if (!t) return false
  return /^(\d{7,11})(\/\d{1,4})?$/.test(t)
}
