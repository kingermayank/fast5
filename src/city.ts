import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, syncMesh } from './physics';
import { asphaltTexture, type FacadeStyle, facadeTextures, sidewalkTexture, signTexture, storefrontTexture, waterNormalTexture } from './textures';

/** Distance between street center lines. */
export const PITCH = 100;
export const STREET_HALF = 12;
const SIDEWALK = 4;
/** Streets run at x = i*PITCH (i = 0..NX) and z = j*PITCH (j = 0..NZ). */
const NX = 5;
const NZ = 7;
const CITY_MAX_X = NX * PITCH;
const CITY_MAX_Z = NZ * PITCH;
export const SEAWALL_Z = CITY_MAX_Z + STREET_HALF + 8;

export const BRIDGE_X = 4 * PITCH;
const BRIDGE_HALF = 14;
const BRIDGE_END_Z = SEAWALL_Z + 950;
export const SWAP_ZONE_Z = BRIDGE_END_Z - 120;

/** Police HQ block (x 100..200, z 100..200); the vault room opens east onto x = 200 street. */
const STATION = { x0: 116, x1: 184, z0: 116, z1: 184, roomX0: 170, roomZ0: 144, roomZ1: 156, roomH: 4.2, h: 20 };
export const VAULT_START = new THREE.Vector3(177, 0, 150);
export const VAULT_START_HEADING = Math.PI / 2; // door faces +x, toward the street
/** Where the cars wait, facing north on the street in front of the station. */
export const CAR_STARTS = [new THREE.Vector3(196.5, 0, 158), new THREE.Vector3(202.5, 0, 158)];
/** x of the station facade; the vault is "out" once it crosses this. */
export const STATION_FACADE_X = STATION.x1;

/** Mia's route: intersections to the bridge, then the swap point. */
export const ROUTE: THREE.Vector3[] = [
  [200, 300], [100, 300], [100, 500], [300, 500], [300, 600], [400, 600], [400, 700], [400, SEAWALL_Z + 150], [400, SWAP_ZONE_Z],
].map(([x, z]) => new THREE.Vector3(x, 0, z));

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

const FACADE_COLORS = [0xf3e3c3, 0xe8a87c, 0x86c5c0, 0xf5d77a, 0xf4f1ea, 0xe98a7a, 0xb7d3e9, 0xd9c2e8, 0xc8d6a4];

