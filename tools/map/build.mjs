// Turns the OpenStreetMap tiles in assets-src/osm/ (see fetch.mjs) into the
// game's map, public/maps/sanjuan.json:
//   node tools/map/build.mjs
//
// The map is real Hato Rey (San Juan, Puerto Rico), where Fast Five shot its
// "Rio" vault chase, joined to the Teodoro Moscoso Bridge where the chase
// ends. Out of the raw data it makes:
//  - a road graph: intersections and the streets between them (center lines and
//    half widths), with every crossing at grade, the expressway's two
//    carriageways merged into one road, and the bridge as a single deck;
//  - building footprints with their real heights, parks, parking lots, the lagoon;
//  - where the set pieces go: the police HQ, Mia's route, the spike strip, the
//    bank, the toll plaza and the swap point.
// Map data © OpenStreetMap contributors (ODbL 1.0).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import polygonClipping from 'polygon-clipping';
import { ORIGIN, PLAN, REGIONS, SPIKES_ALONG_ROUTE, STATION_GAME, STATION_NORTH, SWAP_ALONG_BRIDGE } from './config.mjs';

const SRC = 'assets-src/osm';
const OUT = 'src/map/sanjuan.json';
const M_LAT = 110574;
const M_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

// ---------------------------------------------------------------- load

const osmNodes = new Map();
const osmWays = new Map();
for (const f of readdirSync(SRC)) {
  if (!f.startsWith('tile_')) continue;
  for (const e of JSON.parse(readFileSync(join(SRC, f), 'utf8')).elements) {
    if (e.type === 'node') osmNodes.set(e.id, e);
    else if (e.type === 'way') osmWays.set(e.id, e);
  }
}
const lagoon = JSON.parse(readFileSync(join(SRC, 'lagoon.json'), 'utf8')).outer;
console.log(`OSM: ${osmNodes.size} nodes, ${osmWays.size} ways`);

// ---------------------------------------------------------------- projection

const inRegion = (r, lon, lat) => lon >= r.lon[0] && lon <= r.lon[1] && lat >= r.lat[0] && lat <= r.lat[1];
const regionOf = (lon, lat) => REGIONS.findIndex((r) => inRegion(r, lon, lat));

// The expressway drifts north over the stretch the fold cuts out, so line the two cut ends
// up: slide the bridge region north or south by the difference where PR-17 crosses each cut.
const latShift = (() => {
  const crossings = (lonCut) => {
    const lats = [];
    for (const w of osmWays.values()) {
      if (w.tags?.highway !== 'motorway' || !/Piñero/.test(w.tags.name ?? '')) continue;
      const pts = w.nodes.map((id) => osmNodes.get(id)).filter(Boolean);
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        if ((a.lon - lonCut) * (b.lon - lonCut) > 0 || a.lon === b.lon) continue;
        lats.push(a.lat + ((lonCut - a.lon) / (b.lon - a.lon)) * (b.lat - a.lat));
      }
    }
    return lats.reduce((x, y) => x + y, 0) / lats.length;
  };
  return crossings(REGIONS[0].lon[1]) - crossings(REGIONS[1].lon[0]);
})();
console.log(`fold: bridge region slid ${(REGIONS[1].shift * M_LON).toFixed(0)} m east-west, ${(latShift * M_LAT).toFixed(0)} m north-south`);
/** East/north meters from ORIGIN, with the bridge region slid to meet Hato Rey. */
const enu = (lon, lat, r) => [(lon + REGIONS[r].shift - ORIGIN.lon) * M_LON, (lat + (r === 1 ? latShift : 0) - ORIGIN.lat) * M_LAT];

// The game frame: Ponce de León at the station runs along x = STATION_GAME.x, heading +z (south).
const { anchor, phi } = (() => {
  for (const w of osmWays.values()) {
    if (!/Ponce de Le/.test(w.tags?.name ?? '') || w.tags.highway !== 'primary') continue;
    const pts = w.nodes.map((id) => osmNodes.get(id)).filter(Boolean).map((n) => enu(n.lon, n.lat, 0));
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      if ((a[1] - STATION_NORTH) * (b[1] - STATION_NORTH) > 0 || a[1] === b[1]) continue;
      const t = (STATION_NORTH - a[1]) / (b[1] - a[1]);
      let de = b[0] - a[0];
      let dn = b[1] - a[1];
      if (dn > 0) [de, dn] = [-de, -dn];
      // Base game axes: x = east, z = south.
      return { anchor: [a[0] + t * (b[0] - a[0]), STATION_NORTH], phi: Math.atan2(de, -dn) };
    }
  }
  throw new Error('Ponce de León not found at the station');
})();
const cosA = Math.cos(-phi);
const sinA = Math.sin(-phi);
const toGame = ([e, n]) => {
  const x0 = e - anchor[0];
  const z0 = -(n - anchor[1]);
  return [STATION_GAME.x + x0 * cosA + z0 * sinA, STATION_GAME.z - x0 * sinA + z0 * cosA];
};
const project = (lon, lat, r) => toGame(enu(lon, lat, r));
console.log(`frame: Ponce de León heads ${((phi * 180) / Math.PI).toFixed(1)}° east of south at the station`);

