import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { seeThrough } from './cutaway';

/**
 * Trees, shrubs and palms, in the soft rounded style of the overhead
 * reference: cloud-like canopies that are dark underneath and light on top,
 * in Rio's colours (mostly greens, with flame trees, yellow and pink ipês and
 * jacarandas in flower).
 */

/** Deterministic 0..1 noise from a position, so shared vertices move together (no cracks). */
function hash(x: number, y: number, z: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

/** Grey vertex colours from `shade(point)`, so an instance or material colour gives the hue. */
function shadeBy(g: THREE.BufferGeometry, shade: (p: THREE.Vector3) => number): THREE.BufferGeometry {
  const p = g.attributes.position as THREE.BufferAttribute;
  const c = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const s = shade(v.fromBufferAttribute(p, i));
    c.set([s, s, s], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}

/** Bottom and top of the canopy, for a tree at scale 1. */
const CANOPY_BOTTOM = 3.3;
const CANOPY_TOP = 8.4;

/**
 * Three lumpy balls about 6 m across on a 4.6 m trunk (about 120 triangles:
 * the overhead camera never gets close enough to need more). Smooth sphere
 * normals keep it soft; the shading darkens underneath (cheap ambient occlusion).
 */
function canopyGeometry(): THREE.BufferGeometry {
  const balls: [number, number, number, number, number][] = [
    [0, 5.8, 0, 2.7, 1],
    [1.6, 6.5, 0.8, 1.8, 0],
    [-1.4, 6.6, -0.8, 1.9, 0],
  ];
  const parts = balls.map(([x, y, z, r, detail]) => {
    const g = new THREE.IcosahedronGeometry(r, detail);
    // Smooth normals even on the coarse balls (a sphere's normal is its position).
    if (detail === 0) g.attributes.normal = g.attributes.position.clone();
    g.normalizeNormals();
    const p = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + (hash(v.x * 3 + x, v.y * 3 + y, v.z * 3 + z) - 0.5) * 0.24;
      p.setXYZ(i, v.x * k, v.y * k * 0.85, v.z * k);
    }
    return g.translate(x, y, z);
  });
  const merged = mergeGeometries(parts)!;
  return shadeBy(merged, (q) => {
    const t = THREE.MathUtils.clamp((q.y - CANOPY_BOTTOM) / (CANOPY_TOP - CANOPY_BOTTOM), 0, 1);
    return 0.5 + 0.5 * t + (hash(q.x, q.y, q.z) - 0.5) * 0.08;
  });
}

/** Foliage glows a little with its own colour (light through leaves), so shaded sides aren't black. */
function softFoliage<T extends THREE.MeshStandardMaterial>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.16;',
    );
  };
  // Keep its program apart from plain materials with the same settings.
  mat.customProgramCacheKey = () => 'foliage';
  return mat;
}

/** Mostly greens, with flowering trees: flamboyant red, yellow and pink ipê, jacaranda. */
const GREENS = [0x5a9a3c, 0x4e8f3a, 0x6aa84a, 0x3f7f35, 0x76b04f, 0x588f45];
const FLOWERING: [number, number][] = [
  [0xe0502c, 0.08],
  [0xf0c428, 0.06],
  [0xa57ad6, 0.05],
  [0xe07aa8, 0.03],
];
const SHRUBS = [0x3f7a33, 0x4b8a3c, 0x557f3a, 0x47823a];

const CELL = 320;

/**
 * Trees and shrubs, instanced per 320 m square so squares off screen are
 * culled: a trunk mesh and a canopy mesh in each. Canopies dissolve round the
 * player from overhead, like buildings.
 */
export class Trees {
  readonly group = new THREE.Group();
  private canopy = canopyGeometry();
  private trunk = new THREE.CylinderGeometry(0.2, 0.32, 4.6, 6, 1, true).translate(0, 2.3, 0);
  private canopyMat = seeThrough(softFoliage(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })));
  private trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b513a, roughness: 0.9 });
  private cells = new Map<string, { canopies: { m: THREE.Matrix4; c: THREE.Color }[]; trunks: THREE.Matrix4[] }>();

  constructor(private rand: () => number) {}

  private cell(p: THREE.Vector3) {
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
    let c = this.cells.get(key);
    if (!c) this.cells.set(key, (c = { canopies: [], trunks: [] }));
    return c;
  }

  /** A species colour: usually a green, sometimes a tree in flower. */
  private species(): THREE.Color {
    let r = this.rand();
    for (const [hex, share] of FLOWERING) {
      if (r < share) return new THREE.Color(hex);
      r -= share;
    }
    return new THREE.Color(GREENS[Math.floor(this.rand() * GREENS.length)]);
  }

  /** A tree standing at `pos` on ground `base` m up (a roof garden); `size` about 1 (6 m across). */
  tree(pos: THREE.Vector3, size: number, base = 0): void {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI * 2);
    const s = new THREE.Vector3(size * (0.85 + this.rand() * 0.3), size * (0.8 + this.rand() * 0.35), size * (0.85 + this.rand() * 0.3));
    const m = new THREE.Matrix4().compose(pos.clone().setY(base), q, s);
    const cell = this.cell(pos);
    cell.canopies.push({ m, c: this.species() });
    cell.trunks.push(m);
  }

  /** A shrub: a small canopy sitting on ground `base` m up, about `size` x 6 m across. */
  shrub(pos: THREE.Vector3, size: number, base = 0): void {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rand() * Math.PI * 2);
    const s = new THREE.Vector3(size, size * 0.8, size);
    // Drop it so the bottom of the canopy is on the ground.
    const m = new THREE.Matrix4().compose(pos.clone().setY(base - (CANOPY_BOTTOM - 0.3) * size * 0.8), q, s);
    // Now and then a bougainvillea in flower.
    this.cell(pos).canopies.push({ m, c: new THREE.Color(this.rand() < 0.12 ? 0xc0307a : SHRUBS[Math.floor(this.rand() * SHRUBS.length)]) });
  }

  /** Make the meshes (call once, after placing everything). */
  build(): void {
    for (const { canopies, trunks } of this.cells.values()) {
      const crowns = new THREE.InstancedMesh(this.canopy, this.canopyMat, canopies.length);
      canopies.forEach(({ m, c }, i) => {
        crowns.setMatrixAt(i, m);
        crowns.setColorAt(i, c);
      });
      crowns.computeBoundingSphere();
      crowns.castShadow = crowns.receiveShadow = true;
      this.group.add(crowns);
      if (!trunks.length) continue;
      const stems = new THREE.InstancedMesh(this.trunk, this.trunkMat, trunks.length);
      trunks.forEach((m, i) => stems.setMatrixAt(i, m));
      stems.computeBoundingSphere();
      stems.castShadow = true;
      this.group.add(stems);
    }
  }
}

