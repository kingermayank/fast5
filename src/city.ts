import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { awning, balcony, orientedRect, parapet, pitchedRoof } from './architecture';
import type { CarModel } from './carModel';
import { STREET_GROUPS } from './vehicle';
import { seeThrough } from './cutaway';
import { RAPIER, syncMesh } from './physics';
import { mirrorsLamps } from './streetlight';
import { BANK, BOUNDS, BRIDGE, GOAL, MAP, type MapEdge, onOverpass, OVERPASS, OVERPASS_CLEAR, OVERPASS_TOP, PLAN, points, rampHeight, RAW } from './roadmap';
import { leftOf } from './roads';
import {
  arrowTexture, asphaltTexture, asphaltTextures, asphaltWetTexture, awningTexture, type FacadeStyle, facadeTextures, grassTexture, groundTexture, helipadTexture, mosaicTexture, retainingWallTexture, roofTexture,
  sidewalkTexture, signTexture, storefrontTexture, tileTexture, waterNormalTexture,
} from './textures';
import { palmGeometry, palmMaterials, Trees } from './vegetation';

/**
 * The city you drive through: real Hato Rey streets and buildings (see
 * roadmap.ts and tools/map), dressed as Rio: wave-mosaic sidewalks on the
 * avenues, palms, Portuguese signs. The police HQ and the bank are built here;
 * everything else comes from OpenStreetMap.
 */

/** Static geometry is merged per material within squares this size (m), so off-screen parts are culled. */
const CHUNK = 320;
const SIDEWALK = 2.5;
const BRIDGE_BARRIER = 0.8;
const WATER_Y = -4;
/** The water plane (m) and its ripple tiles across it; it moves with the camera (see follow). */
const WATER_SIZE = 20000;
const WATER_TILES = 300;

/** Police HQ block, west of Ponce de León; the vault room opens east onto the avenue (x = 200). */
const STATION = { x0: 116, x1: 184, z0: 116, z1: 184, roomX0: 170, roomZ0: 144, roomZ1: 156, roomH: 4.2, h: 20 };
export const VAULT_START = new THREE.Vector3(177, 0, 150);
export const VAULT_START_HEADING = Math.PI / 2; // door faces +x, toward the street
/** Where the cars wait, facing down the avenue in front of the station. */
export const CAR_STARTS = [new THREE.Vector3(196.5, 0, 158), new THREE.Vector3(202.5, 0, 158)];
/** Where a street lamp's light is, in the lamp's own frame. */
export const LAMP_HEAD = new THREE.Vector3(0, 3.25, 2.1);
/** Street lamps are drawn in sets by square of the map this wide (m), so squares off screen are culled. */
const LAMP_SQUARE = 400;
/** x of the station facade; the vault is "out" once it crosses this. */
export const STATION_FACADE_X = STATION.x1;

export interface Prop {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  /** Property damage value when first knocked loose. */
  value: number;
  hit: boolean;
  /** A parked car: heavy enough to jam the rig if it's shoved in there (see rig.ts). */
  heavy?: boolean;
  /** Drawn as one copy in an instanced set (see PropInstances): `mesh` is then only a stand-in holding its pose. */
  instance?: { set: PropInstances; index: number };
  /** Glass that shatters the first time it's knocked loose (a bus shelter's panes). */
  glass?: THREE.Object3D;
}

/** Café furniture is light and goes everywhere when hit, but the pieces of a terrace pass through each other. */
const FURNITURE_BIT = 0x0010;
const FURNITURE_GROUPS = (FURNITURE_BIT << 16) | (0xffff & ~FURNITURE_BIT);
/** Café terraces along the route, at most. */
const MAX_CAFES = 44;
/** Parasol canvas: cream, terracotta, bottle green, navy, red, mustard, teal. */
const CANOPIES = [0xf3ead2, 0xc8643c, 0x2f6b4a, 0x253a5e, 0xc0302a, 0xe0a82e, 0x2a8a8a];
const WHITE = new THREE.Color(0xffffff);

/**
 * Many copies of a small prop drawn as instanced meshes (one draw per part for all of
 * them), each copy with its own physics body. A copy's matrix is rewritten only while its
 * body is awake. Parts marked `tinted` take a colour per copy.
 */
class PropInstances {
  readonly meshes: THREE.InstancedMesh[];
  private n = 0;
  private dirty = false;
  private readonly m = new THREE.Matrix4();

  constructor(
    parts: { geo: THREE.BufferGeometry; mat: THREE.Material; tinted?: boolean }[],
    readonly capacity: number,
    /** Culled as a whole when off screen (a set kept to one square of the map; see seal). */
    private culled = false,
  ) {
    this.meshes = parts.map(({ geo, mat, tinted }) => {
      const im = new THREE.InstancedMesh(geo, mat, capacity);
      im.count = 0;
      im.castShadow = im.receiveShadow = true;
      // Copies spread along the route that fly about when hit are never culled as a whole.
      im.frustumCulled = culled;
      im.userData.tinted = !!tinted;
      return im;
    });
  }

  /** Done adding: bound the copies, for culling. */
  seal(): void {
    for (const im of this.meshes) im.computeBoundingSphere();
  }

  get full(): boolean {
    return this.n >= this.capacity;
  }

  /** A new copy at the pose `o` holds (in `colour` if the set is tinted); returns its index. */
  add(o: THREE.Object3D, colour = WHITE): number {
    const i = this.n++;
    this.m.compose(o.position, o.quaternion, o.scale);
    for (const im of this.meshes) {
      im.count = this.n;
      im.setMatrixAt(i, this.m);
      if (im.userData.tinted) im.setColorAt(i, colour);
    }
    return i;
  }

  /** Move copy `i` to the pose `o` holds. */
  set(i: number, o: THREE.Object3D): void {
    this.m.compose(o.position, o.quaternion, o.scale);
    for (const im of this.meshes) im.setMatrixAt(i, this.m);
    this.dirty = true;
  }

  /** Upload the copies that moved this frame. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const im of this.meshes) im.instanceMatrix.needsUpdate = true;
    // One knocked flying may have left the bounds.
    if (this.culled) this.seal();
  }
}

/** Deterministic PRNG so the city is the same every run. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Caribbean pastels for houses, paler tones for offices, glass tints for towers. */
const HOUSE_COLORS = [0xf3e3c3, 0xe8a87c, 0x86c5c0, 0xf5d77a, 0xf4f1ea, 0xe98a7a, 0xb7d3e9, 0xd9c2e8, 0xc8d6a4, 0xf2b8a2];
const OFFICE_COLORS = [0xf4f1ea, 0xe6e1d6, 0xd8dde3, 0xece4d2, 0xcfd6dc];
const TOWER_COLORS = [0xa9c4d8, 0x9fb3c4, 0xc8d4dc, 0x8fa9bd, 0xd6dee4];
/** Roofs, which the overhead view sees most: terracotta and pale concrete on houses, membranes on the big ones. */
const HOUSE_ROOFS = [0xb8664a, 0xa85a3e, 0xc47a5a, 0xd8d3c8, 0xefece6, 0x9fae98, 0xa3adb6];
const OFFICE_ROOFS = [0xd2cec6, 0xe8e6e0, 0xbab3a7, 0x8e9196, 0x6f7276];
const TOWER_ROOFS = [0x5d6066, 0x7d8086, 0x9a9ca0, 0xd0d0cc];
/** Signal lamps top to bottom (red, amber, green): [off, lit] colours; lit is bright enough to bloom. */
const SIGNAL = [
  [new THREE.Color(0.12, 0.02, 0.02), new THREE.Color(6, 0.4, 0.3)],
  [new THREE.Color(0.12, 0.08, 0.01), new THREE.Color(6, 3.4, 0.4)],
  [new THREE.Color(0.02, 0.1, 0.05), new THREE.Color(0.4, 6, 1.6)],
];
/** Pitched roofs: mostly terracotta in its shades, some slate and painted metal. */
const TILE_ROOFS = [0xc8623e, 0xb9553b, 0xd4774c, 0xa94a33, 0xcc8a5e, 0xc0603f, 0xb84e33, 0x7d838a, 0x67707a, 0x5f8466, 0x557799];

function pointInPoly(x: number, z: number, poly: THREE.Vector3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function polyArea(poly: THREE.Vector3[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

/** Flat triangulated polygon (with holes) at height y, normals up, UVs = world xz / uvScale. */
function flatPolygon(outer: THREE.Vector3[], holes: THREE.Vector3[][], y: number, uvScale: number): THREE.BufferGeometry {
  const v2 = (r: THREE.Vector3[]) => r.map((p) => new THREE.Vector2(p.x, p.z));
  const tris = THREE.ShapeUtils.triangulateShape(v2(outer), holes.map(v2));
  const all = [...outer, ...holes.flat()];
  const pos: number[] = [];
  const uv: number[] = [];
  for (const [i, j, k] of tris) {
    const a = all[i];
    let b = all[j];
    let c = all[k];
    // Wind counter-clockwise seen from above (normal +y).
    if ((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x) > 0) [b, c] = [c, b];
    for (const p of [a, b, c]) {
      pos.push(p.x, y, p.z);
      uv.push(p.x / uvScale, p.z / uvScale);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geo;
}

/** Strip along a polyline from lateral offset `from` to `to` (left positive), `y` above its points. UVs: across/along in meters / uvScale, or world xz. */
function ribbon(pts: THREE.Vector3[], from: number, to: number, y: number, uvScale: number, worldUV = false): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const left: THREE.Vector3[] = [];
  const right: THREE.Vector3[] = [];
  let s = 0;
  const along: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let n: THREE.Vector3;
    if (i > 0 && i < pts.length - 1) {
      const n1 = leftOf(pts[i].clone().sub(prev).setY(0).normalize());
      const n2 = leftOf(next.clone().sub(pts[i]).setY(0).normalize());
      n = n1.clone().add(n2);
      if (n.lengthSq() < 1e-6) n = n1;
      n.normalize();
      // Miter: keep the strip its full width through a bend (limited at sharp corners).
      n.multiplyScalar(1 / Math.max(0.5, n.dot(n1)));
    } else {
      n = leftOf(next.clone().sub(prev).setY(0).normalize());
    }
    if (i > 0) s += pts[i].distanceTo(pts[i - 1]);
    along.push(s);
    left.push(pts[i].clone().addScaledVector(n, to));
    right.push(pts[i].clone().addScaledVector(n, from));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const quad = [right[i], right[i + 1], left[i + 1], right[i], left[i + 1], left[i]];
    const quv = [
      [from, along[i]], [from, along[i + 1]], [to, along[i + 1]], [from, along[i]], [to, along[i + 1]], [to, along[i]],
    ];
    quad.forEach((p, k) => {
      pos.push(p.x, p.y + y, p.z);
      if (worldUV) uv.push(p.x / uvScale, p.z / uvScale);
      else uv.push(quv[k][0] / uvScale, quv[k][1] / uvScale);
    });
  }
  // Make every triangle face up. Strips run either way along a street, and a tight bend
  // (a wide road, a short segment) can fold a quad over; deciding from the first triangle
  // alone once turned the whole Piñero expressway face down, so it was culled.
  for (let i = 0; i < pos.length; i += 9) {
    // y of (b - a) x (c - a): negative faces down.
    const up = (pos[i + 5] - pos[i + 2]) * (pos[i + 6] - pos[i]) - (pos[i + 3] - pos[i]) * (pos[i + 8] - pos[i + 2]);
    if (up >= 0) continue;
    for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
    const j = (i / 9) * 6;
    [uv[j + 2], uv[j + 4]] = [uv[j + 4], uv[j + 2]];
    [uv[j + 3], uv[j + 5]] = [uv[j + 5], uv[j + 3]];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/** Part of a center line between arc lengths s0 and s1. */
function slice(edge: MapEdge, s0: number, s1: number): THREE.Vector3[] {
  const out = [MAP.pointAt(edge, s0)];
  for (let i = 0; i < edge.pts.length; i++) if (edge.cum[i] > s0 && edge.cum[i] < s1) out.push(edge.pts[i].clone());
  out.push(MAP.pointAt(edge, s1));
  return out;
}

/** Fill a vertex color attribute so geometry can share a vertex-colored material. */
function tint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return geo;
}

const IRON = new THREE.Color(0x26292e);
const RATTAN = new THREE.Color(0xb98b55);

/** A bistro table: a pale stone top on a cast-iron pedestal. Origin in the middle of its collider, 0.38 m up. */
function cafeTableGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(new THREE.CylinderGeometry(0.4, 0.4, 0.035, 16).toNonIndexed().translate(0, 0.36, 0), new THREE.Color(0xeee8dc)),
    tint(new THREE.CylinderGeometry(0.03, 0.03, 0.63, 6).toNonIndexed().translate(0, 0.025, 0), IRON),
    tint(new THREE.CylinderGeometry(0.2, 0.23, 0.04, 12).toNonIndexed().translate(0, -0.31, 0), IRON),
  ])!;
}

/** A bistro chair facing +z: a rattan seat and back on a thin iron frame. Origin in the middle of its collider, 0.43 m up. */
function cafeChairGeometry(): THREE.BufferGeometry {
  const parts = [
    tint(new THREE.BoxGeometry(0.4, 0.04, 0.4).toNonIndexed().translate(0, 0.02, 0), RATTAN),
    tint(new THREE.BoxGeometry(0.4, 0.34, 0.035).toNonIndexed().translate(0, 0.25, -0.19), RATTAN),
  ];
  for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
    parts.push(tint(new THREE.BoxGeometry(0.03, 0.45, 0.03).toNonIndexed().translate(x, -0.205, z), IRON));
  }
  for (const x of [-0.18, 0.18]) parts.push(tint(new THREE.BoxGeometry(0.03, 0.4, 0.03).toNonIndexed().translate(x, 0.22, -0.2), IRON));
  return mergeGeometries(parts)!;
}

/** A parasol's pole and its weighted base. Origin 1.25 m up (the middle of the pole's collider). */
function parasolPoleGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    tint(new THREE.CylinderGeometry(0.025, 0.025, 2.56, 6).toNonIndexed().translate(0, 0.08, 0), new THREE.Color(0xd9d4c8)),
    tint(new THREE.CylinderGeometry(0.28, 0.3, 0.05, 12).toNonIndexed().translate(0, -1.225, 0), IRON),
    tint(new THREE.SphereGeometry(0.05, 8, 6).toNonIndexed().translate(0, 1.38, 0), new THREE.Color(0xd9d4c8)),
  ])!;
}