// ---------------------------------------------------------------- geometry helpers

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const round1 = (v) => Math.round(v * 10) / 10;
function polyLength(p) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]);
  return s;
}
/** Closest point on segment ab to p: [point, t, distance]. */
function closestOnSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  const q = [a[0] + dx * t, a[1] + dz * t];
  return [q, t, dist(p, q)];
}
/** Proper intersection of segments ab and cd: [t on ab, u on cd] or null. */
function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? [t, u] : null;
}
function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = closestOnSeg(pts[k], pts[i], pts[j])[2];
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
/** Sutherland–Hodgman clip of a lon/lat ring to a region rectangle. */
function clipRing(ring, r) {
  const edges = [
    (p) => p[0] >= r.lon[0], (p) => p[0] <= r.lon[1], (p) => p[1] >= r.lat[0], (p) => p[1] <= r.lat[1],
  ];
  const cut = [
    (a, b) => (r.lon[0] - a[0]) / (b[0] - a[0]), (a, b) => (r.lon[1] - a[0]) / (b[0] - a[0]),
    (a, b) => (r.lat[0] - a[1]) / (b[1] - a[1]), (a, b) => (r.lat[1] - a[1]) / (b[1] - a[1]),
  ];
  let out = ring;
  for (let k = 0; k < 4; k++) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const ia = edges[k](a);
      const ib = edges[k](b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(lerp2(a, b, cut[k](a, b)));
    }
  }
  return out;
}

/** Spatial hash of segments, for "what's near here" queries. */
class SegIndex {
  constructor(cell = 40) {
    this.cell = cell;
    this.map = new Map();
  }
  add(a, b, data) {
    const c = this.cell;
    const x0 = Math.floor(Math.min(a[0], b[0]) / c);
    const x1 = Math.floor(Math.max(a[0], b[0]) / c);
    const z0 = Math.floor(Math.min(a[1], b[1]) / c);
    const z1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = `${i},${j}`;
      if (!this.map.has(k)) this.map.set(k, []);
      this.map.get(k).push({ a, b, data });
    }
  }
  near(p, r) {
    const c = this.cell;
    const out = new Set();
    for (let i = Math.floor((p[0] - r) / c); i <= Math.floor((p[0] + r) / c); i++) {
      for (let j = Math.floor((p[1] - r) / c); j <= Math.floor((p[1] + r) / c); j++) for (const s of this.map.get(`${i},${j}`) ?? []) out.add(s);
    }
    return [...out];
  }
}

// ---------------------------------------------------------------- roads

/** Kept road classes: importance rank (1 = expressway) and half width (m). */
const ROAD = {
  motorway: { rank: 1, hw: 12 },
  trunk: { rank: 2, hw: 10 },
  primary: { rank: 2, hw: 10 },
  secondary: { rank: 3, hw: 8 },
  tertiary: { rank: 4, hw: 6.5 },
  primary_link: { rank: 4, hw: 5 },
  secondary_link: { rank: 4, hw: 5 },
  tertiary_link: { rank: 5, hw: 4.5 },
  unclassified: { rank: 5, hw: 4.5 },
  residential: { rank: 5, hw: 4.5 },
  living_street: { rank: 6, hw: 4 },
};

/** Point positions by key: `n<osm id>` for OSM nodes, `c<n>` / `x<n>` for points made here. */
const pos = new Map();
let synth = 0;
const newKey = (p, prefix = 'x') => {
  const k = `${prefix}${synth++}`;
  pos.set(k, p);
  return k;
};

/** Clip a way's nodes to a region: runs of [lon, lat, key|null]. */
function clipToRegion(pts, r) {
  const R = REGIONS[r];
  const runs = [];
  let cur = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // Liang–Barsky against the region rectangle.
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const tests = [[-dx, a[0] - R.lon[0]], [dx, R.lon[1] - a[0]], [-dy, a[1] - R.lat[0]], [dy, R.lat[1] - a[1]]];
    let ok = true;
    for (const [p, q] of tests) {
      if (Math.abs(p) < 1e-15) {
        if (q < 0) ok = false;
      } else {
        const t = q / p;
        if (p < 0) t0 = Math.max(t0, t);
        else t1 = Math.min(t1, t);
      }
    }
    if (!ok || t0 > t1) {
      if (cur) runs.push(cur);
      cur = null;
      continue;
    }
    const pa = t0 === 0 ? a : [...lerp2(a, b, t0), null];
    const pb = t1 === 1 ? b : [...lerp2(a, b, t1), null];
    if (!cur) cur = [pa];
    cur.push(pb);
    if (t1 < 1) {
      runs.push(cur);
      cur = null;
    }
  }
  if (cur) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}

