// The street map, read from the map.bin blob that tools/rive/pack-map.mjs
// writes from the OpenStreetMap data (© OpenStreetMap contributors, ODbL).
// Coordinates are metres on the ground plane: x east-ish, z north-ish.
import { clock } from "rive/os";

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
  /** Where the police lay the spike strip on Mia's route, and the way she sends you over it. */
  spikesX: f64 = 0;
  spikesZ: f64 = 0;
  spikesDX: f64 = 0;
  spikesDZ: f64 = 1;
  /** The bank's footprint (its near corner first), which way it faces, and the intersection it stands on. */
  bank: StaticArray<f64> = new StaticArray<f64>(0);
  bankHeading: f64 = 0;
  bankCorner: i32 = 0;
  /** The toll gantries on the bridge, as x z pairs. */
  tolls: StaticArray<f64> = new StaticArray<f64>(0);

  nodeX(i: i32): f64 {
    return this.nodes[i * 2];
  }

  nodeZ(i: i32): f64 {
    return this.nodes[i * 2 + 1];
  }
}

/**
 * Reads the map a slice at a time: a native runtime stops any script call
 * that runs past 200 ms, and reading it all at once comes close.
 */
export class MapLoader {
  r: Reader;
  map: MapData = new MapData();
  /** 0 header, 1 edges, 2 buildings, 3 areas, 4 land, 5 walls. */
  stage: i32 = 0;
  /** Items left in this stage. */
  left: i32 = 0;
  done: bool = false;
  failed: bool = false;

  constructor(bytes: ArrayBuffer) {
    this.r = new Reader(bytes);
  }

  /** Reads for about `budget` seconds; true once the whole map is in (or it failed). */
  step(budget: f64): bool {
    let start = clock();
    while (!this.done) {
      if (this.left == 0) {
        this.next();
        continue;
      }
      this.item();
      this.left--;
      if ((this.left & 31) == 0 && clock() - start > budget) return false;
    }
    return true;
  }

  progress(): f64 {
    return this.done ? 1 : <f64>this.r.i / <f64>this.r.u.length;
  }

  /** On to the next stage: its count, or the header before it, or the small tail after the last. */
  private next(): void {
    let r = this.r;
    let m = this.map;
    this.stage++;
    if (this.stage == 1) {
      if (r.word() != 0x504d3546 || r.word() != 2) {
        this.failed = true;
        this.done = true;
        return;
      }
      m.nodes = r.points();
      this.left = r.int();
    } else if (this.stage <= 5) {
      this.left = r.int();
    } else {
      let plan = r.int();
      for (let k = 0; k < plan; k++) m.plan.push(r.int());
      m.foot = r.int();
      m.goal = r.int();
      m.spikesX = r.num();
      m.spikesZ = r.num();
      m.spikesDX = r.num();
      m.spikesDZ = r.num();
      m.bank = r.points();
      m.bankHeading = r.num();
      m.bankCorner = r.int();
      m.tolls = r.points();
      this.done = true;
    }
  }

  private item(): void {
    let r = this.r;
    let m = this.map;
    if (this.stage == 1) {
      let e = new Edge();
      e.a = r.int();
      e.b = r.int();
      e.hw = r.num();
      e.rank = r.int();
      e.bridge = r.word() != 0;
      e.pts = r.points();
      m.edges.push(e);
    } else if (this.stage == 2) {
      let b = new Building();
      b.h = r.num();
      b.kind = r.int();
      b.pts = r.points();
      b.tris = r.tris();
      bounds(b);
      m.buildings.push(b);
    } else if (this.stage == 3) {
      let a = new Area();
      a.kind = r.int();
      a.pts = r.points();
      a.tris = r.tris();
      m.areas.push(a);
    } else if (this.stage == 4) {
      // A land polygon: its outer ring, then any holes (not drawn).
      let rings = r.int();
      for (let j = 0; j < rings; j++) {
        let ring = new Area();
        ring.pts = r.points();
        ring.tris = r.tris();
        if (j == 0) m.land.push(ring);
      }
    } else {
      m.walls.push(r.points());
    }
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
