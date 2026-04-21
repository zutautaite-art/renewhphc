
import type { WorkBook } from 'xlsx'
import * as XLSX from 'xlsx'
import { normKey, parseHouseholdRows } from './householdUploadParse'
import type { HouseholdRecord } from './types/households'

export type MetricKey = string

export type FilterConfigRow = {
  group: string
  key: string
  label: string
  kind: 'household_boolean' | 'small_area_metric' | 'town_metric'
  source?: string
  rawField?: string
  mapField?: string
  status?: string
}

/** `mapValue` = raw count (`_no` column); `pctValue` = percentage (`_pct` / map_field) for tables. */
export type MetricValue = { mapValue: number; pctValue: number | null; rawValue?: number | string }

export type ParsedMetric = {
  key: MetricKey
  label: string
  geography: 'small_area' | 'town'
  unit?: string
  values: Record<string, MetricValue>
}

export type ParsedWorkbookData = {
  households: HouseholdRecord[]
  evCommercial: HouseholdRecord[]
  metricsByKey: Record<string, ParsedMetric>
  filterConfig: FilterConfigRow[]
  importSummary: { sheetName: string; rowsImported: number; detail: string }[]
  warnings: string[]
}

function buildLookup(row: Record<string, unknown>): Map<string, unknown> {
  const m = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) m.set(normKey(k), v)
  return m
}

function getFirst(lookup: Map<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const k = normKey(key)
    if (!lookup.has(k)) continue
    const v = lookup.get(k)
    if (v === null || v === undefined) continue
    if (typeof v === 'string' && v.trim() === '') continue
    return v
  }
  return undefined
}

function parseCellNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  let s = String(v).trim()
  if (!s || s === '-') return null
  s = s.replace(/%/g, '').replace(/\u00a0/g, '').replace(/\s/g, '')
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '')
  else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function inferUnit(field: string | undefined): string | undefined {
  const f = normKey(field ?? '')
  if (!f) return undefined
  if (f.includes('pct') || f.includes('percent') || f.includes('share')) return '%'
  return undefined
}

function normalizeAreaId(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const slashIdx = s.indexOf('/')
  const base = slashIdx >= 0 ? s.slice(0, slashIdx).trim() : s
  const u = base.toUpperCase()
  if (u.startsWith('SOURCE:') || u.startsWith('NOTE:') || u === 'IRELAND TOTAL') return ''
  const digits = base.replace(/[^\d]/g, '')
  if (!digits) return ''
  return digits.length >= 7 && digits.length <= 11 ? digits.padStart(9, '0') : digits
}

/** GEOGID ↔ Excel `cso_code` matching (2022 letter+digits, legacy SA2017_…, slash suffixes). */
export function aliasIds(raw: string): string[] {
  const out = new Set<string>()
  const s = String(raw ?? '').trim()
  if (!s) return []
  out.add(s)
  // New 2022 format: A057103001 (letter + digits, no underscore)
  // Old format: SA2017_017002003
  const withUnderscore = s.match(/^[A-Za-z]+\d{4}_(\d+)$/)
  if (withUnderscore) {
    const code = withUnderscore[1]
    out.add(code.padStart(9, '0'))
    out.add(code.replace(/^0+/, ''))
  }

  const digits = s.replace(/[^\d]/g, '')
  if (digits) {
    out.add(digits)
    out.add(digits.replace(/^0+/, ''))
    if (digits.length < 9) out.add(digits.padStart(9, '0'))
    if (digits.length === 8) out.add('0' + digits)
    if (digits.length === 10) out.add(digits.slice(1)) // A1470050003 → 470050003
  }

  return [...out].filter(Boolean)
}