/** Every part of a merged mesh needs the same attributes: positions, normals, UVs, colours. */
function solid(g: THREE.BufferGeometry, color: [number, number, number]): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
  const c = new Float32Array(ng.attributes.position.count * 3);
  for (let i = 0; i < c.length; i += 3) c.set(color, i);
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return ng;
}

/**
 * A coconut palm, centred on its 8 m trunk (top at +4): a slightly curved,
 * ringed trunk, twelve arching fronds folded along the rib, and coconuts.
 * Groups: trunk, fronds, coconuts (for palmMaterials()).
 */
export function palmGeometry(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.17, 0.27, 8, 7, 10, true);
  const tp = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    // A gentle lean toward the top.
    tp.setX(i, tp.getX(i) + 0.012 * (y + 4) * (y + 4));
  }
  const trunkCol = solid(trunk, [1, 1, 1]);
  shadeBy(trunkCol, (q) => (Math.sin((q.y + 4) * 7) > 0.55 ? 0.72 : 1));

  const top = new THREE.Vector3(0.012 * 64, 4, 0);
  const pos: number[] = [];
  const col: number[] = [];
  const fronds = 12;
  for (let f = 0; f < fronds; f++) {
    const a = (f / fronds) * Math.PI * 2 + hash(f, 1, 2) * 0.4;
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const across = new THREE.Vector3(-out.z, 0, out.x);
    const len = 3.4 + hash(f, 3, 4) * 1.4;
    const droop = 0.55 + hash(f, 5, 6) * 0.6;
    const lift = f % 3 === 0 ? 0.9 : 0.6;
    const seg = 6;
    const centre = (t: number) =>
      top.clone().addScaledVector(out, len * t).add(new THREE.Vector3(0, len * (lift * t * (1 - t) - droop * t * t * 0.7), 0));
    const width = (t: number) => 0.62 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.8;
    for (let i = 0; i < seg; i++) {
      const [t0, t1] = [i / seg, (i + 1) / seg];
      const c0 = centre(t0);
      const c1 = centre(t1);
      // Folded along the rib: the edges hang a little below it.
      const edge = (c: THREE.Vector3, t: number, side: number) => c.clone().addScaledVector(across, side * width(t)).add(new THREE.Vector3(0, -0.18 * width(t), 0));
      const green = (t: number): [number, number, number] => [0.2 + 0.25 * t, 0.42 + 0.2 * t, 0.15 + 0.06 * t];
      for (const side of [1, -1]) {
        const e0 = edge(c0, t0, side);
        const e1 = edge(c1, t1, side);
        for (const [p, t] of [[c0, t0], [e0, t0], [c1, t1], [e0, t0], [e1, t1], [c1, t1]] as const) {
          pos.push(p.x, p.y, p.z);
          col.push(...green(t));
        }
      }
    }
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  leaves.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  leaves.computeVertexNormals();

  const nuts = [0, 1, 2].map((k) => {
    const a = (k / 3) * Math.PI * 2;
    return solid(new THREE.SphereGeometry(0.2, 7, 5).translate(top.x + Math.cos(a) * 0.3, 3.65, Math.sin(a) * 0.3), [0.45, 0.33, 0.18]);
  });
  return mergeGeometries([trunkCol, leaves, mergeGeometries(nuts)!], true)!;
}

/** Materials for palmGeometry's groups: trunk, fronds (two-sided), coconuts. */
export function palmMaterials(): THREE.Material[] {
  return [
    new THREE.MeshStandardMaterial({ color: 0x8a6a48, vertexColors: true, roughness: 0.9 }),
    seeThrough(softFoliage(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide }))),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }),
  ];
}
