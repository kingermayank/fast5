import * as THREE from 'three';
import { Path } from './roads';
import { BRIDGE_FOOT, GOAL, MAP, type MapEdge, type MapNode, PLAN } from './roadmap';

/**
 * GTA-style navigation. The streets are a graph; the route is the cheapest way
 * from wherever the player is to the swap point, recomputed whenever they leave
 * it. Mia's planned route (past the spike strip and the bank) is discounted, so
 * it's the default, but any road that gets there works.
 */

/** Planned streets cost this fraction of their length, so the GPS prefers Mia's route. */
const PLAN_DISCOUNT = 0.25;
/**
 * Side streets cost more than their length (by rank): two cars abreast and a vault
 * fill a residential street wall to wall, so a new route goes back to the avenues.
 */
const RANK_COST: Record<number, number> = { 4: 1.25, 5: 1.7 };
/** Extra cost (meters) of turning at an intersection: with a vault in tow, straight is faster. */
const TURN_COST = 30;
/** How long the player must be off the route before it's recomputed (ignores brief wobbles). */
const OFF_ROUTE_DELAY = 0.5;
/** Cost (meters) of turning round. Real streets have long blocks, so after a spin it's often the best way. */
const U_TURN_COST = 80;

/** The intersection at the foot of the bridge. */
export const BRIDGE_FOOT_POS = BRIDGE_FOOT.pos;

const PLANNED = new Set<MapEdge>();
for (let k = 0; k < PLAN.length - 1; k++) {
  const e = MAP.between(PLAN[k], PLAN[k + 1]);
  if (e) PLANNED.add(e);
}

/** Within this distance of an intersection's center you're "in" it. */
const box = (n: MapNode) => Math.max(8, ...n.edges.map((e) => e.hw)) + 2;

/** Where the player is on the graph: inside an intersection, or on a street heading to one. */
interface Fix {
  /** The intersection they're in, or the one they're driving toward. */
  node: MapNode;
  /** The one behind them on this street (null when inside an intersection). */
  from: MapNode | null;
  /** The street they're on (or came in by, inside an intersection). */
  edge: MapEdge;
  inside: boolean;
}

function locate(p: THREE.Vector3, travel: THREE.Vector3, lastEdge: MapEdge | null): Fix | null {
  const fix = MAP.locate(p, travel);
  if (!fix) return null;
  const { edge } = fix;
  const node = fix.forward ? edge.b : edge.a;
  const from = fix.forward ? edge.a : edge.b;
  for (const n of [node, from]) {
    if (n.pos.distanceTo(p) < box(n)) {
      // Came in by the street we were last on, if it leads here.
      const via = lastEdge && (lastEdge.a === n || lastEdge.b === n) ? lastEdge : edge;
      return { node: n, from: null, edge: via, inside: true };
    }
  }
  return { node, from, edge, inside: false };
}

/** Turn cost between arriving along `inDir` and leaving along `outDir`. */
function turnCost(inDir: THREE.Vector3, outDir: THREE.Vector3): number {
  return inDir.dot(outDir) > 0.82 ? 0 : TURN_COST;
}

/**
 * Cheapest route to the swap point for a car on street `via`: either on to the
 * intersection ahead (`start`, `ahead` m away), or turning round to the one
 * behind. Returns the intersections and the streets into them.
 */
