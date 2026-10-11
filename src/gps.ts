import * as THREE from 'three';
import { BRIDGE_X, PITCH, ROUTE, SEAWALL_Z, STREET_HALF, SWAP_ZONE_Z } from './city';
import { DIRS, Path } from './roads';

/**
 * GTA-style navigation. The street grid is a graph; the route is the cheapest
 * way from wherever the player is to the swap point, recomputed whenever they
 * leave it. Mia's planned route (past the spike strip and the bank) is
 * discounted, so it's the default, but any road that gets there works.
 */

const NX = 5;
const NZ = 7;
/** Planned streets cost this fraction of their length, so the GPS prefers Mia's route. */
const PLAN_DISCOUNT = 0.25;
/** Extra cost (meters) of turning at an intersection: with a vault in tow, straight is faster. */
const TURN_COST = 30;
/** How long the player must be off the route before it's recomputed (ignores brief wobbles). */
const OFF_ROUTE_DELAY = 0.5;
/** Within this distance of an intersection's center you're "in" it. */
const BOX = STREET_HALF + 2;

const NODES: THREE.Vector3[] = [];
for (let i = 0; i <= NX; i++) for (let j = 0; j <= NZ; j++) NODES.push(new THREE.Vector3(i * PITCH, 0, j * PITCH));
const grid = (i: number, j: number) => i * (NZ + 1) + j;
/** The bridge on-ramp and the swap point at the far end. */
const RAMP = NODES.push(new THREE.Vector3(BRIDGE_X, 0, SEAWALL_Z + 150)) - 1;
const GOAL = NODES.push(new THREE.Vector3(BRIDGE_X, 0, SWAP_ZONE_Z)) - 1;
const BRIDGE_FOOT = grid(BRIDGE_X / PITCH, NZ);
/** The intersection at the foot of the bridge. */
export const BRIDGE_FOOT_POS = NODES[BRIDGE_FOOT];

/** Neighbors by direction index (DIRS: +z, +x, -z, -x); -1 = none. */
const LINKS: number[][] = NODES.map(() => [-1, -1, -1, -1]);
for (let i = 0; i <= NX; i++) {
  for (let j = 0; j <= NZ; j++) {
    const n = grid(i, j);
    if (j < NZ) LINKS[n][0] = grid(i, j + 1);
    if (i < NX) LINKS[n][1] = grid(i + 1, j);
    if (j > 0) LINKS[n][2] = grid(i, j - 1);
    if (i > 0) LINKS[n][3] = grid(i - 1, j);
  }
}
LINKS[BRIDGE_FOOT][0] = RAMP;
LINKS[RAMP][2] = BRIDGE_FOOT;
LINKS[RAMP][0] = GOAL;
LINKS[GOAL][2] = RAMP;

const nodeAt = (p: THREE.Vector3) => NODES.findIndex((n) => n.distanceToSquared(p) < 1);
const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Mia's plan as a set of graph edges: the street out of the station, then ROUTE. */
const PLANNED = new Set<string>();
{
  const plan = [new THREE.Vector3(200, 0, 200), ...ROUTE];
  for (let k = 0; k < plan.length - 1; k++) {
    let a = nodeAt(plan[k]);
    const b = nodeAt(plan[k + 1]);
    const d = plan[k + 1].clone().sub(plan[k]).normalize();
    const dir = DIRS.findIndex((x) => x.dot(d) > 0.9);
    while (a !== b && a >= 0 && dir >= 0) {
      const next = LINKS[a][dir];
      if (next < 0) break;
      PLANNED.add(edgeKey(a, next));
      a = next;
    }
  }
}

/** Where the player is on the graph: inside an intersection, or on a street heading to one. */
interface Fix {
  /** The intersection they're in, or the one they're driving toward. */
  node: number;
  /** The one behind them on this street (-1 when inside an intersection). */
  from: number;
  /** Direction of travel (index into DIRS). */
  dir: number;
  inside: boolean;
}

function dirIndex(v: THREE.Vector3): number {
  let best = 0;
  for (let k = 1; k < 4; k++) if (DIRS[k].dot(v) > DIRS[best].dot(v)) best = k;
  return best;
}

function locate(p: THREE.Vector3, travel: THREE.Vector3): Fix {
  // The bridge: a single road north.
  if (p.z > NZ * PITCH + BOX) {
    const north = travel.z >= 0;
    const ramp = NODES[RAMP];
    if (Math.abs(p.z - ramp.z) < BOX) return { node: RAMP, from: -1, dir: north ? 0 : 2, inside: true };
    if (north) return p.z < ramp.z ? { node: RAMP, from: BRIDGE_FOOT, dir: 0, inside: false } : { node: GOAL, from: RAMP, dir: 0, inside: false };
    return p.z > ramp.z ? { node: RAMP, from: GOAL, dir: 2, inside: false } : { node: BRIDGE_FOOT, from: RAMP, dir: 2, inside: false };
  }
  const i = THREE.MathUtils.clamp(Math.round(p.x / PITCH), 0, NX);
  const j = THREE.MathUtils.clamp(Math.round(p.z / PITCH), 0, NZ);
  const dx = Math.abs(p.x - i * PITCH);
  const dz = Math.abs(p.z - j * PITCH);
  if (dx < BOX && dz < BOX) return { node: grid(i, j), from: -1, dir: dirIndex(travel), inside: true };
  if (dx <= dz) {
    // A north-south street.
    const north = travel.z >= 0;
    const lo = THREE.MathUtils.clamp(Math.floor(p.z / PITCH), 0, NZ);
    const hi = THREE.MathUtils.clamp(lo + 1, 0, NZ);
    return north ? { node: grid(i, hi), from: grid(i, lo), dir: 0, inside: false } : { node: grid(i, lo), from: grid(i, hi), dir: 2, inside: false };
  }
  const east = travel.x >= 0;
  const lo = THREE.MathUtils.clamp(Math.floor(p.x / PITCH), 0, NX);
  const hi = THREE.MathUtils.clamp(lo + 1, 0, NX);
  return east ? { node: grid(hi, j), from: grid(lo, j), dir: 1, inside: false } : { node: grid(lo, j), from: grid(hi, j), dir: 3, inside: false };
}

