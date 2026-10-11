import * as THREE from 'three';
import { buildCarModel, type CarModel, type CarModelOptions } from './carModel';
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

/** Most sideways acceleration the tires can hold (m/s², about 1.9 g, arcade-generous). */
const LATERAL_GRIP = 19;
/** With the handbrake on, the tail steps out and the car can rotate faster (a drift). */
const DRIFT_GRIP = 30;

/** Collision group bits: the hero cars ghost through each other, but hit everything else. */
export const HERO_BIT = 0x0002;
export const HERO_GROUPS = (HERO_BIT << 16) | (0xffff & ~HERO_BIT);
/**
 * Dominance groups: in a contact, the higher group acts as if infinitely heavy.
 * Hero cars, the vault and parked cars outrank cruisers and street furniture,
 * so a cop can bump you but can't spin you out.
 */
export const DOMINANT = 1;

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
  /** Nitrous firing this step (set by the game from the NOS meter). */
  nosActive = false;
  /** Seconds left on blown tires: less grip and speed, rims spark. */
  tireBlown = 0;
  /** Rear wheels spinning without traction (pulling against the vault). */
  wheelspin = 0;
  /**
   * How fast steering moves toward the input (1/s): toward full lock, and back
   * to center. The player's keyboard steering eases in so taps aren't twitchy.
   */
  steerRate = { in: 10, out: 10 };
  private lastSpeed = 0;
  private accel = 0;

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

  /** Hero car: ghosts through the other hero car and outranks cops and props in collisions. */
  makeHero(): void {
    this.collider.setCollisionGroups(HERO_GROUPS);
    this.body.setDominanceGroup(DOMINANT);
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

    const blown = this.tireBlown > 0;
    if (blown) this.tireBlown = Math.max(0, this.tireBlown - dt);
    const power = this.assist * (this.nosActive ? 1.9 : 1) * (blown ? 0.7 : 1);
    const top = this.spec.topSpeed * this.assist * (blown ? 0.65 : 1) + (this.nosActive ? 18 : 0);
    let a = 0;
    if (c.throttle > 0) {
      a = vF < -1 ? 30 : this.spec.accel * power * c.throttle * Math.max(0, 1 - vF / top);
    }
    if (this.nosActive && c.throttle === 0 && vF > -1) a = this.spec.accel * power * Math.max(0, 1 - vF / top);
    if (c.brake > 0) {
      a = vF > 1 ? -30 * c.brake : vF > -14 ? -9 : 0;
    }
    if (!c.throttle && !c.brake) a = -vF * 0.4;
    if (c.handbrake) a -= vF * 0.8;

    const easing = Math.abs(c.steer) > Math.abs(this.steer) && c.steer * this.steer >= 0 ? this.steerRate.in : this.steerRate.out;
    this.steer += (c.steer - this.steer) * Math.min(1, easing * dt);
    const speed = Math.abs(vF);
    // Yaw rate the driver asks for (tight at low speed, gentler as speed rises)...
    const demand =
      Math.abs(this.steer) * this.spec.turnRate * Math.min(1, speed / 5) * (1 / (1 + speed / 40)) * (c.handbrake ? 1.5 : 1);
    // ...but the tires can only hold so much sideways force. Asking for more scrubs
    // speed instead (understeer), which tightens the line, as in most racing games.
    const limit = ((c.handbrake ? DRIFT_GRIP : LATERAL_GRIP) * (blown ? 0.6 : 1)) / Math.max(speed, 1);
    if (demand > limit && speed > 8 && !c.handbrake) a -= Math.sign(vF) * Math.min(1, (demand - limit) / limit) * 7;

    const gripRate = (c.handbrake ? 1.0 : this.spec.grip) * (blown ? 0.45 : 1);
    const dvL = -vL * Math.min(1, gripRate * dt);
    this.body.applyImpulse(
      { x: m * (f.x * a * dt + lx * dvL), y: 0, z: m * (f.z * a * dt + lz * dvL) },
      true,
    );

    const yaw = Math.sign(this.steer) * Math.min(demand, limit) * Math.sign(vF);
    const w = this.body.angvel();
    this.body.setAngvel({ x: w.x, y: w.y + (yaw - w.y) * Math.min(1, 12 * dt), z: w.z }, true);

    this.forwardSpeed = vF;
    this.lateralSpeed = vL;
    // Throttle on but barely moving: the rear tires are spinning against the load.
    const straining = c.throttle > 0.5 && Math.abs(vF) < 3;
    this.wheelspin += ((straining ? c.throttle : 0) - this.wheelspin) * Math.min(1, dt * 6);
  }

  /** World positions of the rear tire contact patches (for smoke and skid marks). */
  rearWheels(): THREE.Vector3[] {
    const t = this.body.translation();
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    return [-0.86, 0.86].map((x) => new THREE.Vector3(x, -RIDE_HEIGHT + 0.05, -1.5).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z)));
  }

  /** All four tire contact points. */
  wheels(): THREE.Vector3[] {
    const t = this.body.translation();
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    return [[-0.86, 1.55], [0.86, 1.55], [-0.86, -1.5], [0.86, -1.5]].map(([x, z]) =>
      new THREE.Vector3(x, -RIDE_HEIGHT + 0.05, z).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z)),
    );
  }

  /** Exhaust tips, for nitrous flames. */
  exhausts(): THREE.Vector3[] {
    const t = this.body.translation();
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    return [-0.55, 0.55].map((x) => new THREE.Vector3(x, -RIDE_HEIGHT + 0.4, -2.65).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z)));
  }

  /** Update the visual model. Call once per rendered frame. */
  render(dt: number): void {
    syncMesh(this.model.group, this.body, -RIDE_HEIGHT);
    const roll = THREE.MathUtils.clamp(-this.lateralSpeed * 0.012 - this.steer * this.forwardSpeed * 0.0015, -0.08, 0.08);
    this.model.body.rotation.z += (roll - this.model.body.rotation.z) * Math.min(1, 8 * dt);
    // Squat under power, dive under braking.
    if (dt > 0) {
      this.accel += ((this.forwardSpeed - this.lastSpeed) / dt - this.accel) * Math.min(1, dt * 6);
      this.lastSpeed = this.forwardSpeed;
    }
    const pitch = THREE.MathUtils.clamp(-this.accel * 0.004, -0.045, 0.045);
    this.model.body.rotation.x += (pitch - this.model.body.rotation.x) * Math.min(1, 8 * dt);
    for (const [i, s] of this.model.spinners.entries()) {
      // Rear wheels (indices 2, 3) spin freely while straining against the vault.
      const r = this.model.wheelRadius;
      const spin = i >= 2 ? Math.max(this.forwardSpeed / r, this.wheelspin * 45) : this.forwardSpeed / r;
      s.rotation.x += spin * dt;
    }
    for (const p of this.model.frontPivots) p.rotation.y = this.steer * 0.45;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.model.group);
    this.world.removeRigidBody(this.body);
  }
}
