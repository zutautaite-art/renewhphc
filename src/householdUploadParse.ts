import type { HouseholdRecord } from './types/households'

function parseBool(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  const s = String(value).trim().toLowerCase()
  if (s === '') return undefined
  if (['1', 'true', 'yes', 'y'].includes(s)) return true
  if (['0', 'false', 'no', 'n'].includes(s)) return false
  return undefined
}

export function normKey(k: string): string {
  return String(k).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/\s+/g, '_')
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

function parseCoord(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  let s = String(raw).trim()
  if (s === '' || s === '-') return NaN
  if (/^-?\d+,\d+$/.test(s.replace(/\s/g, ''))) {
    s = s.replace(/\s/g, '').replace(',', '.')
    return Number(s)
  }
  const compact = s.replace(/\s/g, '')
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(compact)) {
    s = compact.replace(/\./g, '').replace(',', '.')
    return Number(s)
  }
  s = compact.replace(/,/g, '')
  return Number(s)
}

const LAT_KEYS = ['lat', 'latitude', 'latitude_clean', 'clean_latitude', 'lattitude', 'ltd', 'dec_lat', 'decimal_latitude', 'gps_lat', 'geog_lat']
const LON_KEYS = ['lon', 'lng', 'longitude_clean', 'clean_longitude', 'long', 'longitude', 'lnt', 'ln', 'dec_lon', 'decimal_longitude', 'gps_lon', 'gps_lng', 'geog_lon', 'geog_long']
const ID_KEYS = ['id', 'hh_id', 'household_id', 'uid', 'ref', 'eircode']
const COUNTY_KEYS = ['county', 'county_name', 'countyname', 'local_authority', 'la', 'council', 'admin_county', 'region', 'area', 'admin_area']
const TOWN_KEYS = ['town', 'town_name', 'settlement', 'bua', 'built_up_area', 'ed', 'electoral_division']
const ADDRESS_KEYS = ['full_address', 'address', 'addr', 'street_address', 'postal_address', 'location', 'eircode']
const DOT_TYPE_KEYS = ['dot_type', 'dot type', 'dottype']
const CUSTOMER_TYPE_KEYS = ['customer_type', 'customer segment', 'segment', 'type']
const UPLOAD_METRIC_KEYS = ['value', 'metric', 'amount', 'total', 'score', 'weight', 'data', 'data_value', 'quantity', 'sum', 'potential_customers', 'customers', 'population', 'kwh', 'mwh']

export function parseUploadMetricFromLookup(lookup: Map<string, unknown>): number | undefined {
  const raw = getFirst(lookup, UPLOAD_METRIC_KEYS)
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const s = String(raw).trim().replace(/%/g, '').replace(/\s/g, '').replace(/,/g, '.')
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

function maybeSwapIrelandLatLon(lat: number, lon: number): { lat: number; lon: number } {
  const latHoldsLongitude = lat >= -11 && lat <= -5
  const lonHoldsLatitude = lon >= 51 && lon <= 56
  if (latHoldsLongitude && lonHoldsLatitude) return { lat: lon, lon: lat }
  return { lat, lon }
}

export function parseHouseholdRows(rows: Record<string, unknown>[]): { parsed: HouseholdRecord[]; errors: string[] } {
  const errors: string[] = []
  const parsed: HouseholdRecord[] = []

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2
    const lookup = buildLookup(row)
    const idRaw = getFirst(lookup, ID_KEYS)
    const latRaw = getFirst(lookup, LAT_KEYS)
    const lonRaw = getFirst(lookup, LON_KEYS)
    const id = String(idRaw ?? '').trim() || `row_${rowNumber}`
    let lat = parseCoord(latRaw)
    let lon = parseCoord(lonRaw)
    ;({ lat, lon } = maybeSwapIrelandLatLon(lat, lon))

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      errors.push(`Row ${rowNumber}: missing/invalid lat/lon (checked columns like lat, latitude, latitude_clean, lon, lng, longitude, longitude_clean)`)
      return
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      errors.push(`Row ${rowNumber}: lat/lon out of range`)
      return
    }

    const addrRaw = getFirst(lookup, ADDRESS_KEYS)
    const fullAddress =
      addrRaw !== undefined && addrRaw !== null && String(addrRaw).trim() !== '' ? String(addrRaw).trim() : undefined
    const address = fullAddress
    const uploadMetric = parseUploadMetricFromLookup(lookup)

    const dotRaw = getFirst(lookup, DOT_TYPE_KEYS)
    const dotLower = String(dotRaw ?? '').trim().toLowerCase()
    const dotType: 'red' | 'yellow' = dotLower === 'yellow' ? 'yellow' : 'red'

    const customerTypeRaw = getFirst(lookup, CUSTOMER_TYPE_KEYS)
    const customerType =
      customerTypeRaw !== undefined && customerTypeRaw !== null && String(customerTypeRaw).trim() !== ''
        ? String(customerTypeRaw).trim()
        : undefined

    parsed.push({
      id,
      lat,
      lon,
      address,
      fullAddress,
      dotType,
      customerType,
      county: String(getFirst(lookup, COUNTY_KEYS) ?? '').trim() || undefined,
      town: String(getFirst(lookup, TOWN_KEYS) ?? '').trim() || undefined,
      uploadMetric,
      solar: parseBool(getFirst(lookup, ['solar', 'has_solar', 'pv'])),
      ev: parseBool(getFirst(lookup, ['ev', 'electric_vehicle', 'has_ev'])),
      heat_pump: parseBool(getFirst(lookup, ['heat_pump', 'heatpump', 'heat_pump_', 'has_heat_pump', 'ashp', 'gshp'])),
    })
  })

  return { parsed, errors }
}

export function sampleNormalizedHeaders(row: Record<string, unknown> | undefined): string[] {
  if (!row) return []
  return Object.keys(row).map((k) => normKey(k))
}