const roads = [];
for (const w of osmWays.values()) {
  const t = w.tags ?? {};
  const spec = ROAD[t.highway];
  if (!spec || t.area === 'yes') continue;
  const pts = w.nodes.map((id) => osmNodes.get(id)).filter(Boolean).map((n) => [n.lon, n.lat, `n${n.id}`]);
  if (pts.length < 2) continue;
  const lanes = parseFloat(t.lanes);
  const hw = Math.min(12, Math.max(spec.hw, lanes > 0 ? lanes * 1.75 + 1.5 : 0));
  // Outbound: toward the bridge (east or north), for merging the expressway's carriageways.
  const first = pts[0];
  const last = pts[pts.length - 1];
  const outbound = (last[0] - first[0]) * M_LON + 0.35 * (last[1] - first[1]) * M_LAT > 0;
  for (let r = 0; r < REGIONS.length; r++) {
    for (const run of clipToRegion(pts, r)) {
      const keys = run.map(([lon, lat, key]) => {
        const p = project(lon, lat, r);
        if (key) {
          pos.set(key, p);
          return key;
        }
        return newKey(p, 'c');
      });
      roads.push({
        keys, hw, rank: spec.rank, cls: t.highway, name: t.name ?? '', bridge: t.bridge === 'yes' && /Moscoso/.test(t['bridge:name'] ?? t['bridge:name:en'] ?? ''),
        oneway: t.oneway === 'yes', outbound, region: r,
      });
    }
  }
}
console.log(`roads: ${roads.length} pieces`);

// Divided roads (the expressway, some avenues) are mapped as two one-way carriageways with the
// same name. Merge each pair into one wide road: the outbound carriageway moves onto the middle
// of the pair and widens; the inbound one goes, where it runs alongside.
{
  const REACH = 45;
  const divided = roads.filter((r) => r.rank <= 3 && r.oneway && r.name);
  const inbound = divided.filter((r) => !r.outbound);
  const outbound = divided.filter((r) => r.outbound);
  const segIndex = (list) => {
    const idx = new SegIndex(40);
    for (const r of list) for (let i = 0; i < r.keys.length - 1; i++) idx.add(pos.get(r.keys[i]), pos.get(r.keys[i + 1]), r);
    return idx;
  };
  const nearest = (idx, p, name) => {
    let best = null;
    for (const s of idx.near(p, REACH)) {
      if (s.data.name !== name) continue;
      const [q, , d] = closestOnSeg(p, s.a, s.b);
      if (d < REACH && (!best || d < best[1])) best = [q, d];
    }
    return best;
  };
  // Which inbound carriageways have a partner (most of their length within reach of one).
  const outIdx = segIndex(outbound);
  const absorbed = inbound.filter((r) => r.keys.filter((k) => nearest(outIdx, pos.get(k), r.name)).length >= r.keys.length * 0.6);
  const inIdx = segIndex(absorbed);
  const moved = new Set();
  let merged = 0;
  for (const r of outbound) {
    const seps = [];
    for (const k of r.keys) {
      if (moved.has(k)) continue;
      const p = pos.get(k);
      const best = nearest(inIdx, p, r.name);
      if (best) {
        pos.set(k, lerp2(p, best[0], 0.5));
        moved.add(k);
        seps.push(best[1]);
      }
    }
    if (seps.length) {
      seps.sort((a, b) => a - b);
      const sep = seps[Math.floor(seps.length / 2)];
      r.hw = Math.min(17, Math.max(r.hw, sep / 2 + 5.5));
      merged++;
    }
  }
  for (const r of absorbed) r.dropped = true;
  console.log(`divided roads: widened ${merged} carriageways, dropped ${absorbed.length} running alongside them`);
}
// Expressway ramps are redundant once every crossing is at grade.
for (const r of roads) if (r.cls === 'motorway_link' || r.cls === 'trunk_link') r.dropped = true;
const kept = roads.filter((r) => !r.dropped);

// ---------------------------------------------------------------- graph

/** Edges: { a, b (node keys), pts (keys), hw, rank, cls, name, bridge }. */
let edges = [];
{
  const uses = new Map();
  for (const r of kept) r.keys.forEach((k, i) => uses.set(k, (uses.get(k) ?? 0) + (i === 0 || i === r.keys.length - 1 ? 2 : 1)));
  for (const r of kept) {
    let start = 0;
    for (let i = 1; i < r.keys.length; i++) {
      if (i === r.keys.length - 1 || uses.get(r.keys[i]) >= 2) {
        const pts = r.keys.slice(start, i + 1);
        edges.push({ a: pts[0], b: pts[pts.length - 1], pts, hw: r.hw, rank: r.rank, cls: r.cls, name: r.name, bridge: r.bridge });
        start = i;
      }
    }
  }
}
const coords = (e) => e.pts.map((k) => pos.get(k));
const edgeLength = (e) => polyLength(coords(e));

/** Split edge e at segment i, fraction t; returns the new node key. Mutates `edges`. */
function splitEdge(e, i, t, key) {
  const k = key ?? newKey(lerp2(pos.get(e.pts[i]), pos.get(e.pts[i + 1]), t));
  const first = { ...e, pts: [...e.pts.slice(0, i + 1), k] };
  const second = { ...e, pts: [k, ...e.pts.slice(i + 1)] };
  first.b = k;
  second.a = k;
  edges.splice(edges.indexOf(e), 1, first, second);
  return k;
}

