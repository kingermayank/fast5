import * as THREE from 'three';
import { buildCarModel, type CarModel, type CarModelOptions, WHEEL_RADIUS } from './carModel';
import type { ControlState } from './input';
import { RAPIER, syncMesh, yawQuat } from './physics';

export interface VehicleSpec {
  mass: number;
  /** Drive acceleration at standstill (m/s²); fades to 0 at top speed. */
  accel: number;
  topSpeed: number;
  turnRate: number;
  /** How fast sideways sliding is cancelled (1/s). */
  grip: number;
  model: CarModelOptions;
}

const HALF = { x: 1.0, y: 0.55, z: 2.5 };
/** Body origin sits this high above the ground. */
const RIDE_HEIGHT = HALF.y + 0.15;
/** Local-space tow point at the rear winch. */
export const TOW_POINT = { x: 0, y: -0.25, z: -HALF.z - 0.1 };

const NO_INPUT: ControlState = { throttle: 0, brake: 0, steer: 0, handbrake: false };

/**
 * Rigid-body car with arcade handling: drive, grip and yaw are applied as
 * impulses/velocity corrections each step, so collisions and tow cables still
 * act on it physically.
 */
export class Vehicle {
  readonly model: CarModel;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  controls: ControlState = NO_INPUT;
  steer = 0;
  forwardSpeed = 0;
  lateralSpeed = 0;
  /** Disabled vehicles get no drive input (wrecked cops, finished race). */
  enabled = true;
  /** Multiplier on drive force and top speed (AI catch-up assist). */
  assist = 1;

  constructor(
    private world: RAPIER.World,
    readonly spec: VehicleSpec,
    position: THREE.Vector3,
    heading: number,
  ) {
    this.model = buildCarModel(spec.model);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, RIDE_HEIGHT, position.z)
        .setRotation(yawQuat(heading))
        .enabledRotations(false, true, false)
        .setCcdEnabled(true)
        .setAngularDamping(1),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z)
        .setMass(spec.mass)
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.1),
      this.body,
    );
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, 0, t.z);
  }

  get forward(): THREE.Vector3 {
    const r = this.body.rotation();
    return new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).setY(0).normalize();
  }

  get heading(): number {
    const f = this.forward;
    return Math.atan2(f.x, f.z);
  }

  /** World position of the rear tow point. */
  towPoint(): THREE.Vector3 {
    const t = this.body.translation();
    const r = this.body.rotation();
    return new THREE.Vector3(TOW_POINT.x, TOW_POINT.y, TOW_POINT.z)
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w))
      .add(new THREE.Vector3(t.x, t.y, t.z));
  }

  place(position: THREE.Vector3, heading: number): void {
    this.body.setTranslation({ x: position.x, y: RIDE_HEIGHT, z: position.z }, true);
    this.body.setRotation(yawQuat(heading), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Apply handling forces. Call before world.step(). */
  step(dt: number): void {
    const c = this.enabled ? this.controls : NO_INPUT;
    const f = this.forward;
    const lx = f.z;
    const lz = -f.x;
    const v = this.body.linvel();
    const vF = v.x * f.x + v.z * f.z;
    const vL = v.x * lx + v.z * lz;
    const m = this.spec.mass;

    let a = 0;
    if (c.throttle > 0) {
      a = vF < -1 ? 30 : this.spec.accel * this.assist * c.throttle * Math.max(0, 1 - vF / (this.spec.topSpeed * this.assist));
    }
    if (c.brake > 0) {
      a = vF > 1 ? -30 * c.brake : vF > -14 ? -9 : 0;
    }
    if (!c.throttle && !c.brake) a = -vF * 0.4;
    if (c.handbrake) a -= vF * 0.8;

    const gripRate = c.handbrake ? 1.0 : this.spec.grip;
    const dvL = -vL * Math.min(1, gripRate * dt);
    this.body.applyImpulse(
      { x: m * (f.x * a * dt + lx * dvL), y: 0, z: m * (f.z * a * dt + lz * dvL) },
      true,
    );

    this.steer += (c.steer - this.steer) * Math.min(1, 10 * dt);
    const speed = Math.abs(vF);
    const yaw =
      this.steer *
      this.spec.turnRate *
      Math.min(1, speed / 5) *
      (1 / (1 + speed / 40)) *
      Math.sign(vF) *
      (c.handbrake ? 1.5 : 1);
    const w = this.body.angvel();
    this.body.setAngvel({ x: w.x, y: w.y + (yaw - w.y) * Math.min(1, 12 * dt), z: w.z }, true);

    this.forwardSpeed = vF;
    this.lateralSpeed = vL;
  }

  /** Update the visual model. Call once per rendered frame. */
  render(dt: number): void {
    syncMesh(this.model.group, this.body, -RIDE_HEIGHT);
    const roll = THREE.MathUtils.clamp(-this.lateralSpeed * 0.012 - this.steer * this.forwardSpeed * 0.0015, -0.08, 0.08);
    this.model.body.rotation.z += (roll - this.model.body.rotation.z) * Math.min(1, 8 * dt);
    for (const s of this.model.spinners) s.rotation.x += (this.forwardSpeed / WHEEL_RADIUS) * dt;
    for (const p of this.model.frontPivots) p.rotation.y = this.steer * 0.45;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.group);
    this.world.removeRigidBody(this.body);
  }
}
