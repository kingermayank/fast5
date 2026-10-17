import * as THREE from 'three';

/**
 * Building parts generated from footprints: pitched roofs, parapets,
 * balconies, awnings. Each returns plain non-indexed geometry for the city to
 * tint and batch. Footprints are rings of points on the ground (x, z), wound
 * so that (dz, -dx) along an edge points out of the building.
 */

/** The smallest rectangle round a footprint: centre, unit axes (`long` is the longer side), sizes. */
export interface Rect {
  center: THREE.Vector3;
  long: THREE.Vector3;
  short: THREE.Vector3;
  length: number;
  width: number;
  /** Footprint area over rectangle area: 1 for a rectangular house. */
  fill: number;
}

function hull(poly: THREE.Vector3[]): THREE.Vector3[] {
  const pts = [...poly].sort((a, b) => a.x - b.x || a.z - b.z);
  const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower: THREE.Vector3[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: THREE.Vector3[] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function area(poly: THREE.Vector3[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s / 2);
}

/** Minimum-area bounding rectangle (it lies along one of the convex hull's edges). */
export function orientedRect(poly: THREE.Vector3[]): Rect {
  const h = hull(poly);
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i];
    const b = h[(i + 1) % h.length];
    const ux = b.x - a.x;
    const uz = b.z - a.z;
    const len = Math.hypot(ux, uz);
    if (len < 1e-6) continue;
    const u = new THREE.Vector3(ux / len, 0, uz / len);
    const v = new THREE.Vector3(-u.z, 0, u.x);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of h) {
      const pu = p.x * u.x + p.z * u.z;
      const pv = p.x * v.x + p.z * v.z;
      u0 = Math.min(u0, pu);
      u1 = Math.max(u1, pu);
      v0 = Math.min(v0, pv);
      v1 = Math.max(v1, pv);
    }
    const a2 = (u1 - u0) * (v1 - v0);
    if (a2 >= bestArea) continue;
    bestArea = a2;
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    const center = new THREE.Vector3(u.x * cu + v.x * cv, 0, u.z * cu + v.z * cv);
    const [long, short, length, width] = u1 - u0 >= v1 - v0 ? [u, v, u1 - u0, v1 - v0] : [v, u, v1 - v0, u1 - u0];
    best = { center, long: long.clone(), short: short.clone(), length, width, fill: 0 };
  }
  if (!best) {
    const c = poly.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(poly.length);
    return { center: c, long: new THREE.Vector3(1, 0, 0), short: new THREE.Vector3(0, 0, 1), length: 0, width: 0, fill: 0 };
  }
  best.fill = area(poly) / Math.max(bestArea, 1e-6);
  return best;
}

/** Triangles as flat arrays, turned to face `want` (a direction the face should lean toward). */
class Tris {
  pos: number[] = [];
  uv: number[] = [];

  add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, want: THREE.Vector3, uv: (p: THREE.Vector3) => [number, number]): void {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(want) < 0) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.uv.push(...uv(p));
    }
  }

  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, want: THREE.Vector3, uv: (p: THREE.Vector3) => [number, number]): void {
    this.add(a, b, c, want, uv);
    this.add(a, c, d, want, uv);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    return g;
  }
}

/** One repeat of the roof tile texture covers this many metres. */
const TILE_REPEAT = 2;

/**
 * A pitched roof over a rectangle, on walls `h` m tall: a gable roof (ridge
 * along the long side, triangular wall ends) or a hip roof (sloping on all four
 * sides). The eaves overhang the walls. UVs run along the eaves and up the
 * slope, for a tile texture. `gables` (gable roofs only) is the wall infill,
 * with UVs at 0 so a facade texture shows plain wall.
 */