// Every crossing at grade: where two streets cross without a shared node (one on a
// flyover), make it an intersection. Only the Moscoso bridge, over water, stays apart.
{
  const idx = new SegIndex(60);
  edges.forEach((e, ei) => {
    const c = coords(e);
    for (let i = 0; i < c.length - 1; i++) idx.add(c[i], c[i + 1], { ei, i });
  });
  const cuts = new Map();
  const addCut = (ei, i, t, key) => {
    if (!cuts.has(ei)) cuts.set(ei, []);
    cuts.get(ei).push({ i, t, key });
  };
  let n = 0;
  edges.forEach((e, ei) => {
    if (e.bridge) return;
    const c = coords(e);
    for (let i = 0; i < c.length - 1; i++) {
      for (const s of idx.near(lerp2(c[i], c[i + 1], 0.5), dist(c[i], c[i + 1]) / 2 + 1)) {
        if (s.data.ei <= ei || edges[s.data.ei].bridge) continue;
        const o = edges[s.data.ei];
        const shared = new Set([e.pts[i], e.pts[i + 1]]);
        if (shared.has(o.pts[s.data.i]) || shared.has(o.pts[s.data.i + 1])) continue;
        const hit = segIntersect(c[i], c[i + 1], s.a, s.b);
        if (!hit) continue;
        const key = newKey(lerp2(c[i], c[i + 1], hit[0]));
        addCut(ei, i, hit[0], key);
        addCut(s.data.ei, s.data.i, hit[1], key);
        n++;
      }
    }
  });
  const next = [];
  edges.forEach((e, ei) => {
    const list = (cuts.get(ei) ?? []).sort((p, q) => p.i - q.i || p.t - q.t);
    if (!list.length) return next.push(e);
    let pts = [e.pts[0]];
    let piece = [];
    let ci = 0;
    for (let i = 0; i < e.pts.length - 1; i++) {
      while (ci < list.length && list[ci].i === i) {
        pts.push(list[ci].key);
        piece.push(pts);
        pts = [list[ci].key];
        ci++;
      }
      pts.push(e.pts[i + 1]);
    }
    piece.push(pts);
    for (const p of piece) if (p.length >= 2 && p[0] !== p[p.length - 1]) next.push({ ...e, pts: p, a: p[0], b: p[p.length - 1] });
  });
  edges = next;
  console.log(`at-grade crossings added: ${n}`);
}

function degrees() {
  const deg = new Map();
  for (const e of edges) for (const k of [e.a, e.b]) deg.set(k, (deg.get(k) ?? 0) + 1);
  return deg;
}

// Streets that ended at a dropped carriageway or ramp, or just short of another street:
// join them to the nearest road.
{
  const deg = degrees();
  let joined = 0;
  for (const [k, d] of deg) {
    if (d !== 1) continue;
    const p = pos.get(k);
    const own = edges.find((e) => e.a === k || e.b === k);
    let best = null;
    for (const e of edges) {
      if (e === own || e.bridge) continue;
      const c = coords(e);
      for (let i = 0; i < c.length - 1; i++) {
        const [q, t, dd] = closestOnSeg(p, c[i], c[i + 1]);
        if (dd < Math.max(12, e.hw + 3) && (!best || dd < best.d)) best = { e, i, t, q, d: dd };
      }
    }
    if (!best) continue;
    // Away from the dead end's own direction is a different street: only join forward-ish.
    const c = coords(own);
    const tip = own.a === k ? c[0] : c[c.length - 1];
    const prev = own.a === k ? c[1] : c[c.length - 2];
    const fwd = [tip[0] - prev[0], tip[1] - prev[1]];
    const to = [best.q[0] - tip[0], best.q[1] - tip[1]];
    if (best.d > 3 && fwd[0] * to[0] + fwd[1] * to[1] < 0) continue;
    const ends = [best.e.a, best.e.b].map((x) => [x, dist(pos.get(x), best.q)]).sort((p, q) => p[1] - q[1]);
    const target = ends[0][1] < 4 ? ends[0][0] : splitEdge(best.e, best.i, best.t);
    if (own.a === k) {
      own.pts.unshift(target);
      own.a = target;
    } else {
      own.pts.push(target);
      own.b = target;
    }
    joined++;
  }
  console.log(`dead ends joined to nearby roads: ${joined}`);
}

// Merge intersections closer than 7 m (divided roads and slightly offset junctions).
{
  const keys = [...degrees().keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  const grid = new Map();
  for (const k of keys) {
    const p = pos.get(k);
    const g = `${Math.floor(p[0] / 7)},${Math.floor(p[1] / 7)}`;
    if (!grid.has(g)) grid.set(g, []);
    grid.get(g).push(k);
  }
  for (const k of keys) {
    const p = pos.get(k);
    const gx = Math.floor(p[0] / 7);
    const gz = Math.floor(p[1] / 7);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) {
      for (const o of grid.get(`${i},${j}`) ?? []) if (o !== k && dist(p, pos.get(o)) < 7) parent.set(find(o), find(k));
    }
  }
  const groups = new Map();
  for (const k of keys) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  for (const [root, ks] of groups) {
    if (ks.length < 2) continue;
    const c = ks.reduce((s, k) => [s[0] + pos.get(k)[0] / ks.length, s[1] + pos.get(k)[1] / ks.length], [0, 0]);
    pos.set(root, c);
  }
  const map = (k) => (parent.has(k) ? find(k) : k);
  edges = edges
    .map((e) => {
      const pts = e.pts.map((k, i) => (i === 0 || i === e.pts.length - 1 ? map(k) : k));
      return { ...e, pts, a: pts[0], b: pts[pts.length - 1] };
    })
    .filter((e) => e.a !== e.b || edgeLength(e) > 40);
}

