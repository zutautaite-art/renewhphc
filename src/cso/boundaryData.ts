import type { FeatureCollection } from 'geojson'
import { CSO_ARCGIS, fetchArcgisGeoJson } from './arcgisGeoJson'

/** Full county (LA) + BUA GeoJSON for map and town↔county linking. */
export async function fetchCsoCountyAndBuaGeoJson(): Promise<{
  counties: FeatureCollection
  bua: FeatureCollection
}> {
  const [counties, bua] = await Promise.all([
    fetchArcgisGeoJson(CSO_ARCGIS.localAuthoritiesQuery, {
      where: '1=1',
      outFields: 'COUNTY,LOCAL_AUTHORITY,GEOGID,GEOGDESC',
      resultRecordCount: '40',
    }),
    fetchArcgisGeoJson(CSO_ARCGIS.builtUpAreasQuery, {
      where: '1=1',
      outFields: 'BUA_NAME,BUA_CODE,GEOGID,GEOGDESC',
      resultRecordCount: '2000',
    }),
  ])
  return { counties, bua }
}
