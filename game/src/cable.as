// A steel tow cable from a car's winch to an eye on the vault door.
//
// The load goes through an elastic tether between the two ends: it only pulls,
// its stiffness is how much the cable stretches under load (elasticity), and
// its damping takes the ring out of a yank. It's solved as an XPBD distance
// constraint inside the physics substeps, so the vault's weight reaches the
// car as a real pull at the hitch: it slows the car, swings its tail toward
// the vault and lightens the nose.
//
// The cable's shape is a strand of particles pinned at both ends: it sags when
// slack, swings, drags on the asphalt and catches on building corners. How
// stiff it is in bending is its "stringiness" (0 a stiff steel rope, 1 a
// floppy string).
//
// The winch has a slip clutch: past `slipForce` it pays cable out (no faster
// than it can spool), and reels it back to the tow length once the strain
// eases. A cable snatched or held past its strength snaps: overloads build up
// damage, a hard yank breaks it outright, and the two halves whip back.
import { Car } from "./car";
import { Vault, ANCHOR_Y } from "./vault";
import { Body, Solver } from "./physics";
import { StaticWorld } from "./world";
import { clamp, G, Rng, MeshBuilder, packNormal, packColor, ROLE_CABLE, TAU } from "./util";

export class CableParams {
  /** Length the winch holds while towing (m). */
  length: f64 = 10;
  /** Elasticity: force per metre of stretch (N/m). */
  stiffness: f64 = 60000;
  /** Damping along the cable (N s/m). */
  damping: f64 = 9000;
  /** It snaps outright past this pull (N); well below it, hard pulls fray it. */
  breakForce: f64 = 140000;
  /** The winch clutch slips (pays out) past this pull (N). */
  slipForce: f64 = 95000;
  /** 0 stiff steel rope ... 1 floppy string. */
  stringiness: f64 = 0.35;
}

const MAX_LENGTH: f64 = 40;
const PAYOUT_SPEED: f64 = 7;
const REEL_SPEED: f64 = 3.5;
/**
 * The most the winch pulls while winding in (N): parked, only the slack (less
 * than the vault's grip on the pavement); on the move, it shortens the tow.
 */
const WINCH_PULL: f64 = 9000;
const WINCH_PULL_MOVING: f64 = 30000;
const RADIUS: f64 = 0.045;
/** Pulls past this share of the break strength fray the cable. */
export const FRAY_FROM: f64 = 0.35;

export class Cable extends Solver {
  car: Car;
  vault: Vault;
  side: f64;
  world: StaticWorld;
  bodies: Array<Body>;
  params: CableParams;
  n: i32 = 19;
  x: Float64Array = new Float64Array(19);
  y: Float64Array = new Float64Array(19);
  z: Float64Array = new Float64Array(19);
  ox: Float64Array = new Float64Array(19);
  oy: Float64Array = new Float64Array(19);
  oz: Float64Array = new Float64Array(19);
  vx: Float64Array = new Float64Array(19);
  vy: Float64Array = new Float64Array(19);
  vz: Float64Array = new Float64Array(19);
  /** Paid-out length (m). */
  length: f64 = 10;
  /** Seconds the winch waits before reeling in after paying out. */
  reelDelay: f64 = 0;
  broken: bool = false;
  cut: i32 = -1;
  segment: f64 = 0.5;
  /** Pull this step: peak and mean over the substeps (N). */
  tension: f64 = 0;
  peak: f64 = 0;
  sum: f64 = 0;
  steps: i32 = 0;
  /** Accumulated overload, 0..1; it snaps at 1. */
  damage: f64 = 0;
  /** Set for one step when it snaps (for effects), with where. */
  snapped: bool = false;
  snapX: f64 = 0;
  snapY: f64 = 0;
  snapZ: f64 = 0;
  /** Paying out this step (m/s), for the winch sound. */
  paying: f64 = 0;
  /** The torn ends' glow after a snap, cooling from 1. */
  heat: f64 = 0;
  rng: Rng;

  constructor(car: Car, vault: Vault, side: f64, world: StaticWorld, bodies: Array<Body>, params: CableParams, seed: u32) {
    super();
    this.car = car;
    this.vault = vault;
    this.side = side;
    this.world = world;
    this.bodies = bodies;
    this.params = params;
    this.rng = new Rng(seed);
  }

  hitchY(): f64 {
    return this.car.spec.hitchY;
  }

