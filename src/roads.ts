import * as THREE from 'three';
import { MAP, type MapEdge, type MapNode } from './roadmap';

/**
 * The street network as the AI sees it: lines to drive along, intersections to
 * choose a way out of. Streets are the real ones (roadmap.ts), so they curve and
 * meet at any angle; directions are unit vectors along them.
 */

/** Left of a travel direction (the game's convention: left of +z is +x). */
export const leftOf = (d: THREE.Vector3) => new THREE.Vector3(d.z, 0, -d.x);

const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z).normalize();

/**
 * The direction of the street at p closest to heading v (v itself, flattened,
 * when off the road).
 */
export function roadDir(p: THREE.Vector3, v: THREE.Vector3): THREE.Vector3 {
  const fix = MAP.locate(p, v, 30);
  if (!fix || fix.dist > fix.edge.hw + 4) return flat(v);
  return fix.forward ? fix.tangent.clone() : fix.tangent.clone().negate();
}

/** Half width of the drivable road at this point. */
export function roadHalfWidth(p: THREE.Vector3): number {
  return MAP.halfWidthAt(p);
}

/** The point on the center line of the street a car at p heading d is on. */
export function streetCenter(p: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 {
  return MAP.locate(p, d)?.point ?? p.clone().setY(0);
}

/** The intersection a car at p heading d is driving toward: its node and the street it's on. */
function ahead(p: THREE.Vector3, d: THREE.Vector3): { node: MapNode; edge: MapEdge } | null {
  const fix = MAP.locate(p, d);
  if (!fix) return null;
  return { node: fix.forward ? fix.edge.b : fix.edge.a, edge: fix.edge };
}

/** Next intersection ahead of p along d, or null (a dead end, the end of the bridge). */
export function nextIntersection(p: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 | null {
  const a = ahead(p, d);
  if (!a || a.node.edges.length < 2) return null;
  return a.node.pos.clone();
}

/** The streets out of the intersection at c (directions), not counting the way you came in. */
function exitEdges(c: THREE.Vector3, arriving: THREE.Vector3): { edge: MapEdge; dir: THREE.Vector3 }[] {
  const node = MAP.nodeAt(c, 2);
  if (!node) return [];
  const out = node.edges.map((edge) => ({ edge, dir: MAP.leaving(edge, node) }));
  // The way back is the street most nearly opposite to how you're arriving.
  let back = -1;
  let worst = -0.6;
  out.forEach((o, i) => {
    const dot = o.dir.dot(arriving);
    if (dot < worst) {
      worst = dot;
      back = i;
    }
  });
  return out.filter((_, i) => i !== back);
}

/** Directions you can leave an intersection by (not counting a U-turn). */
export function exits(c: THREE.Vector3, arriving: THREE.Vector3): THREE.Vector3[] {
  return exitEdges(c, arriving).map((o) => o.dir);
}

/** A polyline path with arc-length lookups. */
export class Path {
  readonly points: THREE.Vector3[];
  private cum: number[] = [0];

  constructor(points: THREE.Vector3[]) {
    this.points = points;
    for (let i = 1; i < points.length; i++) this.cum.push(this.cum[i - 1] + points[i].distanceTo(points[i - 1]));
  }

  get length(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Arc length of the closest point on the path to `p`. */
  project(p: THREE.Vector3): number {
    let best = 0;
    let bestD = Infinity;
    const seg = new THREE.Vector3();
    const rel = new THREE.Vector3();
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      seg.subVectors(this.points[i + 1], a);
      const len2 = seg.lengthSq();
      if (len2 < 1e-6) continue;
      rel.subVectors(p, a);
      const t = THREE.MathUtils.clamp(rel.dot(seg) / len2, 0, 1);
      const q = a.clone().addScaledVector(seg, t);
      const d = q.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = this.cum[i] + t * Math.sqrt(len2);
      }
    }
    return best;
  }

  /** Point at arc length `s` (clamped to the path). */
  at(s: number): THREE.Vector3 {
    s = THREE.MathUtils.clamp(s, 0, this.length);
    for (let i = 0; i < this.points.length - 1; i++) {
      if (s <= this.cum[i + 1]) {
        const t = (s - this.cum[i]) / Math.max(1e-6, this.cum[i + 1] - this.cum[i]);
        return this.points[i].clone().lerp(this.points[i + 1], t);
      }
    }
    return this.points[this.points.length - 1].clone();
  }

  /** Unit direction of travel at arc length `s` (the end directions beyond the ends). */
  tangent(s: number): THREE.Vector3 {
    const c = THREE.MathUtils.clamp(s, 1, Math.max(1, this.length - 1));
    const a = this.at(c - 1);
    const b = this.at(c + 1);
    return b.sub(a).setY(0).normalize();
  }
}

/** Shift a polyline sideways by `offset` (positive = left of its direction of travel). */
export function offsetLine(pts: THREE.Vector3[], offset: number): THREE.Vector3[] {
  if (!offset || pts.length < 2) return pts.map((p) => p.clone());
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const t = b.clone().sub(a).setY(0).normalize();
    return p.clone().addScaledVector(leftOf(t), offset);
  });
}

