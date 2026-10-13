// Downloads the OpenStreetMap data the map is built from into assets-src/osm/:
//   node tools/map/fetch.mjs
// The OSM API only serves small areas per call, so it fetches tiles, politely
// one at a time, skipping any already downloaded. Then run build.mjs.
// Map data © OpenStreetMap contributors (ODbL 1.0).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGIONS, TILES } from './config.mjs';

const OUT = 'assets-src/osm';
const API = 'https://api.openstreetmap.org/api/0.6/map.json';
const HEADERS = { 'User-Agent': 'fast5-map-build (https://github.com/kingermayank/fast5)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });

async function get(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.text();
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (i >= tries) throw err;
      console.log(`  retry ${i} (${err.message})`);
      await sleep(2000 * 2 ** i);
    }
  }
}

for (const r of REGIONS) {
  for (let lon = r.lon[0]; lon < r.lon[1] - 1e-9; lon += TILES.lonStep) {
    for (let lat = r.lat[0]; lat < r.lat[1] - 1e-9; lat += TILES.latStep) {
      const box = [lon, lat, Math.min(lon + TILES.lonStep, r.lon[1]), Math.min(lat + TILES.latStep, r.lat[1])].map((v) => v.toFixed(4));
      const file = join(OUT, `tile_${box.join('_')}.json`);
      if (existsSync(file)) continue;
      console.log(`${r.name}: ${box.join(',')}`);
      writeFileSync(file, await get(`${API}?bbox=${box.join(',')}`));
      await sleep(1000);
    }
  }
}

// The San José lagoon's outline (the shore around the bridge), from Nominatim.
const lagoonFile = join(OUT, 'lagoon.json');
if (!existsSync(lagoonFile)) {
  const url = 'https://nominatim.openstreetmap.org/search?q=Laguna+San+Jos%C3%A9,+Puerto+Rico&format=json&polygon_geojson=1&polygon_threshold=0.0002&limit=1';
  const [hit] = JSON.parse(await get(url));
  writeFileSync(lagoonFile, JSON.stringify({ name: hit.name, source: `OpenStreetMap ${hit.osm_type} ${hit.osm_id} via Nominatim (simplified)`, license: 'ODbL 1.0', outer: hit.geojson.coordinates[0] }));
}
console.log('done; now run: node tools/map/build.mjs');