// Loops (a street leaving and rejoining one intersection) become two edges.
edges = edges.flatMap((e) => {
  if (e.a !== e.b) return [e];
  const mid = Math.floor(e.pts.length / 2);
  const k = mid > 0 && mid < e.pts.length - 1 ? e.pts[mid] : null;
  if (!k) return [];
  return [
    { ...e, pts: e.pts.slice(0, mid + 1), b: k },
    { ...e, pts: e.pts.slice(mid), a: k },
  ];
});

// The police HQ block: no real street may run through it.
const STATION_RECT = { x0: 108, x1: 192, z0: 100, z1: 200 };
const inRect = (p, r, m = 0) => p[0] > r.x0 - m && p[0] < r.x1 + m && p[1] > r.z0 - m && p[1] < r.z1 + m;
edges = edges.filter((e) => /Ponce de Le/.test(e.name) || !coords(e).some((p) => inRect(p, STATION_RECT)));

/** Join chains through nodes with exactly two edges (keeping bridge ends and `pinned` nodes). */
function mergeChains(pinned = new Set()) {
  for (;;) {
    const ends = new Map();
    for (const e of edges) for (const k of [e.a, e.b]) {
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(e);
    }
    let changed = false;
    for (const [k, list] of ends) {
      if (list.length !== 2 || list[0] === list[1] || pinned.has(k)) continue;
      const [e1, e2] = list;
      if (e1.bridge !== e2.bridge) continue;
      const p1 = e1.b === k ? e1.pts : [...e1.pts].reverse();
      const p2 = e2.a === k ? e2.pts : [...e2.pts].reverse();
      if (p1[0] === p2[p2.length - 1]) continue; // would close a loop
      const pts = [...p1, ...p2.slice(1)];
      const longer = edgeLength(e1) >= edgeLength(e2) ? e1 : e2;
      const merged = { ...longer, pts, a: pts[0], b: pts[pts.length - 1], hw: Math.max(e1.hw, e2.hw), rank: Math.min(e1.rank, e2.rank) };
      edges.splice(edges.indexOf(e1), 1, merged);
      edges.splice(edges.indexOf(e2), 1);
      changed = true;
      break;
    }
    if (!changed) return;
  }
}

/** Keep only the network connected to the expressway. */
function largestComponent() {
  const adj = new Map();
  for (const e of edges) for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push(v);
  }
  const seen = new Map();
  let best = null;
  let bestSize = 0;
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const comp = [s];
    seen.set(s, s);
    for (let i = 0; i < comp.length; i++) for (const v of adj.get(comp[i])) if (!seen.has(v)) {
      seen.set(v, s);
      comp.push(v);
    }
    if (comp.length > bestSize) {
      bestSize = comp.length;
      best = s;
    }
  }
  edges = edges.filter((e) => seen.get(e.a) === best);
}

/** Remove short dead-end stubs. */
function pruneStubs(minLen) {
  for (let pass = 0; pass < 3; pass++) {
    const deg = degrees();
    edges = edges.filter((e) => !((deg.get(e.a) === 1 || deg.get(e.b) === 1) && edgeLength(e) < minLen && !e.bridge));
  }
}

largestComponent();
pruneStubs(25);
mergeChains();
// Parallel duplicates (both directions of a short divided stretch): keep one.
{
  const seen = new Map();
  edges = edges.filter((e) => {
    const k = [e.a, e.b].sort().join('|');
    const len = edgeLength(e);
    const prev = seen.get(k);
    if (prev && Math.abs(prev - len) < Math.max(8, len * 0.15)) return false;
    seen.set(k, len);
    return true;
  });
}
mergeChains();

// Debug: MAP_DEBUG=file.json dumps the street graph before the set pieces are placed.
if (process.env.MAP_DEBUG) {
  writeFileSync(process.env.MAP_DEBUG, JSON.stringify(edges.map((e) => ({ n: e.name, r: e.rank, w: e.hw, br: e.bridge, p: coords(e).map((p) => p.map(round1)) }))));
}

// ---------------------------------------------------------------- set pieces on the graph

