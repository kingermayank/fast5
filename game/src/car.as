// A car: a rigid body driven by tyre forces. Bicycle model with slip angles,
// load transfer (from braking, accelerating and the tow cable pulling at the
// hitch), a friction circle on the driven rear axle, handbrake and nitrous.
// The cable's pull arrives as a position correction at the hitch, so the
// vault's weight drags the car back, swings its tail and lightens the front
// (towing makes it understeer); its pull also feeds the load transfer here.
import { Body, Solver } from "./physics";
import { clamp, ease, sign, G } from "./util";

export class CarSpec {
  mass: f64 = 1900;
  /** Engine power (W) and the most drive force the gearing gives at low speed (N). */
  power: f64 = 420000;
  maxDrive: f64 = 26000;
  topSpeed: f64 = 62;
  wheelbase: f64 = 2.92;
  /** Centre of mass to the front axle (m). */
  cgFront: f64 = 1.38;
  cgHeight: f64 = 0.55;
  /** Tyre peak friction and cornering stiffness per unit load (1/rad). */
  mu: f64 = 1.55;
  stiffness: f64 = 14;
  steerMax: f64 = 0.62;
  brake: f64 = 30000;
  /** Hitch at the back bumper (local z, height). */
  hitchZ: f64 = -2.75;
  hitchY: f64 = 0.5;
  halfWidth: f64 = 0.98;
  halfLength: f64 = 2.6;
}

export class Controls {
  throttle: f64 = 0;
  brake: f64 = 0;
  steer: f64 = 0;
  handbrake: bool = false;
  nos: bool = false;
}

export class Car extends Solver {
  body: Body;
  spec: CarSpec;
  controls: Controls = new Controls();
  /** Front wheel angle (rad), eased toward the input. */
  steer: f64 = 0;
  // Read-outs for visuals, sound and the HUD.
  forwardSpeed: f64 = 0;
  lateralSpeed: f64 = 0;
  accel: f64 = 0;
  lastForward: f64 = 0;
  wheelspin: f64 = 0;
  slipRear: f64 = 0;
  slipFront: f64 = 0;
  loadFront: f64 = 0;
  loadRear: f64 = 0;
  /** Cable force at the hitch this step (N, world). */
  towX: f64 = 0;
  towZ: f64 = 0;
  towAccumX: f64 = 0;
  towAccumZ: f64 = 0;
  towSteps: i32 = 0;
  pitch: f64 = 0;
  roll: f64 = 0;
  spinFront: f64 = 0;
  spinRear: f64 = 0;
  drive: f64 = 0;
  braking: bool = false;
  nosActive: bool = false;

  constructor(spec: CarSpec) {
    super();
    this.spec = spec;
    this.body = new Body(spec.mass, spec.halfWidth, spec.halfLength, 1.35);
    this.body.restitution = 0.2;
    this.body.friction = 0.25;
  }

  hitchX(): f64 {
    return this.body.worldX(0, this.spec.hitchZ);
  }

  hitchZ(): f64 {
    return this.body.worldZ(0, this.spec.hitchZ);
  }

  /** Called by a cable with the force it applied at the hitch this substep. */
  addTow(fx: f64, fz: f64): void {
    this.towAccumX += fx;
    this.towAccumZ += fz;
  }

  /** Once per fixed step: ease the steering toward the input. */
  update(dt: f64): void {
    let c = this.controls;
    let speed = Math.abs(this.forwardSpeed);
    let lock = this.spec.steerMax / (1 + speed / 16);
    let target = c.steer * lock;
    this.steer = ease(this.steer, target, Math.abs(target) > Math.abs(this.steer) ? 9 : 12, dt);
  }

