// Packs the street map (src/map/sanjuan.json, built from OpenStreetMap by
// tools/map) into the binary the Rive game reads: game/assets/map.bin.
//
// Every value is a little-endian 32-bit word (u32 or f32), read in order:
//   'F5MP' version
//   nodes:     count, then x z per node
//   edges:     count, then per edge: a b halfWidth rank bridge n, then n points
//   buildings: count, then per building: height kind n, then n points, then triangles
//   areas:     count, then per area: kind(0 green, 1 lot) n, then n points, then triangles
//   land:      count, then per polygon: rings, then per ring: n, then n points, then triangles
//   walls:     count, then per wall: n, then n points
//   poi:       plan count + node ids, foot node, goal node,
//              spikes x z dx dz, bank n + points, bank heading, bank corner node,
//              tolls n + points
// Points are x z pairs in metres (f32). Polygons (footprints, areas, land) are
// stored wound so the game's signed area is positive (see game/src/map.as),
// followed by their triangulation: a count t, then 3t vertex indices packed
// two u16 to a word (low half first, padded to a whole word).
// Map data © OpenStreetMap contributors (ODbL).
import { readFile, writeFile } from 'node:fs/promises';
import { ShapeUtils, Vector2 } from 'three';

const [input = 'src/map/sanjuan.json', output = 'game/assets/map.bin'] = process.argv.slice(2);

/** Building kinds, in the order the game's BuildingKind enum lists them. */
const KINDS = ['yes', 'house', 'apartments', 'commercial', 'school', 'university', 'church', 'residential', 'train_station', 'carport', 'sports_centre', 'college', 'retail', 'ruins', 'office', 'hospital'];

const words = [];
const u32 = (v) => words.push({ u: v >>> 0 });
const f32 = (v) => words.push({ f: v });
const pts = (flat) => {
  u32(flat.length / 2);
  for (const v of flat) f32(v);
};

/** The game's signed area: positive is the winding it builds walls and roofs for. */
function signedArea(p) {
  let s = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  }
  return s;
}

/** A polygon wound positive, with its triangles wound the same way. */
function polygon(flat) {
  let p = flat.slice();
  // Drop a repeated closing point.
  const n0 = p.length / 2;
  if (n0 > 3 && p[0] === p[(n0 - 1) * 2] && p[1] === p[(n0 - 1) * 2 + 1]) p = p.slice(0, -2);
  if (signedArea(p) < 0) {
    const r = [];
    for (let i = p.length / 2 - 1; i >= 0; i--) r.push(p[i * 2], p[i * 2 + 1]);
    p = r;
  }
  const contour = [];
  for (let i = 0; i < p.length; i += 2) contour.push(new Vector2(p[i], p[i + 1]));
  const faces = p.length >= 6 ? ShapeUtils.triangulateShape(contour, []) : [];
  const tris = [];
  for (const [a, b, c] of faces) {
    const t = [p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], p[c * 2], p[c * 2 + 1]];
    tris.push(...(signedArea(t) >= 0 ? [a, b, c] : [a, c, b]));
  }
  pts(p);
  u32(tris.length / 3);
  for (let i = 0; i < tris.length; i += 2) u32((tris[i] & 0xffff) | ((tris[i + 1] ?? 0) << 16));
}

const map = JSON.parse(await readFile(input, 'utf8'));

u32(0x504d3546); // 'F5MP'
u32(2);

u32(map.nodes.length / 2);
for (const v of map.nodes) f32(v);

u32(map.edges.length);
for (const e of map.edges) {
  u32(e.a);
  u32(e.b);
  f32(e.w);
  u32(e.r);
  u32(e.br ? 1 : 0);
  pts(e.p);
}

u32(map.buildings.length);
for (const b of map.buildings) {
  const kind = KINDS.indexOf(b.k);
  if (kind < 0) throw new Error(`unknown building kind ${b.k}`);
  f32(b.h);
  u32(kind);
  polygon(b.p);
}

u32(map.areas.length);
for (const a of map.areas) {
  u32(a.k === 'green' ? 0 : 1);
  polygon(a.p);
}

u32(map.land.length);
for (const poly of map.land) {
  u32(poly.length);
  for (const ring of poly) polygon(ring);
}

u32(map.walls.length);
for (const w of map.walls) pts(w);

const poi = map.poi;
u32(poi.plan.length);
for (const id of poi.plan) u32(id);
u32(poi.foot);
u32(poi.goal);
f32(poi.spikes.p[0]);
f32(poi.spikes.p[1]);
f32(poi.spikes.d[0]);
f32(poi.spikes.d[1]);
pts(poi.bank.p);
f32(poi.bank.heading);
u32(poi.bank.corner);
pts(poi.tolls);

const buf = Buffer.alloc(words.length * 4);
words.forEach((w, i) => ('u' in w ? buf.writeUInt32LE(w.u, i * 4) : buf.writeFloatLE(w.f, i * 4)));
await writeFile(output, buf);
console.log(`${output}: ${buf.length} bytes (${map.nodes.length / 2} nodes, ${map.edges.length} edges, ${map.buildings.length} buildings)`);
