// The street graph, and the GPS on it. Ported from the original game's
// roadmap.ts and gps.ts: where a car is on the streets, and the cheapest way
// from there to the swap point on the bridge, recomputed whenever the player
// leaves it. Mia's planned route (past the spike strip and the bank) is
// discounted so it's the default, but any road that gets there works.
import { MapData } from "./map";
import { clamp } from "./util";

const CELL: f64 = 32;
/** Planned streets cost this fraction of their length, so the GPS prefers Mia's route. */
const PLAN_DISCOUNT: f64 = 0.25;
/** Extra cost (m) of turning at an intersection: with a vault in tow, straight is faster. */
const TURN_COST: f64 = 30;
/** Cost (m) of turning round: real streets have long blocks, so after a spin it's often the best way. */
const U_TURN_COST: f64 = 80;
/** How long the player must be off the route before it's recomputed (ignores brief wobbles). */
const OFF_ROUTE_DELAY: f64 = 0.5;

/** Where a point is on the streets. */
export class RoadFix {
  edge: i32 = -1;
  /** Arc length of the closest centre-line point, from the edge's start. */
  s: f64 = 0;
  x: f64 = 0;
  z: f64 = 0;
  /** Unit direction of the street there, from its start toward its end. */
  tx: f64 = 0;
  tz: f64 = 1;
  /** Distance from the centre line. */
  dist: f64 = 0;
  /** Heading toward the edge's end (rather than its start). */
  forward: bool = true;
}

export class Roads {
  nodeCount: i32;
  nx: Float64Array;
  nz: Float64Array;
  /** Edges at each node: adj[adjStart[n] .. adjStart[n + 1]). */
  adjStart: Int32Array;
  adj: Int32Array;
  edgeCount: i32;
  ea: Int32Array;
  eb: Int32Array;
  hw: Float64Array;
  rank: Int32Array;
  bridge: Uint8Array;
  /** Centre lines (x z pairs from a to b, ends on the nodes) and their arc lengths. */
  pts: Array<Float64Array> = [];
  cum: Array<Float64Array> = [];
  len: Float64Array;
  /** The way out of an edge's ends, ~12 m down it: [2e] from a, [2e + 1] from b. */
  leaveX: Float64Array;
  leaveZ: Float64Array;
  // Street segments by cell: cell c holds segments seg[segStart[c] .. segStart[c + 1]), each edge << 12 | point.
  minX: f64 = 0;
  minZ: f64 = 0;
  cols: i32 = 0;
  rows: i32 = 0;
  segStart: Int32Array = new Int32Array(1);
  seg: Int32Array = new Int32Array(0);
  fix: RoadFix = new RoadFix();
  // Scratch for pointAt.
  px: f64 = 0;
  pz: f64 = 0;