function nodeEdges(k) {
  return edges.filter((e) => e.a === k || e.b === k);
}
/** The intersection where streets named like `a` and `b` meet (closest to `near` if several). */
function junction(a, b, near) {
  const ra = new RegExp(a);
  const rb = new RegExp(b);
  let best = null;
  for (const k of degrees().keys()) {
    const es = nodeEdges(k);
    if (!es.some((e) => ra.test(e.name)) || !es.some((e) => rb.test(e.name))) continue;
    const d = near ? dist(pos.get(k), near) : 0;
    if (!best || d < best[1]) best = [k, d];
  }
  if (!best) throw new Error(`no junction of ${a} and ${b}`);
  return best[0];
}
/** Shortest path between nodes (by length): list of node keys. */
function shortestPath(from, to) {
  const adj = new Map();
  for (const e of edges) for (const [u, v] of [[e.a, e.b], [e.b, e.a]]) {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push([v, edgeLength(e)]);
  }
  const cost = new Map([[from, 0]]);
  const prev = new Map();
  const open = new Set([from]);
  while (open.size) {
    let u = null;
    for (const k of open) if (u === null || cost.get(k) < cost.get(u)) u = k;
    open.delete(u);
    if (u === to) break;
    for (const [v, w] of adj.get(u) ?? []) {
      const c = cost.get(u) + w;
      if (c < (cost.get(v) ?? Infinity)) {
        cost.set(v, c);
        prev.set(v, u);
        open.add(v);
      }
    }
  }
  if (!prev.has(to) && from !== to) throw new Error(`no path ${from} -> ${to}`);
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]));
  return path;
}
const edgeBetween = (u, v) => edges.filter((e) => (e.a === u && e.b === v) || (e.a === v && e.b === u)).sort((p, q) => edgeLength(p) - edgeLength(q))[0];
/** Polyline (coordinates) along a node path. */
function pathCoords(path) {
  const out = [pos.get(path[0])];
  for (let i = 0; i < path.length - 1; i++) {
    const e = edgeBetween(path[i], path[i + 1]);
    const c = coords(e);
    if (e.a !== path[i]) c.reverse();
    out.push(...c.slice(1));
  }
  return out;
}

// The bridge: its foot (the city end) and the swap point along it.
const bridgeEdges = edges.filter((e) => e.bridge);
if (!bridgeEdges.length) throw new Error('bridge not found');
const tollBooths = [...osmNodes.values()]
  .filter((n) => n.tags?.barrier === 'toll_booth' && regionOf(n.lon, n.lat) === 1)
  .map((n) => project(n.lon, n.lat, 1));
let foot;
let goal;
{
  const deg = degrees();
  const bridgeNodes = new Set(bridgeEdges.flatMap((e) => [e.a, e.b]));
  // The foot is the bridge end that joins the rest of the network.
  foot = [...bridgeNodes].find((k) => nodeEdges(k).some((e) => !e.bridge));
  // Walk out along the bridge to the swap point.
  let at = foot;
  let along = 0;
  for (;;) {
    const e = bridgeEdges.find((x) => (x.a === at || x.b === at) && !x.walked);
    if (!e) throw new Error('bridge shorter than the swap distance');
    e.walked = true;
    const c = coords(e);
    const forward = e.a === at;
    if (!forward) c.reverse();
    const len = polyLength(c);
    if (along + len < SWAP_ALONG_BRIDGE) {
      along += len;
      at = forward ? e.b : e.a;
      continue;
    }
    let s = along;
    for (let i = 0; i < c.length - 1; i++) {
      const l = dist(c[i], c[i + 1]);
      if (s + l >= SWAP_ALONG_BRIDGE) {
        const t = (SWAP_ALONG_BRIDGE - s) / l;
        const seg = forward ? i : e.pts.length - 2 - i;
        goal = splitEdge(e, seg, forward ? t : 1 - t);
        break;
      }
      s += l;
    }
    break;
  }
  for (const e of edges) delete e.walked;
  void deg;
}

// Mia's route: from the first intersection south of the station, through the planned turns, to the swap point.
const startNode = (() => {
  let best = null;
  for (const k of degrees().keys()) {
    const p = pos.get(k);
    if (Math.abs(p[0] - STATION_GAME.x) > 8 || p[1] < STATION_GAME.z + 15) continue;
    if (!best || p[1] < pos.get(best)[1]) best = k;
  }
  return best;
})();
const waypoints = [startNode];
for (const [a, b] of PLAN) waypoints.push(junction(a, b, pos.get(waypoints[waypoints.length - 1])));
waypoints.push(foot, goal);
let plan = [startNode];
for (let i = 0; i < waypoints.length - 1; i++) plan.push(...shortestPath(waypoints[i], waypoints[i + 1]).slice(1));
const planCoords = [[STATION_GAME.x, STATION_GAME.z + 8], ...pathCoords(plan)];
console.log(`Mia's route: ${plan.length} intersections, ${Math.round(polyLength(planCoords))} m`);

/** Point and unit tangent at arc length s along a polyline. */
function along(poly, s) {
  for (let i = 0; i < poly.length - 1; i++) {
    const l = dist(poly[i], poly[i + 1]);
    if (s <= l || i === poly.length - 2) {
      const t = Math.min(1, s / l);
      return { p: lerp2(poly[i], poly[i + 1], t), d: [(poly[i + 1][0] - poly[i][0]) / l, (poly[i + 1][1] - poly[i][1]) / l] };
    }
    s -= l;
  }
}
const spikes = along(planCoords, SPIKES_ALONG_ROUTE);

