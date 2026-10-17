// The city's static geometry, built once from the map: the lagoon and the land,
// parks and lots, sidewalks and asphalt, and every building (walls, parapet,
// flat roof, rooftop clutter). Triangles are bucketed into 256 m chunks so the
// renderer only draws what the camera (or the sun) can see.
import { clock } from "rive/os";
import { GpuMesh } from "./render";
import { MapData, Building, KIND_COMMERCIAL, KIND_RETAIL, KIND_HOUSE } from "./map";
import {
  MeshBuilder, packNormal, packColor, shade, hash, clamp, Rng, VERTEX_BYTES,
  ROLE_WALL, ROLE_SHOP, ROLE_ROOF, ROLE_ASPHALT, ROLE_CONCRETE, ROLE_GRASS, ROLE_WATER, ROLE_GROUND, ROLE_LINE, ROLE_MATTE,
} from "./util";

export const CHUNK: f64 = 256;

/** Growable list of u32. */
class U32List {
  data: Uint32Array = new Uint32Array(1024);
  length: i32 = 0;
  push(v: u32): void {
    if (this.length == this.data.length) {
      let next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

export class Chunk {
  first: i32 = 0;
  count: i32 = 0;
  minX: f64 = 1e9;
  minZ: f64 = 1e9;
  maxX: f64 = -1e9;
  maxZ: f64 = -1e9;
  maxY: f64 = 0;
  /** Drawn whatever the camera sees (land and water). */
  always: bool = false;

  grow(x: f64, z: f64, y: f64): void {
    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;
    if (y > this.maxY) this.maxY = y;
  }
}

/** Rio pastels for walls; concrete, tar and clay for roofs. */
const WALLS: StaticArray<u32> = [0xe8c39e, 0xd98f6a, 0xf2d7a7, 0xc9d6c2, 0xa9c5d6, 0xe6b8b0, 0xf0e2c8, 0xd8a65f, 0xb7c99a, 0xe9cfa0, 0xcfb8d8, 0xf3efe4, 0xe7a98a, 0x9fc4c0];
const TOWERS: StaticArray<u32> = [0x9fb0bb, 0x8a98a2, 0xc2bcb0, 0xd7d2c6, 0x7f8f99];
const ROOFS: StaticArray<u32> = [0x9a948c, 0x8b857c, 0xa79f93, 0x6d6862, 0xb8b0a2, 0x7a746c];
const CLAY: StaticArray<u32> = [0xb5653f, 0xa45a3a, 0xc07a4e];

export class CityMesh {
  mesh: MeshBuilder = new MeshBuilder();
  lists: Array<U32List> = [];
  chunks: Array<Chunk> = [];
  indexCount: i32 = 0;
  originX: f64 = -1600;
  originZ: f64 = -1600;
  cols: i32 = 24;
  rows: i32 = 24;
  up: u32 = packNormal(0, 1, 0);
  rng: Rng = new Rng(1234);

  constructor() {
    // Chunk 0 holds what is always drawn; the grid follows.
    for (let i = 0; i < 1 + this.cols * this.rows; i++) {
      this.lists.push(new U32List());
      this.chunks.push(new Chunk());
    }
    this.chunks[0].always = true;
  }

  chunkAt(x: f64, z: f64): i32 {
    let c = <i32>clamp(Math.floor((x - this.originX) / CHUNK), 0, <f64>(this.cols - 1));
    let r = <i32>clamp(Math.floor((z - this.originZ) / CHUNK), 0, <f64>(this.rows - 1));
    return 1 + r * this.cols + c;
  }

  tri(chunk: i32, a: u32, b: u32, c: u32): void {
    let l = this.lists[chunk];
    l.push(a);
    l.push(b);
    l.push(c);
  }

  quad(chunk: i32, a: u32, b: u32, c: u32, d: u32): void {
    this.tri(chunk, a, b, c);
    this.tri(chunk, a, c, d);
  }

  /** A flat polygon (positive winding, with its triangles) at height y. */
  flat(chunk: i32, pts: StaticArray<f64>, tris: StaticArray<i32>, y: f64, color: u32): void {
    let base = <u32>this.mesh.vertexCount;
    let ch = this.chunks[chunk];
    for (let k = 0; k < pts.length; k += 2) {
      this.mesh.vertex(pts[k], y, pts[k + 1], this.up, color);
      ch.grow(pts[k], pts[k + 1], y);
    }
    for (let k = 0; k + 2 < tris.length; k += 3) this.tri(chunk, base + <u32>tris[k], base + <u32>tris[k + 1], base + <u32>tris[k + 2]);
  }

  /** A ribbon of half width hw along a polyline, at height y, facing up. */
  ribbon(chunk: i32, pts: StaticArray<f64>, offset: f64, hw: f64, y: f64, color: u32): void {
    let n = pts.length / 2;
    if (n < 2) return;
    let ch = this.chunks[chunk];
    let first = <u32>this.mesh.vertexCount;
    for (let k = 0; k < n; k++) {
      let k0 = k > 0 ? k - 1 : k;
      let k1 = k < n - 1 ? k + 1 : k;
      // Direction in and out of this point, averaged for a mitred corner.
      let ax = pts[k * 2] - pts[k0 * 2], az = pts[k * 2 + 1] - pts[k0 * 2 + 1];
      let bx = pts[k1 * 2] - pts[k * 2], bz = pts[k1 * 2 + 1] - pts[k * 2 + 1];
      let la = Math.sqrt(ax * ax + az * az), lb = Math.sqrt(bx * bx + bz * bz);
      if (la > 1e-6) { ax /= la; az /= la; }
      if (lb > 1e-6) { bx /= lb; bz /= lb; }
      if (la <= 1e-6) { ax = bx; az = bz; }
      if (lb <= 1e-6) { bx = ax; bz = az; }
      let dx = ax + bx, dz = az + bz;
      let dl = Math.sqrt(dx * dx + dz * dz);
      if (dl < 1e-6) { dx = bx; dz = bz; dl = 1; }
      dx /= dl; dz /= dl;
      let sx = -dz, sz = dx;
      let miter = 1 / Math.max(0.35, sx * -bz + sz * bx);
      let px = pts[k * 2] + sx * offset, pz = pts[k * 2 + 1] + sz * offset;
      let lx = px + sx * hw * miter, lz = pz + sz * hw * miter;
      let rx = px - sx * hw * miter, rz = pz - sz * hw * miter;
      this.mesh.vertex(rx, y, rz, this.up, color);
      this.mesh.vertex(lx, y, lz, this.up, color);
      ch.grow(lx, lz, y);
      ch.grow(rx, rz, y);
    }
    for (let k = 0; k < n - 1; k++) {
      let r0 = first + <u32>(k * 2), l0 = r0 + 1, r1 = r0 + 2, l1 = r0 + 3;
      this.quad(chunk, r0, l0, l1, r1);
    }
  }

  disc(chunk: i32, x: f64, z: f64, r: f64, y: f64, color: u32): void {
    let ch = this.chunks[chunk];
    let center = this.mesh.vertex(x, y, z, this.up, color);
    let sides = 18;
    let first = <u32>this.mesh.vertexCount;
    for (let i = 0; i < sides; i++) {
      let t = 6.283185307179586 * <f64>i / <f64>sides;
      // Counter-clockwise seen from above is -t in x z.
      this.mesh.vertex(x + Math.cos(t) * r, y, z - Math.sin(t) * r, this.up, color);
    }
    for (let i = 0; i < sides; i++) this.tri(chunk, center, first + <u32>i, first + <u32>((i + 1) % sides));
    ch.grow(x - r, z - r, y);
    ch.grow(x + r, z + r, y);
  }

  /** A lit box on a roof or the ground (AC units, tanks, kiosks). */
  block(chunk: i32, x: f64, z: f64, y: f64, hx: f64, hz: f64, h: f64, yaw: f64, color: u32): void {
    let c = Math.cos(yaw), s = Math.sin(yaw);
    // Local x axis (c, -s), local z axis (s, c).
    let corners = new StaticArray<f64>(8);
    let sxs: StaticArray<f64> = [-1, 1, 1, -1];
    let szs: StaticArray<f64> = [-1, -1, 1, 1];
    for (let k = 0; k < 4; k++) {
      let lx = sxs[k] * hx, lz = szs[k] * hz;
      corners[k * 2] = x + lx * c + lz * s;
      corners[k * 2 + 1] = z - lx * s + lz * c;
    }
    let ch = this.chunks[chunk];
    // The corner order above is negative in our winding; walk it backwards.
    for (let k = 0; k < 4; k++) {
      let i = (4 - k) % 4, j = (3 - k + 4) % 4;
      let ax = corners[i * 2], az = corners[i * 2 + 1];
      let bx = corners[j * 2], bz = corners[j * 2 + 1];
      let dx = bx - ax, dz = bz - az;
      let len = Math.sqrt(dx * dx + dz * dz);
      let n = packNormal(-dz / len, 0, dx / len);
      let v0 = this.mesh.vertex(ax, y, az, n, color);
      let v1 = this.mesh.vertex(bx, y, bz, n, color);
      let v2 = this.mesh.vertex(bx, y + h, bz, n, color);
      let v3 = this.mesh.vertex(ax, y + h, az, n, color);
      this.quad(chunk, v0, v1, v2, v3);
    }
    let top = shade(color, 1.08);
    let t0 = this.mesh.vertex(corners[0], y + h, corners[1], this.up, top);
    let t3 = this.mesh.vertex(corners[6], y + h, corners[7], this.up, top);
    let t2 = this.mesh.vertex(corners[4], y + h, corners[5], this.up, top);
    let t1 = this.mesh.vertex(corners[2], y + h, corners[3], this.up, top);
    this.quad(chunk, t0, t3, t2, t1);
    ch.grow(x - hx - hz, z - hx - hz, y + h);
    ch.grow(x + hx + hz, z + hx + hz, y + h);
  }

  building(index: i32, b: Building): void {
    let p = b.pts;
    let n = p.length / 2;
    if (n < 3) return;
    let cx: f64 = 0, cz: f64 = 0;
    for (let k = 0; k < n; k++) {
      cx += p[k * 2];
      cz += p[k * 2 + 1];
    }
    cx /= <f64>n;
    cz /= <f64>n;
    let chunk = this.chunkAt(cx, cz);
    let ch = this.chunks[chunk];
    let h = Math.max(3.2, b.h);
    let tall = h > 30;
    let wall = tall ? TOWERS[<i32>(hash(index * 7 + 1) * <f64>TOWERS.length)] : WALLS[<i32>(hash(index * 7 + 1) * <f64>WALLS.length)];
    let shop = b.kind == KIND_COMMERCIAL || b.kind == KIND_RETAIL || (!tall && h >= 6 && hash(index * 13 + 5) < 0.3);
    let role = shop ? ROLE_SHOP : ROLE_WALL;
    let house = b.kind == KIND_HOUSE || h < 7;
    let roofColor = house ? CLAY[<i32>(hash(index * 3 + 2) * <f64>CLAY.length)] : ROOFS[<i32>(hash(index * 3 + 2) * <f64>ROOFS.length)];
    let parapet = house ? 0.25 : 0.7;
    let color = packColor(wall, role);
    let rim = packColor(shade(wall, 0.7), ROLE_MATTE);

    for (let i = 0; i < n; i++) {
      let j = (i + 1) % n;
      let ax = p[i * 2], az = p[i * 2 + 1];
      let bx = p[j * 2], bz = p[j * 2 + 1];
      let dx = bx - ax, dz = bz - az;
      let len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-4) continue;
      let out = packNormal(-dz / len, 0, dx / len);
      let v0 = this.mesh.vertex(ax, 0, az, out, color);
      let v1 = this.mesh.vertex(bx, 0, bz, out, color);
      let v2 = this.mesh.vertex(bx, h + parapet, bz, out, color);
      let v3 = this.mesh.vertex(ax, h + parapet, az, out, color);
      this.quad(chunk, v0, v1, v2, v3);
      // Inside face of the parapet, so the roof reads as sunk behind a rim.
      let inn = packNormal(dz / len, 0, -dx / len);
      let w0 = this.mesh.vertex(ax, h, az, inn, rim);
      let w1 = this.mesh.vertex(bx, h, bz, inn, rim);
      let w2 = this.mesh.vertex(bx, h + parapet, bz, inn, rim);
      let w3 = this.mesh.vertex(ax, h + parapet, az, inn, rim);
      this.quad(chunk, w1, w0, w3, w2);
      ch.grow(ax, az, h + parapet);
    }
    this.flat(chunk, p, b.tris, h, packColor(roofColor, ROLE_ROOF));

    // Rooftop clutter: AC units, stair heads and Rio's blue water tanks.
    let area = (b.maxX - b.minX) * (b.maxZ - b.minZ);
    if (area < 40) return;
    let tris = b.tris;
    if (tris.length < 3) return;
    let count = house ? 1 : 1 + <i32>(hash(index * 17 + 9) * Math.min(5, area / 300));
    for (let k = 0; k < count; k++) {
      let t = <i32>(this.rng.next() * <f64>(tris.length / 3)) * 3;
      let u = this.rng.next(), v = this.rng.next();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      let ia = tris[t], ib = tris[t + 1], ic = tris[t + 2];
      let x = p[ia * 2] + (p[ib * 2] - p[ia * 2]) * u + (p[ic * 2] - p[ia * 2]) * v;
      let z = p[ia * 2 + 1] + (p[ib * 2 + 1] - p[ia * 2 + 1]) * u + (p[ic * 2 + 1] - p[ia * 2 + 1]) * v;
      let kind = this.rng.next();
      if (house || kind < 0.3) {
        this.block(chunk, x, z, h, 0.55, 0.55, 1.1, this.rng.next() * 3, packColor(0x2f74c0, ROLE_MATTE));
      } else if (kind < 0.75) {
        this.block(chunk, x, z, h, 0.8 + this.rng.next(), 0.6 + this.rng.next() * 0.6, 1.0, this.rng.next() * 3, packColor(0xc9c6bf, ROLE_MATTE));
      } else {
        this.block(chunk, x, z, h, 1.6, 1.4, 2.6, this.rng.next() * 3, packColor(shade(wall, 0.92), ROLE_WALL));
      }
    }
  }

  // Incremental build: step() does as much as fits in a time budget and
  // returns true when done, so loading never stalls a frame (the native
  // runtimes stop any script call over 200 ms).
  stage: i32 = 0;
  item: i32 = 0;
  nodeHw: Float64Array = new Float64Array(0);
  done: bool = false;

  /** 0..1 */
  progress(map: MapData): f64 {
    let total = <f64>(map.areas.length + map.edges.length + this.nodeHw.length + map.buildings.length + 2);
    let at: f64 = 0;
    if (this.stage > 1) at += <f64>map.areas.length;
    if (this.stage > 2) at += <f64>map.edges.length;
    if (this.stage > 3) at += <f64>this.nodeHw.length;
    if (this.stage > 4) at += <f64>map.buildings.length;
    if (this.stage >= 1 && this.stage <= 4) at += <f64>this.item;
    return this.done ? 1 : at / total;
  }

  step(map: MapData, budget: f64): bool {
    if (this.done) return true;
    let start = clock();
    while (clock() - start < budget) {
      if (this.stage == 0) {
        // The lagoon under everything, then the land.
        let water = packColor(0x2b5e68, ROLE_WATER);
        let w0 = this.mesh.vertex(-3000, -0.5, -3000, this.up, water);
        let w1 = this.mesh.vertex(-3000, -0.5, 4500, this.up, water);
        let w2 = this.mesh.vertex(4500, -0.5, 4500, this.up, water);
        let w3 = this.mesh.vertex(4500, -0.5, -3000, this.up, water);
        this.quad(0, w0, w1, w2, w3);
        for (let k = 0; k < map.land.length; k++) this.flat(0, map.land[k].pts, map.land[k].tris, 0, packColor(0xa1978a, ROLE_GROUND));
        this.nodeHw = new Float64Array(map.nodes.length / 2);
        for (let k = 0; k < map.edges.length; k++) {
          let e = map.edges[k];
          if (e.hw > this.nodeHw[e.a]) this.nodeHw[e.a] = e.hw;
          if (e.hw > this.nodeHw[e.b]) this.nodeHw[e.b] = e.hw;
        }
        this.next();
      } else if (this.stage == 1) {
        // Parks and lots.
        if (this.item >= map.areas.length) { this.next(); continue; }
        let a = map.areas[this.item++];
        let chunk = this.chunkAt(a.pts[0], a.pts[1]);
        if (a.kind == 0) this.flat(chunk, a.pts, a.tris, 0.02, packColor(0x5d7f3c, ROLE_GRASS));
        else this.flat(chunk, a.pts, a.tris, 0.015, packColor(0x8d877e, ROLE_CONCRETE));
      } else if (this.stage == 2) {
        // Streets: sidewalk under, asphalt over, a double yellow line on the avenues.
        if (this.item >= map.edges.length) { this.next(); continue; }
        let e = map.edges[this.item++];
        let mid = (e.pts.length / 4) * 2;
        let chunk = this.chunkAt(e.pts[mid], e.pts[mid + 1]);
        if (!e.bridge) this.ribbon(chunk, e.pts, 0, e.hw + 2.6, 0.035, packColor(0xb9b2a7, ROLE_CONCRETE));
        this.ribbon(chunk, e.pts, 0, e.hw, 0.07, packColor(0x45474c, ROLE_ASPHALT));
        if (e.rank <= 3) {
          let yellow = packColor(0xe2bb3d, ROLE_LINE);
          this.ribbon(chunk, e.pts, 0.2, 0.07, 0.08, yellow);
          this.ribbon(chunk, e.pts, -0.2, 0.07, 0.08, yellow);
        }
      } else if (this.stage == 3) {
        // Discs to fill the junctions.
        if (this.item >= this.nodeHw.length) { this.next(); continue; }
        let i = this.item++;
        let hw = this.nodeHw[i];
        if (hw <= 0) continue;
        let x = map.nodeX(i), z = map.nodeZ(i);
        let chunk = this.chunkAt(x, z);
        this.disc(chunk, x, z, hw + 2.6, 0.036, packColor(0xb9b2a7, ROLE_CONCRETE));
        this.disc(chunk, x, z, hw + 0.2, 0.071, packColor(0x45474c, ROLE_ASPHALT));
      } else if (this.stage == 4) {
        if (this.item >= map.buildings.length) { this.next(); continue; }
        let k = this.item++;
        this.building(k, map.buildings[k]);
      } else {
        // One index buffer, chunk after chunk (filled straight from the lists in upload()).
        let at = 0;
        for (let i = 0; i < this.lists.length; i++) {
          this.chunks[i].first = at;
          this.chunks[i].count = this.lists[i].length;
          at += this.lists[i].length;
        }
        this.indexCount = at;
        this.done = true;
        return true;
      }
    }
    return false;
  }

  /** The GPU buffers: vertices in one go, indices chunk by chunk into their ranges. */
  upload(): GpuMesh {
    let gpu = new GpuMesh(<u32>this.mesh.vertexCount * VERTEX_BYTES, <u32>this.indexCount * 4);
    gpu.vbo.update(0, this.mesh.words.buffer, <u32>this.mesh.vertexCount * VERTEX_BYTES, 0);
    for (let i = 0; i < this.lists.length; i++) {
      let l = this.lists[i];
      if (l.length > 0) gpu.ibo.update(<u32>this.chunks[i].first * 4, l.data.buffer, <u32>l.length * 4, 0);
    }
    gpu.indexCount = <u32>this.indexCount;
    return gpu;
  }

  next(): void {
    this.stage++;
    this.item = 0;
  }
}
