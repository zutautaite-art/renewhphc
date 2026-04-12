import type { FeatureCollection } from 'geojson'
import { findCountyFeatureByCountyHint } from './cso/boundaryLookup'
import { normKey } from './householdUploadParse'

function parseCellNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = String(v).trim().replace(/%/g, '').replace(/\s/g, '').replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function columnNumericRatio(rows: Record<string, unknown>[], headerKey: string): number {
  if (!rows.length) return 0
  let ok = 0
  for (const row of rows) {
    const map = new Map<string, unknown>()
    for (const [k, val] of Object.entries(row)) map.set(normKey(k), val)
    const v = map.get(headerKey)
    if (parseCellNumber(v) !== null) ok++
  }
  return ok / rows.length
}

function pickMeasureColumnKey(rows: Record<string, unknown>[]): string | null {
  if (!rows.length) return null
  const keySet = new Set<string>()
  for (const row of rows) {
    for (const k of Object.keys(row)) keySet.add(normKey(k))
  }
  const keys = [...keySet]
  const skip = new Set([
    'id',
    'lat',
    'lon',
    'latitude',
    'longitude',
    'lng',
    'bua_code',
    'geogid',
    'cso_small_area_code',
    'small_area_code',
  ])

  const candidates = keys.filter((k) => !skip.has(k) && k !== 'county' && k !== 'local_authority')
  const withRatio = candidates
    .map((k) => ({ k, r: columnNumericRatio(rows, k) }))
    .filter((x) => x.r >= 0.55)
    .sort((a, b) => b.r - a.r)

  if (!withRatio.length) return null

  const ageNamed = withRatio.find((x) => x.k.includes('age'))
  return (ageNamed ?? withRatio[0]).k
}

/**
 * One row per county / local authority with a numeric measure (e.g. age band %).
 * Maps spreadsheet labels to CSO LOCAL_AUTHORITY via county polygons.
 */
export function tryParseCountyMetricSheet(
  rows: Record<string, unknown>[],
  countiesFc: FeatureCollection,
): { byLa: Record<string, number>; label: string; measureKey: string; errors: string[] } | null {
  if (rows.length < 2 || !countiesFc.features.length) return null

  const measureKey = pickMeasureColumnKey(rows)
  if (!measureKey) return null

  const byLaSums = new Map<string, { sum: number; n: number }>()
  const errors: string[] = []

  for (let idx = 0; idx < rows.length; idx++) {
    const rowNumber = idx + 2
    const row = rows[idx] ?? {}
    const map = new Map<string, unknown>()
    for (const [k, v] of Object.entries(row)) map.set(normKey(k), v)

    const countyHint = String(map.get('county') ?? '').trim()
    const laHintRaw = String(map.get('local_authority') ?? map.get('la') ?? '').trim()
    const laHint = /^\d+$/.test(laHintRaw) ? '' : laHintRaw

    const hint = countyHint || laHint
    if (!hint) {
      errors.push(`Row ${rowNumber}: need a County or Local authority name to map this row.`)
      continue
    }

    const val = parseCellNumber(map.get(measureKey))
    if (val === null) {
      errors.push(`Row ${rowNumber}: "${measureKey}" is not a valid number.`)
      continue
    }

    const feat = findCountyFeatureByCountyHint(countiesFc, hint)
    if (!feat) {
      errors.push(`Row ${rowNumber}: county "${hint}" did not match a CSO local authority boundary.`)
      continue
    }

    const la = String((feat.properties as Record<string, unknown> | null)?.LOCAL_AUTHORITY ?? '').trim()
    if (!la) continue

    const cur = byLaSums.get(la) ?? { sum: 0, n: 0 }
    cur.sum += val
    cur.n += 1
    byLaSums.set(la, cur)
  }

  const byLa: Record<string, number> = {}
  for (const [la, { sum, n }] of byLaSums) {
    byLa[la] = n > 0 ? sum / n : sum
  }

  if (Object.keys(byLa).length < 2) return null

  const label = measureKey.replace(/_/g, ' ')
  return { byLa, label, measureKey, errors }
}

export function choroplethMinMax(byLa: Record<string, number>): { min: number; max: number } {
  const vals = Object.values(byLa).filter((v) => Number.isFinite(v))
  if (!vals.length) return { min: 0, max: 1 }
  return { min: Math.min(...vals), max: Math.max(...vals) }
}

/**
 * Colour scale uses 5th–95th percentile (like typical CSO-style legends) so outliers
 * don’t dominate; values are clamped to [colorMin, colorMax] for the ramp.
 */
export function choroplethPercentileScale(byLa: Record<string, number>): {
  colorMin: number
  colorMax: number
  dataMin: number
  dataMax: number
} {
  const vals = Object.values(byLa).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!vals.length) return { colorMin: 0, colorMax: 1, dataMin: 0, dataMax: 1 }
  const dataMin = vals[0]!
  const dataMax = vals[vals.length - 1]!
  if (vals.length < 4 || dataMin === dataMax) {
    return { colorMin: dataMin, colorMax: dataMax, dataMin, dataMax }
  }
  const i5 = Math.floor((vals.length - 1) * 0.05)
  const i95 = Math.ceil((vals.length - 1) * 0.95)
  let colorMin = vals[i5]!
  let colorMax = vals[i95]!
  if (colorMin === colorMax) {
    colorMin = dataMin
    colorMax = dataMax
  }
  return { colorMin, colorMax, dataMin, dataMax }
}

/** Attach `_metric` to each county feature for MapLibre `fill-color` interpolation. */
export function mergeCountyMetricIntoBoundaries(
  fc: FeatureCollection,
  choropleth: { byLa: Record<string, number> } | null,
): FeatureCollection {
  const normLa = (s: string) => s.trim().toUpperCase()
  if (!choropleth || !Object.keys(choropleth.byLa).length) {
    return fc
  }
  const byLaUpper: Record<string, number> = {}
  for (const [k, v] of Object.entries(choropleth.byLa)) {
    if (Number.isFinite(v)) byLaUpper[normLa(k)] = v
  }
  return {
    type: 'FeatureCollection',
    features: fc.features.map((f) => {
      const la = normLa(String((f.properties as Record<string, unknown> | null)?.LOCAL_AUTHORITY ?? ''))
      const v = la ? byLaUpper[la] : undefined
      return {
        ...f,
        properties: {
          ...(f.properties as object),
          _metric: v ?? null,
        },
      }
    }),
  }
}