function parseFilterConfig(rows: Record<string, unknown>[]): FilterConfigRow[] {
  const out: FilterConfigRow[] = []
  for (const row of rows) {
    const lookup = buildLookup(row)
    const key = String(getFirst(lookup, ['key']) ?? '').trim()
    const group = String(getFirst(lookup, ['group']) ?? '').trim()
    if (!key || !group) continue
    const label = String(getFirst(lookup, ['label']) ?? key).trim()
    const kindRaw = String(getFirst(lookup, ['kind']) ?? '').trim().toLowerCase()
    const kind = (kindRaw === 'household_boolean' || kindRaw === 'town_metric' || kindRaw === 'small_area_metric'
      ? kindRaw
      : 'small_area_metric') as FilterConfigRow['kind']
    const status = String(getFirst(lookup, ['status']) ?? '').trim().toLowerCase()
    if (status !== 'use') continue
    out.push({
      group,
      key,
      label,
      kind,
      source: String(getFirst(lookup, ['source']) ?? '').trim() || undefined,
      rawField: String(getFirst(lookup, ['raw_field', 'rawfield']) ?? '').trim() || undefined,
      mapField: String(getFirst(lookup, ['map_field', 'mapfield']) ?? '').trim() || undefined,
      status: String(getFirst(lookup, ['status']) ?? '').trim() || undefined,
    })
  }
  return out
}

function statusIsUse(row: FilterConfigRow): boolean {
  return String(row.status ?? '').trim().toLowerCase() === 'use'
}

function parseMetricRows(
  rows: Record<string, unknown>[],
  cfg: FilterConfigRow[],
  warnings: string[],
  geography: 'small_area' | 'town',
): Record<string, ParsedMetric> {
  const metrics: Record<string, ParsedMetric> = {}
  const usableCfg = cfg.filter(
    (c) =>
      c.kind === (geography === 'small_area' ? 'small_area_metric' : 'town_metric') &&
      // Allow metrics with only a rawField and no mapField (e.g. phobal_score)
      !!((c.mapField && String(c.mapField).trim()) || (c.rawField && String(c.rawField).trim())) &&
      statusIsUse(c),
  )
  if (!rows.length || !usableCfg.length) return metrics

  const headerSet = new Set<string>()
  for (const row of rows.slice(0, 5)) for (const k of Object.keys(row)) headerSet.add(normKey(k))

  const idAliases = geography === 'small_area'
    ? ['cso_code', 'cso code', 'geogid', 'cso_small_area_code', 'small_area_code', 'small_area', 'sa_geogid', 'sa_code', 'cso_sa_code', 'small_area_id']
    : ['bua_code', 'bua code', 'bua', 'town_code', 'town', 'town_name', 'bua_name']

  for (const conf of usableCfg) {
    const mapField = conf.mapField ?? ''
    const rawField = conf.rawField
    // phobal_score and similar: no mapField, rawField serves as both count and value
    const noMapField = !mapField
    const mapKey = normKey(mapField)
    const rawKey = rawField ? normKey(rawField) : undefined
    if (!noMapField && !headerSet.has(mapKey)) {
      warnings.push(`${geography === 'small_area' ? 'small_area_master' : 'town_master'}: map field "${mapField}" for filter "${conf.key}" was not found.`)
      continue
    }
    if (!rawKey && geography === 'small_area') {
      warnings.push(`small_area_master: raw_field missing for filter "${conf.key}" — skipped.`)
      continue
    }
    if (rawKey && !headerSet.has(rawKey)) {
      warnings.push(
        `${geography === 'small_area' ? 'small_area_master' : 'town_master'}: raw field "${rawField}" for filter "${conf.key}" was not found.`,
      )
      continue
    }

    const values: Record<string, MetricValue> = {}
    rows.forEach((row, idx) => {
      const lookup = buildLookup(row)
      const id = normalizeAreaId(getFirst(lookup, idAliases))
      if (!id) return
      // If no mapField, pctValue is null and countNum comes from rawKey only
      const pctNum = noMapField ? null : parseCellNumber(lookup.get(mapKey))
      const countNum = rawKey ? parseCellNumber(lookup.get(rawKey)) : parseCellNumber(lookup.get(mapKey))
      if (countNum === null) {
        const rawVal = rawKey ? lookup.get(rawKey) : lookup.get(mapKey)
        if (rawVal !== '' && rawVal !== null && rawVal !== undefined) {
          warnings.push(
            `${geography === 'small_area' ? 'small_area_master' : 'town_master'} row ${idx + 2}: count column for "${conf.key}" is not numeric — skipped.`,
          )
        }
        return
      }
      const legacyRaw = rawKey ? lookup.get(rawKey) : undefined
      for (const alias of aliasIds(id)) {
        values[alias] = {
          mapValue: countNum,
          pctValue: pctNum,
          rawValue: typeof legacyRaw === 'string' || typeof legacyRaw === 'number' ? legacyRaw : undefined,
        }
      }
    })

    if (Object.keys(values).length) {
      metrics[conf.key] = {
        key: conf.key,
        label: conf.label,
        geography,
        unit: inferUnit(conf.mapField),
        values,
      }
    }
  }

  return metrics
}