// The bank: on the corner where the route turns onto Avenida Mayagüez, on the far side
// of the turn (ahead and to the left), so a wide vault swing goes through it.
const bankCorner = waypoints[1];
let bank;
{
  const k = plan.indexOf(bankCorner);
  const before = pathCoords(plan.slice(Math.max(0, k - 1), k + 1));
  const c = pos.get(bankCorner);
  const back = along([...before].reverse(), 30).p;
  const inDir = [(c[0] - back[0]) / dist(c, back), (c[1] - back[1]) / dist(c, back)];
  const left = [inDir[1], -inDir[0]];
  const W = 44;
  const D = 40;
  const roadIdx = new SegIndex(40);
  for (const e of edges) {
    const cc = coords(e);
    for (let i = 0; i < cc.length - 1; i++) roadIdx.add(cc[i], cc[i + 1], e);
  }
  const corners = (x0, z0) => [[x0, z0], [x0 + W, z0], [x0 + W, z0 + D], [x0, z0 + D]].map(([x, z]) => [c[0] + left[0] * x + inDir[0] * z, c[1] + left[1] * x + inDir[1] * z]);
  const clearance = (poly) => {
    let worst = Infinity;
    for (let i = 0; i < 4; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      for (let s = 0; s <= 1; s += 0.05) {
        const p = lerp2(a, b, s);
        for (const seg of roadIdx.near(p, 30)) worst = Math.min(worst, closestOnSeg(p, seg.a, seg.b)[2] - seg.data.hw);
      }
    }
    const mid = lerp2(poly[0], poly[2], 0.5);
    for (const seg of roadIdx.near(mid, 40)) if (pointInPoly(seg.a, poly)) worst = -1;
    return worst;
  };
  for (let sum = 8; sum < 90 && !bank; sum += 1) {
    for (let x0 = 4; x0 <= sum - 4 && !bank; x0++) {
      const poly = corners(x0, sum - x0);
      if (clearance(poly) >= 3.5) bank = { poly, heading: Math.atan2(inDir[0], inDir[1]), x0, z0: sum - x0 };
    }
  }
  if (!bank) throw new Error('no room for the bank');
  console.log(`bank: ${bank.x0} m left and ${bank.z0} m past the corner`);
}

// ---------------------------------------------------------------- buildings and land

const roadIdx = new SegIndex(40);
for (const e of edges) {
  const c = coords(e);
  for (let i = 0; i < c.length - 1; i++) roadIdx.add(c[i], c[i + 1], e);
}
const BANK_RECT_POLY = bank.poly;
/** Room kept clear beyond each road's half width: sidewalks on the avenues, a curb elsewhere. */
const sidewalk = (e) => (e.rank <= 3 ? 2.5 : 0.8);

function wayPolygon(w) {
  if (w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) return null;
  const ll = w.nodes.slice(0, -1).map((id) => osmNodes.get(id));
  if (ll.some((n) => !n)) return null;
  const r = regionOf(ll[0].lon, ll[0].lat);
  if (r < 0 || ll.some((n) => regionOf(n.lon, n.lat) !== r)) return null;
  let poly = ll.map((n) => project(n.lon, n.lat, r));
  poly = simplify([...poly, poly[0]], 0.3).slice(0, -1);
  if (poly.length < 3) return null;
  if (signedArea(poly) < 0) poly.reverse();
  return poly;
}

function heightOf(t, area, id) {
  const h = parseFloat(t.height);
  if (h > 0) return h;
  const levels = parseFloat(t['building:levels']);
  if (levels > 0) return levels * 3.2 + 1;
  const r = ((id * 2654435761) % 1000) / 1000;
  if (area > 3000) return 12 + r * 18;
  if (area > 600) return 7 + r * 9;
  return 4 + r * 4;
}

/** A segment's road band (half width r) as a closed ring: a rectangle with pointed ends standing in for round caps. */
function roadBand(a, b, r) {
  const d = dist(a, b) || 1;
  const t = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
  const n = [-t[1], t[0]];
  const p = (base, ut, un) => [base[0] + t[0] * ut + n[0] * un, base[1] + t[1] * ut + n[1] * un];
  const ring = [p(a, 0, r), p(a, -r * 0.7, r * 0.7), p(a, -r, 0), p(a, -r * 0.7, -r * 0.7), p(a, 0, -r), p(b, 0, -r), p(b, r * 0.7, -r * 0.7), p(b, r, 0), p(b, r * 0.7, r * 0.7), p(b, 0, r)];
  if (signedArea(ring) < 0) ring.reverse();
  return [...ring, ring[0]];
}

const buildings = [];
let droppedForRoads = 0;
let trimmed = 0;
for (const w of osmWays.values()) {
  const t = w.tags ?? {};
  if (!t.building || t.building === 'roof' || t.building === 'construction') continue;
  const poly = wayPolygon(w);
  if (!poly) continue;
  const area = signedArea(poly);
  if (area < 12) continue;
  if (poly.some((p) => inRect(p, STATION_RECT, 2) || pointInPoly(p, BANK_RECT_POLY)) || BANK_RECT_POLY.some((p) => pointInPoly(p, poly))) continue;
  // Off the street and its sidewalk: our streets are a little wider than the real ones, so
  // front walls that would stand in them are cut back to the sidewalk.
  const hits = new Set();
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(dist(a, b) / 2));
    for (let s = 0; s <= n; s++) {
      const p = lerp2(a, b, s / n);
      for (const seg of roadIdx.near(p, 25)) if (closestOnSeg(p, seg.a, seg.b)[2] < seg.data.hw + sidewalk(seg.data)) hits.add(seg);
    }
  }
  let kept = poly;
  if (hits.size) {
    const bands = [...hits].map((seg) => roadBand(seg.a, seg.b, seg.data.hw + sidewalk(seg.data)));
    const rest = polygonClipping.difference([[...poly, poly[0]]], ...bands.map((b) => [b]));
    // The biggest piece left, if it's still a building.
    const pieces = rest.map((pp) => pp[0].slice(0, -1)).filter((r) => r.length >= 3);
    const best = pieces.sort((p, q) => Math.abs(signedArea(q)) - Math.abs(signedArea(p)))[0];
    if (!best || Math.abs(signedArea(best)) < Math.max(25, area * 0.35)) {
      droppedForRoads++;
      continue;
    }
    kept = simplify([...best, best[0]], 0.3).slice(0, -1);
    if (signedArea(kept) < 0) kept.reverse();
    trimmed++;
  }
  buildings.push({ poly: kept, h: heightOf(t, area, w.id), kind: t.building, id: w.id });
}
console.log(`buildings: ${buildings.length} (${trimmed} cut back to the sidewalk, ${droppedForRoads} dropped standing in a street)`);