/**
 * A parasol's canvas: an eight-panel cone with a short valance round its rim, the panels in
 * two shades (each café's colour comes from the instance colour). Same origin as the pole.
 */
function parasolCanopyGeometry(): THREE.BufferGeometry {
  const shade = (geo: THREE.BufferGeometry, trisPerPanel: number) => {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const panel = Math.floor(i / (3 * trisPerPanel));
      c.fill(panel % 2 ? 0.84 : 1, i * 3, i * 3 + 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return geo;
  };
  const cone = shade(new THREE.ConeGeometry(1.2, 0.36, 8, 1, true).toNonIndexed().translate(0, 1.18, 0), 1);
  const valance = shade(new THREE.CylinderGeometry(1.2, 1.2, 0.14, 8, 1, true).toNonIndexed().translate(0, 0.93, 0), 2);
  return mergeGeometries([cone, valance])!;
}

export class City {
  readonly group = new THREE.Group();
  readonly props: Prop[] = [];
  /** Intersections, for spawning police. */
  readonly intersections: THREE.Vector3[];
  /** The bank's glass panes, which shatter when hit. */
  readonly bankGlass: Prop[] = [];
  private rand = mulberry32(5);
  private facadeSets = (['residential', 'office', 'colonial'] as FacadeStyle[]).map((style, i) => facadeTextures(style, 101 + i * 37));
  private facadeMats = this.facadeSets.map(
    (t) => new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 1.4, vertexColors: true, roughness: 0.85 }),
  );
  private towerMat = new THREE.MeshStandardMaterial({
    map: this.facadeSets[1].map, emissiveMap: this.facadeSets[1].emissive, emissive: 0xffffff, emissiveIntensity: 1.2, vertexColors: true, roughness: 0.3, metalness: 0.45,
  });
  private storefrontMat = new THREE.MeshStandardMaterial({ map: storefrontTexture(), roughness: 0.5, metalness: 0.2 });
  private trimMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.8 });
  private roofMat = new THREE.MeshStandardMaterial({ color: 0x8d8f93, roughness: 0.8, metalness: 0.3 });
  /** The roof surfaces themselves (rooftop plant uses roofMat), tinted per building. */
  private roofTopMat = new THREE.MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: 0.92 });
  /** Pitched clay-tile roofs, tinted per house. */
  private tileMat = new THREE.MeshStandardMaterial({ map: tileTexture(), vertexColors: true, roughness: 0.8 });
  private tankMat = new THREE.MeshStandardMaterial({ color: 0x2f74c0, roughness: 0.45 });
  /** Skylights: glass that catches the sky. */
  private glassRoofMat = new THREE.MeshStandardMaterial({ color: 0x4f6f86, roughness: 0.08, metalness: 0.6, emissive: 0x1a2a38, emissiveIntensity: 0.6 });
  /** Plain coloured parts (balconies, penthouses, decks, masts), tinted per piece. */
  private balconyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  private poolMat = new THREE.MeshStandardMaterial({ color: 0x35b6e6, roughness: 0.12, metalness: 0.1, emissive: 0x0b4f6e, emissiveIntensity: 0.5 });
  /** Red aviation lights on the masts. */
  private beaconMat = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 4 });
  /** Seen from above and, behind the car, from underneath. */
  private awningMat = new THREE.MeshStandardMaterial({ map: awningTexture(), roughness: 0.85, side: THREE.DoubleSide });
  private concreteMat = new THREE.MeshStandardMaterial({ color: 0xbdb5a8, roughness: 0.9 });
  /** Lamp heads on the overpass: bright enough to bloom, like the street lamps'. */
  private lampHeadMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffd58a, emissiveIntensity: 4.5 });
  /** The street surfaces (buildRoads makes them), for the overpass's deck and ramps. */
  private streetMats!: { asphalt: THREE.Material; walk: THREE.Material; curb: THREE.Material; white: THREE.Material; yellow: THREE.Material };
  /** Static geometry collected per material and chunk, merged into one mesh each at the end. */
  private batches = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; cast: boolean }>();
  private water!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;
  /** One fixed body carries every static collider. */
  private ground: RAPIER.RigidBody;
  /** Building footprints by grid cell, for keeping props out of them. */
  private footprints = new Map<string, THREE.Vector3[][]>();
  /** Props that are drawn only near the camera. */
  private scenery: THREE.Object3D[] = [];
  /** Street lamps (they can be knocked over); the head is at LAMP_HEAD in each one's frame. */
  readonly lamps: THREE.Object3D[] = [];
  /** Park and street trees and shrubs, instanced per square. */
  private trees = new Trees(() => this.rand());
  /** Shopfront bays facing the street, where a café can put its tables out (see buildCafes). */
  private cafeSpots: { at: THREE.Vector3; along: THREE.Vector3; out: THREE.Vector3; width: number }[] = [];
  /** Props drawn instanced (the café furniture). */
  private instanced: PropInstances[] = [];
  /** Where the café tables stand (for tests). */
  readonly cafes: THREE.Vector3[] = [];
  /** Called when a prop's glass shatters, with where and how fast it was going. */
  onShatter?: (at: THREE.Vector3, velocity: THREE.Vector3) => void;

  constructor(private world: RAPIER.World) {
    this.ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.intersections = MAP.nodes.filter((n) => n.edges.length >= 3).map((n) => n.pos);
    this.buildGround();
    this.buildRoads();
    this.buildSignalLamps();
    this.buildBuildings();
    this.buildStation();
    this.buildBank();
    this.buildBridge();
    this.buildOverpass();
    this.buildWalls();
    this.buildLamps();
    this.buildProps();
    this.buildCafes();
    this.buildFiller();
    this.flushBatches();
    this.trees.build();
    this.group.add(this.trees.group);
  }

  /** Animate water ripples and cycle the traffic lights. */
  update(dt: number): void {
    const n = this.water.material.normalMap!;
    n.offset.x += dt * 0.004;
    n.offset.y += dt * 0.0025;
    this.signalTime += dt;
    if (this.signalLamps) {
      for (let i = 0; i < this.signals.length; i++) {
        const s = this.signals[i];
        // A 20 s cycle per intersection: one pair of directions green 8 s, amber 2 s, then the other.
        const t = (this.signalTime + s.offset + s.group * 10) % 20;
        const lit = t < 8 ? 2 : t < 10 ? 1 : 0;
        for (let k = 0; k < 3; k++) this.signalLamps.setColorAt(i * 3 + k, SIGNAL[k][k === lit ? 1 : 0]);
      }
      this.signalLamps.instanceColor!.needsUpdate = true;
    }
  }

  /** Traffic signals: position (for the lamp instances), cycle offset and which pair of directions. */
  private signals: { offset: number; group: number }[] = [];
  private signalLampAt: THREE.Vector3[] = [];
  private signalLamps?: THREE.InstancedMesh;
  private signalTime = 0;
  /** The first direction seen arriving at each signalled intersection (directions across it are the other group). */
  private signalAxis = new Map<THREE.Vector3, { axis: THREE.Vector3; offset: number }>();

  /**
   * A traffic signal for traffic arriving along `dir`: pole on the corner at
   * `pole`, an arm reaching back over the lanes (`right` points to the curb),
   * and a head facing the drivers, its lamps lit by update().
   */
  private addSignal(node: THREE.Vector3, pole: THREE.Vector3, right: THREE.Vector3, dir: THREE.Vector3, hw: number): void {
    let axis = this.signalAxis.get(node);
    if (!axis) this.signalAxis.set(node, (axis = { axis: dir.clone(), offset: this.rand() * 20 }));
    const group = Math.abs(dir.dot(axis.axis)) > 0.7 ? 0 : 1;
    const steel = new THREE.Color(0x3a3f45);
    const reach = Math.min(hw - 0.5, 7);
    const head = pole.clone().addScaledVector(right, -(reach + 1.1) + 0.3);
    this.batch(tint(new THREE.CylinderGeometry(0.11, 0.14, 6, 7).toNonIndexed().translate(pole.x, 3, pole.z), steel), this.balconyMat);
    const arm = new THREE.CylinderGeometry(0.09, 0.11, reach + 1.1, 5).toNonIndexed();
    arm.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), right.clone().negate())));
    arm.translate(...pole.clone().addScaledVector(right, -(reach + 1.1) / 2).setY(5.8).toArray());
    this.batch(tint(arm, steel), this.balconyMat);
    // The head: a dark box hanging under the arm's end, lamps on the face toward the drivers.
    const box = new THREE.BoxGeometry(0.5, 1.35, 0.4).toNonIndexed().translate(head.x, 5.1, head.z);
    this.batch(tint(box, new THREE.Color(0x1d2024)), this.balconyMat);
    for (let k = 0; k < 3; k++) this.signalLampAt.push(head.clone().addScaledVector(dir, -0.22).setY(5.55 - k * 0.42));
    this.signals.push({ offset: axis.offset, group });
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(3, 0.14).setTranslation(pole.x, 3, pole.z).setCollisionGroups(STREET_GROUPS), this.ground);
  }

  /** The signal lamps, one instanced draw (call after the roads are built). */
  private buildSignalLamps(): void {
    if (!this.signalLampAt.length) return;
    // Unlit, so a lit lamp's colour (well over 1) blooms.
    this.signalLamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.19, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }), this.signalLampAt.length);
    this.signalLampAt.forEach((p, i) => {
      this.signalLamps!.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y, p.z));
      this.signalLamps!.setColorAt(i, SIGNAL[i % 3][0]);
    });
    this.group.add(this.signalLamps);
  }

  private batch(geo: THREE.BufferGeometry, mat: THREE.Material, cast = true): void {
    // Whatever stands up off the ground (and so casts a shadow) can hide the car from above.
    if (cast) seeThrough(mat);
    geo.computeBoundingBox();
    const c = geo.boundingBox!.getCenter(new THREE.Vector3());
    const key = `${mat.uuid}|${cast ? 1 : 0}|${Math.floor(c.x / CHUNK)},${Math.floor(c.z / CHUNK)}`;
    let entry = this.batches.get(key);
    if (!entry) this.batches.set(key, (entry = { mat, geos: [], cast }));
    entry.geos.push(geo);
  }

  private flushBatches(): void {
    for (const { mat, geos, cast } of this.batches.values()) {
      const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
      if (!merged) {
        console.warn('[city] could not merge a batch for', mat.type);
        continue;
      }
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.batches.clear();
  }

  /** True if (x, z) is on a drivable street (or the bridge). */
  /** True if (x, z) is inside a building (or within `margin` m of one). */
  indoors(x: number, z: number, margin = 0): boolean {
    return this.inBuilding(x, z, margin);
  }

  isStreet(x: number, z: number): boolean {
    return MAP.onRoad(new THREE.Vector3(x, 0, z));
  }

  /** Sync meshes of props that are moving; show scenery near the camera only. */
  render(camera?: THREE.Camera): void {
    for (const p of this.props) {
      if (p.body.isSleeping()) continue;
      syncMesh(p.mesh, p.body);
      if (p.instance) p.instance.set.set(p.instance.index, p.mesh);
    }
    for (const s of this.instanced) s.flush();
    if (camera) {
      const c = camera.position;
      for (const o of this.scenery) o.visible = Math.abs(o.position.x - c.x) < 320 && Math.abs(o.position.z - c.z) < 320;
    }
  }

  /** Returns property damage caused since the last call. */
  collectDamage(): number {
    let dmg = 0;
    for (const p of this.props) {
      if (p.hit || p.body.isSleeping()) continue;
      const v = p.body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 4) {
        p.hit = true;
        dmg += p.value;
        if (p.glass?.visible) {
          p.glass.visible = false;
          const t = p.body.translation();
          this.onShatter?.(new THREE.Vector3(t.x, t.y + 0.4, t.z), new THREE.Vector3(v.x, Math.max(1, v.y), v.z));
        }
      }
    }
    return dmg;
  }

  // ---------------------------------------------------------------- build helpers

  /** Fixed box collider (turned `heading` about y), optionally drawn with `mat`. */
  private fixedBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, mat?: THREE.Material, heading = 0): void {
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(cx, cy, cz)
        .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
        .setFriction(0.6),
      this.ground,
    );
    if (mat) {
      const geo = this.buildingGeometry(hx * 2, hy * 2, hz * 2);
      geo.applyMatrix4(new THREE.Matrix4().makeRotationY(heading).setPosition(cx, cy, cz));
      this.batch(geo, mat);
    }
  }

  /** Box with UVs scaled so one facade repeat covers 24 m x 16 m (4 x 4 bays of 6 m x 4 m). */
  private buildingGeometry(w: number, h: number, d: number): THREE.BoxGeometry {
    const geo = new THREE.BoxGeometry(w, h, d);
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const faceWidths = [d, d, 0, 0, w, w];
    for (let f = 0; f < 6; f++) {
      for (let k = 0; k < 4; k++) {
        const i = f * 4 + k;
        if (faceWidths[f] === 0) uv.setXY(i, 0, 0);
        else uv.setXY(i, (uv.getX(i) * Math.max(1, Math.round(faceWidths[f] / 6))) / 4, (uv.getY(i) * Math.max(1, Math.round(h / 4))) / 4);
      }
    }
    return geo;
  }

  /**
   * The big flat roofs, which the overhead camera looks straight down on: a
   * stair and lift penthouse, and on apartment blocks a pool with a deck or a
   * garden; masts with red aviation lights on the towers.
   */
  private dressRoof(poly: THREE.Vector3[], h: number, wall: THREE.Color, tower: boolean, office: boolean): void {
    const r = orientedRect(poly);
    if (r.width < 8) return;
    const side = new THREE.Vector3().crossVectors(r.long, new THREE.Vector3(0, 1, 0));
    const at = (u: number, v: number) => r.center.clone().addScaledVector(r.long, u).addScaledVector(side, v);
    const inside = (u: number, v: number, hu: number, hv: number) =>
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([su, sv]) => {
        const p = at(u + su * hu, v + sv * hv);
        return pointInPoly(p.x, p.z, poly);
      });
    // A box on the roof, along the building, with plain (UV 0) faces.
    const box = (w: number, hh: number, d: number, u: number, v: number, y: number, color: THREE.Color | number, mat: THREE.Material = this.balconyMat) => {
      const g = new THREE.BoxGeometry(w, hh, d).toNonIndexed();
      (g.attributes.uv as THREE.BufferAttribute).array.fill(0);
      g.applyMatrix4(new THREE.Matrix4().makeBasis(r.long, new THREE.Vector3(0, 1, 0), side).setPosition(at(u, v).setY(y + hh / 2)));
      this.batch(mat === this.balconyMat ? tint(g, new THREE.Color(color)) : g, mat);
    };
    const end = r.length / 2 - 4;
    if (this.rand() < 0.7 && inside(end, 0, 2, 1.8)) box(3.6, 3, 3.2, end, 0, h, wall.clone().multiplyScalar(0.92));
    if (tower) {
      for (let k = 0; k < 1 + Math.floor(this.rand() * 2); k++) {
        const u = (this.rand() - 0.5) * r.length * 0.6;
        const v = (this.rand() - 0.5) * r.width * 0.6;
        if (!inside(u, v, 0.3, 0.3)) continue;
        const tall = 7 + this.rand() * 7;
        const p = at(u, v);
        this.batch(tint(new THREE.CylinderGeometry(0.12, 0.2, tall, 6).toNonIndexed().translate(p.x, h + tall / 2, p.z), new THREE.Color(0x9aa0a6)), this.balconyMat);
        this.batch(new THREE.SphereGeometry(0.35, 8, 6).translate(p.x, h + tall + 0.2, p.z), this.beaconMat);
      }
      return;
    }
    if (office || r.length < 14 || r.width < 10) {
      if (r.length >= 12 && r.width >= 9) this.roofPlant(r.length, r.width, h, inside, box);
      return;
    }
    const roll = this.rand();
    if (roll < 0.3 && inside(-2, 0, 5, 3.2)) {
      // Pool on a wooden deck.
      box(10, 0.08, 6.4, -2, 0, h, 0xb08654);
      box(7.5, 0.1, 3.8, -2, 0, h + 0.02, 0xffffff, this.poolMat);
    } else if (roll < 0.5 && inside(-2, 0, 4, 3)) {
      // Garden: lawn and a few shrubs.
      box(8, 0.1, 6, -2, 0, h, 0x5f8a3e);
      for (let k = 0; k < 4; k++) {
        const p = at(-2 + (this.rand() - 0.5) * 6, (this.rand() - 0.5) * 4);
        this.batch(tint(new THREE.IcosahedronGeometry(0.8 + this.rand() * 0.5, 1).translate(p.x, h + 0.7, p.z), new THREE.Color(0x3f7a33)), this.balconyMat);
      }
    }
  }

  /**
   * Plant on a flat commercial roof, which the oblique camera sees a lot of:
   * air-conditioning units in a row, vents, a skylight strip and a water tank.
   */
  private roofPlant(
    length: number,
    width: number,
    h: number,
    inside: (u: number, v: number, hu: number, hv: number) => boolean,
    box: (w: number, hh: number, d: number, u: number, v: number, y: number, color: THREE.Color | number, mat?: THREE.Material) => void,
  ): void {
    const units = Math.min(8, 2 + Math.floor((length * width) / 260));
    const rowV = (this.rand() - 0.5) * width * 0.4;
    for (let k = 0; k < units; k++) {
      const u = (k / Math.max(1, units - 1) - 0.5) * length * 0.6 + (this.rand() - 0.5) * 1.2;
      if (!inside(u, rowV, 1.2, 1)) continue;
      box(2.2, 1.2, 1.6, u, rowV, h, 0xc3c6c8);
      // The fan grille on top.
      box(1.2, 0.08, 1.2, u, rowV, h + 1.2, 0x4a4e52);
    }
    for (let k = 0; k < 3; k++) {
      const u = (this.rand() - 0.5) * length * 0.7;
      const v = (this.rand() - 0.5) * width * 0.7;
      if (inside(u, v, 0.5, 0.5)) box(0.7, 0.9, 0.7, u, v, h, 0x8d9196);
    }
    if (this.rand() < 0.6) {
      const v = -rowV * 0.8;
      if (inside(0, v, length * 0.25, 1)) box(length * 0.5, 0.35, 1.6, 0, v, h, 0x6d8fa8, this.glassRoofMat);
    }
    if (this.rand() < 0.5) {
      const u = (this.rand() < 0.5 ? -1 : 1) * length * 0.32;
      if (inside(u, 0, 1.6, 1.6)) {
        box(0.25, 2.2, 2.4, u, 0, h, 0x5b5f64);
        box(2.6, 2.2, 2.6, u, 0, h + 2.2, 0x9aa4ae);
      }
    }
  }

  /** Does a wall at `mid`, facing `out`, look onto a street within about 16 m? */
  private facesStreet(mid: THREE.Vector3, out: THREE.Vector3): boolean {
    for (const d of [3, 7, 11, 16]) if (MAP.onRoad(mid.clone().addScaledVector(out, d), 0.5)) return true;
    return false;
  }

  /** Is there a building at (x, z)? */
  private inBuilding(x: number, z: number, margin = 0): boolean {
    const gx = Math.floor(x / 50);
    const gz = Math.floor(z / 50);
    for (let i = gx - 1; i <= gx + 1; i++) {
      for (let j = gz - 1; j <= gz + 1; j++) {
        for (const poly of this.footprints.get(`${i},${j}`) ?? []) {
          if (pointInPoly(x, z, poly)) return true;
          if (margin > 0) {
            for (let k = 0; k < poly.length; k++) {
              const a = poly[k];
              const b = poly[(k + 1) % poly.length];
              const t = THREE.MathUtils.clamp(((x - a.x) * (b.x - a.x) + (z - a.z) * (b.z - a.z)) / Math.max(1e-6, a.distanceToSquared(b)), 0, 1);
              if (Math.hypot(a.x + (b.x - a.x) * t - x, a.z + (b.z - a.z) * t - z) < margin) return true;
            }
          }
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- ground, water, parks

  private buildGround(): void {
    const groundMat = new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.97 });
    for (const poly of RAW.land) {
      const [outer, ...holes] = poly.map((r) => points(r).slice(0, -1));
      this.batch(flatPolygon(outer, holes, 0, 32), groundMat, false);
    }
    // Physically the ground is one flat slab under everything, bridge included: a triangle mesh
    // here had seams that caught the dragged vault dead at speed. The water is out of reach
    // behind the seawalls and the bridge rails, so it needn't be a hole. It reaches past the
    // far end of the bridge's run-on (see BRIDGE_RUN), so there's no seam out there either.
    const center = this.mapCenter();
    const far = BRIDGE.pts[BRIDGE.pts.length - 1];
    const half = Math.max(6000, Math.abs(far.x - center.x) + 1000, Math.abs(far.z - center.z) + 1000);
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(half, 1, half).setTranslation(center.x, -1, center.z).setFriction(0.6), this.ground);

    // Water under everything: the lagoon, the bay, the edge of the world.
    const ripples = waterNormalTexture();
    ripples.repeat.set(WATER_TILES, WATER_TILES);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE),
      new THREE.MeshPhysicalMaterial({ color: 0x1d4a5a, roughness: 0.12, metalness: 0.1, normalMap: ripples, normalScale: new THREE.Vector2(0.35, 0.35), clearcoat: 0.6 }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(center.x, WATER_Y, center.z);
    this.group.add(this.water);

    // Parks and parking lots, with shade trees in the parks.
    const grass = grassTexture();
    const grassMat = new THREE.MeshStandardMaterial({ map: grass, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const lotTex = asphaltTexture();
    const lotMat = new THREE.MeshStandardMaterial({ map: lotTex, color: 0xb0aca4, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const trees: THREE.Vector3[] = [];
    for (const a of RAW.areas) {
      const poly = points(a.p);
      this.batch(flatPolygon(poly, [], a.k === 'green' ? 0.02 : 0.025, 8), a.k === 'green' ? grassMat : lotMat, false);
      if (a.k !== 'green') continue;
      const area = Math.abs(polyArea(poly));
      const box = new THREE.Box3().setFromPoints(poly);
      for (let n = Math.min(90, Math.floor(area / 170)); n > 0 && trees.length < 3500; n--) {
        const x = box.min.x + this.rand() * (box.max.x - box.min.x);
        const z = box.min.z + this.rand() * (box.max.z - box.min.z);
        if (pointInPoly(x, z, poly) && !MAP.onRoad(new THREE.Vector3(x, 0, z), 2) && !onOverpass(new THREE.Vector3(x, 0, z), 4)) trees.push(new THREE.Vector3(x, 0, z));
      }
    }
    for (const p of trees) {
      this.plantTree(p, 0.95 + this.rand() * 0.6);
      // Shrubs round about.
      for (let k = this.rand() < 0.5 ? 1 + Math.floor(this.rand() * 2) : 0; k > 0; k--) {
        const a = this.rand() * Math.PI * 2;
        const q = p.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(3 + this.rand() * 3));
        if (!MAP.onRoad(q, 1.5) && !onOverpass(q, 2)) this.trees.shrub(q, 0.22 + this.rand() * 0.14);
      }
    }
  }

  /** A tree that stops cops and traffic (not the crew, see STREET_BIT): instanced for drawing, with a fixed trunk collider. */
  private plantTree(p: THREE.Vector3, size: number): void {
    this.trees.tree(p, size);
    this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(1.6, 0.25 * size + 0.08).setTranslation(p.x, 1.6, p.z).setFriction(0.6).setCollisionGroups(STREET_GROUPS),
      this.ground,
    );
  }

  /** Middle of the map (for the ground slab and the water plane). */
  mapCenter(): THREE.Vector3 {
    return BOUNDS.getCenter(new THREE.Vector3()).setY(0);
  }

  /**
   * Keep the water under the camera wherever it goes (the bridge runs on for kilometres):
   * the plane moves in whole ripple tiles, so the ripples stay put.
   */
  follow(focus: THREE.Vector3): void {
    const tile = WATER_SIZE / WATER_TILES;
    this.water.position.x = Math.round(focus.x / tile) * tile;
    this.water.position.z = Math.round(focus.z / tile) * tile;
  }

  // ---------------------------------------------------------------- streets

  private buildRoads(): void {
    const asphalt = asphaltTextures();
    // Damp asphalt with puddles: they mirror the evening sky, and the streaks
    // GroundFx paints under every light read as their reflections.
    const asphaltMat = mirrorsLamps(
      new THREE.MeshStandardMaterial({
        map: asphalt.map, normalMap: asphalt.normal, normalScale: new THREE.Vector2(0.7, 0.7), roughnessMap: asphaltWetTexture(), roughness: 1, envMapIntensity: 1.35,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }),
    );
    const mosaicMat = new THREE.MeshStandardMaterial({ map: mosaicTexture(), roughness: 0.85 });
    const walkMat = new THREE.MeshStandardMaterial({ map: sidewalkTexture(), color: 0xe4ddd0, roughness: 0.9 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe8c94a, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.streetMats = { asphalt: asphaltMat, walk: walkMat, curb: curbMat, white, yellow };

    /** How far from a node its streets' markings and sidewalks stop (the intersection box). */
    const clear = (n: (typeof MAP.nodes)[number], except: MapEdge) => Math.max(0, ...n.edges.filter((e) => e !== except).map((e) => e.hw)) + 1.5;

    const dashes: THREE.Matrix4[] = [];
    const laneDashes: THREE.Matrix4[] = [];
    const stripes: THREE.Matrix4[] = [];
    const stops: THREE.Matrix4[] = [];
    const arrows = { straight: [] as THREE.Matrix4[], left: [] as THREE.Matrix4[], right: [] as THREE.Matrix4[] };
    const up = new THREE.Vector3(0, 1, 0);
    /** Dash transforms along a path at a sideways offset (left positive), one every `period` m. */
    const dashAlong = (path: THREE.Vector3[], offset: number, period: number, out: THREE.Matrix4[]) => {
      let s = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const len = a.distanceTo(b);
        if (len < 1e-3) continue;
        const dir = b.clone().sub(a).divideScalar(len);
        const side = leftOf(dir);
        const yaw = Math.atan2(dir.x, dir.z);
        for (; s < len; s += period) {
          const p = a.clone().lerp(b, s / len).addScaledVector(side, offset);
          out.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(p.x, 0.065, p.z));
        }
        s -= len;
      }
    };
    /** Where a street's markings stop short of a node: at an intersection, not where the bridge just carries on. */
    const stopAt = (n: (typeof MAP.nodes)[number], e: MapEdge) => (n.edges.length > 1 && !n.edges.every((x) => x.bridge) ? clear(n, e) : 0);
    for (const e of MAP.edges) {
      this.batch(ribbon(e.pts, -e.hw, e.hw, 0.05, 16, true), asphaltMat, false);
      const ca = stopAt(e.a, e);
      const cb = stopAt(e.b, e);
      if (e.length - ca - cb < 4) continue;
      const mid = slice(e, ca, e.length - cb);
      // The bridge: solid edge lines inside the barriers (and lanes, below).
      if (e.bridge) for (const side of [1, -1]) this.batch(ribbon(mid, side * (e.hw - 0.6) - 0.09, side * (e.hw - 0.6) + 0.09, 0.06, 4), white, false);
      // Sidewalks with a curb along the avenues (the main ones in Rio's wave mosaic); edge lines.
      if (e.rank <= 4 && !e.bridge) {
        const mat = e.rank <= 2 ? mosaicMat : walkMat;
        for (const side of [1, -1]) {
          const [from, to] = side > 0 ? [e.hw, e.hw + SIDEWALK] : [-e.hw - SIDEWALK, -e.hw];
          this.batch(ribbon(mid, from, to, 0.14, 4), mat, false);
          const curbAt = side * e.hw;
          const curb = ribbon(mid, curbAt - 0.12 * side, curbAt + 0.12 * side, 0.15, 4);
          this.batch(curb, curbMat, false);
          this.batch(ribbon(mid, side * (e.hw - 0.6) - 0.09, side * (e.hw - 0.6) + 0.09, 0.06, 4), white, false);
        }
      }
      // Center line on two-way streets wide enough for one: double solid yellow on the avenues,
      // dashed on the rest; dashed white lane lines on the wide ones (two or three lanes each way).
      if (e.hw >= 6) {
        if (e.rank <= 3) for (const o of [-0.2, 0.2]) this.batch(ribbon(mid, o - 0.07, o + 0.07, 0.06, 4), yellow, false);
        else dashAlong(mid, 0, 10, dashes);
        if (e.hw >= 8) {
          const lanes = e.hw >= 11 ? 3 : 2;
          const w = (e.hw - 0.6) / lanes;
          for (let k = 1; k < lanes; k++) for (const side of [1, -1]) dashAlong(mid, side * w * k, 9, laneDashes);
        }
      }
      // Stop lines across the lanes arriving at an intersection (traffic keeps right), before any
      // crossing; on the avenues, an arrow in each of those lanes: left, ahead, right.
      if (!e.bridge && e.length - ca - cb > 24) {
        for (const [n, s0, arriving] of [[e.a, ca, -1], [e.b, e.length - cb, 1]] as const) {
          if (n.edges.length < 3) continue;
          const sStop = s0 - arriving * (e.rank <= 4 ? 4 : 1);
          const t = MAP.tangentAt(e, sStop);
          const dir = t.clone().multiplyScalar(arriving);
          const right = leftOf(dir).negate();
          const p = MAP.pointAt(e, sStop);
          const yaw = Math.atan2(dir.x, dir.z);
          const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
          const across = e.hw - 0.85;
          stops.push(new THREE.Matrix4().compose(p.clone().addScaledVector(right, 0.25 + across / 2).setY(0.066), q, new THREE.Vector3(across, 1, 0.45)));
          // Where an avenue crosses, a signal on a mast arm over the arriving lanes.
          if (Math.min(...n.edges.map((x) => x.rank)) <= 3) this.addSignal(n.pos, p.clone().addScaledVector(right, e.hw + 1.1), right, dir, e.hw);
          if (e.rank > 3 || e.hw < 6) continue;
          const lanes = e.hw >= 11 ? 3 : e.hw >= 8 ? 2 : 1;
          const w = (e.hw - 0.6) / lanes;
          const at = MAP.pointAt(e, sStop - arriving * 11);
          for (let k = 0; k < lanes; k++) {
            const kind = lanes === 1 ? 'straight' : k === 0 ? 'left' : k === lanes - 1 ? 'right' : 'straight';
            arrows[kind].push(new THREE.Matrix4().compose(at.clone().addScaledVector(right, w * (k + 0.5)).setY(0.067), q, new THREE.Vector3(1, 1, 1)));
          }
        }
      }
      // Zebra crossings where avenues meet other streets.
      if (e.rank <= 4) {
        for (const [n, s] of [[e.a, ca], [e.b, e.length - cb]] as const) {
          if (n.edges.length < 3) continue;
          const p = MAP.pointAt(e, s);
          const t = MAP.tangentAt(e, s);
          const l = leftOf(t);
          const back = n === e.a ? 1.5 : -1.5;
          const yaw = Math.atan2(t.x, t.z);
          for (let k = -e.hw + 1; k <= e.hw - 1; k += 1.3) {
            const q = p.clone().addScaledVector(l, k).addScaledVector(t, back);
            stripes.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(q.x, 0.066, q.z));
          }
        }
      }
    }
    // Intersections: a disc of asphalt as wide as the widest street there.
    for (const n of MAP.nodes) {
      if (n.edges.length < 2) continue;
      const r = Math.max(...n.edges.map((e) => e.hw));
      const ring: THREE.Vector3[] = [];
      for (let k = 0; k < 20; k++) ring.push(new THREE.Vector3(n.pos.x + Math.cos((k / 20) * Math.PI * 2) * r, 0, n.pos.z + Math.sin((k / 20) * Math.PI * 2) * r));
      this.batch(flatPolygon(ring, [], 0.05, 16), asphaltMat, false);
    }
    const dashMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.25, 4).rotateX(-Math.PI / 2), yellow, dashes.length);
    dashes.forEach((m, i) => dashMesh.setMatrixAt(i, m));
    dashMesh.receiveShadow = true;
    const stripeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.6, 3.5).rotateX(-Math.PI / 2), white, stripes.length);
    stripes.forEach((m, i) => stripeMesh.setMatrixAt(i, m));
    stripeMesh.receiveShadow = true;
    this.group.add(dashMesh, stripeMesh);
    const instanced = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    instanced(new THREE.PlaneGeometry(0.15, 3).rotateX(-Math.PI / 2), white, laneDashes);
    // A unit square, stretched per stop line.
    instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), white, stops);
    // Arrows: the texture's top points along the lane (rotateY so v runs along +z).
    const arrowGeo = new THREE.PlaneGeometry(2.4, 4.8).rotateX(-Math.PI / 2).rotateY(Math.PI);
    for (const kind of ['straight', 'left', 'right'] as const) {
      const mat = new THREE.MeshStandardMaterial({ map: arrowTexture(kind), color: 0xe9e9e4, roughness: 0.7, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
      instanced(arrowGeo, mat, arrows[kind]);
    }
  }

  // ---------------------------------------------------------------- buildings

  private buildBuildings(): void {
    const color = new THREE.Color();
    const pick = (list: number[]) => list[Math.floor(this.rand() * list.length)];
    for (const b of RAW.buildings) {
      const poly = points(b.p);
      const r = this.rand();
      const h = b.h;
      // Glass towers on the Golden Mile, offices and apartments in between, painted houses.
      const tower = h >= 28;
      const mat = tower ? this.towerMat : h >= 12 ? this.facadeMats[r < 0.55 ? 1 : 0] : this.facadeMats[r < 0.6 ? 0 : 2];
      const palette = tower ? TOWER_COLORS : h >= 12 ? OFFICE_COLORS : HOUSE_COLORS;
      const wall = new THREE.Color(pick(palette));
      this.batch(tint(this.walls(poly, 0, h, 24, 16), wall), mat);

      // Houses that are near enough rectangles get a pitched tile roof (gable or hip); the
      // rest of the city has flat roofs with a parapet.
      const rect = h < 8 ? orientedRect(poly) : null;
      const pitched = !!rect && rect.fill > 0.82 && rect.width >= 4 && rect.width <= 16 && rect.length <= 32 && this.rand() < 0.75;
      if (pitched) {
        const hip = rect.length / rect.width < 1.3 || this.rand() < 0.4;
        const { roof, gables } = pitchedRoof(rect, h, hip);
        this.batch(tint(roof, color.setHex(pick(TILE_ROOFS))), this.tileMat);
        if (gables) this.batch(tint(gables, wall), mat);
      } else {
        const roofs = tower ? TOWER_ROOFS : h >= 12 ? OFFICE_ROOFS : HOUSE_ROOFS;
        this.batch(tint(this.roof(poly, h), color.setHex(pick(roofs))), this.roofTopMat);
        // Parapet: a pale cornice on the big buildings, the wall colour on houses.
        if (h >= 8) this.batch(parapet(poly, h, 0.9, 0.35, 0.3), this.trimMat);
        else if (h >= 3) this.batch(tint(parapet(poly, h, 0.5, 0.25), wall), mat);
      }

      const c = poly.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(poly.length);
      // Shops on the ground floor along the avenues, with striped awnings over their doors.
      const street = h >= 6 ? MAP.locate(c, undefined, 40) : null;
      const shops = !!street && street.edge.rank <= 3;
      if (shops) this.batch(this.walls(poly, 0, 4.2, 24, 0, 0.12), this.storefrontMat);
      // Balconies on the street sides of apartment blocks (not the glass offices).
      const balconies = !tower && h >= 8 && mat !== this.facadeMats[1] ? 0.35 + this.rand() * 0.5 : 0;
      const slab = new THREE.Color(pick([0xeae6de, 0xdcd6cc, 0xf2f0ea]));
      const rail = new THREE.Color(pick([0xf0f0ec, 0x34404c, 0x2a2a2a, 0x8fa3b5]));
      if (shops || balconies) {
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b2 = poly[(i + 1) % poly.length];
          const len = a.distanceTo(b2);
          if (len < 5) continue;
          const along = b2.clone().sub(a).divideScalar(len);
          const out = new THREE.Vector3(along.z, 0, -along.x);
          if (!this.facesStreet(a.clone().lerp(b2, 0.5), out)) continue;
          // Bays match the facade texture's: whole 6 m bays, windows centred, floors every 4 m.
          const bays = Math.max(1, Math.round(len / 6));
          for (let k = 0; k < bays; k++) {
            const at = a.clone().lerp(b2, (k + 0.5) / bays);
            if (shops && this.rand() < 0.75) {
              const width = Math.min(4.6, (len / bays) * 0.85);
              this.batch(awning(at.clone().addScaledVector(out, 0.12), along, out, width, Math.floor(this.rand() * 4)), this.awningMat);
              this.cafeSpots.push({ at: at.clone(), along: along.clone(), out: out.clone(), width });
            }
            for (let y = 4; y < h - 2.5; y += 4) {
              if (this.rand() > balconies) continue;
              const bal = balcony(at, along, out, y, 3.2, 1.1);
              this.batch(tint(bal.slab, slab), this.balconyMat);
              this.batch(tint(bal.rail, rail), this.balconyMat);
            }
          }
        }
      }
      const area = polyArea(poly);
      // Blue fibreglass water tanks on the small flat roofs, as all over Rio's hills.
      if (!pitched && h < 8 && area > 25 && this.rand() < 0.55) {
        const box = new THREE.Box3().setFromPoints(poly);
        for (let tries = 0; tries < 6; tries++) {
          const x = box.min.x + 1.2 + this.rand() * Math.max(0, box.max.x - box.min.x - 2.4);
          const z = box.min.z + 1.2 + this.rand() * Math.max(0, box.max.z - box.min.z - 2.4);
          if (!pointInPoly(x, z, poly)) continue;
          this.batch(new THREE.CylinderGeometry(0.75, 0.65, 1.1, 10).translate(x, h + 0.55, z), this.tankMat);
          break;
        }
      }
      // Rooftop water tanks and AC units on the bigger flat roofs (every roof in San Juan has them).
      if (!pitched && area > 60 && h >= 8) {
        const box = new THREE.Box3().setFromPoints(poly);
        const units = 1 + Math.floor(this.rand() * 3);
        for (let k = 0, tries = 0; k < units && tries < 12; tries++) {
          const x = box.min.x + 2 + this.rand() * Math.max(0, box.max.x - box.min.x - 4);
          const z = box.min.z + 2 + this.rand() * Math.max(0, box.max.z - box.min.z - 4);
          if (!pointInPoly(x, z, poly)) continue;
          k++;
          if (this.rand() < 0.45) this.batch(new THREE.CylinderGeometry(1.1, 1.1, 2.2, 10).translate(x, h + 1.1, z), this.roofMat);
          else this.batch(new THREE.BoxGeometry(2.2, 1.4, 1.6).translate(x, h + 0.7, z), this.roofMat);
        }
      }
      if (!pitched && h >= 12) this.dressRoof(poly, h, wall, tower, mat === this.facadeMats[1]);
      this.addBuildingCollider(poly, h);
      const key = `${Math.floor(c.x / 50)},${Math.floor(c.z / 50)}`;
      let list = this.footprints.get(key);
      if (!list) this.footprints.set(key, (list = []));
      list.push(poly);
    }
  }

  /**
   * Walls around a footprint from y0 to y1, pushed out by `out` m. UVs repeat
   * every `uRepeat` m around (whole 6 m bays per face) and `vRepeat` m up (0 = stretch once).
   */
  private walls(poly: THREE.Vector3[], y0: number, y1: number, uRepeat: number, vRepeat: number, out = 0): THREE.BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const nrm: number[] = [];
    let u = 0;
    const vTop = vRepeat ? Math.max(1, Math.round((y1 - y0) / 4)) / 4 : 1;
    for (let i = 0; i < poly.length; i++) {
      let a = poly[i];
      let b = poly[(i + 1) % poly.length];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const nx = dz / len;
      const nz = -dx / len;
      if (out) {
        a = a.clone().add(new THREE.Vector3(nx * out, 0, nz * out));
        b = b.clone().add(new THREE.Vector3(nx * out, 0, nz * out));
      }
      const du = uRepeat ? Math.max(1, Math.round(len / 6)) * (6 / uRepeat) : 1;
      // a0, a1, b1 / a0, b1, b0: wound to face outward.
      const quad = [[a, y0, u, 0], [a, y1, u, vTop], [b, y1, u + du, vTop], [a, y0, u, 0], [b, y1, u + du, vTop], [b, y0, u + du, 0]] as const;
      for (const [p, y, uu, vv] of quad) {
        pos.push(p.x, y, p.z);
        uv.push(uu, vv);
        nrm.push(nx, 0, nz);
      }
      u += du;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    return geo;
  }

  private roof(poly: THREE.Vector3[], h: number): THREE.BufferGeometry {
    return flatPolygon(poly, [], h, 8);
  }

  /** Solid footprint: a convex hull when the building is nearly convex, else its walls as a mesh. */
  private addBuildingCollider(poly: THREE.Vector3[], h: number): void {
    const hullPts = new Float32Array(poly.length * 6);
    poly.forEach((p, i) => hullPts.set([p.x, 0, p.z, p.x, h, p.z], i * 6));
    const area = polyArea(poly);
    // Area of the 2D convex hull.
    const sorted = [...poly].sort((a, b) => a.x - b.x || a.z - b.z);
    const cross = (o: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
    const lower: THREE.Vector3[] = [];
    const upper: THREE.Vector3[] = [];
    for (const p of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (const p of [...sorted].reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    const hullArea = Math.abs(polyArea(hull));
    let desc: RAPIER.ColliderDesc | null = null;
    if (hullArea <= area * 1.15) desc = RAPIER.ColliderDesc.convexHull(hullPts);
    if (!desc) {
      const g = this.walls(poly, 0, h, 0, 0);
      const p = g.attributes.position as THREE.BufferAttribute;
      desc = RAPIER.ColliderDesc.trimesh(new Float32Array(p.array), new Uint32Array([...Array(p.count).keys()]));
      g.dispose();
    }
    this.world.createCollider(desc.setFriction(0.6), this.ground);
  }

  // ---------------------------------------------------------------- props

  addProp(
    mesh: THREE.Object3D,
    pos: THREE.Vector3,
    collider: RAPIER.ColliderDesc,
    value: number,
    heading = 0,
    /** A parked car (see Prop.heavy). */
    heavy = false,
  ): Prop {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
        .setSleeping(true)
        .setAngularDamping(0.3),
    );
    this.world.createCollider(collider, body);
    syncMesh(mesh, body);
    mesh.traverse((o) => (o.castShadow = true));
    this.group.add(mesh);
    const prop = { body, mesh, value, hit: false, heavy };
    this.props.push(prop);
    return prop;
  }

  /** Remove a prop from the world (shattered glass). */
  removeProp(p: Prop): void {
    this.world.removeRigidBody(p.body);
    p.mesh.removeFromParent();
    const i = this.props.indexOf(p);
    if (i >= 0) this.props.splice(i, 1);
  }

  /**
   * Palms, light posts, bus kiosks and parked cars along the sidewalks, densest
   * along Mia's route and the avenues. Far-off ones aren't drawn.
   */
  private buildProps(): void {
    const route = PLAN.map((n) => n.pos);
    const nearRoute = (p: THREE.Vector3) => route.some((q, i) => i < route.length - 1 && segDist(p, q, route[i + 1]) < 220);
    let count = 0;
    for (const e of [...MAP.edges].sort((a, b) => a.rank - b.rank)) {
      if (e.bridge || e.length < 30 || count > 900) continue;
      const important = e.rank <= 4;
      const mid = MAP.pointAt(e, e.length / 2);
      const close = nearRoute(mid);
      if (!important && !close) continue;
      const spacing = important ? 17 : 26;
      const ca = Math.max(...e.a.edges.map((x) => x.hw)) + 5;
      const cb = Math.max(...e.b.edges.map((x) => x.hw)) + 5;
      for (let s = ca + this.rand() * 6; s < e.length - cb; s += spacing + this.rand() * 6) {
        for (const side of [1, -1]) {
          const p = MAP.pointAt(e, s);
          const t = MAP.tangentAt(e, s);
          const l = leftOf(t).multiplyScalar(side);
          const curb = p.clone().addScaledVector(l, e.hw + (important ? 1.2 : 0.8));
          if (MAP.onRoad(curb, 0.5) || this.inBuilding(curb.x, curb.z, 0.8) || onOverpass(curb, 3) || this.nearLamp(curb)) continue;
          const out = { along: t, out: l };
          const roll = this.rand();
          // (The lamps are in rows of their own: see buildLamps.)
          if (roll < (important ? 0.3 : 0.4)) this.addPalm(curb);
          else if (roll < (important ? 0.48 : 0.58)) this.plantTree(curb, 0.6 + this.rand() * 0.3);
          else if (roll < (important ? 0.72 : 0.8)) continue;
          else if (roll < 0.8 && important) this.addKiosk(curb, out);
          else if (roll < 0.9) this.addBench(curb.clone().addScaledVector(l, 0.6), out);
          else this.addBin(curb);
          count++;
          // Parked cars along the curb on the smaller streets and some avenues.
          if (e.rank >= 3 && this.rand() < (important ? 0.12 : 0.22)) {
            const cp = p.clone().addScaledVector(l, e.hw - 1.4).addScaledVector(t, 6);
            if (!MAP.onRoad(cp.clone().addScaledVector(l, 3), 0) || e.hw > 6) this.addParkedCar(cp, Math.atan2(t.x, t.z));
          }
        }
      }
    }
  }

  private static palmGeo?: THREE.BufferGeometry;
  private static palmMats?: THREE.Material[];

  private addPalm(pos: THREE.Vector3): void {
    City.palmGeo ??= palmGeometry();
    City.palmMats ??= palmMaterials();
    const mesh = new THREE.Mesh(City.palmGeo, City.palmMats);
    this.addProp(mesh, pos.clone().setY(4.2), RAPIER.ColliderDesc.cylinder(4, 0.3).setMass(250).setFriction(0.6), 2500, this.rand() * Math.PI * 2);
    this.scenery.push(mesh);
  }

  private static postParts?: { geo: THREE.BufferGeometry; mat: THREE.Material }[];
  /** Street lamps, instanced by square of the map (see LAMP_SQUARE). */
  private lampSets = new Map<string, PropInstances>();

  /**
   * A street lamp on the curb. `side.out` points away from the street; the arm
   * reaches back over it. Drawn instanced, a set per square of the map, each
   * with its own body so the vault can still flatten it.
   */
  private addLightPost(pos: THREE.Vector3, side: { out: THREE.Vector3 }): void {
    City.postParts ??= [
      {
        geo: mergeGeometries([new THREE.BoxGeometry(0.22, 7, 0.22), new THREE.BoxGeometry(0.15, 0.15, 2.4).translate(0, 3.4, 1.1)])!,
        mat: new THREE.MeshStandardMaterial({ color: 0x3c4148, metalness: 0.6, roughness: 0.5 }),
      },
      {
        geo: new THREE.BoxGeometry(0.4, 0.2, 0.7).translate(LAMP_HEAD.x, LAMP_HEAD.y, LAMP_HEAD.z),
        // Bright enough to bloom: from above, a lamp is its glow.
        mat: new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffd58a, emissiveIntensity: 4.5 }),
      },
    ];
    const key = `${Math.floor(pos.x / LAMP_SQUARE)},${Math.floor(pos.z / LAMP_SQUARE)}`;
    let set = this.lampSets.get(key);
    if (!set) {
      set = new PropInstances(City.postParts, 1024, true);
      this.lampSets.set(key, set);
      this.instanced.push(set);
      this.group.add(...set.meshes);
    }
    const stand = this.instancedProp(set, pos.clone().setY(3.7), [RAPIER.ColliderDesc.cuboid(0.15, 3.5, 0.15).setMass(150)], 1800, Math.atan2(-side.out.x, -side.out.z));
    if (stand) this.lamps.push(stand);
  }

  /**
   * Street lamps in rows down every street, staggered from one side to the
   * other: closest on the avenues. At night they're what lights the city.
   */
  private buildLamps(): void {
    for (const e of MAP.edges) {
      if (e.bridge || e.length < 30) continue;
      const spacing = (e.rank <= 2 ? 30 : e.rank <= 4 ? 34 : 44) / 2;
      const ca = Math.max(...e.a.edges.map((x) => x.hw)) + 4;
      const cb = Math.max(...e.b.edges.map((x) => x.hw)) + 4;
      let side = e.id % 2 ? 1 : -1;
      for (let s = ca + 2; s < e.length - cb; s += spacing, side = -side) {
        const p = MAP.pointAt(e, s);
        const t = MAP.tangentAt(e, s);
        const l = leftOf(t).multiplyScalar(side);
        const curb = p.clone().addScaledVector(l, e.hw + (e.rank <= 4 ? 1.2 : 0.8));
        if (MAP.onRoad(curb, 0.5) || this.inBuilding(curb.x, curb.z, 0.8) || onOverpass(curb, 3)) continue;
        this.addLightPost(curb, { out: l });
        this.lampSpots.add(`${Math.round(curb.x / 4)},${Math.round(curb.z / 4)}`);
      }
    }
    for (const set of this.lampSets.values()) set.seal();
  }

  /** Where lamps stand, by 4 m cell, so nothing else is put on top of them. */
  private lampSpots = new Set<string>();
  private nearLamp(p: THREE.Vector3): boolean {
    const x = Math.round(p.x / 4);
    const z = Math.round(p.z / 4);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (this.lampSpots.has(`${x + i},${z + j}`)) return true;
    return false;
  }

  private static benchGeo?: THREE.BufferGeometry;
  private static benchMats = [
    new THREE.MeshStandardMaterial({ color: 0x9a6b42, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0x2c3036, metalness: 0.5, roughness: 0.5 }),
  ];

  /** A slatted bench facing the street (`side.out` points away from it). */
  private addBench(pos: THREE.Vector3, side: { out: THREE.Vector3 }): void {
    if (!City.benchGeo) {
      const wood = mergeGeometries([
        new THREE.BoxGeometry(1.8, 0.07, 0.48).translate(0, 0.05, 0),
        new THREE.BoxGeometry(1.8, 0.42, 0.06).translate(0, 0.32, -0.24),
      ]);
      const metal = mergeGeometries([-0.75, 0.75].map((x) => new THREE.BoxGeometry(0.07, 0.45, 0.46).translate(x, -0.2, -0.02)));
      City.benchGeo = mergeGeometries([wood!, metal!], true)!;
    }
    // Its back to the buildings: the seat faces -out.
    const heading = Math.atan2(-side.out.x, -side.out.z);
    const mesh = new THREE.Mesh(City.benchGeo, City.benchMats);
    this.addProp(mesh, pos.clone().setY(0.45), RAPIER.ColliderDesc.cuboid(0.9, 0.45, 0.28).setMass(60), 400, heading);
    this.scenery.push(mesh);
  }

  private static binGeo?: THREE.BufferGeometry;
  private static binMats = [new THREE.MeshStandardMaterial({ color: 0x2f6b45, roughness: 0.6 }), new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.5 })];

  /** A litter bin. */
  private addBin(pos: THREE.Vector3): void {
    City.binGeo ??= mergeGeometries([new THREE.CylinderGeometry(0.28, 0.24, 0.85, 10), new THREE.CylinderGeometry(0.31, 0.31, 0.08, 10).translate(0, 0.46, 0)], true)!;
    const mesh = new THREE.Mesh(City.binGeo, City.binMats);
    this.addProp(mesh, pos.clone().setY(0.43), RAPIER.ColliderDesc.cylinder(0.45, 0.3).setMass(25), 150);
    this.scenery.push(mesh);
  }

  private addKiosk(pos: THREE.Vector3, side: { out: THREE.Vector3 }): void {
    const g = new THREE.Group();
    const frame = new THREE.MeshStandardMaterial({ color: 0x2f6f4f, metalness: 0.4, roughness: 0.5 });
    const glass = new THREE.MeshStandardMaterial({ color: 0xa8d8ff, transparent: true, opacity: 0.35 });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 1.8), frame);
    roof.position.y = 1.2;
    const back = new THREE.Mesh(new THREE.BoxGeometry(4, 2.2, 0.06), glass);
    back.position.z = -0.85;
    const ad = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2, 0.1), new THREE.MeshStandardMaterial({ color: 0xffb13b, emissive: 0x553300 }));
    ad.position.set(1.9, 0, -0.2);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.5), frame);
    bench.position.set(-0.3, -0.6, -0.5);
    g.add(roof, back, ad, bench);
    // The open side faces the street.
    const heading = Math.atan2(-side.out.x, -side.out.z);
    const prop = this.addProp(g, pos.clone().setY(1.15), RAPIER.ColliderDesc.cuboid(2, 1.15, 0.9).setMass(400), 6000, heading);
    // Its glass back goes in a shower the first time it's hit.
    prop.glass = back;
    this.scenery.push(g);
  }

  /**
   * Café terraces outside some of the shops along Mia's route: a bistro table or two on the
   * sidewalk under the awning, two chairs to a table, a parasol over each. They're light, so
   * the vault (or a car) sends the lot flying. Drawn instanced: a handful of draws for all of
   * them. Placed with their own random stream, so the rest of the city stays as it was.
   */
  private buildCafes(): void {
    const rand = mulberry32(77);
    const route = PLAN.map((n) => n.pos);
    const onRoute = (p: THREE.Vector3) => route.some((q, i) => i < route.length - 1 && segDist(p, q, route[i + 1]) < 50);
    // Keep clear of the curb props (palms, lamps, benches, shelters, parked cars) and of each other.
    const taken = this.props.map((p) => {
      const t = p.body.translation();
      return new THREE.Vector3(t.x, 0, t.z);
    });
    const clear = (p: THREE.Vector3) =>
      !MAP.onRoad(p, 1.6) && !this.inBuilding(p.x, p.z, 1.1) && !onOverpass(p, 6) && p.distanceTo(BANK.corner) > 40 && taken.every((q) => q.distanceToSquared(p) > 2.4 * 2.4);
    const spots: { at: THREE.Vector3; along: THREE.Vector3; colour: THREE.Color }[] = [];
    let cafes = 0;
    for (const s of this.cafeSpots) {
      if (cafes >= MAX_CAFES) break;
      if (rand() > 0.55 || !onRoute(s.at)) continue;
      const colour = new THREE.Color(CANOPIES[Math.floor(rand() * CANOPIES.length)]);
      let tables = 0;
      for (const k of s.width > 3.4 ? [-1, 1] : [0]) {
        for (const d of [2.1, 2.6, 3.1, 3.7]) {
          const p = s.at.clone().addScaledVector(s.along, k * 1.25).addScaledVector(s.out, d).setY(0);
          if (!clear(p)) continue;
          spots.push({ at: p, along: s.along, colour });
          taken.push(p);
          tables++;
          break;
        }
      }
      if (tables) cafes++;
    }
    if (!spots.length) return;
    const furniture = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 });
    const canvas = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const tables = new PropInstances([{ geo: cafeTableGeometry(), mat: furniture }], spots.length);
    const chairs = new PropInstances([{ geo: cafeChairGeometry(), mat: furniture }], spots.length * 2);
    const parasols = new PropInstances(
      [
        { geo: parasolPoleGeometry(), mat: furniture },
        { geo: parasolCanopyGeometry(), mat: canvas, tinted: true },
      ],
      spots.length,
    );
    for (const s of [tables, chairs, parasols]) {
      this.instanced.push(s);
      for (const m of s.meshes) this.group.add(m);
    }
    for (const { at, along, colour } of spots) {
      this.cafes.push(at);
      const turn = Math.atan2(along.x, along.z);
      this.instancedProp(tables, at.clone().setY(0.38), [RAPIER.ColliderDesc.cylinder(0.38, 0.4).setMass(16)], 250, turn + rand() * Math.PI);
      for (const side of [1, -1]) {
        // Facing the table, a little askew.
        const c = at.clone().addScaledVector(along, side * 0.64);
        this.instancedProp(chairs, c.setY(0.43), [RAPIER.ColliderDesc.cuboid(0.2, 0.43, 0.2).setMass(7)], 120, turn + (side > 0 ? Math.PI : 0) + (rand() - 0.5) * 0.5);
      }
      // The parasol stands through the table on its own base: a pole, and the canopy up top.
      this.instancedProp(
        parasols,
        at.clone().setY(1.25),
        [RAPIER.ColliderDesc.cylinder(1.2, 0.06).setMass(9), RAPIER.ColliderDesc.cylinder(0.08, 1.05).setTranslation(0, 1.0, 0).setMass(3)],
        200,
        rand() * Math.PI,
        colour,
      );
    }
  }

  /** A prop drawn as a copy in an instanced set: its body, and a stand-in object for its pose. */
  private instancedProp(set: PropInstances, pos: THREE.Vector3, colliders: RAPIER.ColliderDesc[], value: number, heading: number, colour?: THREE.Color): THREE.Object3D | null {
    if (set.full) return null;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
        .setSleeping(true)
        .setAngularDamping(0.4),
    );
    for (const c of colliders) this.world.createCollider(c.setFriction(0.5).setCollisionGroups(FURNITURE_GROUPS), body);
    const stand = new THREE.Object3D();
    syncMesh(stand, body);
    const index = set.add(stand, colour);
    this.props.push({ body, mesh: stand, value, hit: false, instance: { set, index } });
    return stand;
  }

  private static parkedColors = [0xc0392b, 0x2e86de, 0xf1c40f, 0xecf0f1, 0x16a085, 0x7f8c8d, 0x8e44ad, 0x1f2a36, 0xd35400];
  private static parkedGeo?: THREE.BufferGeometry;
  private static parkedPaints = new Map<number, THREE.Material[]>();

  /**
   * A small saloon, facing +z with its origin 0.78 m up (the middle of its
   * collider): the side profile extruded across the car, a dark glasshouse
   * with a painted roof, wheels, and head and tail lamps. Groups: paint,
   * glass, tyres, headlamps, tail lamps.
   */
  private static parkedGeometry(): THREE.BufferGeometry {
    const W = 1.72;
    const across = (shape: THREE.Shape, width: number) =>
      new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 1 })
        .rotateY(-Math.PI / 2)
        .translate(width / 2, 0, 0);
    const lower = new THREE.Shape();
    lower.moveTo(-2.12, 0.3);
    lower.lineTo(-2.18, 0.64);
    lower.lineTo(-2.02, 0.9);
    lower.lineTo(-1.25, 0.98);
    lower.lineTo(1.0, 0.98);
    lower.lineTo(1.95, 0.84);
    lower.lineTo(2.16, 0.6);
    lower.lineTo(2.12, 0.3);
    lower.lineTo(-2.12, 0.3);
    const glasshouse = new THREE.Shape();
    glasshouse.moveTo(-1.2, 0.96);
    glasshouse.lineTo(-0.78, 1.4);
    glasshouse.lineTo(0.42, 1.4);
    glasshouse.lineTo(1.0, 0.96);
    glasshouse.lineTo(-1.2, 0.96);
    const paint = mergeGeometries([across(lower, W).toNonIndexed(), new THREE.BoxGeometry(W - 0.22, 0.07, 1.16).translate(0, 1.43, -0.18).toNonIndexed()])!;
    const glass = across(glasshouse, W - 0.18).toNonIndexed();
    const tyres = mergeGeometries(
      [[-0.8, 1.32], [0.8, 1.32], [-0.8, -1.32], [0.8, -1.32]].map(([x, z]) => new THREE.CylinderGeometry(0.33, 0.33, 0.24, 12).rotateZ(Math.PI / 2).translate(x, 0.33, z).toNonIndexed()),
    )!;
    const heads = mergeGeometries([-0.58, 0.58].map((x) => new THREE.BoxGeometry(0.36, 0.12, 0.08).translate(x, 0.74, 2.15).toNonIndexed()))!;
    const tails = mergeGeometries([-0.62, 0.62].map((x) => new THREE.BoxGeometry(0.34, 0.12, 0.08).translate(x, 0.8, -2.17).toNonIndexed()))!;
    const strip = (g: THREE.BufferGeometry) => {
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      return g;
    };
    return mergeGeometries([paint, glass, tyres, heads, tails].map(strip), true)!.translate(0, -0.78, 0);
  }

  private static parkedGlass = new THREE.MeshStandardMaterial({ color: 0x18222c, metalness: 0.75, roughness: 0.1 });
  private static parkedTyre = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  private static parkedHead = new THREE.MeshStandardMaterial({ color: 0xfff4dd, emissive: 0xffeecc, emissiveIntensity: 0.8 });
  private static parkedTail = new THREE.MeshStandardMaterial({ color: 0x5a0a0a, emissive: 0xff2a1a, emissiveIntensity: 0.7 });

  private static civilianPaints = new Map<number, THREE.MeshPhysicalMaterial>();

  /**
   * A car like the parked ones for traffic, as a CarModel with its origin on the
   * ground. Its tail lamps are its own, so it can show its brake lights.
   */
  static civilianCar(color: number): CarModel {
    City.parkedGeo ??= City.parkedGeometry();
    let paint = City.civilianPaints.get(color);
    if (!paint) {
      paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.25 });
      City.civilianPaints.set(color, paint);
    }
    const brake = City.parkedTail.clone();
    const mesh = new THREE.Mesh(City.parkedGeo, [paint, City.parkedGlass, City.parkedTyre, City.parkedHead, brake]);
    mesh.position.y = 0.78;
    mesh.castShadow = true;
    const body = new THREE.Group();
    body.add(mesh);
    const group = new THREE.Group();
    group.add(body);
    return { group, body, spinners: [], frontPivots: [], paint, brake, wheelRadius: 0.33 };
  }

  private addParkedCar(pos: THREE.Vector3, heading: number): void {
    const color = City.parkedColors[Math.floor(this.rand() * City.parkedColors.length)];
    City.parkedGeo ??= City.parkedGeometry();
    let mats = City.parkedPaints.get(color);
    if (!mats) {
      mats = [new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.35 }), City.parkedGlass, City.parkedTyre, City.parkedHead, City.parkedTail];
      City.parkedPaints.set(color, mats);
    }
    const mesh = new THREE.Mesh(City.parkedGeo, mats);
    this.addProp(mesh, pos.clone().setY(0.78), RAPIER.ColliderDesc.cuboid(0.9, 0.75, 2.1).setMass(1300).setFriction(0.8), 15000, heading, true);
    this.scenery.push(mesh);
  }

  // ---------------------------------------------------------------- set pieces

  private buildBank(): void {
    const B = BANK;
    const f = B.frame;
    const stone = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, roughness: 0.7 });
    const facade = this.facadeSets[1];
    const upper = new THREE.MeshStandardMaterial({ map: facade.map, emissiveMap: facade.emissive, emissive: 0xffffff, emissiveIntensity: 1.2, color: 0xd6dde6, roughness: 0.4, metalness: 0.3 });
    // Boxes in the bank's frame: x across (0..w), z along (0..d).
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat?: THREE.Material) => {
      const c = f.toWorld((x0 + x1) / 2, (z0 + z1) / 2, (y0 + y1) / 2);
      this.fixedBox(c.x, c.y, c.z, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, mat, f.heading);
    };
    const { w, d, lobbyH, h } = B;
    // Upper floors sit on the lobby; the lobby itself is open behind the glass.
    box(0, w, lobbyH, h, 0, d, upper);
    box(-0.3, w + 0.3, lobbyH - 0.4, lobbyH + 0.6, -0.3, d + 0.3, stone);
    // Back walls.
    box(w - 0.5, w, 0, lobbyH, 0, d, stone);
    box(0, w, 0, lobbyH, d - 0.5, d, stone);

    // Lobby floor and lights.
    const floor = new THREE.Mesh(
      flatPolygon([f.toWorld(0, 0), f.toWorld(w, 0), f.toWorld(w, d), f.toWorld(0, d)], [], 0.22, 4),
      new THREE.MeshStandardMaterial({ color: 0xe8e0d0, roughness: 0.25, metalness: 0.1 }),
    );
    floor.receiveShadow = true;
    this.group.add(floor);
    const lamp = new THREE.PointLight(0xffe2b0, 30, 30, 2);
    lamp.position.copy(f.toWorld(w / 2, d / 2, lobbyH - 0.8));
    this.group.add(lamp);

    // Gold sign over the corner, facing the approach.
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(18, 2.6), new THREE.MeshBasicMaterial({ map: signTexture('BANCO DO RIO', '#1b1b1b', '#e8c25a') }));
    sign.position.copy(f.toWorld(w / 2, -0.35, lobbyH + 1.6));
    sign.rotation.y = f.heading + Math.PI;
    this.group.add(sign);

    // Glass panes along the two street faces.
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x9fc8e0, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.35, clearcoat: 1 });
    const paneH = lobbyH - 0.5;
    const pane = (lx: number, lz: number, acrossX: boolean) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(acrossX ? 2.4 : 0.12, paneH, acrossX ? 0.12 : 2.4), glassMat);
      const p = this.addProp(mesh, f.toWorld(lx, lz, paneH / 2 + 0.22), RAPIER.ColliderDesc.cuboid(acrossX ? 1.2 : 0.06, paneH / 2, acrossX ? 0.06 : 1.2).setMass(90), 12000, f.heading);
      this.bankGlass.push(p);
    };
    for (let z = 1.3; z < d - 1; z += 2.5) pane(0.2, z, false);
    for (let x = 1.3; x < w - 1; x += 2.5) pane(x, 0.2, true);

    // Stone columns behind the glass, and teller counters.
    const colGeo = new THREE.CylinderGeometry(0.35, 0.35, lobbyH - 0.6, 12);
    const colY = (lobbyH - 0.6) / 2 + 0.22;
    for (let z = 6; z < d - 3; z += 8) this.addProp(new THREE.Mesh(colGeo, stone), f.toWorld(2, z, colY), RAPIER.ColliderDesc.cylinder((lobbyH - 0.6) / 2, 0.35).setMass(500), 8000);
    for (let x = 6; x < w - 3; x += 8) this.addProp(new THREE.Mesh(colGeo, stone), f.toWorld(x, 2, colY), RAPIER.ColliderDesc.cylinder((lobbyH - 0.6) / 2, 0.35).setMass(500), 8000);
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.5 });
    for (let x = 10; x < w - 6; x += 7) {
      this.addProp(new THREE.Mesh(new THREE.BoxGeometry(5, 1.2, 1), wood), f.toWorld(x, d - 8, 0.82), RAPIER.ColliderDesc.cuboid(2.5, 0.6, 0.5).setMass(300), 6000, f.heading);
    }
  }

  private buildStation(): void {
    const S = STATION;
    const office = this.facadeSets[1];
    const wall = new THREE.MeshStandardMaterial({ map: office.map, emissiveMap: office.emissive, emissive: 0xffffff, emissiveIntensity: 1.2, color: 0xe6edf5, roughness: 0.85 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x1d3f8f, roughness: 0.6 });
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: THREE.Material = wall) =>
      this.fixedBox((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, mat);

    box(S.x0, S.roomX0, 0, S.h, S.z0, S.z1); // main hall
    box(S.roomX0, S.x1, 0, S.h, S.z0, S.roomZ0); // south wing
    box(S.roomX0, S.x1, 0, S.h, S.roomZ1, S.z1); // north wing
    box(S.roomX0, S.x1, S.roomH, S.h, S.roomZ0, S.roomZ1); // above the vault room
    // A proper roof (it fills the screen from above while you pull the vault out), with a helipad.
    const roofPoly = [new THREE.Vector3(S.x0, 0, S.z0), new THREE.Vector3(S.x1, 0, S.z0), new THREE.Vector3(S.x1, 0, S.z1), new THREE.Vector3(S.x0, 0, S.z1)];
    this.batch(tint(flatPolygon(roofPoly, [], S.h + 0.03, 8), new THREE.Color(0x9a9da2)), this.roofTopMat);
    this.batch(this.walls(roofPoly, S.h - 0.4, S.h + 0.6, 0, 0, 0.3), this.trimMat);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(7, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: helipadTexture(), roughness: 0.8 }));
    pad.position.set((S.x0 + S.roomX0) / 2, S.h + 0.06, (S.z0 + S.z1) / 2);
    pad.rotation.y = -Math.PI / 2;
    seeThrough(pad.material);
    this.group.add(pad);

    // Forecourt in Rio mosaic between the station and the avenue.
    this.batch(flatPolygon([new THREE.Vector3(S.x0 - 4, 0, S.z0 - 4), new THREE.Vector3(S.x1 + 6, 0, S.z0 - 4), new THREE.Vector3(S.x1 + 6, 0, S.z1 + 4), new THREE.Vector3(S.x0 - 4, 0, S.z1 + 4)], [], 0.1, 4), new THREE.MeshStandardMaterial({ map: mosaicTexture(), roughness: 0.85 }), false);

    // Blue stripe and sign on the street facade.
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.2, S.z1 - S.z0), stripe);
    band.position.set(S.x1 + 0.1, S.roomH + 1.4, (S.z0 + S.z1) / 2);
    this.group.add(band);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(16, 3), new THREE.MeshBasicMaterial({ map: signTexture('POLÍCIA', '#1d3f8f', '#ffffff') }));
    sign.position.set(S.x1 + 0.25, S.h - 4, (S.z0 + S.z1) / 2);
    sign.rotation.y = Math.PI / 2;
    this.group.add(sign);

    // Vault room interior: dark floor so it reads as indoors.
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(S.x1 - S.roomX0, S.roomZ1 - S.roomZ0), new THREE.MeshStandardMaterial({ color: 0x55585e }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((S.roomX0 + S.x1) / 2, 0.11, (S.roomZ0 + S.roomZ1) / 2);
    this.group.add(floor);

    // Brick wall closing the room: the vault goes through it. One instanced mesh draws all the
    // bricks; each is its own rigid body.
    const brickMat = new THREE.MeshStandardMaterial({ color: 0xd9d4cc, roughness: 0.95 });
    const bw = 1.2;
    const bh = 0.6;
    const brickGeo = new THREE.BoxGeometry(0.5, bh, bw);
    const cols = Math.round((S.roomZ1 - S.roomZ0) / bw);
    const rows = Math.round(S.roomH / bh);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const mesh = new THREE.Mesh(brickGeo, brickMat);
        const pos = new THREE.Vector3(S.x1 - 0.25, bh / 2 + row * bh, S.roomZ0 + bw / 2 + col * bw);
        this.addProp(mesh, pos, RAPIER.ColliderDesc.cuboid(0.25, bh / 2 - 0.01, bw / 2 - 0.01).setMass(60).setFriction(0.8), 300);
      }
    }
  }

  /**
   * The Teodoro Moscoso Bridge: deck, barriers, piers and lights along its real
   * line across the lagoon; the toll plaza at its foot; a gantry at the swap point.
   */
  private buildBridge(): void {
    const pts = BRIDGE.pts;
    const hw = BRIDGE.hw;
    const concrete = this.concreteMat;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = a.distanceTo(b);
      if (len < 0.5) continue;
      const mid = a.clone().lerp(b, 0.5);
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      const t = b.clone().sub(a).normalize();
      const l = leftOf(t);
      // Deck slab (drawn only: the ground slab carries the cars, so there are no seams to catch the vault).
      const deck = this.buildingGeometry((hw + BRIDGE_BARRIER) * 2, 1.2, len + 1.2);
      deck.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(mid.x, -0.6, mid.z));
      this.batch(deck, concrete);
      for (const side of [-1, 1]) {
        const c = mid.clone().addScaledVector(l, side * (hw + BRIDGE_BARRIER / 2));
        this.fixedBox(c.x, 0.5, c.z, BRIDGE_BARRIER / 2, 0.5, len / 2 + 0.4, concrete, yaw);
        // Invisible upper rail so a tumbling vault can't vault the 1 m barrier.
        this.fixedBox(c.x, 2.2, c.z, BRIDGE_BARRIER / 2, 1.2, len / 2 + 0.4, undefined, yaw);
      }
    }
    // Piers and lights every so often along the deck.
    const path = pts;
    let acc = 0;
    let nextPier = 30;
    let nextLight = 20;
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];
      const len = a.distanceTo(b);
      const t = b.clone().sub(a).normalize();
      const l = leftOf(t);
      const yaw = Math.atan2(t.x, t.z);
      while (nextPier < acc + len) {
        const p = a.clone().addScaledVector(t, nextPier - acc);
        const pier = new THREE.BoxGeometry(hw * 1.6, 5, 3).translate(0, WATER_Y + 1.3, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(p.x, 0, p.z));
        this.batch(pier, concrete);
        nextPier += 60;
      }
      while (nextLight < acc + len) {
        const p = a.clone().addScaledVector(t, nextLight - acc);
        const side = Math.round(nextLight / 45) % 2 === 0 ? 1 : -1;
        this.addLightPost(p.clone().addScaledVector(l, side * (hw - 0.8)), { out: l.clone().multiplyScalar(side) });
        nextLight += 45;
      }
      acc += len;
    }

    // Toll plaza at the foot: booths on islands across the deck, under a canopy.
    const tolls = points(RAW.poi.tolls);
    if (tolls.length) {
      const at = tolls.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(tolls.length);
      const fix = MAP.locate(at);
      if (fix) {
        const t = fix.tangent;
        const l = leftOf(t);
        const yaw = Math.atan2(t.x, t.z);
        const c = fix.point;
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x2a6fb8, roughness: 0.5, metalness: 0.4 });
        const canopy = new THREE.BoxGeometry(hw * 2 + 4, 0.8, 9).applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(c.x, 6.4, c.z));
        this.batch(canopy, roofMat);
        const boothMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.6 });
        const glass = new THREE.MeshStandardMaterial({ color: 0x223344, metalness: 0.6, roughness: 0.2 });
        for (let k = -hw + 4; k <= hw - 4; k += 7.5) {
          const p = c.clone().addScaledVector(l, k);
          const g = new THREE.Group();
          const booth = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.6, 3.2), boothMat);
          const window = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.9, 2.4), glass);
          window.position.y = 0.4;
          g.add(booth, window);
          this.addProp(g, p.clone().setY(1.3), RAPIER.ColliderDesc.cuboid(0.8, 1.3, 1.6).setMass(500), 9000, yaw);
          // Canopy posts on the islands.
          const post = new THREE.CylinderGeometry(0.2, 0.2, 6, 8).translate(p.x, 3, p.z).applyMatrix4(new THREE.Matrix4().makeTranslation(t.x * 3.8, 0, t.z * 3.8));
          this.batch(post, roofMat);
        }
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.4), new THREE.MeshBasicMaterial({ map: signTexture('PEDÁGIO', '#1d3f8f', '#ffffff') }));
        sign.position.copy(c.clone().addScaledVector(t, -4.6).setY(6.4));
        sign.rotation.y = yaw + Math.PI;
        this.group.add(sign);
      }
    }

    // Toll-style gantry marking the swap point.
    const gfix = MAP.locate(GOAL.pos);
    if (gfix) {
      const t = gfix.tangent;
      const l = leftOf(t);
      const yaw = Math.atan2(t.x, t.z);
      const gantryMat = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.6 });
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), gantryMat);
        post.position.copy(GOAL.pos.clone().addScaledVector(l, side * hw).setY(4));
        this.group.add(post);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 1, 1.2, 1), gantryMat);
      beam.position.copy(GOAL.pos.clone().setY(8));
      beam.rotation.y = yaw;
      this.group.add(beam);
    }
  }

  /** Where the overpass's lights are (for the pools groundfx.ts paints): the lamps on its deck and ramps, and the floodlights under it. */
  readonly overpassLamps: THREE.Vector3[] = [];

  /**
   * The Barbosa overpass (OVERPASS in roadmap.ts): the avenue's bridge over the
   * expressway, a slab on six girders between two abutments, and its ramps, each an
   * embankment between walls of precast panels running down to the ground. Four
   * lanes with sidewalks and parapets all the way, lamp posts, the avenue's name on
   * the deck's fascia both ways, floodlights on the abutments under it. The walls are
   * solid; the ramps can be driven (an incline under the asphalt).
   */
  private buildOverpass(): void {
    const { ramps, laneHalf, deckHalf, abut } = OVERPASS;
    const mats = this.streetMats;
    const panels = new THREE.MeshStandardMaterial({ map: retainingWallTexture(), roughness: 0.93 });
    const concrete = this.concreteMat;
    const girderMat = new THREE.MeshStandardMaterial({ color: 0x8f8b83, roughness: 0.85 });
    const walkOut = laneHalf + 2;
    const STEP = 3;
    const rail = 1.1;

    /** A line every STEP m along a polyline: where, how far along, which way, and left of that. */
    const sample = (line: THREE.Vector3[]) => {
      const out: { p: THREE.Vector3; s: number; t: THREE.Vector3; n: THREE.Vector3 }[] = [];
      const cum = [0];
      for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
      const total = cum[cum.length - 1];
      const at = (s: number) => {
        let i = 0;
        while (i < line.length - 2 && cum[i + 1] < s) i++;
        const k = (s - cum[i]) / Math.max(1e-6, cum[i + 1] - cum[i]);
        return { p: line[i].clone().lerp(line[i + 1], THREE.MathUtils.clamp(k, 0, 1)), t: line[i + 1].clone().sub(line[i]).setY(0).normalize() };
      };
      for (let s = 0; ; s = Math.min(total, s + STEP)) {
        const { p, t } = at(s);
        out.push({ p, s, t, n: leftOf(t) });
        if (s >= total) break;
      }
      // Smooth the turns: each sample's way is the mean of its neighbours'.
      for (let i = 1; i < out.length - 1; i++) {
        out[i].t = out[i + 1].p.clone().sub(out[i - 1].p).setY(0).normalize();
        out[i].n = leftOf(out[i].t);
      }
      return out;
    };
    type Sample = ReturnType<typeof sample>[number];
    /** A strip over the samples between offsets `from` and `to` (left positive), `y(sample)` up. */
    const strip = (ss: Sample[], from: number, to: number, y: (q: Sample) => number, mat: THREE.Material, uv = 4, world = false, cast = false) =>
      this.batch(ribbon(ss.map((q) => q.p.clone().setY(y(q))), from, to, 0, uv, world), mat, cast);
    /**
     * An upright face along the samples at offset `x`, from `lo` to `hi` (m up), facing
     * `side` (+1 left), mapped in meters / `uv` along and up.
     */
    const face = (ss: Sample[], x: number, lo: (q: Sample) => number, hi: (q: Sample) => number, side: number, mat: THREE.Material, uv = 6) => {
      const pos: number[] = [];
      const tex: number[] = [];
      for (let i = 0; i < ss.length - 1; i++) {
        const [a, b] = [ss[i], ss[i + 1]];
        const pa = a.p.clone().addScaledVector(a.n, x);
        const pb = b.p.clone().addScaledVector(b.n, x);
        const quad = [
          [pa, lo(a), a.s], [pb, lo(b), b.s], [pb, hi(b), b.s],
          [pa, lo(a), a.s], [pb, hi(b), b.s], [pa, hi(a), a.s],
        ] as const;
        // Wound to face the way asked: flip if the first triangle faces the other way.
        const ab = pb.clone().sub(pa);
        const facing = new THREE.Vector3(ab.z, 0, -ab.x).dot(a.n) * side;
        const order = facing >= 0 ? [0, 2, 1, 3, 5, 4] : [0, 1, 2, 3, 4, 5];
        for (const k of order) {
          const [p, y, s] = quad[k];
          pos.push(p.x, y, p.z);
          tex.push(s / uv, y / uv);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
      geo.computeVertexNormals();
      this.batch(geo, mat);
    };
    /** A fixed box collider centred at `c`, `half` its half-extents, turned to yaw `h` and pitch `pitch` (nose down positive). */
    const solid = (c: THREE.Vector3, half: THREE.Vector3, h: number, pitch = 0) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, h, 0, 'YXZ'));
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(c.x, c.y, c.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setFriction(0.6),
        this.ground,
      );
    };
    /** A lamp post on the parapet at `q`, on side `side`, its arm out over the lanes. */
    const post = (q: Sample, side: number) => {
      const base = q.p.clone().addScaledVector(q.n, side * (walkOut + 0.2)).setY(rampHeight(q.s) + rail);
      const steel = new THREE.Color(0x4a4f55);
      this.batch(tint(new THREE.CylinderGeometry(0.08, 0.13, 7.4, 7).toNonIndexed().translate(base.x, base.y + 3.7, base.z), steel), this.balconyMat);
      const reach = 2.4;
      const arm = new THREE.CylinderGeometry(0.06, 0.07, reach, 5).toNonIndexed();
      arm.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), q.n.clone().multiplyScalar(-side))));
      arm.translate(...base.clone().addScaledVector(q.n, -side * reach / 2).setY(base.y + 7.3).toArray());
      this.batch(tint(arm, steel), this.balconyMat);
      const head = base.clone().addScaledVector(q.n, -side * reach).setY(base.y + 7.15);
      this.batch(new THREE.BoxGeometry(0.5, 0.16, 0.9).translate(head.x, head.y, head.z), this.lampHeadMat);
      this.overpassLamps.push(head);
    };

    // The deck's girders and slab, between the abutments on either side of the crossing.
    const ends = ramps.map((line) => sample(line).find((q) => q.s >= abut)!);
    const axis = ends[1].p.clone().sub(ends[0].p).setY(0);
    const span = axis.length();
    axis.normalize();
    const yaw = Math.atan2(axis.x, axis.z);
    const across = leftOf(axis);
    const mid = ends[0].p.clone().lerp(ends[1].p, 0.5);
    const slabLo = OVERPASS_CLEAR + 1;
    for (let k = 0; k < 6; k++) {
      const c = mid.clone().addScaledVector(across, (k - 2.5) * 3.5);
      const g = new THREE.BoxGeometry(0.45, slabLo - OVERPASS_CLEAR, span + 1.2).translate(0, (slabLo + OVERPASS_CLEAR) / 2, 0);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(c.x, 0, c.z));
      this.batch(g, girderMat);
      // A bottom flange.
      const fl = new THREE.BoxGeometry(0.75, 0.12, span + 1.2).translate(0, OVERPASS_CLEAR + 0.06, 0);
      fl.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(c.x, 0, c.z));
      this.batch(fl, girderMat);
    }
    const slab = new THREE.BoxGeometry(deckHalf * 2 - 0.2, OVERPASS_TOP - slabLo, span + 1.2).translate(0, (OVERPASS_TOP + slabLo) / 2, 0);
    slab.applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(mid.x, 0, mid.z));
    this.batch(slab, concrete);
    solid(mid.clone().setY(OVERPASS_TOP - 0.3), new THREE.Vector3(deckHalf - 0.2, 0.3, span / 2 + 1), yaw);
    // The deck's fascia and parapets either side, over the expressway.
    for (const side of [1, -1]) {
      const c = mid.clone().addScaledVector(across, side * (deckHalf - 0.2));
      solid(c.clone().setY(OVERPASS_TOP + rail / 2), new THREE.Vector3(0.2, rail / 2, span / 2 + 1), yaw);
      // The avenue's name on the fascia, to the traffic coming at it on the expressway.
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 1.15), new THREE.MeshBasicMaterial({ map: signTexture('AV. BARBOSA  ·  PR-27', '#1f6b3a', '#ffffff') }));
      sign.position.copy(mid).addScaledVector(across, side * (deckHalf + 0.05)).setY(OVERPASS_CLEAR + 0.75);
      sign.lookAt(sign.position.clone().addScaledVector(across, side));
      this.group.add(sign);
    }

    for (const line of ramps) {
      const ss = sample(line);
      const h = (q: Sample) => rampHeight(q.s);
      const deck = ss.filter((q) => q.s <= abut + STEP);
      const bank = ss.filter((q) => q.s >= abut - 0.01);
      // The road: asphalt, the double yellow line, white edge and lane lines; sidewalks with a curb.
      strip(ss, -laneHalf, laneHalf, (q) => h(q) + 0.05, mats.asphalt, 16, true);
      for (const o of [-0.2, 0.2]) strip(ss, o - 0.07, o + 0.07, (q) => h(q) + 0.06, mats.yellow);
      for (const side of [1, -1]) {
        strip(ss, side * (laneHalf - 0.6) - 0.09, side * (laneHalf - 0.6) + 0.09, (q) => h(q) + 0.06, mats.white);
        // Dashed lane line down the middle of each side.
        for (let k = 0; k + 1 < ss.length; k += 3) strip(ss.slice(k, k + 2), side * laneHalf * 0.47 - 0.075, side * laneHalf * 0.47 + 0.075, (q) => h(q) + 0.06, mats.white);
        const [a, b] = side > 0 ? [laneHalf, walkOut] : [-walkOut, -laneHalf];
        strip(ss, a, b, (q) => h(q) + 0.15, mats.walk);
        face(ss, side * laneHalf, (q) => h(q) + 0.04, (q) => h(q) + 0.15, side, mats.curb, 1);
        // The parapet: inside face, cap, and outside (the fascia over the expressway, the panel wall down the embankment).
        face(ss, side * walkOut, (q) => h(q) + 0.15, (q) => h(q) + rail, side, concrete, 2);
        const [c0, c1] = side > 0 ? [walkOut, deckHalf] : [-deckHalf, -walkOut];
        strip(ss, c0, c1, (q) => h(q) + rail, concrete, 2, false, true);
        face(deck, side * deckHalf, () => OVERPASS_CLEAR + 0.1, (q) => h(q) + rail, -side, concrete, 2);
        face(bank, side * deckHalf, () => 0, (q) => h(q) + rail, -side, panels);
      }
      // The abutment: the embankment's end, facing the expressway, under the girders' ends.
      const e = ends[ramps.indexOf(line)];
      const out = e.t.clone();
      const ab = new THREE.BoxGeometry(deckHalf * 2, OVERPASS_CLEAR, 1.4).translate(0, OVERPASS_CLEAR / 2, 0.7);
      ab.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(out.x, out.z)).setPosition(e.p.x, 0, e.p.z));
      // Panels on its faces, one repeat per 6 m.
      const uvs = ab.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uvs.count; i++) uvs.setXY(i, (uvs.getX(i) * deckHalf * 2) / 6, (uvs.getY(i) * OVERPASS_CLEAR) / 6);
      this.batch(ab, panels);
      // A seat for the girders along its top.
      const seat = new THREE.BoxGeometry(deckHalf * 2, 0.35, 2.0).translate(0, OVERPASS_CLEAR - 0.17, 0.5);
      seat.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.atan2(out.x, out.z)).setPosition(e.p.x, 0, e.p.z));
      this.batch(seat, concrete);
      solid(e.p.clone().addScaledVector(out, 0.7).setY(OVERPASS_TOP / 2), new THREE.Vector3(deckHalf, OVERPASS_TOP / 2, 0.7), Math.atan2(out.x, out.z));
      // Floodlights on its face, over the lanes, lighting the road under the deck.
      for (const x of [-5, 5]) {
        const lamp = e.p.clone().addScaledVector(across, x).addScaledVector(out, -0.12).setY(OVERPASS_CLEAR - 0.9);
        this.batch(new THREE.BoxGeometry(0.9, 0.35, 0.3).translate(lamp.x, lamp.y, lamp.z), this.lampHeadMat);
        this.overpassLamps.push(e.p.clone().addScaledVector(out, -OVERPASS.hw * 0.45).addScaledVector(across, x));
      }
      // The embankment, solid: an incline under the asphalt, its walls (the parapets on top).
      for (let i = 0; i + 1 < bank.length; i++) {
        const [a, b] = [bank[i], bank[i + 1]];
        const len = a.p.distanceTo(b.p);
        if (len < 0.5) continue;
        const dir = b.p.clone().sub(a.p).setY(0).normalize();
        const hy = Math.atan2(dir.x, dir.z);
        const [ha, hb] = [h(a), h(b)];
        const pitch = Math.atan2(ha - hb, len);
        const c = a.p.clone().lerp(b.p, 0.5);
        solid(c.clone().setY((ha + hb) / 2 + 0.15 - 0.5), new THREE.Vector3(deckHalf - 0.4, 0.5, len / 2 + 0.25), hy, pitch);
        for (const side of [1, -1]) {
          const w = c.clone().addScaledVector(leftOf(dir), side * (deckHalf - 0.2));
          const top = Math.max(ha, hb) + rail;
          solid(w.setY(top / 2), new THREE.Vector3(0.2, top / 2, len / 2 + 0.2), hy);
        }
      }
      // Lamp posts down the ramp, alternating sides.
      for (let k = 0, s = 9; s < ss[ss.length - 1].s - 6; s += 30, k++) post(ss.reduce((best, q) => (Math.abs(q.s - s) < Math.abs(best.s - s) ? q : best)), k % 2 ? 1 : -1);
    }
  }

  /**
   * Invisible walls around the drivable area, a seawall along the lagoon shore
   * (with a gap where the bridge leaves it), and a wall across the bridge's far end.
   */
  private buildWalls(): void {
    const bridge = BRIDGE.pts;
    const nearBridge = (p: THREE.Vector3) => bridge.some((q, i) => i < bridge.length - 1 && segDist(p, q, bridge[i + 1]) < BRIDGE.hw + 4);
    const seawall = this.concreteMat;
    const land = RAW.land.map((poly) => poly.map((r) => points(r)));
    const onLand = (x: number, z: number) => land.some(([outer, ...holes]) => pointInPoly(x, z, outer) && !holes.some((h) => pointInPoly(x, z, h)));
    for (const ringFlat of RAW.walls) {
      const ring = points(ringFlat);
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const len = a.distanceTo(b);
        const n = Math.max(1, Math.ceil(len / 12));
        for (let k = 0; k < n; k++) {
          const p = a.clone().lerp(b, k / n);
          const q = a.clone().lerp(b, (k + 1) / n);
          const mid = p.clone().lerp(q, 0.5);
          if (nearBridge(mid)) continue;
          const yaw = Math.atan2(q.x - p.x, q.z - p.z);
          const l = p.distanceTo(q);
          const side = leftOf(q.clone().sub(p).normalize());
          const water = !onLand(mid.x + side.x * 4, mid.z + side.z * 4) || !onLand(mid.x - side.x * 4, mid.z - side.z * 4);
          this.fixedBox(mid.x, 5, mid.z, 0.5, 5, l / 2 + 0.5, undefined, yaw);
          if (water) {
            // A low seawall you can see, down to the water.
            const g = new THREE.BoxGeometry(1, 0.8 - WATER_Y, l + 0.2).translate(0, (0.8 + WATER_Y) / 2, 0).applyMatrix4(new THREE.Matrix4().makeRotationY(yaw).setPosition(mid.x, 0, mid.z));
            this.batch(g, seawall);
          }
        }
      }
    }
    // The far end of the bridge.
    const end = bridge[bridge.length - 1];
    const prev = bridge[bridge.length - 2];
    const yaw = Math.atan2(end.x - prev.x, end.z - prev.z);
    this.fixedBox(end.x, 3, end.z, BRIDGE.hw + 1, 3, 0.5, undefined, yaw);
  }

  /**
   * The rest of the city beyond the map's edge: a field of simple blocks, one
   * instanced draw, so the skyline doesn't just stop.
   */
  private buildFiller(): void {
    const land = RAW.land.map((poly) => poly.map((r) => points(r)));
    const onLand = (x: number, z: number) => land.some(([outer, ...holes]) => pointInPoly(x, z, outer) && !holes.some((h) => pointInPoly(x, z, h)));
    const play = RAW.walls.map((r) => points(r));
    const inPlay = (x: number, z: number) => play.some((r) => pointInPoly(x, z, r));
    const box = new THREE.Box3();
    for (const poly of land) box.expandByPoint(poly[0][0]).union(new THREE.Box3().setFromPoints(poly[0]));
    const spots: { x: number; z: number; w: number; d: number; h: number }[] = [];
    const step = 55;
    for (let x = box.min.x; x < box.max.x; x += step) {
      for (let z = box.min.z; z < box.max.z; z += step) {
        const px = x + (this.rand() - 0.5) * 20;
        const pz = z + (this.rand() - 0.5) * 20;
        if (!onLand(px, pz) || inPlay(px, pz)) continue;
        // Keep a margin from the drivable area so the filler doesn't crowd real streets.
        if (play.some((r) => r.some((q, i) => i < r.length - 1 && segDist(new THREE.Vector3(px, 0, pz), q, r[i + 1]) < 45))) continue;
        spots.push({ x: px, z: pz, w: 18 + this.rand() * 22, d: 18 + this.rand() * 22, h: 6 + Math.pow(this.rand(), 2.2) * 50 });
      }
    }
    if (!spots.length) return;
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mat = new THREE.MeshStandardMaterial({ map: this.facadeSets[0].map, roughness: 0.9 });
    const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    spots.forEach((s, i) => {
      mesh.setMatrixAt(i, m.makeScale(s.w, s.h, s.d).setPosition(s.x, 0, s.z));
      mesh.setColorAt(i, c.setHex(HOUSE_COLORS[i % HOUSE_COLORS.length]));
    });
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }
}

/** Distance from p to segment ab (on the ground). */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 < 1e-9 ? 0 : THREE.MathUtils.clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1);
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}