  anchorY(): f64 {
    return ANCHOR_Y + this.vault.lift;
  }

  /** Straight-line distance between the two ends on the ground plane. */
  span(): f64 {
    let dx = this.vault.anchorX(this.side) - this.car.hitchX();
    let dz = this.vault.anchorZ(this.side) - this.car.hitchZ();
    return Math.sqrt(dx * dx + dz * dz);
  }

  /** Hooks the cable up with `slack` metres to spare, laid in a sagging line. */
  hook(slack: f64): void {
    this.broken = false;
    this.cut = -1;
    this.damage = 0;
    this.heat = 0;
    this.length = this.span() + slack;
    let ax = this.car.hitchX(), az = this.car.hitchZ();
    let bx = this.vault.anchorX(this.side), bz = this.vault.anchorZ(this.side);
    for (let i = 0; i < this.n; i++) {
      let t = <f64>i / <f64>(this.n - 1);
      this.x[i] = ax + (bx - ax) * t;
      this.z[i] = az + (bz - az) * t;
      this.y[i] = Math.max(0.06, this.hitchY() + (this.anchorY() - this.hitchY()) * t - Math.sin(t * 3.14159) * 0.6);
      this.vx[i] = 0;
      this.vy[i] = 0;
      this.vz[i] = 0;
    }
  }

  strain(): f64 {
    return this.peak / this.params.breakForce;
  }

