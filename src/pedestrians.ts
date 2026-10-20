import * as THREE from 'three';
import { MAP, type MapNode, nearOverpass, PLAN } from './roadmap';

/*
 * People on the corners of the busy crossings along Mia's route. They stand about and
 * turn to stare as the convoy comes; when it's close they scatter, arms up, running away
 * from the road, and anyone the vault comes near dives flat. Nobody is ever hit: they
 * have no bodies in the physics and they're always gone before it gets there. A minute
 * later, with the convoy long gone, they're back on their corners for the next pass.
 * Generic figures in everyday clothes (nobody in particular), drawn instanced: four draws
 * for all of them (legs, bodies, heads, arms), each part coloured per person.
 */

type Mode = 'idle' | 'run' | 'dive' | 'watch';

interface Person {
  home: THREE.Vector3;
  homeYaw: number;
  pos: THREE.Vector3;
  yaw: number;
  mode: Mode;
  /** Seconds in this mode. */
  t: number;
  /** Running: which way and how fast (m/s). */
  run: THREE.Vector3;
  /** How far they're lying down (0 standing, 1 flat). */
  flat: number;
  scale: number;
  phase: number;
  /** The corner they're on: its middle, and which way is away from the road. */
  corner: THREE.Vector3;
  out: THREE.Vector3;
}

const SHIRTS = [0xf4f1ea, 0xd8443a, 0xf2c14e, 0x2f9c95, 0xe86fa3, 0x3b6fb6, 0x5aa457, 0xf08a3c, 0x7d5ba6, 0x222428];
const TROUSERS = [0x2f4a73, 0x3a3f47, 0xc8b48a, 0x1c1d20, 0x6b7f99, 0xe9e4d8];
const SKINS = [0x7a5236, 0x5b3a26, 0xc89f7e, 0xa8704f, 0xe0b48f, 0x8d5a3b];