const AREA_KIND = (t) =>
  t.landuse === 'grass' || t.landuse === 'forest' || t.landuse === 'meadow' || t.landuse === 'recreation_ground' || t.leisure === 'park' || t.leisure === 'garden' ||
  t.leisure === 'pitch' || t.natural === 'wood' || t.natural === 'scrub' || t.natural === 'grassland'
    ? 'green'
    : t.amenity === 'parking'
      ? 'lot'
      : null;
const areas = [];
for (const w of osmWays.values()) {
  const kind = AREA_KIND(w.tags ?? {});
  if (!kind) continue;
  const poly = wayPolygon(w);
  if (poly && signedArea(poly) > 40) areas.push({ kind, poly });
}

// Land and water. The two regions are what you can drive; around them an apron of land
// (filled with distant city at runtime) to the west and south, and open water to the
// north-east beyond the lagoon, so the bridge crosses into a bay.
const rect = (lon0, lon1, lat0, lat1, r) => [[[lon0, lat0], [lon1, lat0], [lon1, lat1], [lon0, lat1], [lon0, lat0]].map(([lon, lat]) => project(lon, lat, r))];
const [A, B] = REGIONS;
const playArea = polygonClipping.union(rect(A.lon[0], A.lon[1], A.lat[0], A.lat[1], 0), rect(B.lon[0], B.lon[1], B.lat[0], B.lat[1], 1));
const apron = polygonClipping.union(
  playArea,
  rect(A.lon[0] - 0.025, A.lon[1], A.lat[0] - 0.02, A.lat[1] + 0.02, 0),
  rect(B.lon[0], B.lon[1] + 0.03, B.lat[0] - 0.02, B.lat[0], 1),
);
const lagoonRing = clipRing(lagoon, B).map(([lon, lat]) => project(lon, lat, 1));
const waterGeom = polygonClipping.union(
  [[...lagoonRing, lagoonRing[0]]],
  rect(B.lon[0], B.lon[1], B.lat[1], B.lat[1] + 0.06, 1),
  rect(B.lon[1], B.lon[1] + 0.06, 18.414, B.lat[1] + 0.06, 1),
);
const land = polygonClipping.difference(apron, waterGeom);
/** The edge of what you can drive: region borders and the lagoon shore. */
const walls = polygonClipping.difference(playArea, waterGeom).flat();

// ---------------------------------------------------------------- write

const nodeKeys = [...degrees().keys()];
const nodeIndex = new Map(nodeKeys.map((k, i) => [k, i]));
const flat = (pts) => pts.flatMap((p) => [round1(p[0]), round1(p[1])]);
const out = {
  attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)',
  source: 'Hato Rey and the Teodoro Moscoso Bridge, San Juan, Puerto Rico (tools/map)',
  nodes: flat(nodeKeys.map((k) => pos.get(k))),
  edges: edges.map((e) => ({
    a: nodeIndex.get(e.a),
    b: nodeIndex.get(e.b),
    w: round1(e.hw),
    r: e.rank,
    n: e.name,
    ...(e.bridge ? { br: 1 } : {}),
    p: flat(simplify(coords(e), 0.6)),
  })),
  buildings: buildings.map((b) => ({ h: round1(b.h), k: b.kind, p: flat(b.poly) })),
  areas: areas.map((a) => ({ k: a.kind, p: flat(a.poly) })),
  /** Land polygons, each [outer ring, ...holes] (rings closed); everything else is water. */
  land: land.map((poly) => poly.map(flat)),
  /** Closed rings bounding the drivable area. */
  walls: walls.map(flat),
  poi: {
    plan: plan.map((k) => nodeIndex.get(k)),
    foot: nodeIndex.get(foot),
    goal: nodeIndex.get(goal),
    spikes: { p: spikes.p.map(round1), d: spikes.d.map((v) => +v.toFixed(4)) },
    bank: { p: flat(bank.poly), heading: +bank.heading.toFixed(4), corner: nodeIndex.get(bankCorner) },
    tolls: flat(tollBooths),
  },
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`wrote ${OUT}: ${nodeKeys.length} intersections, ${edges.length} streets, ${buildings.length} buildings, ${areas.length} areas, ${kb} KB`);