  constructor(map: MapData) {
    let n = map.nodes.length / 2;
    this.nodeCount = n;
    this.nx = new Float64Array(n);
    this.nz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.nx[i] = map.nodes[i * 2];
      this.nz[i] = map.nodes[i * 2 + 1];
    }
    let m = map.edges.length;
    this.edgeCount = m;
    this.ea = new Int32Array(m);
    this.eb = new Int32Array(m);
    this.hw = new Float64Array(m);
    this.rank = new Int32Array(m);
    this.bridge = new Uint8Array(m);
    this.len = new Float64Array(m);
    this.leaveX = new Float64Array(m * 2);
    this.leaveZ = new Float64Array(m * 2);
    let degree = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) {
      let src = map.edges[e];
      this.ea[e] = src.a;
      this.eb[e] = src.b;
      this.hw[e] = src.hw;
      this.rank[e] = src.rank;
      this.bridge[e] = src.bridge ? 1 : 0;
      // The stored line, with its ends snapped onto the nodes.
      let k = src.pts.length;
      let p = new Float64Array(k);
      for (let j = 0; j < k; j++) p[j] = src.pts[j];
      p[0] = this.nx[src.a];
      p[1] = this.nz[src.a];
      p[k - 2] = this.nx[src.b];
      p[k - 1] = this.nz[src.b];
      let c = new Float64Array(k / 2);
      for (let j = 1; j < k / 2; j++) {
        let dx = p[j * 2] - p[j * 2 - 2], dz = p[j * 2 + 1] - p[j * 2 - 1];
        c[j] = c[j - 1] + Math.sqrt(dx * dx + dz * dz);
      }
      this.pts.push(p);
      this.cum.push(c);
      this.len[e] = c[k / 2 - 1];
      degree[src.a + 1]++;
      degree[src.b + 1]++;
    }
    for (let i = 0; i < n; i++) degree[i + 1] += degree[i];
    this.adjStart = degree;
    this.adj = new Int32Array(degree[n]);
    let fill = new Int32Array(n);
    for (let e = 0; e < m; e++) {
      let a = this.ea[e], b = this.eb[e];
      this.adj[degree[a] + fill[a]++] = e;
      this.adj[degree[b] + fill[b]++] = e;
    }
    for (let e = 0; e < m; e++) {
      for (let end = 0; end < 2; end++) {
        let node = end == 0 ? this.ea[e] : this.eb[e];
        let s = Math.min(12, this.len[e]);
        this.pointAt(e, end == 0 ? s : this.len[e] - s);
        let dx = this.px - this.nx[node], dz = this.pz - this.nz[node];
        let d = Math.sqrt(dx * dx + dz * dz) + 1e-9;
        this.leaveX[e * 2 + end] = dx / d;
        this.leaveZ[e * 2 + end] = dz / d;
      }
    }
    this.buildGrid();
  }

  private buildGrid(): void {
    let minX: f64 = 1e9, minZ: f64 = 1e9, maxX: f64 = -1e9, maxZ: f64 = -1e9;
    for (let i = 0; i < this.nodeCount; i++) {
      minX = Math.min(minX, this.nx[i]);
      maxX = Math.max(maxX, this.nx[i]);
      minZ = Math.min(minZ, this.nz[i]);
      maxZ = Math.max(maxZ, this.nz[i]);
    }
    this.minX = minX - CELL * 2;
    this.minZ = minZ - CELL * 2;
    this.cols = <i32>Math.ceil((maxX - minX) / CELL) + 4;
    this.rows = <i32>Math.ceil((maxZ - minZ) / CELL) + 4;
    let cells = this.cols * this.rows;
    let count = new Int32Array(cells + 1);
    for (let pass = 0; pass < 2; pass++) {
      let fill = new Int32Array(cells);
      for (let e = 0; e < this.edgeCount; e++) {
        let p = this.pts[e];
        let pad = this.hw[e] + 2;
        for (let i = 0; i + 3 < p.length; i += 2) {
          let c0 = this.col(Math.min(p[i], p[i + 2]) - pad), c1 = this.col(Math.max(p[i], p[i + 2]) + pad);
          let r0 = this.row(Math.min(p[i + 1], p[i + 3]) - pad), r1 = this.row(Math.max(p[i + 1], p[i + 3]) + pad);
          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              let cell = r * this.cols + c;
              if (pass == 0) count[cell + 1]++;
              else this.seg[this.segStart[cell] + fill[cell]++] = (e << 12) | (i / 2);
            }
          }
        }
      }
      if (pass == 0) {
        for (let k = 0; k < cells; k++) count[k + 1] += count[k];
        this.segStart = count;
        this.seg = new Int32Array(count[cells]);
      }
    }
  }

  private col(x: f64): i32 {
    return <i32>clamp(Math.floor((x - this.minX) / CELL), 0, <f64>(this.cols - 1));
  }

  private row(z: f64): i32 {
    return <i32>clamp(Math.floor((z - this.minZ) / CELL), 0, <f64>(this.rows - 1));
  }

  other(e: i32, node: i32): i32 {
    return this.ea[e] == node ? this.eb[e] : this.ea[e];
  }

  /** Index into leaveX/Z for leaving `node` along edge e. */
  leaving(e: i32, node: i32): i32 {
    return e * 2 + (this.ea[e] == node ? 0 : 1);
  }

  /** The point at arc length s along edge e (from its start), into px, pz. */
  pointAt(e: i32, s: f64): void {
    let p = this.pts[e];
    let c = this.cum[e];
    let n = c.length;
    s = clamp(s, 0, c[n - 1]);
    for (let i = 0; i < n - 1; i++) {
      if (s <= c[i + 1]) {
        let t = (s - c[i]) / Math.max(1e-6, c[i + 1] - c[i]);
        this.px = p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t;
        this.pz = p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t;
        return;
      }
    }
    this.px = p[n * 2 - 2];
    this.pz = p[n * 2 - 1];
  }

  /** The edge joining two nodes (the shortest, if several), or -1. */
  between(u: i32, v: i32): i32 {
    let best = -1;
    for (let k = this.adjStart[u]; k < this.adjStart[u + 1]; k++) {
      let e = this.adj[k];
      if ((this.ea[e] == v || this.eb[e] == v) && (best < 0 || this.len[e] < this.len[best])) best = e;
    }
    return best;
  }

  /**
   * The street a car at (x, z) is on, into `fix`. Heading (dx, dz) when `dir`:
   * a car in an intersection is on whichever street it's lined up with;
   * without, the nearest street. False if there's none within `radius`.
   */
  locate(x: f64, z: f64, dx: f64, dz: f64, dir: bool, radius: f64 = 60): bool {
    let best: f64 = 1e18;
    let found = false;
    let f = this.fix;
    let c0 = this.col(x - radius), c1 = this.col(x + radius);
    let r0 = this.row(z - radius), r1 = this.row(z + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let cell = r * this.cols + c;
        for (let k = this.segStart[cell]; k < this.segStart[cell + 1]; k++) {
          let code = this.seg[k];
          let e = code >> 12, i = code & 4095;
          let p = this.pts[e];
          let ax = p[i * 2], az = p[i * 2 + 1];
          let sx = p[i * 2 + 2] - ax, sz = p[i * 2 + 3] - az;
          let l2 = sx * sx + sz * sz;
          let t = l2 < 1e-9 ? 0 : clamp(((x - ax) * sx + (z - az) * sz) / l2, 0, 1);
          let qx = ax + sx * t, qz = az + sz * t;
          let d = Math.sqrt((qx - x) * (qx - x) + (qz - z) * (qz - z));
          if (d > radius) continue;
          let l = Math.sqrt(l2) + 1e-9;
          let tx = sx / l, tz = sz / l;
          let align = dir ? Math.abs(tx * dx + tz * dz) : 1;
          // Off the asphalt counts most; then (in an intersection) being lined up; then distance.
          let score = Math.max(0, d - this.hw[e]) + (1 - align) * this.hw[e] * 0.9 + d * 0.05;
          if (score < best) {
            best = score;
            found = true;
            let cs = this.cum[e];
            f.edge = e;
            f.s = cs[i] + t * (cs[i + 1] - cs[i]);
            f.x = qx;
            f.z = qz;
            f.tx = tx;
            f.tz = tz;
            f.dist = d;
            f.forward = dir ? tx * dx + tz * dz >= 0 : true;
          }
        }
      }
    }
    return found;
  }

  /** True on the bridge deck. */
  onBridge(x: f64, z: f64): bool {
    if (!this.locate(x, z, 0, 0, false, 60)) return false;
    return this.bridge[this.fix.edge] != 0 && this.fix.dist < this.hw[this.fix.edge] + 3;
  }
}

