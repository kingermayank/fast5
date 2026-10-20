import * as THREE from 'three';
import data from './map/sanjuan.json';

/**
 * The map: real Hato Rey (San Juan, where Fast Five shot its "Rio" vault chase)
 * and the Teodoro Moscoso Bridge, built from OpenStreetMap by tools/map. This
 * module holds the street graph and answers "where am I on the road" questions;
 * city.ts builds what you see from the same data.
 * Map data © OpenStreetMap contributors (ODbL 1.0).
 */

interface RawMap {
  attribution: string;
  nodes: number[];
  edges: { a: number; b: number; w: number; r: number; n: string; br?: number; p: number[] }[];
  buildings: { h: number; k: string; p: number[] }[];
  areas: { k: 'green' | 'lot'; p: number[] }[];
  land: number[][][];
  walls: number[][];
  poi: {
    plan: number[];
    foot: number;
    goal: number;
    spikes: { p: [number, number]; d: [number, number] };
    bank: { p: number[]; heading: number; corner: number };
    tolls: number[];
  };
}
export const RAW = data as unknown as RawMap;

export interface MapNode {
  id: number;
  pos: THREE.Vector3;
  edges: MapEdge[];
}

export interface MapEdge {
  id: number;
  a: MapNode;
  b: MapNode;
  /** Half width of the asphalt (m). */
  hw: number;
  /** 1 = expressway ... 6 = lane. */
  rank: number;
  name: string;
  bridge: boolean;
  /** Center line from a to b. */
  pts: THREE.Vector3[];
  /** Arc length at each point. */
  cum: number[];
  length: number;
}

/** Where a point is on the street network. */
export interface RoadFix {
  edge: MapEdge;
  /** Arc length of the closest center-line point, from edge.a. */
  s: number;
  point: THREE.Vector3;
  /** Unit direction of the street at s, from a toward b. */
  tangent: THREE.Vector3;
  /** Distance from the center line. */
  dist: number;
  /** Heading toward b (rather than a). */
  forward: boolean;
}

/** Flat [x, z, x, z, ...] to points on the ground. */
export const points = (flat: number[]) => {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(new THREE.Vector3(flat[i], 0, flat[i + 1]));
  return out;
};

const CELL = 32;

export class RoadMap {
  readonly nodes: MapNode[];
  readonly edges: MapEdge[];
  private grid = new Map<string, { edge: MapEdge; i: number }[]>();
  private nodeGrid = new Map<string, MapNode[]>();