  override forces(h: f64): void {
    this.towSteps++;
    let b = this.body;
    let s = this.spec;
    let c = this.controls;
    let fx = b.fwdX(), fz = b.fwdZ();
    let lx = b.leftX(), lz = b.leftZ();
    let vf = b.vx * fx + b.vz * fz;
    let vl = b.vx * lx + b.vz * lz;
    let cgF = s.cgFront;
    let cgR = s.wheelbase - cgF;

    // Normal loads: static split, plus transfer from acceleration and from the
    // tow cable pulling back at the hitch (it lifts the nose).
    let mg = s.mass * G;
    let towBack = -(this.towX * fx + this.towZ * fz);
    let transfer = (s.mass * this.accel * s.cgHeight + Math.max(0, towBack) * s.hitchY) / s.wheelbase;
    let nF = Math.max(0.15 * mg, (mg * cgR) / s.wheelbase - transfer);
    let nR = Math.max(0.15 * mg, (mg * cgF) / s.wheelbase + transfer);
    this.loadFront = nF;
    this.loadRear = nR;

    // Longitudinal: drive (rear), brakes, engine braking and rolling.
    let nos = c.nos && this.nosActive;
    let drive: f64 = 0;
    let brakeF: f64 = 0, brakeR: f64 = 0;
    this.braking = false;
    if (c.throttle > 0 && vf > -1.5) {
      let top = s.topSpeed + (nos ? 16 : 0);
      let pull = Math.min(s.maxDrive * (nos ? 1.5 : 1), (s.power * (nos ? 1.8 : 1)) / Math.max(Math.abs(vf), 1));
      drive = c.throttle * pull * clamp((top - vf) / 6, 0, 1);
    } else if (c.throttle > 0 && vf <= -1.5) {
      brakeF = s.brake * 0.6;
      brakeR = s.brake * 0.4;
      this.braking = true;
    }
    if (c.brake > 0) {
      if (vf > 1.0) {
        brakeF = s.brake * 0.62 * c.brake;
        brakeR = s.brake * 0.38 * c.brake;
        this.braking = true;
      } else if (c.throttle == 0) {
        // Stopped: reverse.
        drive = -c.brake * s.maxDrive * 0.45 * clamp((7 + vf) / 3, 0, 1);
      }
    }
    // No pedals: engine braking, and the brakes hold it once it's nearly stopped.
    if (c.throttle == 0 && c.brake == 0 && !c.handbrake && Math.abs(vf) < 2.5) {
      brakeF = s.brake * 0.35;
      brakeR = s.brake * 0.25;
    }
    // Brakes oppose the wheel's motion and can't push it backwards.
    let dirF = vf > 0.3 ? 1.0 : vf < -0.3 ? -1.0 : vf / 0.3;
    let longF = -brakeF * dirF;
    let longR = drive - brakeR * dirF;
    if (c.handbrake) longR = -dirF * s.mu * 0.75 * nR;
    longR -= vf * 25 + dirF * (c.throttle == 0 ? 1900 : 140);

    // Traction control: drive stays just under what the rear tyres can take,
    // except on nitrous, which overpowers them (and lights them up).
    let capR = s.mu * nR;
    if (!c.handbrake && longR > 0) longR = Math.min(longR, capR * (nos ? 1.18 : 0.94));
    // Friction circle at the rear: past the limit the tyres spin (or lock), and
    // what's left for cornering shrinks, so power or the handbrake swings the tail.
    let spin: f64 = 0;
    if (Math.abs(longR) > capR) {
      spin = (Math.abs(longR) - capR) / capR;
      longR = sign(longR) * capR * 0.92;
    }
    this.wheelspin = ease(this.wheelspin, c.throttle > 0.5 ? clamp(spin * 2, 0, 1) : 0, 8, h);
    let latCapR = Math.sqrt(Math.max(0, capR * capR - longR * longR)) * (c.handbrake ? 0.45 : 1);
    let capF = s.mu * nF;
    let latCapF = Math.sqrt(Math.max(0, capF * capF - longF * longF));

    // Lateral: slip angles (regularised at walking pace) through a saturating curve.
    let v0 = Math.max(Math.abs(vf), 3.5);
    let vlF = vl + b.w * cgF;
    let vlR = vl - b.w * cgR;
    let alphaF = Math.atan2(vlF - vf * this.steer, v0);
    let alphaR = Math.atan2(vlR, v0);
    this.slipFront = alphaF;
    this.slipRear = alphaR;
    let latF = -latCapF * Math.tanh((s.stiffness * nF * alphaF) / Math.max(latCapF, 1));
    let latR = -latCapR * Math.tanh((s.stiffness * nR * alphaR) / Math.max(latCapR, 1));

    // Front forces act in the wheel's frame, turned by the steering angle.
    let cs = Math.cos(this.steer), sn = Math.sin(this.steer);
    let wfx = fx * cs + lx * sn, wfz = fz * cs + lz * sn;
    let wlx = lx * cs - fx * sn, wlz = lz * cs - fz * sn;
    let pfx = b.x + fx * cgF, pfz = b.z + fz * cgF;
    let prx = b.x - fx * cgR, prz = b.z - fz * cgR;
    b.addForce(wfx * longF + wlx * latF, wfz * longF + wlz * latF, pfx, pfz);
    b.addForce(fx * longR + lx * latR, fz * longR + lz * latR, prx, prz);

    // Air.
    let speed = b.speed();
    b.addForce(-b.vx * speed * 0.42, -b.vz * speed * 0.42, b.x, b.z);

    // Stability assist: past walking pace, ease the yaw toward what the steering
    // asks for (a spin the driver didn't ask for is damped; the handbrake turns
    // it off). The cable's pull is an outside force, so the vault still swings the tail.
    if (!c.handbrake && Math.abs(vf) > 5) {
      let want = (vf * Math.tan(this.steer)) / s.wheelbase;
      let limit = (s.mu * G) / Math.abs(vf);
      want = clamp(want, -limit, limit);
      let excess = b.w - want;
      let inertia = 1 / b.invInertia;
      b.tq -= excess * inertia * 3.5 * clamp((Math.abs(vf) - 5) / 10, 0, 1);
    }

    this.drive = drive;
    this.forwardSpeed = vf;
    this.lateralSpeed = vl;
  }

  override velocities(h: f64): void {
    let b = this.body;
    let vf = b.vx * b.fwdX() + b.vz * b.fwdZ();
    this.accel = ease(this.accel, (vf - this.lastForward) / h, 10, h);
    this.lastForward = vf;
  }

  /** Once per fixed step, after the substeps: settle read-outs and visuals. */
  settle(dt: f64): void {
    // The tow force averaged over the step's substeps.
    if (this.towSteps > 0) {
      this.towX = this.towAccumX / <f64>this.towSteps;
      this.towZ = this.towAccumZ / <f64>this.towSteps;
    }
    this.towAccumX = 0;
    this.towAccumZ = 0;
    this.towSteps = 0;
    let s = this.spec;
    let b = this.body;
    // Body lean: dive and squat from the load transfer, roll from cornering.
    let mg = s.mass * G;
    let squat = (this.loadRear - (mg * s.cgFront) / s.wheelbase) / mg;
    this.pitch = ease(this.pitch, clamp(-squat * 0.35, -0.07, 0.07), 9, dt);
    let lat = b.w * this.forwardSpeed;
    this.roll = ease(this.roll, clamp(-lat * 0.006, -0.07, 0.07), 9, dt);
    let r: f64 = 0.35;
    this.spinFront += (this.forwardSpeed / r) * dt;
    this.spinRear += ((this.forwardSpeed + this.wheelspin * 30) / r) * dt;
  }
}
