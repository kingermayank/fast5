// The street map, read from the map.bin blob that tools/rive/pack-map.mjs
// writes from the OpenStreetMap data (© OpenStreetMap contributors, ODbL).
// Coordinates are metres on the ground plane: x east-ish, z north-ish.

class Reader {
  u: Uint32Array;
  f: Float32Array;
  i: i32 = 0;

  constructor(bytes: ArrayBuffer) {
    this.u = Uint32Array.wrap(bytes);
    this.f = Float32Array.wrap(bytes);
  }

  word(): u32 {
    return this.u[this.i++];
  }

  int(): i32 {
    return <i32>this.u[this.i++];
  }

  num(): f64 {
    return <f64>this.f[this.i++];
  }

  /** A triangle count followed by 3 indices per triangle, two u16 to a word. */
  tris(): StaticArray<i32> {
    let t = this.int();
    let out = new StaticArray<i32>(t * 3);
    let words = (t * 3 + 1) / 2;
    for (let k = 0; k < words; k++) {
      let w = this.u[this.i++];
      out[k * 2] = <i32>(w & 0xffff);
      if (k * 2 + 1 < t * 3) out[k * 2 + 1] = <i32>(w >> 16);
    }
    return out;
  }

  /** A count followed by that many x z pairs, as a flat array. */
  points(): StaticArray<f64> {
    let n = this.int();
    let out = new StaticArray<f64>(n * 2);
    for (let k = 0; k < n * 2; k++) out[k] = <f64>this.f[this.i++];
    return out;
  }
}

export class Edge {
  a: i32 = 0;
  b: i32 = 0;
  /** Half width of the asphalt (m). */
  hw: f64 = 0;
  /** 1 expressway ... 6 lane. */
  rank: i32 = 0;
  bridge: bool = false;
  /** Centre line, x z pairs, from node a to node b. */
  pts: StaticArray<f64> = new StaticArray<f64>(0);
}

export class Building {
  h: f64 = 0;
  kind: i32 = 0;
  /** Footprint, x z pairs, wound so signedArea is positive (the packer does it). */
  pts: StaticArray<f64> = new StaticArray<f64>(0);
  /** The roof's triangles, as indices into pts (the packer triangulates). */
  tris: StaticArray<i32> = new StaticArray<i32>(0);
  minX: f64 = 0;
  minZ: f64 = 0;
  maxX: f64 = 0;
  maxZ: f64 = 0;
}

export class Area {
  /** 0 green, 1 lot. */
  kind: i32 = 0;
  pts: StaticArray<f64> = new StaticArray<f64>(0);
  tris: StaticArray<i32> = new StaticArray<i32>(0);
}

/** Building kinds, in tools/rive/pack-map.mjs order. */
export const KIND_YES = 0;
export const KIND_HOUSE = 1;
export const KIND_APARTMENTS = 2;
export const KIND_COMMERCIAL = 3;
export const KIND_RETAIL = 12;
export const KIND_OFFICE = 14;

export class MapData {
  nodes: StaticArray<f64> = new StaticArray<f64>(0);
  edges: Array<Edge> = [];
  buildings: Array<Building> = [];
  areas: Array<Area> = [];
  /** Land polygons (outer rings); outside them is the lagoon. */
  land: Array<Area> = [];
  walls: Array<StaticArray<f64>> = [];
  plan: Array<i32> = [];
  foot: i32 = 0;
  goal: i32 = 0;
  bank: StaticArray<f64> = new StaticArray<f64>(0);
  bankHeading: f64 = 0;

  nodeX(i: i32): f64 {
    return this.nodes[i * 2];
  }

  nodeZ(i: i32): f64 {
    return this.nodes[i * 2 + 1];
  }