/** Who's close enough to be animated (m from the camera); the rest are hidden. */
const NEAR = 230;
/** The convoy this close (m), moving, sets a corner running; the vault this close makes them dive. */
const SCATTER = 40;
const DIVE = 8;

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export class Pedestrians {
  readonly group = new THREE.Group();
  private people: Person[] = [];
  private legs: THREE.InstancedMesh;
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private arms: THREE.InstancedMesh;
  private readonly m = new THREE.Matrix4();
  private readonly part = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private wasNear = new Set<Person>();

  constructor(private blocked: (p: THREE.Vector3) => boolean) {
    let seed = 91;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    // Corners of the route's crossings, a few people to each.
    for (const node of PLAN) {
      if (node.edges.length < 3 || nearOverpass(node.pos, 40)) continue;
      for (const c of this.corners(node)) {
        if (rand() < 0.35) continue;
        const n = 2 + Math.floor(rand() * 4);
        for (let i = 0; i < n; i++) {
          const p = c.at.clone().add(new THREE.Vector3((rand() - 0.5) * 2.6, 0, (rand() - 0.5) * 2.6));
          if (blocked(p) || MAP.onRoad(p, 0.7)) continue;
          // Facing the crossing, more or less.
          const toward = c.at.clone().sub(c.out.clone().multiplyScalar(3)).sub(p);
          const yaw = Math.atan2(toward.x, toward.z) + (rand() - 0.5) * 1.2;
          this.people.push({
            home: p.clone(),
            homeYaw: yaw,
            pos: p.clone(),
            yaw,
            mode: 'idle',
            t: rand() * 5,
            run: new THREE.Vector3(),
            flat: 0,
            scale: 0.9 + rand() * 0.18,
            phase: rand() * 10,
            corner: c.at,
            out: c.out,
          });
        }
      }
    }
    const n = this.people.length;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    const make = (geo: THREE.BufferGeometry, count: number) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      im.castShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
      return im;
    };
    // Each part's pivot at its joint: legs and arms hang from hip and shoulder.
    this.legs = make(new THREE.BoxGeometry(0.15, 0.86, 0.17).translate(0, -0.43, 0), n * 2);
    this.bodies = make(new THREE.BoxGeometry(0.42, 0.6, 0.24).translate(0, 0.3, 0), n);
    this.heads = make(new THREE.SphereGeometry(0.13, 10, 8), n);
    this.arms = make(new THREE.BoxGeometry(0.1, 0.6, 0.11).translate(0, -0.3, 0), n * 2);
    const col = new THREE.Color();
    this.people.forEach((p, i) => {
      const shirt = SHIRTS[Math.floor(rand() * SHIRTS.length)];
      const skin = SKINS[Math.floor(rand() * SKINS.length)];
      const sleeves = rand() < 0.6;
      this.bodies.setColorAt(i, col.setHex(shirt));
      this.heads.setColorAt(i, col.setHex(skin));
      for (const k of [0, 1]) {
        this.legs.setColorAt(i * 2 + k, col.setHex(TROUSERS[Math.floor(p.phase * 7) % TROUSERS.length]));
        this.arms.setColorAt(i * 2 + k, col.setHex(sleeves ? skin : shirt));
      }
      this.hide(i);
    });
  }

  /** The corners of a crossing: between each pair of streets out of it, back from the asphalt. */
  private corners(node: MapNode): { at: THREE.Vector3; out: THREE.Vector3 }[] {
    const dirs = node.edges
      .map((e) => {
        const pts = MAP.from(e, node);
        const d = pts[Math.min(1, pts.length - 1)].clone().sub(pts[0]).setY(0).normalize();
        return { a: Math.atan2(d.x, d.z), d, hw: e.hw };
      })
      .sort((x, y) => x.a - y.a);
    const out: { at: THREE.Vector3; out: THREE.Vector3 }[] = [];
    for (let i = 0; i < dirs.length; i++) {
      const a = dirs[i];
      const b = dirs[(i + 1) % dirs.length];
      const mid = a.d.clone().add(b.d);
      if (mid.lengthSq() < 0.05) continue;
      mid.normalize();
      const r = Math.max(a.hw, b.hw) * 1.45 + 3.2;
      out.push({ at: node.pos.clone().addScaledVector(mid, r).setY(0), out: mid });
    }
    return out;
  }

  get count(): number {
    return this.people.length;
  }

  /** How many are running or down right now (for tests). */
  get scattered(): number {
    return this.people.filter((p) => p.mode === 'run' || p.mode === 'dive').length;
  }

  private hide(i: number): void {
    this.bodies.setMatrixAt(i, HIDDEN);
    this.heads.setMatrixAt(i, HIDDEN);
    for (const k of [0, 1]) {
      this.legs.setMatrixAt(i * 2 + k, HIDDEN);
      this.arms.setMatrixAt(i * 2 + k, HIDDEN);
    }
  }

  /**
   * Per frame: who's near the camera, who should run (the car `car` coming at `speed`, the
   * vault at `vault`), and everyone's pose.
   */
  update(dt: number, camera: THREE.Vector3, car: THREE.Vector3, speed: number, vault: THREE.Vector3): void {
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      const near = Math.abs(p.pos.x - camera.x) < NEAR && Math.abs(p.pos.z - camera.z) < NEAR;
      if (!near) {
        if (this.wasNear.has(p)) {
          this.wasNear.delete(p);
          this.hide(i);
        }
        // Out of sight: back on their corner, as they were.
        if (p.mode !== 'idle') this.reset(p);
        continue;
      }
      this.wasNear.add(p);
      p.t += dt;
      const dCar = p.pos.distanceTo(car);
      const dVault = p.pos.distanceTo(vault);
      if (p.mode === 'idle' || p.mode === 'watch') {
        if (dVault < DIVE + 2 || (dCar < SCATTER && speed > 6)) {
          // Away from whichever is nearer, and away from the road.
          const from = dVault < dCar ? vault : car;
          const away = p.pos.clone().sub(from).setY(0).normalize().add(p.out.clone().multiplyScalar(0.9)).normalize();
          p.run.copy(away).multiplyScalar(4.8 + ((p.phase * 13) % 1.8));
          p.mode = dVault < DIVE ? 'dive' : 'run';
          p.t = 0;
        } else if (dCar < 90) {
          // Turned to stare at what's coming.
          this.turnTo(p, Math.atan2(car.x - p.pos.x, car.z - p.pos.z), dt * 3);
        } else if (p.mode === 'watch' && p.t > 20 && dCar > 160) {
          this.reset(p);
        }
      } else if (p.mode === 'run') {
        this.turnTo(p, Math.atan2(p.run.x, p.run.z), dt * 10);
        const next = p.pos.clone().addScaledVector(p.run, dt);
        if ((!MAP.onRoad(next, -0.5) || p.t < 0.3) && !this.blocked(next)) p.pos.copy(next);
        if (dVault < DIVE) {
          p.mode = 'dive';
          p.t = 0;
        } else if (p.t > 2.4 + (p.phase % 1)) {
          p.mode = 'watch';
          p.t = 0;
        }
      } else if (p.mode === 'dive') {
        p.flat = Math.min(1, p.flat + dt * 3.2);
        if (p.t < 0.45) p.pos.addScaledVector(p.run, dt * 0.8);
        if (p.t > 2.2) {
          p.mode = 'watch';
          p.t = 0;
        }
      }
      if (p.mode !== 'dive' && p.flat > 0) p.flat = Math.max(0, p.flat - dt * 1.6);
      this.pose(i, p);
    }
    for (const im of [this.legs, this.bodies, this.heads, this.arms]) im.instanceMatrix.needsUpdate = true;
  }

  private turnTo(p: Person, yaw: number, k: number): void {
    const d = Math.atan2(Math.sin(yaw - p.yaw), Math.cos(yaw - p.yaw));
    p.yaw += d * Math.min(1, k);
  }

  private reset(p: Person): void {
    p.pos.copy(p.home);
    p.yaw = p.homeYaw;
    p.mode = 'idle';
    p.flat = 0;
    p.t = 0;
  }

  /** Write person `i`'s parts: standing, running, waving their arms, or flat on the ground. */
  private pose(i: number, p: Person): void {
    const s = p.scale;
    // Diving pitches the whole body forward about the feet, down to the pavement.
    const pitch = p.flat * (Math.PI / 2 - 0.08);
    this.m.compose(p.pos, this.q.setFromEuler(this.e.set(pitch, p.yaw, 0, 'YXZ')), new THREE.Vector3(s, s, s));
    if (p.flat > 0) this.m.premultiply(new THREE.Matrix4().makeTranslation(0, 0.14 * p.flat, 0));
    const running = p.mode === 'run';
    const panic = running || p.mode === 'dive';
    const w = p.t * (running ? 13 : 2) + p.phase;
    const stride = running ? Math.sin(w) * 0.8 : 0;
    const set = (im: THREE.InstancedMesh, j: number, x: number, y: number, z: number, rx: number, rz: number) => {
      this.part.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e.set(rx, 0, rz)), new THREE.Vector3(1, 1, 1));
      im.setMatrixAt(j, this.part.premultiply(this.m));
    };
    const lean = running ? 0.25 : p.mode === 'dive' ? 0.2 : Math.sin(p.t * 0.7 + p.phase) * 0.03;
    set(this.legs, i * 2, 0.1, 0.88, 0, stride, 0);
    set(this.legs, i * 2 + 1, -0.1, 0.88, 0, -stride, 0);
    set(this.bodies, i, 0, 0.88, 0, lean, 0);
    set(this.heads, i, 0, 0.88 + 0.6 * Math.cos(lean) + 0.15, 0.6 * Math.sin(lean), 0, 0);
    // Panicking: both arms up and flailing (diving: out in front); otherwise down at their sides.
    const up = p.mode === 'dive' ? 0 : panic ? 2.6 + Math.sin(w * 1.3) * 0.35 : 0.08;
    const fwd = p.mode === 'dive' ? -2.9 : running ? 0 : Math.sin(p.t * 1.1 + p.phase) * 0.05;
    const sy = 0.88 + 0.56 * Math.cos(lean);
    const sz = 0.56 * Math.sin(lean);
    // After it's gone by, half of them hold a phone up at it.
    const filming = p.mode === 'watch' && p.phase % 2 < 1;
    set(this.arms, i * 2, 0.27, sy, sz, fwd, up);
    set(this.arms, i * 2 + 1, -0.27, sy, sz, filming ? -1.35 : fwd, filming ? -0.15 : -up);
  }
}