/** Cheapest route from `start` (arriving along `dir`) to the swap point; no U-turns. */
function shortestRoute(start: number, dir: number): number[] {
  const S = NODES.length * 4;
  const cost = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const done = new Uint8Array(S);
  cost[start * 4 + dir] = 0;
  for (;;) {
    let s = -1;
    for (let k = 0; k < S; k++) if (!done[k] && cost[k] < Infinity && (s < 0 || cost[k] < cost[s])) s = k;
    if (s < 0) return [start];
    const node = s >> 2;
    const inDir = s & 3;
    if (node === GOAL) {
      const ids: number[] = [];
      for (let k = s; k >= 0; k = prev[k]) ids.unshift(k >> 2);
      return ids;
    }
    done[s] = 1;
    for (let d = 0; d < 4; d++) {
      const next = LINKS[node][d];
      if (next < 0 || d === (inDir + 2) % 4) continue;
      const len = NODES[node].distanceTo(NODES[next]) * (PLANNED.has(edgeKey(node, next)) ? PLAN_DISCOUNT : 1);
      const c = cost[s] + len + (d === inDir ? 0 : TURN_COST);
      const t = next * 4 + d;
      if (c < cost[t]) {
        cost[t] = c;
        prev[t] = s;
      }
    }
  }
}

export interface Turn {
  /** The intersection where the route turns. */
  at: THREE.Vector3;
  side: 'left' | 'right';
  /** Driving distance to it along the route (m). */
  distance: number;
}

export class Gps {
  /** Intersections still to drive through, next first; the last is the swap point. */
  nodes: THREE.Vector3[] = [];
  /** How many times the route was recomputed because the player took another way. */
  reroutes = 0;
  /** Called after a reroute (not the first route). */
  onReroute?: () => void;
  /** Recent reroutes, for debugging. */
  readonly log: string[] = [];
  private ids: number[] = [];
  private offFor = 0;

  /** Call every frame with the player's position and direction of travel. */
  update(dt: number, p: THREE.Vector3, travel: THREE.Vector3): void {
    const fix = locate(p, travel);
    if (!this.ids.length) {
      this.route(fix);
      return;
    }
    if (this.ids.length === 1 && this.ids[0] === GOAL) return;
    const k = this.ids.indexOf(fix.node);
    let onRoute: boolean;
    if (fix.inside) {
      // Working through an intersection on the route (skip any we somehow jumped past).
      // Off-route intersections aren't judged until they pick a street out of them.
      if (k > 0) this.ids.splice(0, k);
      onRoute = true;
    } else if (k === 0) {
      onRoute = true;
    } else if (k === 1 && fix.from === this.ids[0]) {
      // Through the last intersection the way the route said.
      this.ids.shift();
      onRoute = true;
    } else {
      onRoute = false;
    }
    this.offFor = onRoute ? 0 : this.offFor + dt;
    if (this.offFor > OFF_ROUTE_DELAY) {
      this.offFor = 0;
      const was = this.ids.slice(0, 2).map((n) => `${NODES[n].x},${NODES[n].z}`).join('>');
      this.log.push(`at ${Math.round(p.x)},${Math.round(p.z)} heading ${'NESW'[[0, 3, 2, 1][fix.dir]]} to ${NODES[fix.node].x},${NODES[fix.node].z} (route was ${was})`);
      if (this.log.length > 12) this.log.shift();
      this.route(fix);
      this.reroutes++;
      this.onReroute?.();
    }
    this.sync();
  }

  /** The route as a drivable polyline from `p`. */
  path(p: THREE.Vector3): Path {
    return new Path([p.clone().setY(0), ...this.nodes]);
  }

  /** The next intersection where the route turns, if any. */
  nextTurn(p: THREE.Vector3, travel: THREE.Vector3): Turn | null {
    let distance = p.distanceTo(this.nodes[0] ?? p);
    let incoming = this.nodes[0] ? DIRS[locate(p, travel).dir] : travel;
    for (let k = 0; k < this.nodes.length - 1; k++) {
      const out = this.nodes[k + 1].clone().sub(this.nodes[k]).normalize();
      const cross = incoming.x * out.z - incoming.z * out.x;
      // Left of travel is +x when facing +z, which makes a left turn a negative cross product.
      if (Math.abs(cross) > 0.5) return { at: this.nodes[k], side: cross < 0 ? 'left' : 'right', distance };
      distance += this.nodes[k].distanceTo(this.nodes[k + 1]);
      incoming = out;
    }
    return null;
  }

  /** Total driving distance left to the swap point (m). */
  remaining(p: THREE.Vector3): number {
    return this.path(p).length;
  }

  private route(fix: Fix): void {
    this.ids = shortestRoute(fix.node, fix.dir);
    this.sync();
  }

  private sync(): void {
    this.nodes = this.ids.map((n) => NODES[n]);
  }
}