  constructor(raw: RawMap) {
    this.nodes = points(raw.nodes).map((pos, id) => ({ id, pos, edges: [] }));
    this.edges = raw.edges.map((e, id) => {
      const pts = points(e.p);
      // Snap the ends onto the nodes (the stored polylines are simplified separately).
      pts[0].copy(this.nodes[e.a].pos);
      pts[pts.length - 1].copy(this.nodes[e.b].pos);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const edge: MapEdge = { id, a: this.nodes[e.a], b: this.nodes[e.b], hw: e.w, rank: e.r, name: e.n, bridge: !!e.br, pts, cum, length: cum[cum.length - 1] };
      edge.a.edges.push(edge);
      edge.b.edges.push(edge);
      return edge;
    });
    for (const e of this.edges) {
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i];
        const b = e.pts[i + 1];
        const pad = e.hw + 2;
        for (let gx = Math.floor((Math.min(a.x, b.x) - pad) / CELL); gx <= Math.floor((Math.max(a.x, b.x) + pad) / CELL); gx++) {
          for (let gz = Math.floor((Math.min(a.z, b.z) - pad) / CELL); gz <= Math.floor((Math.max(a.z, b.z) + pad) / CELL); gz++) {
            const k = `${gx},${gz}`;
            let list = this.grid.get(k);
            if (!list) this.grid.set(k, (list = []));
            list.push({ edge: e, i });
          }
        }
      }
    }
    for (const n of this.nodes) {
      const k = `${Math.floor(n.pos.x / CELL)},${Math.floor(n.pos.z / CELL)}`;
      let list = this.nodeGrid.get(k);
      if (!list) this.nodeGrid.set(k, (list = []));
      list.push(n);
    }
  }

  node(id: number): MapNode {
    return this.nodes[id];
  }

  /** The intersection at p (within `tol` m), if any. */
  nodeAt(p: THREE.Vector3, tol = 1): MapNode | null {
    let best: MapNode | null = null;
    let bestD = tol;
    const gx = Math.floor(p.x / CELL);
    const gz = Math.floor(p.z / CELL);
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gz - 1; j <= gz + 1; j++) {
        for (const n of this.nodeGrid.get(`${i},${j}`) ?? []) {
          const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
          if (d < bestD) {
            bestD = d;
            best = n;
          }
        }
      }
    }
    return best;
  }

  /** Every street segment within `radius` of p, with its closest point. */
  private near(p: THREE.Vector3, radius: number, visit: (edge: MapEdge, i: number, t: number, d: number) => void): void {
    const seen = new Set<string>();
    const gx = Math.floor(p.x / CELL);
    const gz = Math.floor(p.z / CELL);
    const r = Math.ceil(radius / CELL);
    for (let i = gx - r; i <= gx + r; i++) {
      for (let j = gz - r; j <= gz + r; j++) {
        for (const s of this.grid.get(`${i},${j}`) ?? []) {
          const key = `${s.edge.id}:${s.i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const a = s.edge.pts[s.i];
          const b = s.edge.pts[s.i + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const l2 = dx * dx + dz * dz;
          const t = l2 < 1e-9 ? 0 : THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1);
          const d = Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
          if (d <= radius) visit(s.edge, s.i, t, d);
        }
      }
    }
  }

  /**
   * The street a car at p is on. With a heading, a car in an intersection is on
   * whichever street it's lined up with; without, the nearest street.
   */
  locate(p: THREE.Vector3, dir?: THREE.Vector3, radius = 60): RoadFix | null {
    let best: RoadFix | null = null;
    let bestScore = Infinity;
    this.near(p, radius, (edge, i, t, d) => {
      const a = edge.pts[i];
      const b = edge.pts[i + 1];
      const tangent = new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
      const align = dir ? Math.abs(tangent.x * dir.x + tangent.z * dir.z) : 1;
      // Off the asphalt counts most; then (in an intersection) being lined up; then distance.
      const score = Math.max(0, d - edge.hw) + (1 - align) * edge.hw * 0.9 + d * 0.05;
      if (score < bestScore) {
        bestScore = score;
        const s = edge.cum[i] + t * (edge.cum[i + 1] - edge.cum[i]);
        best = {
          edge, s, tangent, dist: d,
          point: new THREE.Vector3(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t),
          forward: dir ? tangent.x * dir.x + tangent.z * dir.z >= 0 : true,
        };
      }
    });
    return best;
  }

  /** On the asphalt of some street (or the bridge deck). */
  onRoad(p: THREE.Vector3, margin = 0): boolean {
    let on = false;
    this.near(p, 20, (edge, _i, _t, d) => {
      if (d <= edge.hw + margin) on = true;
    });
    return on;
  }

  /** Half width of the road at p (the widest street there, in an intersection). */
  halfWidthAt(p: THREE.Vector3): number {
    let hw = 0;
    this.near(p, 20, (edge, _i, _t, d) => {
      if (d <= edge.hw) hw = Math.max(hw, edge.hw);
    });
    return hw || (this.locate(p)?.edge.hw ?? 6);
  }

  /** Point at arc length s along an edge (from a), clamped. */
  pointAt(edge: MapEdge, s: number): THREE.Vector3 {
    s = THREE.MathUtils.clamp(s, 0, edge.length);
    for (let i = 0; i < edge.pts.length - 1; i++) {
      if (s <= edge.cum[i + 1]) {
        const t = (s - edge.cum[i]) / Math.max(1e-6, edge.cum[i + 1] - edge.cum[i]);
        return edge.pts[i].clone().lerp(edge.pts[i + 1], t);
      }
    }
    return edge.pts[edge.pts.length - 1].clone();
  }

  /** Unit direction a → b at arc length s. */
  tangentAt(edge: MapEdge, s: number): THREE.Vector3 {
    return this.pointAt(edge, s + 1).sub(this.pointAt(edge, s - 1)).setY(0).normalize();
  }

  /** The other end of an edge. */
  other(edge: MapEdge, n: MapNode): MapNode {
    return edge.a === n ? edge.b : edge.a;
  }

  /** The way out of node n along edge: the direction toward a point ~12 m down it. */
  leaving(edge: MapEdge, n: MapNode): THREE.Vector3 {
    const s = Math.min(12, edge.length);
    const p = edge.a === n ? this.pointAt(edge, s) : this.pointAt(edge, edge.length - s);
    return p.sub(n.pos).setY(0).normalize();
  }

  /** The way into node n along edge (the direction you're driving as you arrive). */
  arriving(edge: MapEdge, n: MapNode): THREE.Vector3 {
    return this.leaving(edge, n).negate();
  }

  /** The edge's center line, starting at node n. */
  from(edge: MapEdge, n: MapNode): THREE.Vector3[] {
    return edge.a === n ? edge.pts : [...edge.pts].reverse();
  }

  /** The edge joining two nodes (the shortest, if several). */
  between(u: MapNode, v: MapNode): MapEdge | null {
    let best: MapEdge | null = null;
    for (const e of u.edges) if ((e.a === v || e.b === v) && (!best || e.length < best.length)) best = e;
    return best;
  }
}

// ----------------------------------------------------- the Barbosa overpass

/** Length of a polyline. */
const lineLength = (pts: THREE.Vector3[]) => pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0);

/** A polyline's first `s` m (with the cut point at its end). */
function lineHead(pts: THREE.Vector3[], s: number): THREE.Vector3[] {
  const out = [pts[0].clone()];
  for (let i = 1; i < pts.length; i++) {
    const len = pts[i].distanceTo(pts[i - 1]);
    if (s <= len) {
      out.push(pts[i - 1].clone().lerp(pts[i], s / Math.max(1e-6, len)));
      return out;
    }
    s -= len;
    out.push(pts[i].clone());
  }
  return out;
}

/** The deck's top and the underside of its girders (m up), and how far out from the expressway's middle each ramp touches down (m). */
export const OVERPASS_TOP = 7.75;
export const OVERPASS_CLEAR = 6.4;
const RAMP_OUT = 135;

/**
 * Where Mia's route crosses Avenida Dr. José Celso Barbosa (PR-27), the avenue goes
 * over the Piñero expressway on a bridge. The map build makes every crossing a
 * junction, so this one is taken apart again before anything is built from the data:
 * the avenue's dead-end stub north of the expressway goes, and the road south of it
 * now starts where the ramp up to the bridge comes down (city.ts builds the bridge
 * and its ramps over them). Returns the crossing and the line each ramp follows, out
 * from the crossing, `RAMP_OUT` m long.
 */
const BARBOSA = (function cut(raw: RawMap) {
  const node = raw.poi.plan.find((id) => raw.edges.some((e) => (e.a === id || e.b === id) && /Celso Barbosa/.test(e.n)));
  if (node === undefined) return null;
  const crossing = new THREE.Vector3(raw.nodes[node * 2], 0, raw.nodes[node * 2 + 1]);
  const degree = (id: number) => raw.edges.filter((e) => e.a === id || e.b === id).length;
  const ramps: THREE.Vector3[][] = [];
  for (const e of raw.edges.filter((x) => (x.a === node || x.b === node) && x.r > 1)) {
    // Its line out from the crossing, without the little jogs a simplified polyline has (under 12 m).
    const raw0 = points(e.p);
    if (e.a !== node) raw0.reverse();
    const line = raw0.filter((p, i) => i === 0 || i === raw0.length - 1 || p.distanceTo(raw0[0]) > 12 && raw0.slice(0, i).every((q) => q.distanceTo(p) > 12));
    const far = e.a === node ? e.b : e.a;
    const len = lineLength(line);
    ramps.push(lineHead(line, Math.min(RAMP_OUT, len)));
    if (degree(far) === 1 && len < RAMP_OUT + 60) {
      // A stub that only ever led to this crossing: gone.
      raw.edges.splice(raw.edges.indexOf(e), 1);
      continue;
    }
    // The rest starts at the ramp's foot.
    const rest = lineHead([...line].reverse(), len - RAMP_OUT);
    raw.nodes.push(rest[rest.length - 1].x, rest[rest.length - 1].z);
    const foot = raw.nodes.length / 2 - 1;
    if (e.a === node) {
      e.a = foot;
      e.p = rest.reverse().flatMap((p) => [p.x, p.z]);
    } else {
      e.b = foot;
      e.p = rest.flatMap((p) => [p.x, p.z]);
    }
  }
  return { node, crossing, ramps };
})(RAW);

// ----------------------------------------------------- the bridge runs on

/** The map's own extent (its streets, without the bridge's run-on below): for the minimap and the water. */
export const BOUNDS = new THREE.Box3().setFromPoints(points(RAW.nodes));

/**
 * How far (m) the bridge runs on past the end of the map's data. The real one lands
 * about where the data stops; this one carries straight on across the open bay into
 * the haze, so the fight on it never runs out of deck.
 */
export const BRIDGE_RUN = 10000;

/** Where the run-on starts (the end of the real bridge), which way it goes, and its edge's id. */
export const RUN_ON = (function runOn(raw: RawMap) {
  // The bridge's far end: the end of a bridge edge that nothing else meets.
  const degree = new Map<number, number>();
  for (const e of raw.edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const last = raw.edges.find((e) => e.br && (degree.get(e.a) === 1 || degree.get(e.b) === 1));
  if (!last) return null;
  const endId = degree.get(last.b) === 1 ? last.b : last.a;
  const line = points(last.p);
  if (endId === last.a) line.reverse();
  const end = new THREE.Vector3(raw.nodes[endId * 2], 0, raw.nodes[endId * 2 + 1]);
  const dir = end.clone().sub(line[line.length - 2]).normalize();
  // Straight on, as an edge of its own, with a point every 250 m (so what's built along it comes in pieces).
  const p: number[] = [];
  for (let s = 0; s <= BRIDGE_RUN; s += 250) p.push(end.x + dir.x * s, end.z + dir.z * s);
  raw.nodes.push(p[p.length - 2], p[p.length - 1]);
  const edge = raw.edges.push({ a: endId, b: raw.nodes.length / 2 - 1, w: last.w, r: last.r, n: last.n, br: 1, p }) - 1;
  // Where the real bridge lands, the map has a piece of shore with no streets on it, and the
  // run-on would cross it. It goes under water (its drivable ring, and its corners from the land).
  const nodes = points(raw.nodes);
  const inside = (x: number, z: number, ring: THREE.Vector3[]) => {
    let inn = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inn = !inn;
    }
    return inn;
  };
  const streetless = raw.walls.filter((flat) => {
    const ring = points(flat);
    return !nodes.some((n) => inside(n.x, n.z, ring));
  });
  const gone = new Set(streetless.flatMap((flat) => points(flat).map((q) => `${q.x},${q.z}`)));
  raw.walls = raw.walls.filter((flat) => !streetless.includes(flat));
  raw.land = raw.land.map((poly) =>
    poly.map((flat) => {
      const kept = points(flat).filter((q) => !gone.has(`${q.x},${q.z}`));
      // Rings are closed: if the first corner went, close it on the new first.
      if (kept.length && !kept[0].equals(kept[kept.length - 1])) kept.push(kept[0].clone());
      return kept.flatMap((q) => [q.x, q.z]);
    }),
  );
  return { from: end, dir, edge, node: endId };
})(RAW);

export const MAP = new RoadMap(RAW);

// ------------------------------------------------------------- set pieces

/**
 * The goal: the far end of the real bridge, where its run-on begins (the fight on the
 * bridge happens short of it, heading back toward the city). The bridge's city end.
 */
export const GOAL = MAP.node(RUN_ON?.node ?? RAW.poi.goal);
export const BRIDGE_FOOT = MAP.node(RAW.poi.foot);
/** Mia's planned route: intersections from the station to partway across the bridge (the GPS carries on from there to the goal). */
export const PLAN = RAW.poi.plan.map((id) => MAP.node(id));

/** The bridge deck as one path from its foot, and how far along it the swap point is. */
export const BRIDGE = (() => {
  const pts: THREE.Vector3[] = [];
  let at = BRIDGE_FOOT;
  const used = new Set<MapEdge>();
  let goalAlong = 0;
  for (;;) {
    const e = at.edges.find((x) => x.bridge && !used.has(x));
    if (!e) break;
    used.add(e);
    const seg = MAP.from(e, at);
    pts.push(...(pts.length ? seg.slice(1) : seg));
    at = MAP.other(e, at);
    if (at === GOAL) {
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
      goalAlong = len;
    }
  }
  const hw = Math.max(...[...used].map((e) => e.hw));
  return { pts, hw, goalAlong, edges: used };
})();

/** True on the bridge deck. */
export function onBridge(p: THREE.Vector3): boolean {
  const fix = MAP.locate(p);
  return !!fix && fix.edge.bridge && fix.dist < fix.edge.hw + 3;
}

/** A local frame on the ground: x across (left of forward), z forward. */
export interface Frame {
  origin: THREE.Vector3;
  x: THREE.Vector3;
  z: THREE.Vector3;
  /** Rotation about y that turns +z into `z` (and +x into `x`). */
  heading: number;
  toLocal(p: THREE.Vector3): { x: number; z: number };
  toWorld(x: number, z: number, y?: number): THREE.Vector3;
}

export function frame(origin: THREE.Vector3, forward: THREE.Vector3): Frame {
  const z = new THREE.Vector3(forward.x, 0, forward.z).normalize();
  const x = new THREE.Vector3(z.z, 0, -z.x);
  const o = origin.clone().setY(0);
  return {
    origin: o,
    x,
    z,
    heading: Math.atan2(z.x, z.z),
    toLocal: (p) => ({ x: (p.x - o.x) * x.x + (p.z - o.z) * x.z, z: (p.x - o.x) * z.x + (p.z - o.z) * z.z }),
    toWorld: (lx, lz, y = 0) => new THREE.Vector3(o.x + x.x * lx + z.x * lz, y, o.z + x.z * lx + z.z * lz),
  };
}

/**
 * The bank on the corner where Mia's route turns onto the expressway: a frame
 * at its near corner (x across, away from the avenue; z along the approach),
 * its footprint, and the intersection it stands on.
 */
export const BANK = (() => {
  const c = points(RAW.poi.bank.p);
  const f = frame(c[0], c[3].clone().sub(c[0]));
  return { frame: f, w: c[0].distanceTo(c[1]), d: c[0].distanceTo(c[3]), lobbyH: 6, h: 28, corner: MAP.node(RAW.poi.bank.corner).pos };
})();

/**
 * The Barbosa overpass, where the swap happens: the avenue's bridge over the Piñero
 * expressway, past the bank on the way to the Moscoso bridge. A frame at the
 * crossing (z along the expressway the way the route runs, x across, left of it);
 * the expressway's half-width there and its centre line through the crossing (from
 * the bank's corner on to the bridge's foot); the deck's half-width along the
 * expressway; how far either side of the crossing its abutment walls stand; and the
 * line each of the avenue's ramps follows, out from the crossing.
 */
export const OVERPASS = (() => {
  const k = PLAN.findIndex((n) => n.id === BARBOSA?.node);
  if (!BARBOSA || k < 1) throw new Error('the Barbosa overpass is not on the route');
  const n = PLAN[k];
  const before = MAP.from(MAP.between(PLAN[k - 1], n)!, PLAN[k - 1]);
  const after = MAP.from(MAP.between(n, PLAN[k + 1])!, n);
  const road = [...before, ...after.slice(1)];
  const dir = after[Math.min(2, after.length - 1)].clone().sub(before[Math.max(0, before.length - 3)]).setY(0).normalize();
  const hw = Math.max(...n.edges.map((e) => e.hw));
  return {
    frame: frame(n.pos, dir),
    hw,
    road,
    /** The deck carries the avenue's four lanes and two sidewalks (to the outside of its parapets). */
    deckHalf: 10.4,
    /** The avenue's half-width on the deck and the ramps: its lanes, and to the outside of the parapets. */
    laneHalf: 8,
    abut: hw + 3.5,
    ramps: BARBOSA.ramps,
  };
})();

/** How high the avenue is `s` m out from the crossing along either ramp: the deck's top over the expressway and a little past it, then an even grade down to the ground at the foot. */
export function rampHeight(s: number): number {
  const s0 = OVERPASS.abut + 5;
  const u = THREE.MathUtils.clamp((s - s0) / (RAMP_OUT - s0), 0, 1);
  // The grade eases in and out over the first and last fifth.
  const a = 0.2;
  const done = u < a ? (u * u) / (2 * a) : u < 1 - a ? a / 2 + (u - a) : 1 - a - (1 - u) ** 2 / (2 * a);
  return OVERPASS_TOP * (1 - done / (1 - a));
}

/** Distance from p to segment ab, on the ground. */
function segDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1);
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}

/** Within `margin` m of the overpass's structure: under its deck, or on or beside either ramp (for keeping props and trees off it). */
export function onOverpass(p: THREE.Vector3, margin = 0): boolean {
  if (underOverpass(p, margin)) return true;
  return OVERPASS.ramps.some((line) => line.some((q, i) => i < line.length - 1 && segDistance(p, q, line[i + 1]) < OVERPASS.deckHalf + margin));
}

/** Under the overpass's deck (with `margin` m to spare all round), between its abutments. */
export function underOverpass(p: THREE.Vector3, margin = 0): boolean {
  const l = OVERPASS.frame.toLocal(p);
  return Math.abs(l.z) < OVERPASS.deckHalf + margin && Math.abs(l.x) < OVERPASS.abut + margin;
}

/** On the expressway within `margin` m of the overpass (for keeping the other set pieces away from it). */
export function nearOverpass(p: THREE.Vector3, margin = 0): boolean {
  const l = OVERPASS.frame.toLocal(p);
  return Math.abs(l.z) < OVERPASS.deckHalf + margin && Math.abs(l.x) < OVERPASS.hw + margin;
}

/** Where the cops lay the spike strip: on Mia's route, facing the way she sends you. */
export const SPIKES = frame(new THREE.Vector3(RAW.poi.spikes.p[0], 0, RAW.poi.spikes.p[1]), new THREE.Vector3(RAW.poi.spikes.d[0], 0, RAW.poi.spikes.d[1]));
