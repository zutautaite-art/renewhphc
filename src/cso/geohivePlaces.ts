import { CSO_ARCGIS } from './arcgisGeoJson'

type ArcgisFeatureJson = {
  attributes?: Record<string, unknown>
}

type ArcgisQueryJson = {
  features?: ArcgisFeatureJson[]
  exceededTransferLimit?: boolean
  error?: { message?: string; details?: string[] }
}

const PAGE = 2000

/** Paginated attribute-only query (GeoHive / ArcGIS REST). */
export async function fetchArcgisAttributesAll(
  queryUrl: string,
  baseParams: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let offset = 0

  for (;;) {
    const u = new URL(queryUrl)
    const merged: Record<string, string> = {
      f: 'json',
      returnGeometry: 'false',
      outSR: '4326',
      ...baseParams,
      resultRecordCount: String(PAGE),
      resultOffset: String(offset),
    }
    Object.entries(merged).forEach(([k, v]) => u.searchParams.set(k, v))

    const res = await fetch(u.toString())
    const data = (await res.json()) as ArcgisQueryJson

    if (!res.ok || data.error) {
      const msg =
        data.error?.message || data.error?.details?.join('; ') || `HTTP ${res.status}`
      throw new Error(msg)
    }

    const batch = data.features?.map((f) => f.attributes).filter(Boolean) ?? []
    out.push(...(batch as Record<string, unknown>[]))

    const more = data.exceededTransferLimit === true && batch.length === PAGE
    offset += batch.length
    if (!more || batch.length === 0) break
    if (offset > 100_000) break
  }

  return out
}

export type LocalAuthorityRow = {
  /** CSO county name (often uppercase, e.g. WATERFORD). */
  county: string
  /** Full local authority label for the UI and primary filter match. */
  localAuthority: string
}

/** All 31 local authorities from Census Hub LA layer (GeoHive). */
export async function fetchLocalAuthorityRows(): Promise<LocalAuthorityRow[]> {
  const rows = await fetchArcgisAttributesAll(CSO_ARCGIS.localAuthoritiesQuery, {
    where: '1=1',
    outFields: 'COUNTY,LOCAL_AUTHORITY',
    orderByFields: 'LOCAL_AUTHORITY',
  })

  const byLa = new Map<string, LocalAuthorityRow>()
  for (const r of rows) {
    const la = String(r.LOCAL_AUTHORITY ?? '').trim()
    const c = String(r.COUNTY ?? '').trim()
    if (!la || la === '-') continue
    if (!byLa.has(la)) byLa.set(la, { county: c, localAuthority: la })
  }
  return [...byLa.values()].sort((a, b) => a.localAuthority.localeCompare(b.localAuthority, 'en-IE'))
}

/** Built-up area (town) names — CSO BUA layer (GeoHive). */
export async function fetchBuiltUpAreaNames(): Promise<string[]> {
  const rows = await fetchArcgisAttributesAll(CSO_ARCGIS.builtUpAreasQuery, {
    where: "BUA_NAME IS NOT NULL AND BUA_NAME <> ''",
    outFields: 'BUA_NAME',
    orderByFields: 'BUA_NAME',
  })

  const seen = new Set<string>()
  const names: string[] = []
  for (const r of rows) {
    const n = String(r.BUA_NAME ?? '').trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    names.push(n)
  }
  return names.sort((a, b) => a.localeCompare(b, 'en-IE'))
}