/** The first `len` meters of a center line (extended straight if it's shorter). */
function firstMeters(pts: THREE.Vector3[], len: number): THREE.Vector3[] {
  const out = [pts[0].clone()];
  let left = len;
  for (let i = 1; i < pts.length && left > 0; i++) {
    const d = pts[i].distanceTo(pts[i - 1]);
    if (d >= left) {
      out.push(pts[i - 1].clone().lerp(pts[i], left / d));
      return out;
    }
    out.push(pts[i].clone());
    left -= d;
  }
  const n = out.length;
  const dir = n > 1 ? out[n - 1].clone().sub(out[n - 2]).normalize() : new THREE.Vector3(0, 0, 1);
  out.push(out[n - 1].clone().addScaledVector(dir, left));
  return out;
}

/**
 * The line a car follows from `p` heading `d`, keeping lateral offset `offset`
 * from the street's center line, through the next intersection (turning onto
 * the street leaving toward `exit` if given, else the straightest one) and on
 * for `tail` meters.
 */
export function lanePath(p: THREE.Vector3, d: THREE.Vector3, offset: number, corner: THREE.Vector3 | null, exit: THREE.Vector3 | null, tail = 70): Path {
  const fix = MAP.locate(p, d);
  if (!fix) {
    const l = leftOf(d);
    return new Path([p.clone().addScaledVector(l, offset).addScaledVector(d, -6), p.clone().addScaledVector(l, offset).addScaledVector(d, tail)]);
  }
  const { edge } = fix;
  // From 6 m behind us to the end of this street.
  const s0 = fix.forward ? Math.max(0, fix.s - 6) : Math.min(edge.length, fix.s + 6);
  const inPts = [MAP.pointAt(edge, s0)];
  if (fix.forward) {
    for (let i = 0; i < edge.pts.length; i++) if (edge.cum[i] > s0) inPts.push(edge.pts[i].clone());
  } else {
    for (let i = edge.pts.length - 1; i >= 0; i--) if (edge.cum[i] < s0) inPts.push(edge.pts[i].clone());
  }
  const node = fix.forward ? edge.b : edge.a;
  const arriving = MAP.arriving(edge, node);
  // Where we leave the intersection.
  let next: MapEdge | null = null;
  const options = node.edges.length > 1 ? exitEdges(node.pos, arriving) : [];
  if (options.length) {
    const want = corner && exit && corner.distanceTo(node.pos) < 3 ? exit : arriving;
    next = options.reduce((a, o) => (o.dir.dot(want) > a.dir.dot(want) ? o : a)).edge;
  }
  const inLine = offsetLine(inPts, offset);
  if (!next) {
    // Dead end: carry on straight.
    const n = inLine.length;
    const dir = inLine[n - 1].clone().sub(inLine[Math.max(0, n - 2)]).setY(0).normalize();
    inLine.push(inLine[n - 1].clone().addScaledVector(dir.lengthSq() > 0 ? dir : d, tail));
    return new Path(inLine);
  }
  const outLine = offsetLine(firstMeters(MAP.from(next, node), tail), offset);
  // Round the corner: cut both lines back from where they'd meet and join them with a curve.
  const d1 = arriving;
  const d2 = MAP.leaving(next, node);
  const a1 = node.pos.clone().addScaledVector(leftOf(d1), offset);
  const a2 = node.pos.clone().addScaledVector(leftOf(d2), offset);
  const cross = d1.x * d2.z - d1.z * d2.x;
  let apex: THREE.Vector3;
  if (Math.abs(cross) < 0.15) {
    apex = a1.clone().lerp(a2, 0.5);
  } else {
    // a1 + t d1 = a2 + u d2
    const t = ((a2.x - a1.x) * d2.z - (a2.z - a1.z) * d2.x) / cross;
    apex = a1.clone().addScaledVector(d1, THREE.MathUtils.clamp(t, -12, 12));
  }
  const inLen = new Path(inLine).length;
  const r = Math.max(2, Math.min(9, inLen * 0.4, tail * 0.4));
  const before = apex.clone().addScaledVector(d1, -r);
  const after = apex.clone().addScaledVector(d2, r);
  const pts: THREE.Vector3[] = [];
  for (const q of inLine) if (before.clone().sub(q).dot(d1) > 0.5) pts.push(q);
  if (!pts.length) pts.push(inLine[0]);
  const curve = new THREE.QuadraticBezierCurve3(before, apex, after);
  for (let k = 0; k <= 6; k++) pts.push(curve.getPoint(k / 6));
  for (const q of outLine) if (q.clone().sub(after).dot(d2) > 0.5) pts.push(q);
  return new Path(pts);
}

