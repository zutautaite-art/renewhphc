export type BasemapMode = 'terrain' | 'satellite'

export const BASEMAP_SOURCE_ID = 'basemap-raster'
export const BASEMAP_LAYER_ID = 'basemap-raster-layer'

/** Standard OpenStreetMap raster tiles (OSM “Carto” style, same family as openstreetmap.org). */
const TERRAIN_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png']

/** Esri World Imagery (z/y/x tile order). */
const SATELLITE_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
]

export function basemapTileUrls(mode: BasemapMode): string[] {
  return mode === 'satellite' ? SATELLITE_TILES : TERRAIN_TILES
}

/**
 * Basemap credits (shown in the map attribution control for both OSM and satellite).
 * Same overlays (CSO boundaries, etc.) apply to either basemap.
 */
export const BASEMAP_ATTRIBUTION =
  'Basemap — Map: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '(<a href="https://www.openstreetmap.org/">openstreetmap.org</a>). ' +
  'Satellite: © Esri — Source: Esri, Maxar, Earthstar Geographics, USDA, USGS, AeroGRID, IGN, IGP, and the GIS User Community.'

export function getBasemapStyle() {
  return {
    version: 8,
    /** Required for `symbol` layers (county name labels on the map). */
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      [BASEMAP_SOURCE_ID]: {
        type: 'raster',
        tiles: basemapTileUrls('terrain'),
        tileSize: 256,
      },
    },
    layers: [
      {
        id: BASEMAP_LAYER_ID,
        type: 'raster',
        source: BASEMAP_SOURCE_ID,
      },
    ],
  }
}