export class City {
  readonly group = new THREE.Group();
  readonly props: Prop[] = [];
  /** Intersections, for spawning police. */
  readonly intersections: THREE.Vector3[] = [];
  private rand = mulberry32(5);
  private facadeSets = (['residential', 'office', 'colonial'] as FacadeStyle[]).map((style, i) => facadeTextures(style, 101 + i * 37));
  private facadeMats = FACADE_COLORS.map((c, i) => {
    const t = this.facadeSets[i % this.facadeSets.length];
    return new THREE.MeshStandardMaterial({ map: t.map, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: 1.4, color: c, roughness: 0.85 });
  });
  private storefrontMat = new THREE.MeshStandardMaterial({ map: storefrontTexture(), roughness: 0.5, metalness: 0.2 });
  private trimMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.8 });
  private roofMat = new THREE.MeshStandardMaterial({ color: 0x8d8f93, roughness: 0.8, metalness: 0.3 });
  /** Static geometry collected per material and merged into one mesh each at the end. */
  private batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private water!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshPhysicalMaterial>;

  constructor(private world: RAPIER.World) {
    for (let i = 0; i <= NX; i++) for (let j = 0; j <= NZ; j++) this.intersections.push(new THREE.Vector3(i * PITCH, 0, j * PITCH));
    this.buildGround();
    this.buildBlocks();
    this.buildStation();
    this.buildBridge();
    this.buildBounds();
    this.flushBatches();
  }

  /** Animate water ripples. */
  update(dt: number): void {
    const n = this.water.material.normalMap!;
    n.offset.x += dt * 0.004;
    n.offset.y += dt * 0.0025;
  }

  private batch(geo: THREE.BufferGeometry, mat: THREE.Material): void {
    const list = this.batches.get(mat) ?? [];
    list.push(geo);
    this.batches.set(mat, list);
  }

  private flushBatches(): void {
    for (const [mat, geos] of this.batches) {
      const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = mesh.receiveShadow = true;
      this.group.add(mesh);
      geos.forEach((g) => g.dispose());
    }
    this.batches.clear();
  }

  /** True if (x, z) is on a drivable street (or the bridge). */
  isStreet(x: number, z: number): boolean {
    if (z > SEAWALL_Z) return Math.abs(x - BRIDGE_X) < BRIDGE_HALF;
    const dx = Math.abs(x - Math.round(x / PITCH) * PITCH);
    const dz = Math.abs(z - Math.round(z / PITCH) * PITCH);
    return (dx < STREET_HALF || dz < STREET_HALF) && x > -STREET_HALF && x < CITY_MAX_X + STREET_HALF && z > -STREET_HALF;
  }

  /** Sync meshes of props that are moving. */
  render(): void {
    for (const p of this.props) if (!p.body.isSleeping()) syncMesh(p.mesh, p.body);
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

  // ---------------------------------------------------------------- build

  private fixedBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, mat?: THREE.Material | THREE.Material[]): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6), body);
    if (mat) this.batch(this.buildingGeometry(hx * 2, hy * 2, hz * 2).translate(cx, cy, cz), mat as THREE.Material);
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

  private buildGround(): void {
    const asphalt = asphaltTexture();
    const w = CITY_MAX_X + 240;
    const d = SEAWALL_Z + 120;
    asphalt.repeat.set(w / 8, d / 8);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(CITY_MAX_X / 2, 0, SEAWALL_Z - d / 2);
    ground.receiveShadow = true;
    this.group.add(ground);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(CITY_MAX_X / 2, -0.5, SEAWALL_Z - d / 2));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, 0.5, d / 2).setFriction(0.6), body);

    const ripples = waterNormalTexture();
    ripples.repeat.set(120, 120);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshPhysicalMaterial({ color: 0x1d4a5a, roughness: 0.12, metalness: 0.1, normalMap: ripples, normalScale: new THREE.Vector2(0.35, 0.35), clearcoat: 0.6 }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(CITY_MAX_X / 2, -4, SEAWALL_Z + 1000);
    this.group.add(this.water);

    // Dashed center lines.
    const dashGeo = new THREE.PlaneGeometry(0.3, 4).rotateX(-Math.PI / 2);
    const dashes: THREE.Vector3[] = [];
    const dashRot: number[] = [];
    for (let i = 0; i <= NX; i++) {
      for (let z = 0; z < CITY_MAX_Z; z += 10) {
        if ((z % PITCH) < STREET_HALF + 2 || (z % PITCH) > PITCH - STREET_HALF - 2) continue;
        dashes.push(new THREE.Vector3(i * PITCH, 0.02, z));
        dashRot.push(0);
      }
    }
    for (let j = 0; j <= NZ; j++) {
      for (let x = 0; x < CITY_MAX_X; x += 10) {
        if ((x % PITCH) < STREET_HALF + 2 || (x % PITCH) > PITCH - STREET_HALF - 2) continue;
        dashes.push(new THREE.Vector3(x, 0.02, j * PITCH));
        dashRot.push(Math.PI / 2);
      }
    }
    const dashMesh = new THREE.InstancedMesh(dashGeo, new THREE.MeshBasicMaterial({ color: 0xe8d36a }), dashes.length);
    const m = new THREE.Matrix4();
    dashes.forEach((p, k) => dashMesh.setMatrixAt(k, m.makeRotationY(dashRot[k]).setPosition(p)));
    this.group.add(dashMesh);

    // Solid white edge lines along each block, and zebra crossings at every intersection.
    const white = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.7 });
    const inner = PITCH - STREET_HALF * 2;
    const lineGeo = new THREE.PlaneGeometry(0.2, inner).rotateX(-Math.PI / 2);
    const stripeGeo = new THREE.PlaneGeometry(0.6, 4.5).rotateX(-Math.PI / 2);
    const lines: THREE.Matrix4[] = [];
    const stripes: THREE.Matrix4[] = [];
    for (let i = 0; i <= NX; i++) {
      for (let j = 0; j <= NZ; j++) {
        const cx = i * PITCH;
        const cz = j * PITCH;
        for (const off of [-STREET_HALF + 1, STREET_HALF - 1]) {
          if (j < NZ) lines.push(new THREE.Matrix4().makeTranslation(cx + off, 0.02, cz + PITCH / 2));
          if (i < NX) lines.push(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(cx + PITCH / 2, 0.02, cz + off));
        }
        for (let k = -STREET_HALF + 1.5; k <= STREET_HALF - 1.5; k += 1.3) {
          for (const side of [-1, 1]) {
            stripes.push(new THREE.Matrix4().makeTranslation(cx + k, 0.025, cz + side * (STREET_HALF + 2.5)));
            stripes.push(new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(cx + side * (STREET_HALF + 2.5), 0.025, cz + k));
          }
        }
      }
    }
    for (const [geo, mats] of [[lineGeo, lines], [stripeGeo, stripes]] as const) {
      const inst = new THREE.InstancedMesh(geo, white, mats.length);
      mats.forEach((mm, k) => inst.setMatrixAt(k, mm));
      inst.receiveShadow = true;
      this.group.add(inst);
    }
  }

  private buildBlocks(): void {
    const sidewalk = sidewalkTexture();
    sidewalk.repeat.set(20, 20);
    const sidewalkMat = new THREE.MeshStandardMaterial({ map: sidewalk, roughness: 0.95 });
    const inner = PITCH - STREET_HALF * 2;

    // Blocks inside the grid plus one ring outside it (scenery behind the boundary walls).
    for (let bi = -1; bi <= NX; bi++) {
      for (let bj = -1; bj < NZ; bj++) {
        const x0 = bi * PITCH + STREET_HALF;
        const z0 = bj * PITCH + STREET_HALF;
        const outer = bi < 0 || bi >= NX || bj < 0;
        const slab = new THREE.Mesh(new THREE.BoxGeometry(inner, 0.2, inner), sidewalkMat);
        slab.position.set(x0 + inner / 2, 0.1, z0 + inner / 2);
        slab.receiveShadow = true;
        this.group.add(slab);
        if (bi === 1 && bj === 1) continue; // police HQ, built separately
        this.buildingsOnBlock(x0 + SIDEWALK, z0 + SIDEWALK, inner - SIDEWALK * 2);
        if (!outer) this.propsAroundBlock(x0, z0, inner);
      }
    }
    this.propsAroundBlock(1 * PITCH + STREET_HALF, 1 * PITCH + STREET_HALF, inner, true);
  }

  private buildingsOnBlock(x0: number, z0: number, size: number): void {
    const r = this.rand;
    // Split into 1-3 lots along each axis.
    const splitsX = 1 + Math.floor(r() * 2.5);
    const splitsZ = 1 + Math.floor(r() * 2.5);
    const gap = 1;
    const lw = size / splitsX;
    const ld = size / splitsZ;
    for (let a = 0; a < splitsX; a++) {
      for (let b = 0; b < splitsZ; b++) {
        const h = 12 + Math.floor(r() * 10) * 4;
        const w = lw - gap;
        const d = ld - gap;
        const mat = this.facadeMats[Math.floor(r() * this.facadeMats.length)];
        const cx = x0 + a * lw + lw / 2;
        const cz = z0 + b * ld + ld / 2;
        this.fixedBox(cx, h / 2, cz, w / 2, h / 2, d / 2, mat);
        this.decorateBuilding(cx, cz, w, d, h);
      }
    }
  }

  /** Visual-only details: shop fronts, cornice, rooftop AC units and water tanks. */
  private decorateBuilding(cx: number, cz: number, w: number, d: number, h: number): void {
    const r = this.rand;
    const shop = new THREE.BoxGeometry(w + 0.3, 4.2, d + 0.3);
    // Shop texture repeats every 24 m along each face.
    const uv = shop.attributes.uv as THREE.BufferAttribute;
    const widths = [d, d, 0, 0, w, w];
    for (let i = 0; i < uv.count; i++) {
      const f = Math.floor(i / 4);
      uv.setX(i, widths[f] === 0 ? 0 : (uv.getX(i) * widths[f]) / 24);
    }
    this.batch(shop.translate(cx, 2.1, cz), this.storefrontMat);
    this.batch(new THREE.BoxGeometry(w + 0.8, 0.7, d + 0.8).translate(cx, h + 0.1, cz), this.trimMat);
    this.batch(new THREE.BoxGeometry(w + 0.5, 0.35, d + 0.5).translate(cx, 4.4, cz), this.trimMat);
    const units = 1 + Math.floor(r() * 3);
    for (let k = 0; k < units; k++) {
      const ux = cx + (r() - 0.5) * (w - 4);
      const uz = cz + (r() - 0.5) * (d - 4);
      this.batch(new THREE.BoxGeometry(2.2, 1.4, 1.6).translate(ux, h + 1.15, uz), this.roofMat);
    }
    if (r() < 0.5) {
      const tx = cx + (r() - 0.5) * (w - 5);
      const tz = cz + (r() - 0.5) * (d - 5);
      this.batch(new THREE.CylinderGeometry(1.3, 1.3, 2.4, 14).translate(tx, h + 2.6, tz), this.roofMat);
      this.batch(new THREE.BoxGeometry(2.2, 1.2, 2.2).translate(tx, h + 0.9, tz), this.roofMat);
    }
  }

  /** Palms, light posts, bus kiosks and parked cars along each block's curbs. */
  private propsAroundBlock(x0: number, z0: number, inner: number, isStation = false): void {
    const r = this.rand;
    const edge = 1.2; // from curb
    const sides: { along: 'x' | 'z'; fixed: number; out: number }[] = [
      { along: 'x', fixed: z0 + edge, out: -1 },
      { along: 'x', fixed: z0 + inner - edge, out: 1 },
      { along: 'z', fixed: x0 + edge, out: -1 },
      { along: 'z', fixed: x0 + inner - edge, out: 1 },
    ];
    for (const s of sides) {
      // Keep the vault's exit path in front of the police HQ clear.
      if (isStation && !(s.along === 'z' && s.out === 1)) continue;
      const start = s.along === 'x' ? x0 : z0;
      for (let t = 10; t < inner - 6; t += 16) {
        const along = start + t + r() * 4;
        if (isStation && along > 130 && along < 172) continue;
        const pos = s.along === 'x' ? new THREE.Vector3(along, 0, s.fixed) : new THREE.Vector3(s.fixed, 0, along);
        const roll = r();
        if (roll < 0.45) this.addPalm(pos);
        else if (roll < 0.8) this.addLightPost(pos, s);
        else if (roll < 0.9) this.addKiosk(pos, s);
        // Parked car on the street side of the curb.
        if (r() < 0.25) {
          const off = s.out * 3.6;
          const cp = s.along === 'x' ? new THREE.Vector3(along + 6, 0, s.fixed + off) : new THREE.Vector3(s.fixed + off, 0, along + 6);
          this.addParkedCar(cp, s.along === 'x' ? Math.PI / 2 : 0);
        }
      }
    }
  }

  addProp(
    mesh: THREE.Object3D,
    pos: THREE.Vector3,
    collider: RAPIER.ColliderDesc,
    value: number,
    heading = 0,
  ): void {
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
    this.props.push({ body, mesh, value, hit: false });
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
  }

  private static postGeo?: THREE.BufferGeometry;
  private static postMats = [
    new THREE.MeshStandardMaterial({ color: 0x3c4148, metalness: 0.6, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xffe9a8, emissiveIntensity: 0.6 }),
  ];

  private addLightPost(pos: THREE.Vector3, s: { along: 'x' | 'z'; out: number }): void {
    if (!City.postGeo) {
      const pole = mergeGeometries([new THREE.BoxGeometry(0.22, 7, 0.22), new THREE.BoxGeometry(0.15, 0.15, 2.4).translate(0, 3.4, 1.1)]);
      const lamp = new THREE.BoxGeometry(0.4, 0.2, 0.7).translate(0, 3.25, 2.1);
      City.postGeo = mergeGeometries([pole, lamp], true)!;
    }
    // Arm points over the street.
    const heading = s.along === 'x' ? (s.out > 0 ? 0 : Math.PI) : s.out > 0 ? Math.PI / 2 : -Math.PI / 2;
    this.addProp(new THREE.Mesh(City.postGeo, City.postMats), pos.clone().setY(3.7), RAPIER.ColliderDesc.cuboid(0.15, 3.5, 0.15).setMass(150), 1800, heading);
  }

  private addKiosk(pos: THREE.Vector3, s: { along: 'x' | 'z'; out: number }): void {
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
    const heading = s.along === 'x' ? (s.out > 0 ? 0 : Math.PI) : s.out > 0 ? Math.PI / 2 : -Math.PI / 2;
    this.addProp(g, pos.clone().setY(1.15), RAPIER.ColliderDesc.cuboid(2, 1.15, 0.9).setMass(400), 6000, heading);
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
    this.addProp(g, pos.clone().setY(0.78), RAPIER.ColliderDesc.cuboid(0.9, 0.75, 2.1).setMass(1300).setFriction(0.8), 15000, heading);
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
    floor.position.set((S.roomX0 + S.x1) / 2, 0.03, (S.roomZ0 + S.roomZ1) / 2);
    this.group.add(floor);

    // Brick wall closing the room: the vault goes through it.
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

  private buildBridge(): void {
    const len = BRIDGE_END_Z - SEAWALL_Z;
    const cz = SEAWALL_Z + len / 2;
    const deckMat = new THREE.MeshStandardMaterial({ map: (() => { const t = asphaltTexture(); t.repeat.set(4, len / 8); return t; })(), roughness: 0.95 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c5bd, roughness: 0.9 });

    const deck = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE_HALF * 2, 1.2, len), deckMat);
    deck.position.set(BRIDGE_X, -0.6, cz);
    deck.receiveShadow = true;
    this.group.add(deck);
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(BRIDGE_X, -0.6, cz));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(BRIDGE_HALF, 0.6, len / 2).setFriction(0.6), body);

    for (const side of [-1, 1]) {
      this.fixedBox(BRIDGE_X + side * (BRIDGE_HALF - 0.4), 0.5, cz, 0.4, 0.5, len / 2, concrete);
    }
    // Piers.
    for (let z = SEAWALL_Z + 40; z < BRIDGE_END_Z; z += 60) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE_HALF * 1.6, 6, 3), concrete);
      pier.position.set(BRIDGE_X, -4, z);
      this.group.add(pier);
    }
    // Light posts along the barriers.
    for (let z = SEAWALL_Z + 30; z < BRIDGE_END_Z - 20; z += 45) {
      this.addLightPost(new THREE.Vector3(BRIDGE_X - BRIDGE_HALF + 1.4, 0, z), { along: 'z', out: 1 });
      this.addLightPost(new THREE.Vector3(BRIDGE_X + BRIDGE_HALF - 1.4, 0, z + 22), { along: 'z', out: -1 });
    }
    // Dashes.
    const dashGeo = new THREE.PlaneGeometry(0.3, 4).rotateX(-Math.PI / 2);
    const n = Math.floor(len / 10);
    const dashes = new THREE.InstancedMesh(dashGeo, new THREE.MeshBasicMaterial({ color: 0xe8d36a }), n);
    const m = new THREE.Matrix4();
    for (let k = 0; k < n; k++) dashes.setMatrixAt(k, m.makeTranslation(BRIDGE_X, 0.02, SEAWALL_Z + k * 10 + 5));
    this.group.add(dashes);

    // Toll-style gantry marking the swap point.
    const gantryMat = new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.6 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), gantryMat);
      post.position.set(BRIDGE_X + side * BRIDGE_HALF, 4, SWAP_ZONE_Z);
      this.group.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(BRIDGE_HALF * 2 + 1, 1.2, 1), gantryMat);
    beam.position.set(BRIDGE_X, 8, SWAP_ZONE_Z);
    this.group.add(beam);
  }

  /** Invisible walls around the drivable area, with a gap for the bridge. */
  private buildBounds(): void {
    const minX = -STREET_HALF;
    const maxX = CITY_MAX_X + STREET_HALF;
    const minZ = -STREET_HALF;
    const wall = (x0: number, x1: number, z0: number, z1: number) =>
      this.fixedBox((x0 + x1) / 2, 5, (z0 + z1) / 2, Math.max(0.5, (x1 - x0) / 2), 5, Math.max(0.5, (z1 - z0) / 2));
    wall(minX - 1, minX, minZ, SEAWALL_Z);
    wall(maxX, maxX + 1, minZ, SEAWALL_Z);
    wall(minX, maxX, minZ - 1, minZ);
    wall(minX, BRIDGE_X - BRIDGE_HALF, SEAWALL_Z, SEAWALL_Z + 1);
    wall(BRIDGE_X + BRIDGE_HALF, maxX, SEAWALL_Z, SEAWALL_Z + 1);
    wall(BRIDGE_X - BRIDGE_HALF, BRIDGE_X + BRIDGE_HALF, BRIDGE_END_Z, BRIDGE_END_Z + 1);

    // Seawall visual, either side of the bridge.
    const seawallMat = new THREE.MeshStandardMaterial({ color: 0xc9c5bd });
    for (const [x0, x1] of [[minX - 120, BRIDGE_X - BRIDGE_HALF], [BRIDGE_X + BRIDGE_HALF, maxX + 120]]) {
      const seawall = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1, 2), seawallMat);
      seawall.position.set((x0 + x1) / 2, 0.5, SEAWALL_Z + 1);
      this.group.add(seawall);
    }
  }
}