  static parse(bytes: ArrayBuffer): MapData? {
    let r = new Reader(bytes);
    if (r.word() != 0x504d3546) return null;
    if (r.word() != 2) return null;
    let m = new MapData();
    m.nodes = r.points();

    let edges = r.int();
    for (let k = 0; k < edges; k++) {
      let e = new Edge();
      e.a = r.int();
      e.b = r.int();
      e.hw = r.num();
      e.rank = r.int();
      e.bridge = r.word() != 0;
      e.pts = r.points();
      m.edges.push(e);
    }

    let buildings = r.int();
    for (let k = 0; k < buildings; k++) {
      let b = new Building();
      b.h = r.num();
      b.kind = r.int();
      b.pts = r.points();
      b.tris = r.tris();
      bounds(b);
      m.buildings.push(b);
    }

    let areas = r.int();
    for (let k = 0; k < areas; k++) {
      let a = new Area();
      a.kind = r.int();
      a.pts = r.points();
      a.tris = r.tris();
      m.areas.push(a);
    }

    let land = r.int();
    for (let k = 0; k < land; k++) {
      let rings = r.int();
      for (let j = 0; j < rings; j++) {
        let ring = new Area();
        ring.pts = r.points();
        ring.tris = r.tris();
        if (j == 0) m.land.push(ring);
      }
    }

    let walls = r.int();
    for (let k = 0; k < walls; k++) m.walls.push(r.points());

    let plan = r.int();
    for (let k = 0; k < plan; k++) m.plan.push(r.int());
    m.foot = r.int();
    m.goal = r.int();
    r.num(); r.num(); r.num(); r.num(); // spikes
    m.bank = r.points();
    m.bankHeading = r.num();
    return m;
  }
}

function bounds(b: Building): void {
  b.minX = 1e9; b.minZ = 1e9; b.maxX = -1e9; b.maxZ = -1e9;
  for (let k = 0; k < b.pts.length; k += 2) {
    let x = b.pts[k], z = b.pts[k + 1];
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
}

// ------------------------------------------------------------ polygon helpers

/**
 * Twice the signed area in the x z plane. Footprints are stored with this
 * positive: then a roof triangle (a, b, c) faces up (+y) when wound as
 * stored, and an edge's outward normal is (-dz, dx).
 */
export function signedArea(p: StaticArray<f64>): f64 {
  let s: f64 = 0;
  let n = p.length / 2;
  for (let i = 0; i < n; i++) {
    let j = (i + 1) % n;
    s += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
  }
  return s;
}

export function reverse(p: StaticArray<f64>): void {
  let n = p.length / 2;
  for (let i = 0; i < n / 2; i++) {
    let j = n - 1 - i;
    let x = p[i * 2], z = p[i * 2 + 1];
    p[i * 2] = p[j * 2];
    p[i * 2 + 1] = p[j * 2 + 1];
    p[j * 2] = x;
    p[j * 2 + 1] = z;
  }
}

export function pointInPolygon(p: StaticArray<f64>, x: f64, z: f64): bool {
  let inside = false;
  let n = p.length / 2;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    let xi = p[i * 2], zi = p[i * 2 + 1];
    let xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) != (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    j = i;
  }
  return inside;
}

/** Ear clipping: triangle indices (into the polygon's points) for a simple polygon of positive winding. */
export function triangulate(p: StaticArray<f64>): Array<i32> {
  let n = p.length / 2;
  let out: Array<i32> = [];
  if (n < 3) return out;
  let idx: Array<i32> = [];
  for (let i = 0; i < n; i++) idx.push(i);
  let guard = 0;
  while (idx.length > 3 && guard < n * n) {
    guard++;
    let found = false;
    let m = idx.length;
    for (let k = 0; k < m; k++) {
      let ia = idx[(k + m - 1) % m], ib = idx[k], ic = idx[(k + 1) % m];
      let ax = p[ia * 2], az = p[ia * 2 + 1];
      let bx = p[ib * 2], bz = p[ib * 2 + 1];
      let cx = p[ic * 2], cz = p[ic * 2 + 1];
      // Convex corner (same orientation as the polygon: this is minus its signed area)?
      let cross = (cx - bx) * (az - bz) - (ax - bx) * (cz - bz);
      if (cross >= -1e-9) continue;
      let ear = true;
      for (let q = 0; q < m; q++) {
        let iq = idx[q];
        if (iq == ia || iq == ib || iq == ic) continue;
        if (inTriangle(p[iq * 2], p[iq * 2 + 1], ax, az, bx, bz, cx, cz)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push(ia);
      out.push(ib);
      out.push(ic);
      idx.splice(k, 1);
      found = true;
      break;
    }
    if (!found) break;
  }
  if (idx.length == 3) {
    out.push(idx[0]);
    out.push(idx[1]);
    out.push(idx[2]);
  } else if (idx.length > 3) {
    // Self-touching outline: fan the rest rather than leave a hole.
    for (let k = 1; k + 1 < idx.length; k++) {
      out.push(idx[0]);
      out.push(idx[k]);
      out.push(idx[k + 1]);
    }
  }
  return out;
}

function inTriangle(px: f64, pz: f64, ax: f64, az: f64, bx: f64, bz: f64, cx: f64, cz: f64): bool {
  let d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  let d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  let d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  let neg = d1 < 0 || d2 < 0 || d3 < 0;
  let pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