/**
 * Which way the route leaves `corner` for a car arriving along `dir`: toward
 * the route's next intersection if the corner is on the route, else the
 * straightest way on. `route` is the remaining intersections, next first.
 */
export function routeExit(corner: THREE.Vector3, dir: THREE.Vector3, route: THREE.Vector3[]): THREE.Vector3 | null {
  const options = exitEdges(corner, dir);
  if (!options.length) return null;
  const node = MAP.nodeAt(corner, 2);
  const k = route.findIndex((w) => w.distanceTo(corner) < 3);
  const next = k >= 0 ? route[k + 1] : undefined;
  if (node && next) {
    const target = MAP.nodeAt(next, 2);
    const o = options.find((x) => target && MAP.other(x.edge, node) === target);
    if (o) return o.dir.clone();
  }
  const straight = options.reduce((a, o) => (o.dir.dot(dir) > a.dir.dot(dir) ? o : a));
  return straight.dir.clone();
}

/**
 * Fastest safe speed (m/s) at arc length `s` on `path` for what's coming up:
 * for each bend in the next `lookahead` meters, the speed that keeps sideways
 * acceleration under `grip` m/s², plus what braking at `brake` m/s² can shed
 * before getting there.
 */
export function curveSpeed(path: Path, s: number, lookahead = 70, grip = 6, brake = 7): number {
  // Bend sharpness over a 30 m window: street center lines are polylines with small kinks
  // every few tens of meters, which a short window would read as tight corners.
  const W = 30;
  let v = Infinity;
  for (let d = 0; d <= lookahead; d += 6) {
    const t1 = path.tangent(s + d - W / 2);
    const t2 = path.tangent(s + d + W / 2);
    const angle = Math.acos(THREE.MathUtils.clamp(t1.dot(t2), -1, 1));
    if (angle < 0.03) continue;
    const vBend = Math.sqrt(grip / (angle / W));
    v = Math.min(v, Math.sqrt(vBend * vBend + 2 * brake * d));
  }
  return v;
}
