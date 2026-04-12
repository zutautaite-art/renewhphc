import type { Feature, FeatureCollection } from 'geojson'
import type { LocalAuthorityRow } from './cso/geohivePlaces'
import { geometryBBox } from './geoBounds'
import { pointInPolygonCoords } from './pointInPolygon'

export type LinkedTownOption = {
  /** CSO BUA_CODE — stable id for selection and map. */
  buaCode: string
  buaName: string
  localAuthority: string
  /** Dropdown row text (may include county when names collide). */
  label: string
}

function propsOf(f: Feature): Record<string, unknown> {
  return (f.properties as Record<string, unknown> | null) ?? {}
}

function laPolygons(countiesFc: FeatureCollection): {
  la: string
  county: string
  feature: Feature
}[] {
  const out: { la: string; county: string; feature: Feature }[] = []
  for (const f of countiesFc.features) {
    const p = propsOf(f)
    const la = String(p.LOCAL_AUTHORITY ?? '').trim()
    if (!la || la === '-') continue
    const county = String(p.COUNTY ?? '').trim()
    if (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon') continue
    out.push({ la, county, feature: f })
  }
  return out
}

function testPointForBua(f: Feature): [number, number] | null {
  const g = f.geometry
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return null
  const box = geometryBBox(g)
  if (!box) return null
  const lng = (box[0] + box[2]) / 2
  const lat = (box[1] + box[3]) / 2
  if (pointInPolygonCoords(lng, lat, g)) return [lng, lat]
  // Bbox centre can fall outside crescent shapes — try first vertex of exterior ring
  if (g.type === 'Polygon') {
    const ring = g.coordinates[0]
    const p = ring?.[0]
    if (p && pointInPolygonCoords(p[0], p[1], g)) return [p[0], p[1]]
  } else {
    for (const poly of g.coordinates) {
      const sub = poly[0]
      const p = sub?.[0]
      if (p) {
        const piece = { type: 'Polygon' as const, coordinates: poly }
        if (pointInPolygonCoords(p[0], p[1], piece)) return [p[0], p[1]]
      }
    }
  }
  return [lng, lat]
}

function findLaForPoint(
  lng: number,
  lat: number,
  las: { la: string; county: string; feature: Feature }[],
): { la: string; county: string } | null {
  for (const { la, county, feature } of las) {
    const g = feature.geometry
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue
    if (pointInPolygonCoords(lng, lat, g)) return { la, county }
  }
  return null
}

function titleCaseCounty(c: string): string {
  if (!c) return ''
  return c
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Derive LA rows + link each BUA polygon to a local authority via point-in-polygon. */
export function linkBuaToLocalAuthorities(
  countiesFc: FeatureCollection,
  buaFc: FeatureCollection,
): { towns: LinkedTownOption[]; laRows: LocalAuthorityRow[] } {
  const las = laPolygons(countiesFc)
  const byLa = new Map<string, LocalAuthorityRow>()
  for (const { la, county } of las) {
    if (!byLa.has(la)) byLa.set(la, { localAuthority: la, county })
  }
  const laRows = [...byLa.values()].sort((a, b) =>
    a.localAuthority.localeCompare(b.localAuthority, 'en-IE'),
  )

  const rawTowns: Omit<LinkedTownOption, 'label'>[] = []

  for (const f of buaFc.features) {
    const p = propsOf(f)
    const name = String(p.BUA_NAME ?? '').trim()
    const code = String(p.BUA_CODE ?? p.GEOGID ?? '').trim()
    if (!name || !code) continue
    const pt = testPointForBua(f)
    if (!pt) continue
    const hit = findLaForPoint(pt[0], pt[1], las)
    if (!hit) continue
    rawTowns.push({
      buaCode: code,
      buaName: name,
      localAuthority: hit.la,
    })
  }

  const nameCount = new Map<string, number>()
  for (const t of rawTowns) {
    nameCount.set(t.buaName, (nameCount.get(t.buaName) ?? 0) + 1)
  }

  const countyHint = new Map<string, string>()
  for (const { la, county } of las) {
    if (!countyHint.has(la)) countyHint.set(la, titleCaseCounty(county))
  }

  const towns: LinkedTownOption[] = rawTowns.map((t) => {
    const dup = (nameCount.get(t.buaName) ?? 0) > 1
    const hint = countyHint.get(t.localAuthority) ?? t.localAuthority
    const label = dup ? `${t.buaName} (${hint})` : t.buaName
    return { ...t, label }
  })

  towns.sort((a, b) => a.label.localeCompare(b.label, 'en-IE'))

  return { towns, laRows }
}
