import fs from 'fs'
const s = fs.readFileSync(new URL('../public/small_areas_metrics.geojson', import.meta.url), 'utf8')
const fc = JSON.parse(s)
const p = fc.features[0]?.properties ?? {}
console.log(Object.keys(p).sort().join('\n'))
