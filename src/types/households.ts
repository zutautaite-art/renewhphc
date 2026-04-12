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
  county?: string
  town?: string
  solar?: boolean
  ev?: boolean
  heat_pump?: boolean
}

