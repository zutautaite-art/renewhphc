import type { HouseholdRecord } from './types/households'
import { normKey } from './householdUploadParse'

/** Which sidebar filters have backing data from the current upload. */
export type LoadedFilterAvailability = {
  potentialCustomers: boolean
  ageBand: boolean
  education: boolean
  familyComposition: boolean
  householdIncome: boolean
  incomeProxy: boolean
  renewableShare: boolean
}

export function emptyFilterAvailability(): LoadedFilterAvailability {
  return {
    potentialCustomers: false,
    ageBand: false,
    education: false,
    familyComposition: false,
    householdIncome: false,
    incomeProxy: false,
    renewableShare: false,
  }
}

/** Combine availability from multiple sheets (e.g. household tab + county metric tab). */
export function mergeLoadedFilterAvailability(
  a: LoadedFilterAvailability,
  b: LoadedFilterAvailability,
): LoadedFilterAvailability {
  return {
    potentialCustomers: a.potentialCustomers || b.potentialCustomers,
    ageBand: a.ageBand || b.ageBand,
    education: a.education || b.education,
    familyComposition: a.familyComposition || b.familyComposition,
    householdIncome: a.householdIncome || b.householdIncome,
    incomeProxy: a.incomeProxy || b.incomeProxy,
    renewableShare: a.renewableShare || b.renewableShare,
  }
}

/** Union of header keys from the first N rows (captures optional columns). */
export function collectNormalizedHeaderKeys(rows: Record<string, unknown>[], maxRows = 120): string[] {
  const s = new Set<string>()
  for (const row of rows.slice(0, maxRows)) {
    for (const k of Object.keys(row)) {
      s.add(normKey(k))
    }
  }
  return [...s]
}

function haystack(headers: string[]): string {
  return headers.join(' ').toLowerCase()
}

/**
 * Infer which filters are backed by household point / code-sheet data using column names
 * and optional parsed fields (solar / ev / heat pump).
 */
export function inferFromHouseholdData(
  normalizedHeaderKeys: string[],
  records: HouseholdRecord[],
): LoadedFilterAvailability {
  const a = emptyFilterAvailability()
  if (!records.length) return a

  a.potentialCustomers = true

  const H = haystack(normalizedHeaderKeys)

  a.ageBand = /\b(age|band|cohort|35|44|40|50|demographic|middle|persona.*age|years)\b/i.test(H)

  a.education = /\b(edu|education|degree|bachelor|tertiary|qualification|graduate|third.?level|phd|masters)\b/i.test(
    H,
  )

  a.familyComposition = /\b(family|fertilit|children|kids|depend|household_size|persons|with_children)\b/i.test(H)

  const proxyHint = /\b(proxy|property|price|sale|median_price|3_5|3\.5)\b/i.test(H)
  a.incomeProxy = proxyHint

  if (!proxyHint) {
    a.householdIncome =
      /\b(income|earnings|disposable|gross|net|wage|salary)\b.*\b(pct|percent|share|ratio)\b/i.test(H) ||
      /\b(household_income|income_pct|income_percent|pct_income)\b/i.test(H) ||
      /\b(income|earnings)\b/i.test(H)
  }

  const energyFromValues = records.some(
    (h) => h.solar !== undefined || h.ev !== undefined || h.heat_pump !== undefined,
  )
  a.renewableShare =
    /\b(renew|solar|pv|wind|green|carbon|grid|elec|generation|heat_pump|heatpump|ashp|gshp|ev\b|vehicle|emission)\b/i.test(
      H,
    ) || energyFromValues

  return a
}

/**
 * County aggregate sheet carries a single numeric measure — map its column key to the closest persona / electricity filter.
 */
export function inferFromCountyMeasureKey(measureKey: string): LoadedFilterAvailability {
  const a = emptyFilterAvailability()
  const k = measureKey.toLowerCase().replace(/\s+/g, '_')

  if (/age|band|cohort|35|44|40|50|demographic|years|elder|youth/.test(k)) {
    a.ageBand = true
    return a
  }
  if (/edu|degree|bachelor|qualification|tertiary|graduate|school|student/.test(k)) {
    a.education = true
    return a
  }
  if (/family|fertilit|child|kid|depend|persons|household.*size/.test(k)) {
    a.familyComposition = true
    return a
  }
  if (/proxy|price|property|sale|median|3_5|3\.5/.test(k)) {
    a.incomeProxy = true
    return a
  }
  if (/income|earn|pct|percent|wage|salary|disposable|gross|net/.test(k)) {
    a.householdIncome = true
    return a
  }
  if (/renew|solar|wind|green|electric|carbon|grid|generation|emission|fuel/.test(k)) {
    a.renewableShare = true
    return a
  }

  a.ageBand = true
  return a
}
