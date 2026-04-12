import type { HouseholdRecord } from './types/households'
import type { LocalAuthorityRow } from './cso/geohivePlaces'

/** Strip common council suffixes for looser CSV ↔ GeoHive matching. */
function squashCouncil(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+city and county council$/i, '')
    .replace(/\s+county council$/i, '')
    .replace(/\s+city council$/i, '')
    .replace(/\s+council$/i, '')
}

function norm(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

export function householdMatchesCounty(
  hh: HouseholdRecord,
  selectedLa: string,
  laRows: LocalAuthorityRow[],
): boolean {
  if (!selectedLa) return true
  const raw = hh.county
  if (!raw) return false

  const nRaw = norm(raw)
  const nSel = norm(selectedLa)
  if (nRaw === nSel) return true
  if (squashCouncil(raw) === squashCouncil(selectedLa)) return true

  const row = laRows.find((r) => r.localAuthority === selectedLa)
  if (row) {
    if (nRaw === norm(row.county)) return true
    if (squashCouncil(raw) === squashCouncil(row.county)) return true
  }

  return nRaw.includes(nSel) || nSel.includes(nRaw)
}

export function householdMatchesTown(hh: HouseholdRecord, selectedTown: string): boolean {
  if (!selectedTown) return true
  const t = hh.town
  if (!t) return false
  return norm(t) === norm(selectedTown)
}

export function filterHouseholdsByLocation(
  list: HouseholdRecord[],
  selectedTown: string,
  selectedCountyLa: string,
  laRows: LocalAuthorityRow[],
): HouseholdRecord[] {
  return list.filter(
    (h) =>
      householdMatchesTown(h, selectedTown) && householdMatchesCounty(h, selectedCountyLa, laRows),
  )
}

/** Per-row weight for choropleth and totals: spreadsheet measure when present, otherwise 1. */
export function householdUploadWeight(h: HouseholdRecord): number {
  const m = h.uploadMetric
  if (typeof m === 'number' && Number.isFinite(m)) return m
  return 1
}

/** True if any row carries a numeric upload column — aggregations use summed weights instead of row counts. */
export function listUsesUploadMetricWeights(list: HouseholdRecord[]): boolean {
  return list.some((h) => typeof h.uploadMetric === 'number' && Number.isFinite(h.uploadMetric))
}

/** Sum upload weights per CSO local authority (for map hover). */
export function countHouseholdsByLocalAuthority(
  list: HouseholdRecord[],
  laRows: LocalAuthorityRow[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of list) {
    const w = householdUploadWeight(h)
    for (const r of laRows) {
      if (householdMatchesCounty(h, r.localAuthority, laRows)) {
        out[r.localAuthority] = (out[r.localAuthority] ?? 0) + w
        break
      }
    }
  }
  return out
}

/** Sum weights per normalised town name (for BUA hover). */
export function countHouseholdsByTownNorm(list: HouseholdRecord[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of list) {
    const t = h.town?.trim().toLowerCase()
    if (!t) continue
    out[t] = (out[t] ?? 0) + householdUploadWeight(h)
  }
  return out
}

/** Sum weights per CSO Small Area GEOGID (rows placed from small-area codes only). */
export function countHouseholdsByCsoSaGeogid(list: HouseholdRecord[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of list) {
    const g = h.csoSaGeogid?.trim()
    if (!g) continue
    out[g] = (out[g] ?? 0) + householdUploadWeight(h)
  }
  return out
}

/** Sum weights by CSO local authority / county label on each row (same as map county field). */
export function countHouseholdsByCountyField(list: HouseholdRecord[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of list) {
    const k = (h.county ?? '').trim() || 'Unknown county'
    out[k] = (out[k] ?? 0) + householdUploadWeight(h)
  }
  return out
}
