import * as THREE from 'three';
import { barrierTexture, checkerTexture, curbTexture, grassTexture, roadTexture } from './textures';

export const ROAD_HALF_WIDTH = 9;
export const CURB_WIDTH = 1.4;
export const WALL_OFFSET = 17;
const WALL_HEIGHT = 1.3;
const SAMPLES = 2400;
const SCALE = 1.5;

/** Circuit layout (x, z) before scaling. Driven in this order, starting at index 0. */
const LAYOUT: [number, number][] = [
  [0, 0], [0, 180], [40, 260], [130, 280], [200, 230], [190, 150], [120, 110],
  [110, 40], [180, -20], [260, -40], [280, -140], [210, -220], [90, -230], [10, -160],
];

export interface TrackLocation {
  index: number;
  /** Signed distance from the center line; positive = left of travel direction. */
  lateral: number;
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  left: THREE.Vector3;
}

export class Track {
  readonly group = new THREE.Group();
  readonly points: THREE.Vector3[] = [];
  readonly tangents: THREE.Vector3[] = [];
  readonly lefts: THREE.Vector3[] = [];
  readonly length: number;
  readonly sampleCount = SAMPLES;

  constructor() {
    const curve = new THREE.CatmullRomCurve3(
      LAYOUT.map(([x, z]) => new THREE.Vector3(x * SCALE, 0, z * SCALE)),
      true,
      'centripetal',
    );
    this.length = curve.getLength();
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      const p = curve.getPointAt(t);
      const tan = curve.getTangentAt(t).setY(0).normalize();
      this.points.push(p);
      this.tangents.push(tan);
      this.lefts.push(new THREE.Vector3(tan.z, 0, -tan.x));
    }
    this.build();
  }

  /** Index of a sample `meters` along the track from `index` (may be negative). */
  offsetIndex(index: number, meters: number): number {
    const step = Math.round((meters / this.length) * SAMPLES);
    return (((index + step) % SAMPLES) + SAMPLES) % SAMPLES;
  }

  /**
   * Find where `pos` is relative to the track. Searches near `hint` when given
   * (cheap, used every frame), otherwise scans every sample.
   */
  locate(pos: THREE.Vector3, hint?: number): TrackLocation {
    let best = 0;
    let bestD = Infinity;
    const check = (i: number) => {
      const p = this.points[i];
      const d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint === undefined) {
      for (let i = 0; i < SAMPLES; i++) check(i);
    } else {
      for (let k = -80; k <= 80; k++) check((hint + k + SAMPLES) % SAMPLES);
    }
    const point = this.points[best];
    const left = this.lefts[best];
    const lateral = (pos.x - point.x) * left.x + (pos.z - point.z) * left.z;
    return { index: best, lateral, point, tangent: this.tangents[best], left };
  }

  private build(): void {
    const anisotropy = 8;

    const road = roadTexture();
    road.anisotropy = anisotropy;
    this.group.add(
      this.ribbon(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, 0.02, 20, new THREE.MeshStandardMaterial({ map: road, roughness: 0.9 })),
    );

    const curbMat = new THREE.MeshStandardMaterial({ map: curbTexture(), roughness: 0.7 });
    this.group.add(this.ribbon(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + CURB_WIDTH, 0.04, 4, curbMat));
    this.group.add(this.ribbon(-ROAD_HALF_WIDTH - CURB_WIDTH, -ROAD_HALF_WIDTH, 0.04, 4, curbMat));

    const wallMat = new THREE.MeshStandardMaterial({ map: barrierTexture(), side: THREE.DoubleSide, roughness: 0.6 });
    this.group.add(this.wall(WALL_OFFSET, wallMat));
    this.group.add(this.wall(-WALL_OFFSET, wallMat));

    this.buildGround();
    this.buildStartLine();
    this.buildTrees();
  }

  /** Flat strip between two lateral offsets, following the center line. */
  private ribbon(inner: number, outer: number, y: number, vMeters: number, mat: THREE.Material): THREE.Mesh {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const step = this.length / SAMPLES;
    for (let i = 0; i <= SAMPLES; i++) {
      const p = this.points[i % SAMPLES];
      const l = this.lefts[i % SAMPLES];
      const v = (i * step) / vMeters;
      pos.push(p.x + l.x * inner, y, p.z + l.z * inner, p.x + l.x * outer, y, p.z + l.z * outer);
      uv.push(0, v, 1, v);
      if (i < SAMPLES) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Vertical barrier at a lateral offset. */
  private wall(offset: number, mat: THREE.Material): THREE.Mesh {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const step = this.length / SAMPLES;
    for (let i = 0; i <= SAMPLES; i++) {
      const p = this.points[i % SAMPLES];
      const l = this.lefts[i % SAMPLES];
      const x = p.x + l.x * offset;
      const z = p.z + l.z * offset;
      const u = (i * step) / 6;
      pos.push(x, 0, z, x, WALL_HEIGHT, z);
      uv.push(u, 0, u, 1);
      if (i < SAMPLES) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildGround(): void {
    const tex = grassTexture();
    tex.repeat.set(300, 300);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(3000, 3000),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.group.add(ground);
  }

  private buildStartLine(): void {
    const p = this.points[0];
    const t = this.tangents[0];
    const heading = Math.atan2(t.x, t.z);

    const tex = checkerTexture();
    tex.repeat.set(ROAD_HALF_WIDTH, 1);
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 2),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 }),
    );
    line.rotation.set(-Math.PI / 2, 0, heading);
    line.position.set(p.x, 0.03, p.z);
    line.receiveShadow = true;
    this.group.add(line);

    // Gantry over the line.
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.5, roughness: 0.4 });
    const span = (ROAD_HALF_WIDTH + CURB_WIDTH + 1.5) * 2;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 7, 0.6), postMat);
      post.position.set((side * span) / 2, 3.5, 0);
      post.castShadow = true;
      gantry.add(post);
    }
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(span + 0.6, 1.4, 0.8),
      new THREE.MeshStandardMaterial({ color: 0xd42020, emissive: 0x400000, roughness: 0.5 }),
    );
    beam.position.y = 7;
    beam.castShadow = true;
    gantry.add(beam);
    gantry.position.set(p.x, 0, p.z);
    gantry.rotation.y = heading;
    this.group.add(gantry);
  }

  private buildTrees(): void {
    const box = new THREE.Box3().setFromPoints(this.points).expandByScalar(220);
    const count = 700;
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2, 6);
    const leafGeo = new THREE.ConeGeometry(2.2, 6, 7);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b3a1e }), count);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0x2f6b2a, flatShading: true }), count);
    trunks.castShadow = leaves.castShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const color = new THREE.Color();
    const minDist = WALL_OFFSET + 5;
    let placed = 0;
    for (let attempt = 0; attempt < count * 20 && placed < count; attempt++) {
      pos.set(THREE.MathUtils.lerp(box.min.x, box.max.x, Math.random()), 0, THREE.MathUtils.lerp(box.min.z, box.max.z, Math.random()));
      let near = false;
      for (let i = 0; i < SAMPLES; i += 8) {
        const p = this.points[i];
        if ((p.x - pos.x) ** 2 + (p.z - pos.z) ** 2 < minDist * minDist) {
          near = true;
          break;
        }
      }
      if (near) continue;
      const scale = 0.7 + Math.random() * 0.9;
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.random() * Math.PI * 2);
      s.setScalar(scale);
      m.compose(pos.clone().setY(1 * scale), q, s);
      trunks.setMatrixAt(placed, m);
      m.compose(pos.clone().setY(4.8 * scale), q, s);
      leaves.setMatrixAt(placed, m);
      leaves.setColorAt(placed, color.setHSL(0.27 + Math.random() * 0.08, 0.45, 0.25 + Math.random() * 0.1));
      placed++;
    }
    trunks.count = leaves.count = placed;
    this.group.add(trunks, leaves);
  }
}
