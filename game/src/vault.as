// The vault: a steel box dragged along the asphalt. Friction acts at its four
// corners (static when it barely moves, kinetic and a little slicker at speed),
// which is what makes it swing wide on corners, fishtail and surge on the
// cables. It also rocks on its base: pitch and roll are damped springs kicked
// by its accelerations and by the road surface while it slides.
import { Body, Solver } from "./physics";
import { clamp, smoothstep, G, MeshBuilder, packColor, shade, ROLE_STEEL } from "./util";

export class VaultParams {
  mass: f64 = 4000;
  muStatic: f64 = 0.55;
  muKinetic: f64 = 0.36;
  /** How much slicker it gets when skating fast (0..1). */
  skate: f64 = 0.3;
}

export const VAULT_HX: f64 = 1.5;
export const VAULT_HZ: f64 = 1.5;
export const VAULT_H: f64 = 2.5;
/** Cable eyes on the door face (local x, height). */
export const ANCHOR_X: f64 = 0.9;
export const ANCHOR_Y: f64 = 0.6;

export class Vault extends Solver {
  body: Body;
  params: VaultParams;
  pitch: f64 = 0;
  roll: f64 = 0;
  pitchV: f64 = 0;
  rollV: f64 = 0;
  lift: f64 = 0;
  liftV: f64 = 0;
  /** Sliding speed this step, and the frictional power (W) for sparks and sound. */
  sliding: f64 = 0;
  grind: f64 = 0;
  lastVX: f64 = 0;
  lastVZ: f64 = 0;
  noise: f64 = 0;

  constructor(params: VaultParams) {
    super();
    this.params = params;
    this.body = new Body(params.mass, VAULT_HX, VAULT_HZ, VAULT_H);
    this.body.restitution = 0.08;
    this.body.friction = 0.5;
  }

  anchorX(side: f64): f64 {
    return this.body.worldX(side * ANCHOR_X, VAULT_HZ + 0.05);
  }

  anchorZ(side: f64): f64 {
    return this.body.worldZ(side * ANCHOR_X, VAULT_HZ + 0.05);
  }

  /** Corner friction, at the velocity level after each substep. */
  override velocities(h: f64): void {
    let b = this.body;
    let p = this.params;
    let n = (b.mass * G) / 4;
    let grind: f64 = 0;
    for (let k = 0; k < 4; k++) {
      let lx = (k == 0 || k == 3) ? -VAULT_HX : VAULT_HX;
      let lz = k < 2 ? -VAULT_HZ : VAULT_HZ;
      let wx = b.worldX(lx, lz), wz = b.worldZ(lx, lz);
      let vx = b.pointVX(wx, wz), vz = b.pointVZ(wx, wz);
      let s = Math.sqrt(vx * vx + vz * vz);
      if (s < 1e-6) continue;
      let tx = vx / s, tz = vz / s;
      let mu = s < 0.25 ? p.muStatic : p.muKinetic * (1 - p.skate * smoothstep(4, 22, s));
      let stop = s / b.invMassAt(wx, wz, tx, tz);
      let j = Math.min(stop, mu * n * h);
      b.applyImpulse(-tx * j, -tz * j, wx, wz);
      grind += j * s;
    }
    this.grind = grind / h;
  }

  /** Once per fixed step: rocking and the read-outs. */
  settle(dt: f64): void {
    let b = this.body;
    this.sliding = b.speed();
    // Acceleration in the vault's own frame.
    let ax = (b.vx - this.lastVX) / dt, az = (b.vz - this.lastVZ) / dt;
    this.lastVX = b.vx;
    this.lastVZ = b.vz;
    let along = ax * b.fwdX() + az * b.fwdZ();
    let across = ax * b.leftX() + az * b.leftZ();
    // Road texture while it slides: a little random kick, more the faster it goes.
    this.noise += dt * (20 + this.sliding * 3);
    let bump = (Math.sin(this.noise * 1.7) * Math.sin(this.noise * 2.9 + 1.3)) * smoothstep(1, 12, this.sliding);
    // Damped springs (about 1.6 Hz, lightly damped so it visibly rocks).
    let k: f64 = 100, d: f64 = 5;
    this.pitchV += (-k * this.pitch - d * this.pitchV - along * 0.035 + bump * 2.2) * dt;
    this.rollV += (-k * this.roll - d * this.rollV + across * 0.03 + bump * 1.4) * dt;
    this.liftV += (-k * 2 * this.lift - d * this.liftV + Math.abs(bump) * 6) * dt;
    this.pitch = clamp(this.pitch + this.pitchV * dt, -0.12, 0.12);
    this.roll = clamp(this.roll + this.rollV * dt, -0.12, 0.12);
    this.lift = clamp(this.lift + this.liftV * dt, -0.02, 0.12);
  }

  /** The vault's mesh in its own space: origin at the middle of its base, door toward +z. */
  static mesh(m: MeshBuilder): void {
    let steel = packColor(0x8f949b, ROLE_STEEL);
    let dark = packColor(0x3c4046, ROLE_STEEL);
    let worn = packColor(0x6f747a, ROLE_STEEL);
    m.box(0, VAULT_H / 2, 0, VAULT_HX, VAULT_H / 2, VAULT_HZ, steel);
    // A plinth that takes the scraping.
    m.box(0, 0.08, 0, VAULT_HX + 0.04, 0.08, VAULT_HZ + 0.04, worn);
    // Door, lock wheel with three spokes, hinges.
    m.box(0, 1.25, VAULT_HZ + 0.05, 1.15, 1.0, 0.06, dark);
    m.cylinder(0, 1.3, VAULT_HZ + 0.16, 0.12, 0.08, 2, 14, steel);
    for (let i = 0; i < 3; i++) {
      let t = (<f64>i * 3.14159265) / 3;
      let c = Math.cos(t), s = Math.sin(t);
      // A spoke as a thin box along (c, s) in the door plane.
      let half: f64 = 0.42;
      m.face(0, 1.3, VAULT_HZ + 0.2, c, s, 0, -s, c, 0, half, 0.03, 0, 0, 1, steel);
    }
    m.cylinder(0, 1.3, VAULT_HZ + 0.17, 0.45, 0.03, 2, 24, steel);
    for (let j = 0; j < 2; j++) {
      let y: f64 = j == 0 ? 0.6 : 1.9;
      m.cylinder(-1.18, y, VAULT_HZ + 0.1, 0.09, 0.2, 1, 10, dark);
    }
    // Cable eyes.
    for (let side = -1; side <= 1; side += 2) {
      m.box(<f64>side * ANCHOR_X, ANCHOR_Y, VAULT_HZ + 0.08, 0.12, 0.1, 0.08, packColor(0x2a2c30, ROLE_STEEL));
    }
    // Rivet bands around the top and the bottom.
    for (let y = 0; y < 2; y++) {
      let yy: f64 = y == 0 ? 0.35 : 2.2;
      m.box(0, yy, 0, VAULT_HX + 0.02, 0.05, VAULT_HZ + 0.02, packColor(shade(0x8f949b, 0.82), ROLE_STEEL));
    }
    // The top: a slightly darker lid so it reads from above.
    m.box(0, VAULT_H + 0.02, 0, VAULT_HX - 0.12, 0.02, VAULT_HZ - 0.12, packColor(0x7d8289, ROLE_STEEL));
  }
}