/** A min-heap of (cost, state). */
class Heap {
  cost: Array<f64> = [];
  state: Array<i32> = [];

  clear(): void {
    this.cost.length = 0;
    this.state.length = 0;
  }

  push(c: f64, s: i32): void {
    let i = this.cost.length;
    this.cost.push(c);
    this.state.push(s);
    while (i > 0) {
      let parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  /** Removes the cheapest; its cost and state are in topCost, topState. */
  pop(): void {
    this.topCost = this.cost[0];
    this.topState = this.state[0];
    let last = this.cost.length - 1;
    this.cost[0] = this.cost[last];
    this.state[0] = this.state[last];
    this.cost.length = last;
    this.state.length = last;
    let i = 0;
    for (;;) {
      let l = i * 2 + 1, r = l + 1, m = i;
      if (l < last && this.cost[l] < this.cost[m]) m = l;
      if (r < last && this.cost[r] < this.cost[m]) m = r;
      if (m == i) break;
      this.swap(i, m);
      i = m;
    }
  }

  topCost: f64 = 0;
  topState: i32 = 0;

  get size(): i32 {
    return this.cost.length;
  }

  private swap(a: i32, b: i32): void {
    let c = this.cost[a];
    this.cost[a] = this.cost[b];
    this.cost[b] = c;
    let s = this.state[a];
    this.state[a] = this.state[b];
    this.state[b] = s;
  }
}

/** GTA-style navigation to the swap point. */
export class Gps {
  roads: Roads;
  goal: i32;
  foot: i32;
  planned: Uint8Array;
  /** Intersections still to drive through, next first (the last is the swap point), and the streets into them. */
  ids: Array<i32> = [];
  edges: Array<i32> = [];
  /** The route ahead as a polyline from the player (x z pairs), and its length, rebuilt each update. */
  path: Array<f64> = [];
  pathCum: Array<f64> = [];
  pathLength: f64 = 0;
  /** The next intersection where the route turns: -1 left, 1 right, 0 none; how far along the route. */
  turnSide: i32 = 0;
  turnDistance: f64 = 0;
  turnNode: i32 = -1;
  /** Bumped every time the route's recomputed because the player took another way. */
  reroutes: i32 = 0;
  private offFor: f64 = 0;
  private lastEdge: i32 = -1;
  // The player's place on the graph: the intersection they're in or heading for, the one behind, the street.
  private fixNode: i32 = -1;
  private fixFrom: i32 = -1;
  private fixEdge: i32 = -1;
  private fixInside: bool = false;
  private heap: Heap = new Heap();
  private cost: Float64Array;
  private prev: Int32Array;
  // Scratch for the path.
  private pts: Array<f64> = [];

  constructor(roads: Roads, map: MapData) {
    this.roads = roads;
    this.goal = map.goal;
    this.foot = map.foot;
    this.planned = new Uint8Array(roads.edgeCount);
    for (let k = 0; k + 1 < map.plan.length; k++) {
      let e = roads.between(map.plan[k], map.plan[k + 1]);
      if (e >= 0) this.planned[e] = 1;
    }
    this.cost = new Float64Array(roads.edgeCount * 2);
    this.prev = new Int32Array(roads.edgeCount * 2);
  }

  /** Forgets the route (a new run). */
  reset(): void {
    this.ids.length = 0;
    this.edges.length = 0;
    this.path.length = 0;
    this.pathCum.length = 0;
    this.pathLength = 0;
    this.turnSide = 0;
    this.turnNode = -1;
    this.reroutes = 0;
    this.offFor = 0;
    this.lastEdge = -1;
  }

  /** Within this distance of an intersection's centre you're "in" it. */
  private box(n: i32): f64 {
    let r = this.roads;
    let w: f64 = 8;
    for (let k = r.adjStart[n]; k < r.adjStart[n + 1]; k++) w = Math.max(w, r.hw[r.adj[k]]);
    return w + 2;
  }

  /** Where the player is on the graph, into the fix fields. */
  private locate(x: f64, z: f64, dx: f64, dz: f64): bool {
    let r = this.roads;
    if (!r.locate(x, z, dx, dz, true)) return false;
    let f = r.fix;
    let e = f.edge;
    let node = f.forward ? r.eb[e] : r.ea[e];
    let from = f.forward ? r.ea[e] : r.eb[e];
    for (let k = 0; k < 2; k++) {
      let n = k == 0 ? node : from;
      let ddx = r.nx[n] - x, ddz = r.nz[n] - z;
      if (Math.sqrt(ddx * ddx + ddz * ddz) < this.box(n)) {
        // Came in by the street we were last on, if it leads here.
        let le = this.lastEdge;
        this.fixNode = n;
        this.fixFrom = -1;
        this.fixEdge = le >= 0 && (r.ea[le] == n || r.eb[le] == n) ? le : e;
        this.fixInside = true;
        return true;
      }
    }
    this.fixNode = node;
    this.fixFrom = from;
    this.fixEdge = e;
    this.fixInside = false;
    return true;
  }

  /** Call every frame with the player's position and direction of travel. True when it rerouted. */
  update(dt: f64, x: f64, z: f64, dx: f64, dz: f64): bool {
    if (!this.locate(x, z, dx, dz)) return false;
    let rerouted = false;
    if (!this.fixInside) this.lastEdge = this.fixEdge;
    if (this.ids.length == 0) {
      this.route(x, z);
    } else if (!(this.ids.length == 1 && this.ids[0] == this.goal)) {
      let k = this.ids.indexOf(this.fixNode);
      let onRoute: bool;
      if (this.fixInside) {
        // Working through an intersection on the route (skip any we somehow jumped past).
        if (k > 0) {
          this.ids.splice(0, k);
          this.edges.splice(0, k);
        }
        onRoute = true;
      } else if (this.fixEdge == this.edges[0] || (k == 0 && this.roads.other(this.edges[0], this.fixNode) == this.fixFrom)) {
        // On the route's street, either way (turning round to follow it is fine).
        onRoute = true;
      } else if (k == 1 && this.fixFrom == this.ids[0] && this.edges[1] == this.fixEdge) {
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
        this.route(x, z);
        this.reroutes++;
        rerouted = true;
      }
    }
    this.buildPath(x, z);
    this.findTurn();
    return rerouted;
  }

  private route(x: f64, z: f64): void {
    let r = this.roads;
    // How far along the street the intersection ahead is (0 when already in one).
    let ahead: f64 = 0;
    if (!this.fixInside && r.locate(x, z, 0, 0, false, 30) && r.fix.edge == this.fixEdge) {
      let e = this.fixEdge;
      ahead = this.fixNode == r.eb[e] ? r.len[e] - r.fix.s : r.fix.s;
    }
    this.shortest(this.fixNode, this.fixEdge, ahead);
  }

  /**
   * Cheapest route to the swap point for a car on street `via`: either on to the
   * intersection ahead (`start`, `ahead` m away), or turning round to the one
   * behind. States are "arriving at a node along an edge": 2e for its start, 2e + 1 its end.
   */
  private shortest(start: i32, via: i32, ahead: f64): void {
    let r = this.roads;
    let cost = this.cost, prev = this.prev;
    for (let i = 0; i < cost.length; i++) {
      cost[i] = Infinity;
      prev[i] = -1;
    }
    let heap = this.heap;
    heap.clear();
    let s0 = via * 2 + (r.ea[via] == start ? 0 : 1);
    let behind = r.other(via, start);
    let s1 = via * 2 + (r.ea[via] == behind ? 0 : 1);
    cost[s0] = ahead;
    heap.push(ahead, s0);
    let c1 = Math.max(0, r.len[via] - ahead) + U_TURN_COST;
    if (c1 < cost[s1]) {
      cost[s1] = c1;
      heap.push(c1, s1);
    }
    let found = -1;
    while (heap.size > 0) {
      heap.pop();
      let c = heap.topCost, s = heap.topState;
      if (c > cost[s]) continue;
      let e = s >> 1;
      let node = (s & 1) == 0 ? r.ea[e] : r.eb[e];
      if (node == this.goal) {
        found = s;
        break;
      }
      // The way we're driving as we arrive: the reverse of leaving here along e.
      let li = r.leaving(e, node);
      let inX = -r.leaveX[li], inZ = -r.leaveZ[li];
      for (let k = r.adjStart[node]; k < r.adjStart[node + 1]; k++) {
        let out = r.adj[k];
        let next = r.other(out, node);
        let lo = r.leaving(out, node);
        let turn = out == e ? U_TURN_COST : inX * r.leaveX[lo] + inZ * r.leaveZ[lo] > 0.82 ? 0 : TURN_COST;
        let c2 = c + r.len[out] * (this.planned[out] != 0 ? PLAN_DISCOUNT : 1) + turn;
        let t = out * 2 + (r.ea[out] == next ? 0 : 1);
        if (c2 < cost[t]) {
          cost[t] = c2;
          prev[t] = s;
          heap.push(c2, t);
        }
      }
    }
    this.ids.length = 0;
    this.edges.length = 0;
    if (found < 0) {
      this.ids.push(start);
      this.edges.push(via);
      return;
    }
    for (let s = found; s >= 0; s = prev[s]) {
      let e = s >> 1;
      this.ids.push((s & 1) == 0 ? r.ea[e] : r.eb[e]);
      this.edges.push(e);
    }
    this.ids.reverse();
    this.edges.reverse();
  }

  /** Appends edge e's centre line, starting from `node`, skipping its first `skip` points. */
  private appendEdge(e: i32, node: i32, skip: i32): void {
    let p = this.roads.pts[e];
    let n = p.length / 2;
    let fromStart = this.roads.ea[e] == node;
    for (let j = skip; j < n; j++) {
      let i = fromStart ? j : n - 1 - j;
      this.pts.push(p[i * 2]);
      this.pts.push(p[i * 2 + 1]);
    }
  }

  /**
   * The route ahead as a drivable polyline from (x, z), along the streets: the
   * whole route as a line, picked up from the point on it nearest the player
   * (looking only near its start, so a route that doubles back can't confuse it).
   */
  private buildPath(x: f64, z: f64): void {
    let r = this.roads;
    let pts = this.pts;
    pts.length = 0;
    let out = this.path;
    out.length = 0;
    this.pathCum.length = 0;
    this.pathLength = 0;
    if (this.ids.length == 0) return;
    let e0 = this.edges[0], n0 = this.ids[0];
    if (r.ea[e0] == n0 || r.eb[e0] == n0) this.appendEdge(e0, r.other(e0, n0), 0);
    else {
      pts.push(r.nx[n0]);
      pts.push(r.nz[n0]);
    }
    let near = pts.length / 2;
    for (let k = 1; k < this.ids.length; k++) this.appendEdge(this.edges[k], this.ids[k - 1], 1);
    let n = pts.length / 2;
    // Where we are: the nearest point on the current street or the next 300 m after it.
    let prefix = near;
    let acc: f64 = 0;
    for (let i = near; i < n && acc < 300; i++) {
      acc += dist(pts, i, i - 1);
      prefix = i + 1;
    }
    let bestD: f64 = 1e18, bestS: f64 = 0, s: f64 = 0;
    for (let i = 0; i + 1 < Math.max(2, prefix) && i + 1 < n; i++) {
      let ax = pts[i * 2], az = pts[i * 2 + 1];
      let sx = pts[i * 2 + 2] - ax, sz = pts[i * 2 + 3] - az;
      let l2 = sx * sx + sz * sz;
      let t = l2 < 1e-9 ? 0 : clamp(((x - ax) * sx + (z - az) * sz) / l2, 0, 1);
      let qx = ax + sx * t - x, qz = az + sz * t - z;
      let d = qx * qx + qz * qz;
      let l = Math.sqrt(l2);
      if (d < bestD) {
        bestD = d;
        bestS = s + t * l;
      }
      s += l;
    }
    out.push(x);
    out.push(z);
    this.pathCum.push(0);
    let along: f64 = 0;
    let total: f64 = 0;
    for (let i = 1; i < n; i++) {
      along += dist(pts, i, i - 1);
      if (along > bestS + 0.5) {
        let px = out[out.length - 2], pz = out[out.length - 1];
        let dx = pts[i * 2] - px, dz = pts[i * 2 + 1] - pz;
        total += Math.sqrt(dx * dx + dz * dz);
        out.push(pts[i * 2]);
        out.push(pts[i * 2 + 1]);
        this.pathCum.push(total);
      }
    }
    if (out.length == 2 && n > 0) {
      out.push(pts[n * 2 - 2]);
      out.push(pts[n * 2 - 1]);
      let dx = out[2] - x, dz = out[3] - z;
      total = Math.sqrt(dx * dx + dz * dz);
      this.pathCum.push(total);
    }
    this.pathLength = total;
  }

  /** How far along the path the point nearest (x, z) is. */
  private project(x: f64, z: f64): f64 {
    let p = this.path;
    let best: f64 = 1e18, bestS: f64 = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      let ax = p[i], az = p[i + 1];
      let sx = p[i + 2] - ax, sz = p[i + 3] - az;
      let l2 = sx * sx + sz * sz;
      let t = l2 < 1e-9 ? 0 : clamp(((x - ax) * sx + (z - az) * sz) / l2, 0, 1);
      let qx = ax + sx * t - x, qz = az + sz * t - z;
      let d = qx * qx + qz * qz;
      if (d < best) {
        best = d;
        bestS = this.pathCum[i / 2] + t * Math.sqrt(l2);
      }
    }
    return bestS;
  }

  /** The point `s` m along the path, into atX, atZ. */
  pointAlong(s: f64): void {
    let p = this.path;
    let c = this.pathCum;
    let n = c.length;
    if (n == 0) return;
    if (s <= 0) {
      this.atX = p[0];
      this.atZ = p[1];
      return;
    }
    for (let i = 0; i + 1 < n; i++) {
      if (s <= c[i + 1]) {
        let t = (s - c[i]) / Math.max(1e-6, c[i + 1] - c[i]);
        this.atX = p[i * 2] + (p[i * 2 + 2] - p[i * 2]) * t;
        this.atZ = p[i * 2 + 1] + (p[i * 2 + 3] - p[i * 2 + 1]) * t;
        return;
      }
    }
    this.atX = p[n * 2 - 2];
    this.atZ = p[n * 2 - 1];
  }

  atX: f64 = 0;
  atZ: f64 = 0;

  /** The next intersection where the route turns, if any. */
  private findTurn(): void {
    this.turnSide = 0;
    this.turnNode = -1;
    if (this.ids.length == 0) return;
    let r = this.roads;
    let distance = this.project(r.nx[this.ids[0]], r.nz[this.ids[0]]);
    for (let k = 0; k + 1 < this.ids.length; k++) {
      let node = this.ids[k];
      let li = r.leaving(this.edges[k], node);
      let inX = -r.leaveX[li], inZ = -r.leaveZ[li];
      let lo = r.leaving(this.edges[k + 1], node);
      let outX = r.leaveX[lo], outZ = r.leaveZ[lo];
      let cross = inX * outZ - inZ * outX;
      // Left of travel is +x when facing +z, which makes a left turn a negative cross product.
      if (Math.abs(cross) > 0.5 && inX * outX + inZ * outZ < 0.85) {
        this.turnSide = cross < 0 ? -1 : 1;
        this.turnDistance = distance;
        this.turnNode = node;
        return;
      }
      distance += r.len[this.edges[k + 1]];
    }
  }

  /** Heading for the bridge with nothing but the bridge left to drive. */
  nextIsGoal(): bool {
    return this.ids.length > 0 && this.ids[0] == this.goal;
  }
}

function dist(p: Array<f64>, i: i32, j: i32): f64 {
  let dx = p[i * 2] - p[j * 2], dz = p[i * 2 + 1] - p[j * 2 + 1];
  return Math.sqrt(dx * dx + dz * dz);
}
