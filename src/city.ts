import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seeThrough } from './cutaway';
import { RAPIER, syncMesh } from './physics';
import { BANK, BRIDGE, GOAL, MAP, type MapEdge, PLAN, points, RAW } from './roadmap';
import { leftOf } from './roads';
import {
  asphaltTexture, type FacadeStyle, facadeTextures, grassTexture, groundTexture, helipadTexture, mosaicTexture, roofTexture, sidewalkTexture, signTexture,
  storefrontTexture, waterNormalTexture,
} from './textures';

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

/** Police HQ block, west of Ponce de León; the vault room opens east onto the avenue (x = 200). */
const STATION = { x0: 116, x1: 184, z0: 116, z1: 184, roomX0: 170, roomZ0: 144, roomZ1: 156, roomH: 4.2, h: 20 };
export const VAULT_START = new THREE.Vector3(177, 0, 150);
export const VAULT_START_HEADING = Math.PI / 2; // door faces +x, toward the street
/** Where the cars wait, facing down the avenue in front of the station. */
export const CAR_STARTS = [new THREE.Vector3(196.5, 0, 158), new THREE.Vector3(202.5, 0, 158)];
/** Where a street lamp's light is, in the lamp's own frame. */
export const LAMP_HEAD = new THREE.Vector3(0, 3.25, 2.1);
/** x of the station facade; the vault is "out" once it crosses this. */
export const STATION_FACADE_X = STATION.x1;