function shortestRoute(start: MapNode, via: MapEdge, ahead: number): { nodes: MapNode[]; edges: MapEdge[] } {
  // States: arriving at a node along an edge.
  type State = { node: MapNode; edge: MapEdge };
  const key = (s: State) => `${s.node.id}:${s.edge.id}`;
  const cost = new Map<string, number>();
  const prev = new Map<string, State | null>();
  const states = new Map<string, State>();
  const open = new Set<string>();
  const behind = MAP.other(via, start);
  // The street we're on costs what it would anywhere else on the route (Mia's streets are cheaper).
  const per = PLANNED.has(via) ? PLAN_DISCOUNT : (RANK_COST[via.rank] ?? 1);
  for (const [s0, c0] of [
    [{ node: start, edge: via }, ahead * per],
    [{ node: behind, edge: via }, Math.max(0, via.length - ahead) * per + U_TURN_COST],
  ] as const) {
    if (c0 >= (cost.get(key(s0)) ?? Infinity)) continue;
    cost.set(key(s0), c0);
    prev.set(key(s0), null);
    states.set(key(s0), s0);
    open.add(key(s0));
  }
  let found: State | null = null;
  while (open.size) {
    let bk = '';
    let bc = Infinity;
    for (const k of open) {
      const c = cost.get(k)!;
      if (c < bc) {
        bc = c;
        bk = k;
      }
    }
    open.delete(bk);
    const s = states.get(bk)!;
    if (s.node === GOAL) {
      found = s;
      break;
    }
    const inDir = MAP.arriving(s.edge, s.node);
    for (const e of s.node.edges) {
      const next = MAP.other(e, s.node);
      const turn = e === s.edge ? U_TURN_COST : turnCost(inDir, MAP.leaving(e, s.node));
      const c = bc + e.length * (PLANNED.has(e) ? PLAN_DISCOUNT : (RANK_COST[e.rank] ?? 1)) + turn;
      const t = { node: next, edge: e };
      const tk = key(t);
      if (c < (cost.get(tk) ?? Infinity)) {
        cost.set(tk, c);
        prev.set(tk, s);
        states.set(tk, t);
        open.add(tk);
      }
    }
  }
  if (!found) return { nodes: [start], edges: [via] };
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  for (let s: State | null = found; s; s = prev.get(key(s)) ?? null) {
    nodes.unshift(s.node);
    edges.unshift(s.edge);
  }
  return { nodes, edges };
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
  private ids: MapNode[] = [];
  /** edges[k] leads into ids[k] (edges[0] is the street we're on toward ids[0]). */
  private edges: MapEdge[] = [];
  private offFor = 0;
  private lastEdge: MapEdge | null = null;

  /** Call every frame with the player's position and direction of travel. */
  update(dt: number, p: THREE.Vector3, travel: THREE.Vector3): void {
    const fix = locate(p, travel, this.lastEdge);
    if (!fix) return;
    if (!fix.inside) this.lastEdge = fix.edge;
    if (!this.ids.length) {
      this.route(fix, p);
      return;
    }
    if (this.ids.length === 1 && this.ids[0] === GOAL) return;
    const k = this.ids.indexOf(fix.node);
    let onRoute: boolean;
    if (fix.inside) {
      // Working through an intersection on the route (skip any we somehow jumped past).
      // Off-route intersections aren't judged until they pick a street out of them.
      if (k > 0) {
        this.ids.splice(0, k);
        this.edges.splice(0, k);
      }
      onRoute = true;
    } else if (fix.edge === this.edges[0] || (k === 0 && MAP.other(this.edges[0], fix.node) === fix.from)) {
      // On the route's street, either way (turning round to follow it is fine).
      onRoute = true;
    } else if (k === 1 && fix.from === this.ids[0] && this.edges[1] === fix.edge) {
      // Through the last intersection the way the route said.
      this.ids.shift();
      this.edges.shift();
      onRoute = true;
    } else {
      onRoute = false;
    }
    this.offFor = onRoute ? 0 : this.offFor + dt;
    if (this.offFor > OFF_ROUTE_DELAY) {
      this.offFor = 0;
      const was = this.ids.slice(0, 2).map((n) => `${Math.round(n.pos.x)},${Math.round(n.pos.z)}`).join('>');
      this.log.push(`at ${Math.round(p.x)},${Math.round(p.z)} on ${fix.edge.name || 'a side street'} to ${Math.round(fix.node.pos.x)},${Math.round(fix.node.pos.z)} (route was ${was})`);
      if (this.log.length > 12) this.log.shift();
      this.route(fix, p);
      this.reroutes++;
      this.onReroute?.();
    }
    this.sync();
  }

  /**
   * The route ahead as a drivable polyline from `p`, along the streets: the whole
   * route as a line, picked up from the point on it nearest to `p` (looking only
   * near its start, so a route that doubles back can't confuse it).
   */
  path(p: THREE.Vector3): Path {
    const here = p.clone().setY(0);
    if (!this.ids.length) return new Path([here]);
    const pts: THREE.Vector3[] = [];
    const e0 = this.edges[0];
    const n0 = this.ids[0];
    if (e0 && (e0.a === n0 || e0.b === n0)) pts.push(...MAP.from(e0, MAP.other(e0, n0)).map((q) => q.clone()));
    else pts.push(n0.pos.clone());
    const near = pts.length;
    for (let k = 1; k < this.ids.length; k++) pts.push(...MAP.from(this.edges[k], this.ids[k - 1]).slice(1).map((q) => q.clone()));
    // Where we are: nearest point on the current street or the next few after it.
    let prefixEnd = near;
    let len = 0;
    for (let i = near; i < pts.length && len < 300; i++, prefixEnd = i) len += pts[i].distanceTo(pts[i - 1]);
    const s = new Path(pts.slice(0, Math.max(2, prefixEnd))).project(here);
    const full = new Path(pts);
    // From the middle of the street abreast of us (not from the car itself, so an offset
    // from the route is an offset from the street).
    const out = [full.at(s)];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      acc += pts[i].distanceTo(pts[i - 1]);
      if (acc > s + 0.5) out.push(pts[i]);
    }
    if (out.length === 1) out.push(full.at(full.length));
    return new Path(out);
  }

  /** The next intersection where the route turns, if any. */
  nextTurn(p: THREE.Vector3, travel: THREE.Vector3): Turn | null {
    if (!this.ids.length) return null;
    const full = this.path(p);
    let distance = full.project(this.ids[0].pos);
    void travel;
    for (let k = 0; k < this.ids.length - 1; k++) {
      const node = this.ids[k];
      const incoming = MAP.arriving(this.edges[k], node);
      const out = MAP.leaving(this.edges[k + 1], node);
      const cross = incoming.x * out.z - incoming.z * out.x;
      // Left of travel is +x when facing +z, which makes a left turn a negative cross product.
      if (Math.abs(cross) > 0.5 && incoming.dot(out) < 0.85) return { at: node.pos, side: cross < 0 ? 'left' : 'right', distance };
      distance += this.edges[k + 1].length;
    }
    return null;
  }

  /** Total driving distance left to the swap point (m). */
  remaining(p: THREE.Vector3): number {
    return this.path(p).length;
  }

  private route(fix: Fix, p: THREE.Vector3): void {
    // How far along the street the intersection ahead is (0 when already in one).
    const f = fix.inside ? null : MAP.locate(p, undefined, 30);
    const ahead = f && f.edge === fix.edge ? (fix.node === f.edge.b ? f.edge.length - f.s : f.s) : 0;
    const r = shortestRoute(fix.node, fix.edge, ahead);
    this.ids = r.nodes;
    this.edges = r.edges;
    this.sync();
  }

  private sync(): void {
    this.nodes = this.ids.map((n) => n.pos);
  }
}
