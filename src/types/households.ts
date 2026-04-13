export type HouseholdRecord = {
  id: string
  lat: number
  lon: number
  /** Set when the row was placed from a CSO Small Area code — used for map SA shading / hover. */
  csoSaGeogid?: string
  /**
   * Optional numeric value from the spreadsheet (value / amount / score / etc.).
   * When present on any row, choropleth and county totals use sums of this field; otherwise each row counts as 1.
   */
  uploadMetric?: number
  /** Free-text address from upload when present; else UI derives from town/county/coords. */
  address?: string
  /** From `Full_Address` on cleaned household / EV commercial sheets. */
  fullAddress?: string
  /** From `dot_type`: red = household customer, yellow = EV commercial. */
  dotType?: 'red' | 'yellow'
  /** Optional free-text customer / segment label from spreadsheet when present. */
  customerType?: string
  county?: string
  town?: string
  solar?: boolean
  ev?: boolean
  heat_pump?: boolean
}
