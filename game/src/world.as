// Static collision: building footprints in a uniform grid. Answers "which
// buildings are near this box", pushes points (cable strands) out of them, and
// casts rays for the drivers.
import { MapData, Building, pointInPolygon } from "./map";

/** Result of a closest-edge query. */
export class EdgeHit {
  /** Outward normal of the closest wall. */
  nx: f64 = 0;
  nz: f64 = 0;
  /** Distance from the point to that wall (m). */
  dist: f64 = 0;
  /** Closest point on the wall. */
  x: f64 = 0;
  z: f64 = 0;
}

export class StaticWorld {
  map: MapData;
  cell: f64 = 24;
  minX: f64 = 0;
  minZ: f64 = 0;
  cols: i32 = 0;
  rows: i32 = 0;
  /** Buildings per cell, flattened: cell c holds items[start[c] .. start[c + 1]). */
  start: Int32Array = new Int32Array(1);
  items: Int32Array = new Int32Array(0);
  stamp: Int32Array;
  query: i32 = 0;
  found: Array<i32> = [];
  hit: EdgeHit = new EdgeHit();

  constructor(map: MapData) {
    this.map = map;
    this.stamp = new Int32Array(map.buildings.length);
    let minX: f64 = 1e9, minZ: f64 = 1e9, maxX: f64 = -1e9, maxZ: f64 = -1e9;
    for (let i = 0; i < map.buildings.length; i++) {
      let b = map.buildings[i];
      if (b.minX < minX) minX = b.minX;
      if (b.minZ < minZ) minZ = b.minZ;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxZ > maxZ) maxZ = b.maxZ;
    }
    this.minX = minX - this.cell;
    this.minZ = minZ - this.cell;
    this.cols = <i32>Math.ceil((maxX - minX) / this.cell) + 2;
    this.rows = <i32>Math.ceil((maxZ - minZ) / this.cell) + 2;
    // Two passes, no per-cell arrays: count, then fill (thousands of small
    // allocations at load would make for a long collection pause).
    let cells = this.cols * this.rows;
    let count = new Int32Array(cells + 1);
    for (let pass = 0; pass < 2; pass++) {
      let fill = new Int32Array(cells);
      for (let i = 0; i < map.buildings.length; i++) {
        let b = map.buildings[i];
        let c0 = this.col(b.minX), c1 = this.col(b.maxX);
        let r0 = this.row(b.minZ), r1 = this.row(b.maxZ);
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            let cell = r * this.cols + c;
            if (pass == 0) count[cell + 1]++;
            else this.items[this.start[cell] + fill[cell]++] = i;
          }
        }
      }
      if (pass == 0) {
        for (let k = 0; k < cells; k++) count[k + 1] += count[k];
        this.start = count;
        this.items = new Int32Array(count[cells]);
      }
    }
  }

  col(x: f64): i32 {
    let c = <i32>Math.floor((x - this.minX) / this.cell);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  row(z: f64): i32 {
    let r = <i32>Math.floor((z - this.minZ) / this.cell);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  /** Buildings whose bounds overlap the rectangle, in `found`. */
  near(minX: f64, minZ: f64, maxX: f64, maxZ: f64): Array<i32> {
    this.query++;
    this.found.length = 0;
    let c0 = this.col(minX), c1 = this.col(maxX);
    let r0 = this.row(minZ), r1 = this.row(maxZ);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let cell = r * this.cols + c;
        let end = this.start[cell + 1];
        for (let k = this.start[cell]; k < end; k++) {
          let i = this.items[k];
          if (this.stamp[i] == this.query) continue;
          this.stamp[i] = this.query;
          let b = this.map.buildings[i];
          if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
          this.found.push(i);
        }
      }
    }
    return this.found;
  }

  /** Closest wall of building `b` to the point, into `hit`. */
  closestEdge(b: Building, x: f64, z: f64): EdgeHit {
    let p = b.pts;
    let n = p.length / 2;
    let best: f64 = 1e18;
    let h = this.hit;
    for (let i = 0; i < n; i++) {
      let j = (i + 1) % n;
      let ax = p[i * 2], az = p[i * 2 + 1];
      let dx = p[j * 2] - ax, dz = p[j * 2 + 1] - az;
      let len2 = dx * dx + dz * dz;
      if (len2 < 1e-9) continue;
      let t = ((x - ax) * dx + (z - az) * dz) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let cx = ax + dx * t, cz = az + dz * t;
      let d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 < best) {
        best = d2;
        let len = Math.sqrt(len2);
        h.nx = -dz / len;
        h.nz = dx / len;
        h.x = cx;
        h.z = cz;
      }
    }
    h.dist = Math.sqrt(best);
    return h;
  }

  /**
   * Pushes a point of radius r out of any building it is in or touching.
   * Returns true and leaves the push in `hit` (normal, depth in dist) when it moved.
   */
  pushOut(x: f64, z: f64, r: f64): bool {
    let list = this.near(x - r, z - r, x + r, z + r);
    for (let k = 0; k < list.length; k++) {
      let b = this.map.buildings[list[k]];
      let inside = pointInPolygon(b.pts, x, z);
      let e = this.closestEdge(b, x, z);
      if (inside) {
        e.dist = e.dist + r;
        return true;
      }
      if (e.dist < r) {
        // Outside but touching: push straight away from the closest point (round at corners).
        if (e.dist > 1e-6) {
          e.nx = (x - e.x) / e.dist;
          e.nz = (z - e.z) / e.dist;
        }
        e.dist = r - e.dist;
        return true;
      }
    }
    return false;
  }

  /** Distance along the ray to the first wall, or maxDist. */
  raycast(x: f64, z: f64, dx: f64, dz: f64, maxDist: f64): f64 {
    let ex = x + dx * maxDist, ez = z + dz * maxDist;
    let list = this.near(Math.min(x, ex), Math.min(z, ez), Math.max(x, ex), Math.max(z, ez));
    let best = maxDist;
    for (let k = 0; k < list.length; k++) {
      let b = this.map.buildings[list[k]];
      let p = b.pts;
      let n = p.length / 2;
      for (let i = 0; i < n; i++) {
        let j = (i + 1) % n;
        let ax = p[i * 2], az = p[i * 2 + 1];
        let sx = p[j * 2] - ax, sz = p[j * 2 + 1] - az;
        let den = dx * sz - dz * sx;
        if (Math.abs(den) < 1e-9) continue;
        let t = ((ax - x) * sz - (az - z) * sx) / den;
        let u = ((ax - x) * dz - (az - z) * dx) / den;
        if (t >= 0 && t < best && u >= 0 && u <= 1) best = t;
      }
    }
    return best;
  }
}
