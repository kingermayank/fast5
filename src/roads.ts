import * as THREE from 'three';
import { BRIDGE_X, PITCH, SEAWALL_Z, STREET_HALF } from './city';

/**
 * The street network as the AI sees it: a grid of streets at x = i*PITCH and
 * z = j*PITCH, plus the bridge running north from x = BRIDGE_X.
 */
const NX = 5;
const NZ = 7;
export const BRIDGE_HALF_WIDTH = 14;

/** The four travel directions. */
export const DIRS = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(-1, 0, 0)];

/** Left of a travel direction (the game's convention: left of +z is +x). */
export const leftOf = (d: THREE.Vector3) => new THREE.Vector3(d.z, 0, -d.x);

/** Snap a heading vector to the nearest grid direction. */
export function snapDir(v: THREE.Vector3): THREE.Vector3 {
  let best = DIRS[0];
  let bestDot = -Infinity;
  for (const d of DIRS) {
    const dot = d.x * v.x + d.z * v.z;
    if (dot > bestDot) {
      bestDot = dot;
      best = d;
    }
  }
  return best.clone();
}

export function onBridge(p: THREE.Vector3): boolean {
  return p.z > SEAWALL_Z - 5 && Math.abs(p.x - BRIDGE_X) < BRIDGE_HALF_WIDTH + 2;
}

/** Half width of the drivable road at this point (street or bridge). */
export function roadHalfWidth(p: THREE.Vector3): number {
  return onBridge(p) ? BRIDGE_HALF_WIDTH : STREET_HALF;
}

/**
 * Center line of the street a car at `p` travelling along `d` is on: the point
 * on that line nearest `p`.
 */
export function streetCenter(p: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 {
  if (onBridge(p)) return new THREE.Vector3(BRIDGE_X, 0, p.z);
  if (Math.abs(d.z) > 0.5) return new THREE.Vector3(Math.round(p.x / PITCH) * PITCH, 0, p.z);
  return new THREE.Vector3(p.x, 0, Math.round(p.z / PITCH) * PITCH);
}

/** Next intersection center ahead of `p` along `d`, or null (bridge, or the edge of town). */
export function nextIntersection(p: THREE.Vector3, d: THREE.Vector3): THREE.Vector3 | null {
  if (onBridge(p) && p.z > SEAWALL_Z) return null;
  const c = streetCenter(p, d);
  const along = d.x !== 0 ? c.x : c.z;
  const sign = d.x !== 0 ? Math.sign(d.x) : Math.sign(d.z);
  // Nearest grid line strictly ahead (with a little margin so we move on once past the center).
  const k = sign > 0 ? Math.floor((along + 2) / PITCH) + 1 : Math.ceil((along - 2) / PITCH) - 1;
  const v = k * PITCH;
  const result = d.x !== 0 ? new THREE.Vector3(v, 0, c.z) : new THREE.Vector3(c.x, 0, v);
  const i = Math.round(result.x / PITCH);
  const j = Math.round(result.z / PITCH);
  if (i < 0 || i > NX || j < 0 || j > NZ) return null;
  return result;
}

/** Directions you can leave an intersection by (not counting a U-turn). */
export function exits(c: THREE.Vector3, arriving: THREE.Vector3): THREE.Vector3[] {
  const i = Math.round(c.x / PITCH);
  const j = Math.round(c.z / PITCH);
  return DIRS.filter((d) => {
    if (d.x === -arriving.x && d.z === -arriving.z) return false;
    if (d.x > 0) return i < NX;
    if (d.x < 0) return i > 0;
    if (d.z > 0) return j < NZ || c.x === BRIDGE_X;
    return j > 0;
  }).map((d) => d.clone());
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

  /** Unit direction of travel at arc length `s`. */
  tangent(s: number): THREE.Vector3 {
    const a = this.at(s - 1);
    const b = this.at(s + 1);
    return b.sub(a).setY(0).normalize();
  }
}

/**
 * The line a car follows from `p` heading `d`, keeping lateral offset `offset`
 * from the street's center line, through the next intersection (turning onto
 * `exit` if given) and on for `tail` meters.
 */
export function lanePath(p: THREE.Vector3, d: THREE.Vector3, offset: number, corner: THREE.Vector3 | null, exit: THREE.Vector3 | null, tail = 70): Path {
  const center = streetCenter(p, d);
  const l1 = leftOf(d);
  const start = center.clone().addScaledVector(l1, offset).addScaledVector(d, -6);
  const pts: THREE.Vector3[] = [start];
  if (!corner || !exit || (exit.x === d.x && exit.z === d.z)) {
    const end = (corner ?? center).clone().addScaledVector(l1, offset);
    const dist = Math.max(0, (end.clone().sub(center)).dot(d));
    pts.push(center.clone().addScaledVector(l1, offset).addScaledVector(d, dist + tail));
    return new Path(pts);
  }
  const l2 = leftOf(exit);
  // Where the two offset lines cross, and a rounded corner through it.
  const apex = corner.clone().addScaledVector(l1, offset).addScaledVector(l2, offset);
  const r = 9;
  const before = apex.clone().addScaledVector(d, -r);
  const after = apex.clone().addScaledVector(exit, r);
  if (before.clone().sub(start).dot(d) > 0) pts.push(before);
  const curve = new THREE.QuadraticBezierCurve3(before, apex, after);
  for (let k = 1; k <= 6; k++) pts.push(curve.getPoint(k / 6));
  pts.push(after.clone().addScaledVector(exit, tail));
  return new Path(pts);
}

/**
 * Which way Mia's route leaves `corner` for a car arriving along `dir`, or
 * straight on if the route doesn't turn here. `route` is the remaining
 * waypoints, next first.
 */
export function routeExit(corner: THREE.Vector3, dir: THREE.Vector3, route: THREE.Vector3[]): THREE.Vector3 | null {
  const options = exits(corner, dir);
  let exit = options.find((e) => e.dot(dir) > 0.9) ?? null;
  const next = route.find((w) => w.distanceTo(corner) > 5);
  const routeHere = !!route[0] && route[0].distanceTo(corner) < 5;
  if (next) {
    const leg = next.clone().sub(corner);
    const lateral = Math.abs(leg.dot(leftOf(dir)));
    // Turn here if this corner is a waypoint, or the waypoint is level with it on a cross street.
    if (routeHere || (lateral > 5 && leg.dot(dir) < 5)) {
      const best = options.reduce((a, e) => (e.dot(leg) > a.dot(leg) ? e : a), options[0]);
      if (best && best.dot(leg) > 0) exit = best;
    }
  }
  return exit ?? options[0] ?? null;
}