export function pitchedRoof(r: Rect, h: number, hip: boolean, slope = 0.62, overhang = 0.35): { roof: THREE.BufferGeometry; gables: THREE.BufferGeometry | null; ridge: number } {
  const { center: c, long: a, short: b } = r;
  const hl = r.length / 2;
  const hw = r.width / 2;
  const eave = h - overhang * slope;
  const ridge = h + hw * slope;
  const at = (u: number, v: number, y: number) => c.clone().addScaledVector(a, u).addScaledVector(b, v).setY(y);
  const E = (su: number, sv: number) => at(su * (hl + overhang), sv * (hw + overhang), eave);
  // A hip roof's ridge stops short of the ends by as much as the slope runs in from the sides.
  const end = hip ? Math.max(0, hl - hw) : hl + overhang;
  const R1 = at(-end, 0, ridge);
  const R2 = at(end, 0, ridge);
  const roof = new Tris();
  const up = new THREE.Vector3(0, 1, 0);
  // Tiles: across along the eave, courses counted up the slope from this face's eave.
  const k = Math.hypot(1, slope);
  const slopeUV = (eaveDir: THREE.Vector3, outward: THREE.Vector3, eavePt: THREE.Vector3) => (p: THREE.Vector3): [number, number] => {
    const along = p.x * eaveDir.x + p.z * eaveDir.z;
    const climb = ((eavePt.x - p.x) * outward.x + (eavePt.z - p.z) * outward.z) * k;
    return [along / TILE_REPEAT, climb / TILE_REPEAT];
  };
  for (const sv of [1, -1]) {
    const out = b.clone().multiplyScalar(sv);
    roof.quad(E(-1, sv), E(1, sv), R2, R1, up.clone().add(out), slopeUV(a, out, E(-1, sv)));
  }
  let gables: THREE.BufferGeometry | null = null;
  if (hip) {
    for (const su of [1, -1]) {
      const out = a.clone().multiplyScalar(su);
      roof.add(E(su, -1), E(su, 1), su > 0 ? R2 : R1, up.clone().add(out), slopeUV(b, out, E(su, -1)));
    }
  } else {
    const g = new Tris();
    for (const su of [1, -1]) {
      const out = a.clone().multiplyScalar(su);
      g.add(at(su * hl, -hw, h), at(su * hl, hw, h), at(su * hl, 0, ridge), out, () => [0, 0]);
    }
    gables = g.geometry();
  }
  return { roof: roof.geometry(), gables, ridge };
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * A box of `size` (along the wall, up, out from it) centred at `at`. Footprint
 * walls run so that `along` x up points into the building, so the box is built
 * on -along to keep its basis right-handed (a mirrored box renders inside out).
 */
function wallBox(at: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3, size: [number, number, number]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(...size).toNonIndexed();
  g.applyMatrix4(new THREE.Matrix4().makeBasis(along.clone().negate(), UP, out).setPosition(at));
  return g;
}

/** A balcony on a wall: a slab and a railing along its front, centred at `at` on the wall line, floor at `y`. */
export function balcony(at: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3, y: number, width: number, depth: number): { slab: THREE.BufferGeometry; rail: THREE.BufferGeometry } {
  return {
    slab: wallBox(at.clone().addScaledVector(out, depth / 2).setY(y), along, out, [width, 0.18, depth]),
    rail: wallBox(at.clone().addScaledVector(out, depth - 0.03).setY(y + 0.55), along, out, [width, 1, 0.06]),
  };
}

/**
 * A shop awning: striped canvas sloping out and down from the wall over a
 * doorway, with a short valance off its front edge. `scheme` (0 to 3) picks
 * the stripe colours from awningTexture's bands.
 */
export function awning(at: THREE.Vector3, along: THREE.Vector3, out: THREE.Vector3, width: number, scheme: number, top = 3.9, reach = 1.7, drop = 0.6): THREE.BufferGeometry {
  const t = new Tris();
  const hw = width / 2;
  const front = top - drop;
  const valance = 0.3;
  const p = (u: number, o: number, y: number) => at.clone().addScaledVector(along, u).addScaledVector(out, o).setY(y);
  // Band `scheme` of the texture (canvas row k*64 is v 1 - k/4 at its top, with flipY).
  const vTop = 1 - scheme / 4;
  const vBand = 0.25;
  const uv = (q: THREE.Vector3): [number, number] => {
    const u = ((q.x - at.x) * along.x + (q.z - at.z) * along.z + hw) / width;
    const o = (q.x - at.x) * out.x + (q.z - at.z) * out.z;
    // The slope uses the top three quarters of the band, the valance the rest.
    const v = o < reach - 1e-3 ? vTop - (o / reach) * vBand * 0.75 : vTop - vBand * 0.75 - ((front - q.y) / valance) * vBand * 0.25;
    return [u, v];
  };
  t.quad(p(-hw, 0, top), p(hw, 0, top), p(hw, reach, front), p(-hw, reach, front), UP.clone().add(out), uv);
  t.quad(p(-hw, reach, front), p(hw, reach, front), p(hw, reach, front - valance), p(-hw, reach, front - valance), out, uv);
  return t.geometry();
}

/**
 * A parapet round a flat roof: outer face (proud of the wall by `out`), top,
 * and inner face, so from above the roof reads as a tray with a rim.
 * UVs are 0 (plain colour).
 */
export function parapet(poly: THREE.Vector3[], h: number, rise = 0.7, thick = 0.3, out = 0.12): THREE.BufferGeometry {
  const t = new Tris();
  const zero = (): [number, number] => [0, 0];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.3) continue;
    const n = new THREE.Vector3(dz / len, 0, -dx / len);
    const ao = a.clone().addScaledVector(n, out);
    const bo = b.clone().addScaledVector(n, out);
    const ai = a.clone().addScaledVector(n, out - thick);
    const bi = b.clone().addScaledVector(n, out - thick);
    const y0 = h - 0.5;
    const y1 = h + rise;
    t.quad(ao.clone().setY(y0), bo.clone().setY(y0), bo.clone().setY(y1), ao.clone().setY(y1), n, zero);
    t.quad(ao.clone().setY(y1), bo.clone().setY(y1), bi.clone().setY(y1), ai.clone().setY(y1), new THREE.Vector3(0, 1, 0), zero);
    t.quad(ai.clone().setY(h), bi.clone().setY(h), bi.clone().setY(y1), ai.clone().setY(y1), n.clone().negate(), zero);
  }
  return t.geometry();
}