export interface Prop {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  /** Property damage value when first knocked loose. */
  value: number;
  hit: boolean;
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

/** Strip along a polyline from lateral offset `from` to `to` (left positive), at height y. UVs: across/along in meters / uvScale, or world xz. */
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
      pos.push(p.x, y, p.z);
      if (worldUV) uv.push(p.x / uvScale, p.z / uvScale);
      else uv.push(quv[k][0] / uvScale, quv[k][1] / uvScale);
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // Strips run either way along a street; make sure they all face up.
  const nrm = geo.attributes.normal as THREE.BufferAttribute;
  if (nrm.count && nrm.getY(0) < 0) {
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i += 3) {
      for (const attr of [p]) {
        const x = attr.getX(i + 1);
        const yy = attr.getY(i + 1);
        const z = attr.getZ(i + 1);
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, x, yy, z);
      }
    }
    const u = uv;
    for (let i = 0; i < u.length; i += 6) {
      [u[i + 2], u[i + 4]] = [u[i + 4], u[i + 2]];
      [u[i + 3], u[i + 5]] = [u[i + 5], u[i + 3]];
    }
    geo.computeVertexNormals();
  }
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
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
  private concreteMat = new THREE.MeshStandardMaterial({ color: 0xbdb5a8, roughness: 0.9 });
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

  constructor(private world: RAPIER.World) {
    this.ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.intersections = MAP.nodes.filter((n) => n.edges.length >= 3).map((n) => n.pos);
    this.buildGround();
    this.buildRoads();
    this.buildBuildings();
    this.buildStation();
    this.buildBank();
    this.buildBridge();
    this.buildWalls();
    this.buildProps();
    this.buildFiller();
    this.flushBatches();
  }

  /** Animate water ripples. */
  update(dt: number): void {
    const n = this.water.material.normalMap!;
    n.offset.x += dt * 0.004;
    n.offset.y += dt * 0.0025;
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
  isStreet(x: number, z: number): boolean {
    return MAP.onRoad(new THREE.Vector3(x, 0, z));
  }

  /** Sync meshes of props that are moving; show scenery near the camera only. */
  render(camera?: THREE.Camera): void {
    for (const p of this.props) if (!p.body.isSleeping()) syncMesh(p.mesh, p.body);
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
    // behind the seawalls and the bridge rails, so it needn't be a hole.
    const center = this.mapCenter();
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 1, 6000).setTranslation(center.x, -1, center.z).setFriction(0.6), this.ground);

    // Water under everything: the lagoon, the bay, the edge of the world.
    const ripples = waterNormalTexture();
    ripples.repeat.set(300, 300);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 20000),
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
      for (let n = Math.min(60, Math.floor(area / 260)); n > 0 && trees.length < 2500; n--) {
        const x = box.min.x + this.rand() * (box.max.x - box.min.x);
        const z = box.min.z + this.rand() * (box.max.z - box.min.z);
        if (pointInPoly(x, z, poly) && !MAP.onRoad(new THREE.Vector3(x, 0, z), 2)) trees.push(new THREE.Vector3(x, 0, z));
      }
    }
    this.plantTrees(trees);
  }

  /** Middle of the map (for the water plane and the distant scenery). */
  mapCenter(): THREE.Vector3 {
    const box = new THREE.Box3().setFromPoints(MAP.nodes.map((n) => n.pos));
    return box.getCenter(new THREE.Vector3()).setY(0);
  }

  /** Broad-canopy shade trees (mango, flamboyán), instanced; scenery only. */
  private plantTrees(at: THREE.Vector3[]): void {
    if (!at.length) return;
    const trunk = new THREE.CylinderGeometry(0.25, 0.4, 4, 6).translate(0, 2, 0);
    const crown = new THREE.IcosahedronGeometry(3.2, 0).scale(1, 0.7, 1).translate(0, 5.2, 0);
    const geo = mergeGeometries([trunk.toNonIndexed(), crown], true)!;
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0x6b5139, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ color: 0x3d6b33, roughness: 0.85, flatShading: true }),
    ];
    const mesh = new THREE.InstancedMesh(geo, mats, at.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const color = new THREE.Color();
    at.forEach((p, i) => {
      const k = 0.7 + this.rand() * 0.7;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI * 2);
      s.set(k, k * (0.8 + this.rand() * 0.4), k);
      mesh.setMatrixAt(i, m.compose(p, q, s));
      // A few flamboyán reds among the greens.
      mesh.setColorAt(i, color.setHex(this.rand() < 0.12 ? 0xd2543a : [0xffffff, 0xd8e8c8, 0xc0d8b0][Math.floor(this.rand() * 3)]));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- streets

  private buildRoads(): void {
    const asphalt = asphaltTexture();
    const asphaltMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mosaicMat = new THREE.MeshStandardMaterial({ map: mosaicTexture(), roughness: 0.85 });
    const walkMat = new THREE.MeshStandardMaterial({ map: sidewalkTexture(), color: 0xe4ddd0, roughness: 0.9 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xcfc8bb, roughness: 0.8 });
    const white = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe8c94a, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });

    /** How far from a node its streets' markings and sidewalks stop (the intersection box). */
    const clear = (n: (typeof MAP.nodes)[number], except: MapEdge) => Math.max(0, ...n.edges.filter((e) => e !== except).map((e) => e.hw)) + 1.5;

    const dashes: THREE.Matrix4[] = [];
    const stripes: THREE.Matrix4[] = [];
    for (const e of MAP.edges) {
      this.batch(ribbon(e.pts, -e.hw, e.hw, 0.05, 8, true), asphaltMat, false);
      const ca = e.a.edges.length > 1 ? clear(e.a, e) : 0;
      const cb = e.b.edges.length > 1 ? clear(e.b, e) : 0;
      if (e.length - ca - cb < 4) continue;
      const mid = slice(e, ca, e.length - cb);
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
      // Dashed center line on two-way streets wide enough for one.
      if (e.hw >= 6 && !e.bridge) {
        const path = mid;
        let s = 0;
        for (let i = 0; i < path.length - 1; i++) {
          const a = path[i];
          const b = path[i + 1];
          const len = a.distanceTo(b);
          const yaw = Math.atan2(b.x - a.x, b.z - a.z);
          for (; s < len; s += 10) {
            const p = a.clone().lerp(b, s / len);
            dashes.push(new THREE.Matrix4().makeRotationY(yaw).setPosition(p.x, 0.065, p.z));
          }
          s -= len;
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
      this.batch(flatPolygon(ring, [], 0.05, 8), asphaltMat, false);
    }
    const dashMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.25, 4).rotateX(-Math.PI / 2), yellow, dashes.length);
    dashes.forEach((m, i) => dashMesh.setMatrixAt(i, m));
    dashMesh.receiveShadow = true;
    const stripeMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.6, 3.5).rotateX(-Math.PI / 2), white, stripes.length);
    stripes.forEach((m, i) => stripeMesh.setMatrixAt(i, m));
    stripeMesh.receiveShadow = true;
    this.group.add(dashMesh, stripeMesh);
  }

  // ---------------------------------------------------------------- buildings

  private buildBuildings(): void {
    const color = new THREE.Color();
    for (const b of RAW.buildings) {
      const poly = points(b.p);
      const r = this.rand();
      const h = b.h;
      // Glass towers on the Golden Mile, offices and apartments in between, painted houses.
      const tower = h >= 28;
      const mat = tower ? this.towerMat : h >= 12 ? this.facadeMats[r < 0.55 ? 1 : 0] : this.facadeMats[r < 0.6 ? 0 : 2];
      const palette = tower ? TOWER_COLORS : h >= 12 ? OFFICE_COLORS : HOUSE_COLORS;
      color.setHex(palette[Math.floor(this.rand() * palette.length)]);
      this.batch(tint(this.walls(poly, 0, h, 24, 16), color), mat);
      const roofs = tower ? TOWER_ROOFS : h >= 12 ? OFFICE_ROOFS : HOUSE_ROOFS;
      this.batch(tint(this.roof(poly, h), color.setHex(roofs[Math.floor(this.rand() * roofs.length)])), this.roofTopMat);
      if (h >= 8) this.batch(this.walls(poly, h - 0.4, h + 0.5, 0, 0, 0.3), this.trimMat);

      const c = poly.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(poly.length);
      // Shops on the ground floor along the avenues.
      const street = h >= 6 ? MAP.locate(c, undefined, 40) : null;
      if (street && street.edge.rank <= 3) this.batch(this.walls(poly, 0, 4.2, 24, 0, 0.12), this.storefrontMat);
      // Rooftop water tanks and AC units (every roof in San Juan has them).
      const area = polyArea(poly);
      if (area > 60) {
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
    /** Heavy enough to stop a cruiser dead (parked cars); see DOMINANT in vehicle.ts. */
    dominant = false,
  ): Prop {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) })
        .setSleeping(true)
        .setAngularDamping(0.3)
        .setDominanceGroup(dominant ? 1 : 0),
    );
    this.world.createCollider(collider, body);
    syncMesh(mesh, body);
    mesh.traverse((o) => (o.castShadow = true));
    this.group.add(mesh);
    const prop = { body, mesh, value, hit: false };
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
          if (MAP.onRoad(curb, 0.5) || this.inBuilding(curb.x, curb.z, 0.8)) continue;
          const out = { along: t, out: l };
          const roll = this.rand();
          if (roll < (important ? 0.42 : 0.55)) this.addPalm(curb);
          else if (roll < 0.78) this.addLightPost(curb, out);
          else if (roll < 0.86 && important) this.addKiosk(curb, out);
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
  private static palmMats = [
    new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: 0x3f8a3a, roughness: 0.8, side: THREE.DoubleSide, flatShading: true }),
  ];

  private addPalm(pos: THREE.Vector3): void {
    if (!City.palmGeo) {
      const trunk = new THREE.CylinderGeometry(0.18, 0.3, 8, 7);
      const fronds: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 7; k++) {
        const leaf = new THREE.ConeGeometry(0.5, 4, 3).rotateX(Math.PI / 2 + 0.5).translate(0, 4, 1.8);
        fronds.push(leaf.rotateY((k / 7) * Math.PI * 2));
      }
      City.palmGeo = mergeGeometries([trunk, mergeGeometries(fronds)], true)!;
    }
    const mesh = new THREE.Mesh(City.palmGeo, City.palmMats);
    this.addProp(mesh, pos.clone().setY(4.2), RAPIER.ColliderDesc.cylinder(4, 0.3).setMass(250).setFriction(0.6), 2500);
    this.scenery.push(mesh);
  }

  private static postGeo?: THREE.BufferGeometry;
  private static postMats = [
    new THREE.MeshStandardMaterial({ color: 0x3c4148, metalness: 0.6, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 0.6 }),
  ];

  /** `side.out` points away from the street; the arm reaches back over it. */
  private addLightPost(pos: THREE.Vector3, side: { out: THREE.Vector3 }): void {
    if (!City.postGeo) {
      const pole = mergeGeometries([new THREE.BoxGeometry(0.22, 7, 0.22), new THREE.BoxGeometry(0.15, 0.15, 2.4).translate(0, 3.4, 1.1)]);
      const lamp = new THREE.BoxGeometry(0.4, 0.2, 0.7).translate(LAMP_HEAD.x, LAMP_HEAD.y, LAMP_HEAD.z);
      City.postGeo = mergeGeometries([pole, lamp], true)!;
    }
    const heading = Math.atan2(-side.out.x, -side.out.z);
    const mesh = new THREE.Mesh(City.postGeo, City.postMats);
    this.addProp(mesh, pos.clone().setY(3.7), RAPIER.ColliderDesc.cuboid(0.15, 3.5, 0.15).setMass(150), 1800, heading);
    this.scenery.push(mesh);
    this.lamps.push(mesh);
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
    this.addProp(g, pos.clone().setY(1.15), RAPIER.ColliderDesc.cuboid(2, 1.15, 0.9).setMass(400), 6000, heading);
    this.scenery.push(g);
  }

  private static parkedColors = [0xc0392b, 0x2e86de, 0xf1c40f, 0xecf0f1, 0x16a085, 0x7f8c8d, 0x8e44ad];

  private addParkedCar(pos: THREE.Vector3, heading: number): void {
    const color = City.parkedColors[Math.floor(this.rand() * City.parkedColors.length)];
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2530, metalness: 0.8, roughness: 0.2 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x111111 });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 4.2), paint);
    body.position.y = -0.05;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 2.1), glass);
    cabin.position.set(0, 0.55, -0.2);
    g.add(body, cabin);
    for (const [x, z] of [[-0.85, 1.3], [0.85, 1.3], [-0.85, -1.3], [0.85, -1.3]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12).rotateZ(Math.PI / 2), tire);
      w.position.set(x, -0.4, z);
      g.add(w);
    }
    this.addProp(g, pos.clone().setY(0.78), RAPIER.ColliderDesc.cuboid(0.9, 0.75, 2.1).setMass(1300).setFriction(0.8), 15000, heading, true);
    this.scenery.push(g);
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
