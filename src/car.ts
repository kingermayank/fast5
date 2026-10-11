import * as THREE from 'three';
import type { ControlState } from './input';

const ACCEL = 24;
const BRAKE = 45;
const REVERSE_ACCEL = 10;
const MAX_REVERSE = 14;
const TOP_SPEED_ROAD = 70;
const TOP_SPEED_GRASS = 28;
const TURN_RATE = 2.3;
const WHEEL_RADIUS = 0.4;

export type Surface = 'road' | 'grass';

/** Arcade car: a velocity in the ground plane plus a heading, with tunable grip. */
export class Car {
  readonly mesh = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  heading = 0;
  steer = 0;
  /** Signed speed along the car's forward axis (m/s). */
  forwardSpeed = 0;
  lateralSpeed = 0;

  private body = new THREE.Group();
  private spinners: THREE.Object3D[] = [];
  private frontPivots: THREE.Object3D[] = [];

  constructor(color = 0xe0242a) {
    this.buildMesh(color);
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  place(position: THREE.Vector3, heading: number): void {
    this.position.copy(position).setY(0);
    this.heading = heading;
    this.velocity.set(0, 0, 0);
    this.forwardSpeed = this.lateralSpeed = this.steer = 0;
    this.syncMesh(0);
  }

  update(dt: number, input: ControlState, surface: Surface): void {
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const lx = fz;
    const lz = -fx;
    let vF = this.velocity.x * fx + this.velocity.z * fz;
    let vL = this.velocity.x * lx + this.velocity.z * lz;

    const onGrass = surface === 'grass';
    const top = onGrass ? TOP_SPEED_GRASS : TOP_SPEED_ROAD;

    if (input.throttle > 0) {
      if (vF < -0.5) vF += BRAKE * dt;
      else vF += ACCEL * input.throttle * Math.max(0, 1 - vF / top) * dt;
    }
    if (input.brake > 0) {
      if (vF > 0.5) vF -= BRAKE * input.brake * dt;
      else vF = Math.max(-MAX_REVERSE, vF - REVERSE_ACCEL * dt);
    }
    if (!input.throttle && !input.brake) vF -= vF * 0.5 * dt;
    if (input.handbrake) vF -= vF * 0.9 * dt;
    // Grass bleeds off speed above its top speed.
    if (onGrass && Math.abs(vF) > top) vF -= Math.sign(vF) * 30 * dt;

    // Steering: smooth input, less authority at high speed, none when stopped.
    this.steer += (input.steer - this.steer) * Math.min(1, 10 * dt);
    const speedAbs = Math.abs(vF);
    const lowSpeed = Math.min(1, speedAbs / 6);
    const highSpeed = 1 / (1 + speedAbs / 45);
    const yawRate = this.steer * TURN_RATE * lowSpeed * highSpeed * Math.sign(vF) * (input.handbrake ? 1.5 : 1);
    this.heading += yawRate * dt;

    // Lateral grip: how fast sideways sliding is killed. Low grip = drift.
    const grip = input.handbrake ? 1.2 : onGrass ? 3.5 : 7;
    vL *= Math.exp(-grip * dt);

    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    this.velocity.set(nfx * vF + nfz * vL, 0, nfz * vF - nfx * vL);
    this.position.addScaledVector(this.velocity, dt);
    this.forwardSpeed = vF;
    this.lateralSpeed = vL;
    this.syncMesh(dt);
  }

  syncMesh(dt: number): void {
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.heading;
    const roll = THREE.MathUtils.clamp(-this.lateralSpeed * 0.012 - this.steer * this.forwardSpeed * 0.0015, -0.08, 0.08);
    this.body.rotation.z += (roll - this.body.rotation.z) * Math.min(1, 8 * dt);
    for (const s of this.spinners) s.rotation.x += (this.forwardSpeed / WHEEL_RADIUS) * dt;
    for (const p of this.frontPivots) p.rotation.y = this.steer * 0.45;
  }

  private buildMesh(color: number): void {
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15181d, metalness: 0.3, roughness: 0.6 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2a3a, metalness: 0.9, roughness: 0.1 });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this.body.add(m);
      return m;
    };

    add(new THREE.BoxGeometry(2, 0.5, 4.4), paint, 0, 0.6, 0);
    add(new THREE.BoxGeometry(1.9, 0.25, 1.4), paint, 0, 0.9, 1.4).rotation.x = 0.12;
    add(new THREE.BoxGeometry(1.6, 0.5, 1.9), glass, 0, 1.1, -0.35);
    add(new THREE.BoxGeometry(2.05, 0.2, 4.5), dark, 0, 0.38, 0);
    // Rear wing.
    add(new THREE.BoxGeometry(2, 0.08, 0.5), dark, 0, 1.35, -2.0);
    add(new THREE.BoxGeometry(0.1, 0.45, 0.3), dark, -0.7, 1.1, -2.0);
    add(new THREE.BoxGeometry(0.1, 0.45, 0.3), dark, 0.7, 1.1, -2.0);
    // Lights.
    const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 1.5 });
    const tail = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff0000, emissiveIntensity: 1.2 });
    for (const x of [-0.7, 0.7]) {
      add(new THREE.BoxGeometry(0.45, 0.14, 0.05), head, x, 0.7, 2.21);
      add(new THREE.BoxGeometry(0.45, 0.14, 0.05), tail, x, 0.72, -2.21);
    }
    this.mesh.add(this.body);

    const tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.8, roughness: 0.3 });
    const tireGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.36, 18).rotateZ(Math.PI / 2);
    const rimGeo = new THREE.BoxGeometry(0.38, 0.5, 0.12);
    for (const [x, z, front] of [
      [-1.02, 1.4, true],
      [1.02, 1.4, true],
      [-1.02, -1.4, false],
      [1.02, -1.4, false],
    ] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_RADIUS, z);
      const spinner = new THREE.Group();
      const t = new THREE.Mesh(tireGeo, tire);
      t.castShadow = true;
      spinner.add(t, new THREE.Mesh(rimGeo, rim));
      pivot.add(spinner);
      this.mesh.add(pivot);
      this.spinners.push(spinner);
      if (front) this.frontPivots.push(pivot);
    }
  }
}