export function parseWorkbookData(wb: WorkBook): ParsedWorkbookData {
  const households: HouseholdRecord[] = []
  const evCommercial: HouseholdRecord[] = []
  const warnings: string[] = []
  const importSummary: ParsedWorkbookData['importSummary'] = []
  const metricsByKey: Record<string, ParsedMetric> = {}
  let filterConfig: FilterConfigRow[] = []

  const cfgSheet = wb.Sheets['filter_config']
  if (cfgSheet) {
    const cfgRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(cfgSheet, { defval: '', raw: true })
    filterConfig = parseFilterConfig(cfgRows)
    importSummary.push({ sheetName: 'filter_config', rowsImported: filterConfig.length, detail: 'Metric config' })
  } else {
    warnings.push('filter_config sheet not found.')
  }

  const hhSheet = wb.Sheets['households_clean']
  if (hhSheet) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(hhSheet, { defval: '', raw: true })
    const hh = parseHouseholdRows(rows)
    households.push(...hh.parsed)
    warnings.push(...hh.errors.map((e) => `households_clean: ${e}`))
    importSummary.push({ sheetName: 'households_clean', rowsImported: hh.parsed.length, detail: 'Household rows (lat/lon)' })
  } else {
    warnings.push('households_clean sheet not found.')
  }

  const evSheet = wb.Sheets['ev_commercial_clean']
  if (evSheet) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(evSheet, { defval: '', raw: true })
    const ev = parseHouseholdRows(rows)
    evCommercial.push(...ev.parsed)
    warnings.push(...ev.errors.map((e) => `ev_commercial_clean: ${e}`))
    importSummary.push({ sheetName: 'ev_commercial_clean', rowsImported: ev.parsed.length, detail: 'EV commercial rows (lat/lon)' })
  } else {
    warnings.push('ev_commercial_clean sheet not found.')
  }

  const saSheet = wb.Sheets['small_area_master']
  if (saSheet) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(saSheet, { defval: '', raw: true })
    Object.assign(metricsByKey, parseMetricRows(rows, filterConfig, warnings, 'small_area'))
    importSummary.push({ sheetName: 'small_area_master', rowsImported: rows.length, detail: 'Small Area metric table' })
  } else {
    warnings.push('small_area_master sheet not found.')
  }

  const townSheet = wb.Sheets['town_master']
  if (townSheet) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(townSheet, { defval: '', raw: true })
    Object.assign(metricsByKey, parseMetricRows(rows, filterConfig, warnings, 'town'))
    importSummary.push({ sheetName: 'town_master', rowsImported: rows.length, detail: 'Town metric table' })
  }

  if (!filterConfig.length && Object.keys(metricsByKey).length === 0) {
    warnings.push('Workbook did not match the cleaned template (small_area_master / households_clean / filter_config).')
  }

  return { households, evCommercial, metricsByKey, filterConfig, importSummary, warnings }
}