  override positions(h: f64): void {
    let car = this.car.body;
    let vb = this.vault.body;
    let p = this.params;
    let ax = this.car.hitchX(), az = this.car.hitchZ();
    let bx = this.vault.anchorX(this.side), bz = this.vault.anchorZ(this.side);
    let d: f64 = 0;
    let pull: f64 = 0;

    // 1. The tether: the load path between car and vault.
    if (!this.broken) {
      let dx = bx - ax, dz = bz - az;
      d = Math.sqrt(dx * dx + dz * dz);
      if (d > this.length && d > 1e-6) {
        let nx = dx / d, nz = dz / d;
        let c = d - this.length;
        // Separation speed of the ends (from this substep's predicted motion).
        let vsep = (vb.pointVX(bx, bz) - car.pointVX(ax, az)) * nx + (vb.pointVZ(bx, bz) - car.pointVZ(ax, az)) * nz;
        let at = 1 / (p.stiffness * h * h);
        let gamma = (p.damping / p.stiffness) / h;
        let w = car.invMassAt(ax, az, nx, nz) + vb.invMassAt(bx, bz, nx, nz);
        let dl = (-c - gamma * vsep * h) / ((1 + gamma) * w + at);
        if (dl < 0) {
          pull = -dl / (h * h);
          // The clutch: a hard yank pays cable out rather than stopping dead.
          if (pull > p.slipForce && vsep > 0 && this.length < MAX_LENGTH) {
            let pay = Math.min(vsep, PAYOUT_SPEED) * h;
            this.length = Math.min(MAX_LENGTH, this.length + pay);
            this.paying = Math.max(this.paying, pay / h);
            this.reelDelay = 1.4;
          }
          car.applyCorrection(nx * -dl, nz * -dl, ax, az);
          vb.applyCorrection(nx * dl, nz * dl, bx, bz);
          this.car.addTow(nx * pull, nz * pull);
        }
      }
      this.sum += pull;
      this.steps++;
      if (pull > this.peak) this.peak = pull;
    }

    // 2. The strand.
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.ox[i] = this.x[i];
      this.oy[i] = this.y[i];
      this.oz[i] = this.z[i];
      this.vy[i] -= G * h;
      this.x[i] += this.vx[i] * h;
      this.y[i] += this.vy[i] * h;
      this.z[i] += this.vz[i] * h;
    }
    // Taut, the strand stretches with the tether; slack, it hangs at its length.
    // Once snapped, both halves stay on their eyes, parted between cut and cut + 1.
    if (!this.broken) this.segment = Math.max(this.length, d) / <f64>(n - 1);
    let rest = this.segment;
    let bendK = (1 - this.params.stringiness) * 0.25;
    for (let iter = 0; iter < 3; iter++) {
      this.x[0] = ax;
      this.y[0] = this.hitchY();
      this.z[0] = az;
      this.x[n - 1] = bx;
      this.y[n - 1] = this.anchorY();
      this.z[n - 1] = bz;
      for (let i = 0; i < n - 1; i++) {
        if (i == this.cut) continue;
        this.link(i, i + 1, rest, 1.0, i == 0, i + 1 == n - 1);
      }
      // Bending: pull every other pair toward their straight distance.
      if (bendK > 0) {
        for (let i = 0; i < n - 2; i++) {
          if (this.cut == i || this.cut == i + 1) continue;
          this.link(i, i + 2, rest * 2, bendK, i == 0, i + 2 == n - 1);
        }
      }
    }
    // Collisions: the ground, buildings, and the cars and the vault.
    for (let i = 1; i < n - 1; i++) this.collide(i);
    if (this.broken) {
      this.collide(this.cut);
      this.collide(this.cut + 1);
    }
  }

  /** Distance constraint between particles i and j (ends pinned when attached). */
  private link(i: i32, j: i32, rest: f64, k: f64, pinI: bool, pinJ: bool): void {
    let dx = this.x[j] - this.x[i], dy = this.y[j] - this.y[i], dz = this.z[j] - this.z[i];
    let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return;
    let c = len - rest;
    let wi: f64 = pinI ? 0 : 1;
    let wj: f64 = pinJ ? 0 : 1;
    let w = wi + wj;
    if (w == 0) return;
    let s = (c / len / w) * k;
    this.x[i] += dx * s * wi;
    this.y[i] += dy * s * wi;
    this.z[i] += dz * s * wi;
    this.x[j] -= dx * s * wj;
    this.y[j] -= dy * s * wj;
    this.z[j] -= dz * s * wj;
  }

  private collide(i: i32): void {
    if (i < 0 || i >= this.n) return;
    if (this.y[i] < RADIUS + 0.04) this.y[i] = RADIUS + 0.04;
    if (this.world.pushOut(this.x[i], this.z[i], RADIUS)) {
      let e = this.world.hit;
      this.x[i] += e.nx * e.dist;
      this.z[i] += e.nz * e.dist;
    }
    for (let k = 0; k < this.bodies.length; k++) {
      let b = this.bodies[k];
      if (this.y[i] > b.height) continue;
      let lx = b.localX(this.x[i], this.z[i]), lz = b.localZ(this.x[i], this.z[i]);
      let ox = b.hx + RADIUS - Math.abs(lx), oz = b.hz + RADIUS - Math.abs(lz);
      if (ox <= 0 || oz <= 0) continue;
      if (ox < oz) lx += lx >= 0 ? ox : -ox;
      else lz += lz >= 0 ? oz : -oz;
      this.x[i] = b.worldX(lx, lz);
      this.z[i] = b.worldZ(lx, lz);
    }
  }

  override velocities(h: f64): void {
    let drag = Math.max(0, 1 - 0.8 * h);
    for (let i = 0; i < this.n; i++) {
      let vx = (this.x[i] - this.ox[i]) / h, vy = (this.y[i] - this.oy[i]) / h, vz = (this.z[i] - this.oz[i]) / h;
      if (this.y[i] <= RADIUS + 0.05) {
        // Dragging on the asphalt.
        let f = Math.max(0, 1 - 14 * h);
        vx *= f;
        vz *= f;
      }
      this.vx[i] = vx * drag;
      this.vy[i] = vy * drag;
      this.vz[i] = vz * drag;
    }
  }

  /** Once per fixed step, after the substeps: the winch, the strain, snapping. */
  settle(dt: f64): void {
    this.snapped = false;
    this.tension = this.steps > 0 ? this.sum / <f64>this.steps : 0;
    let p = this.params;
    if (!this.broken) {
      // Fraying: anything past a third of its strength wears it, a lot more the
      // harder the pull; easy towing lets it recover, slowly. Past its strength it goes.
      let ratio = this.peak / p.breakForce;
      let over = ratio - FRAY_FROM;
      if (over > 0) this.damage += over * over * dt * 6;
      else if (ratio < 0.2) this.damage = Math.max(0, this.damage - dt * 0.01);
      if (ratio > 1 || this.damage >= 1) this.snap();
      // The winch winds back to the tow length once nothing is yanking on it,
      // stalling against anything heavier than it can pull.
      this.reelDelay -= dt;
      let moving = this.car.forwardSpeed > 3;
      if (this.reelDelay <= 0 && this.length > p.length && this.tension < (moving ? WINCH_PULL_MOVING : WINCH_PULL)) {
        this.length = Math.max(p.length, this.length - REEL_SPEED * dt);
      }
      if (this.reelDelay <= 0 && this.length < p.length) this.length = p.length;
    }
    this.paying *= 0.5;
    this.heat = Math.max(0, this.heat - dt * 0.6);
    this.peak = 0;
    this.sum = 0;
    this.steps = 0;
  }

  /** It parts near the middle; the halves fly back toward their ends. */
  snap(): void {
    let n = this.n;
    let cut = n / 3 + <i32>(this.rng.next() * <f64>(n / 3));
    this.broken = true;
    this.cut = cut;
    this.snapped = true;
    this.snapX = (this.x[cut] + this.x[cut + 1]) / 2;
    this.snapY = (this.y[cut] + this.y[cut + 1]) / 2;
    this.snapZ = (this.z[cut] + this.z[cut + 1]) / 2;
    let ax = this.x[0], az = this.z[0];
    let bx = this.x[n - 1], bz = this.z[n - 1];
    let dx = bx - ax, dz = bz - az;
    let len = Math.max(1e-6, Math.sqrt(dx * dx + dz * dz));
    dx /= len;
    dz /= len;
    let recoil = clamp((this.peak / this.params.breakForce) * 26, 14, 34);
    for (let i = 1; i < n - 1; i++) {
      let towardCar = i <= cut;
      let near = towardCar ? <f64>i / <f64>cut : <f64>(n - 1 - i) / <f64>(n - 2 - cut);
      let k = recoil * near * near;
      let s: f64 = towardCar ? -1 : 1;
      this.vx[i] += dx * s * k + (this.rng.next() - 0.5) * 4;
      this.vz[i] += dz * s * k + (this.rng.next() - 0.5) * 4;
      this.vy[i] += 2 + this.rng.next() * 5 * near;
    }
    this.damage = 1;
    this.heat = 1;
  }

  /** How hot the cable glows: strain while it holds, the torn ends cooling once it's gone. */
  glow(): f64 {
    if (this.broken) return this.heat;
    return Math.max(clamp(this.strain(), 0, 1.2), this.damage * 0.75);
  }

  /** The cable as a tube (both halves once snapped), for the renderer. */
  tube(m: MeshBuilder, color: u32): void {
    let n = this.n;
    let start = 0;
    while (start < n - 1) {
      let end = this.broken && this.cut >= start ? this.cut : n - 1;
      if (end > start) this.strip(m, start, end, color);
      start = end + 1;
    }
  }

  private strip(m: MeshBuilder, from: i32, to: i32, color: u32): void {
    let sides = 6;
    let first = <u32>m.vertexCount;
    let col = packColor(color, ROLE_CABLE);
    for (let i = from; i <= to; i++) {
      let i0 = i > from ? i - 1 : i;
      let i1 = i < to ? i + 1 : i;
      let tx = this.x[i1] - this.x[i0], ty = this.y[i1] - this.y[i0], tz = this.z[i1] - this.z[i0];
      let tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (tl < 1e-9) { tx = 1; ty = 0; tz = 0; tl = 1; }
      tx /= tl; ty /= tl; tz /= tl;
      // A frame around the tangent: u across (horizontal), v = t x u.
      let ux = -tz, uy: f64 = 0, uz = tx;
      let ul = Math.sqrt(ux * ux + uz * uz);
      if (ul < 1e-6) { ux = 1; uz = 0; ul = 1; }
      ux /= ul; uz /= ul;
      let vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      for (let k = 0; k < sides; k++) {
        let a = (TAU * <f64>k) / <f64>sides;
        let c = Math.cos(a), s = Math.sin(a);
        let nx = ux * c + vx * s, ny = uy * c + vy * s, nz = uz * c + vz * s;
        m.vertex(this.x[i] + nx * RADIUS, this.y[i] + ny * RADIUS, this.z[i] + nz * RADIUS, packNormal(nx, ny, nz), col);
      }
    }
    let rings = to - from;
    for (let r = 0; r < rings; r++) {
      for (let k = 0; k < sides; k++) {
        let a = first + <u32>(r * sides + k);
        let b = first + <u32>(r * sides + (k + 1) % sides);
        let c = b + <u32>sides;
        let d = a + <u32>sides;
        m.quad(a, b, c, d);
      }
    }
  }
}
