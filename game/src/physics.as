// Rigid bodies on the ground plane, simulated with substepped XPBD (Müller et
// al., "Detailed Rigid Body Simulation with Extended Position Based Dynamics").
// Each body has a position (x, z), a heading a (forward = (sin a, cos a), local
// +x is the body's left) and a box footprint. Every substep integrates forces,
// solves contacts and joints as position corrections, derives velocities, then
// applies restitution and friction at the velocity level.
//
// Conventions: angular velocity w is about +y, so a point at offset r from the
// centre moves with v + (w * r.z, -w * r.x), and an impulse J at r turns the
// body by (r.z * J.x - r.x * J.z) / I.
import { StaticWorld } from "./world";

export class Body {
  x: f64 = 0;
  z: f64 = 0;
  a: f64 = 0;
  vx: f64 = 0;
  vz: f64 = 0;
  w: f64 = 0;
  px: f64 = 0;
  pz: f64 = 0;
  pa: f64 = 0;
  mass: f64 = 1;
  invMass: f64 = 1;
  invInertia: f64 = 1;
  /** Half extents of the footprint: hx across (left), hz along (forward). */
  hx: f64 = 1;
  hz: f64 = 1;
  height: f64 = 1;
  /** Forces for this substep (cleared after integration). */
  fx: f64 = 0;
  fz: f64 = 0;
  tq: f64 = 0;
  restitution: f64 = 0.15;
  friction: f64 = 0.35;
  /** Collision bits: this body is in `group` and collides with bodies whose group is in `mask`. */
  group: u32 = 1;
  mask: u32 = 0xffff;
  /** Hard knocks this step (largest closing speed), for effects. */
  impact: f64 = 0;
  impactX: f64 = 0;
  impactZ: f64 = 0;
  /** Scraping along a wall this step (sliding speed), for sparks. */
  scrape: f64 = 0;
  scrapeX: f64 = 0;
  scrapeZ: f64 = 0;

  constructor(mass: f64, hx: f64, hz: f64, height: f64) {
    this.setMass(mass, hx, hz);
    this.height = height;
  }

  setMass(mass: f64, hx: f64, hz: f64): void {
    this.mass = mass;
    this.hx = hx;
    this.hz = hz;
    this.invMass = mass > 0 ? 1 / mass : 0;
    // Solid box about the vertical axis.
    let inertia = (mass * ((2 * hx) * (2 * hx) + (2 * hz) * (2 * hz))) / 12;
    this.invInertia = mass > 0 ? 1 / inertia : 0;
  }

  place(x: f64, z: f64, a: f64): void {
    this.x = x;
    this.z = z;
    this.a = a;
    this.px = x;
    this.pz = z;
    this.pa = a;
    this.vx = 0;
    this.vz = 0;
    this.w = 0;
  }

  fwdX(): f64 { return Math.sin(this.a); }
  fwdZ(): f64 { return Math.cos(this.a); }
  leftX(): f64 { return Math.cos(this.a); }
  leftZ(): f64 { return -Math.sin(this.a); }

  /** World x of a local point (lx left, lz forward). */
  worldX(lx: f64, lz: f64): f64 {
    return this.x + lx * Math.cos(this.a) + lz * Math.sin(this.a);
  }

  worldZ(lx: f64, lz: f64): f64 {
    return this.z - lx * Math.sin(this.a) + lz * Math.cos(this.a);
  }

  /** Local coordinates of a world point. */
  localX(x: f64, z: f64): f64 {
    let dx = x - this.x, dz = z - this.z;
    return dx * Math.cos(this.a) - dz * Math.sin(this.a);
  }

  localZ(x: f64, z: f64): f64 {
    let dx = x - this.x, dz = z - this.z;
    return dx * Math.sin(this.a) + dz * Math.cos(this.a);
  }

  pointVX(px: f64, pz: f64): f64 {
    return this.vx + this.w * (pz - this.z);
  }

  pointVZ(px: f64, pz: f64): f64 {
    return this.vz - this.w * (px - this.x);
  }

  speed(): f64 {
    return Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  }

  /** Generalised inverse mass at a point along a unit direction. */
  invMassAt(px: f64, pz: f64, nx: f64, nz: f64): f64 {
    let c = (pz - this.z) * nx - (px - this.x) * nz;
    return this.invMass + this.invInertia * c * c;
  }

  applyImpulse(jx: f64, jz: f64, px: f64, pz: f64): void {
    this.vx += jx * this.invMass;
    this.vz += jz * this.invMass;
    this.w += this.invInertia * ((pz - this.z) * jx - (px - this.x) * jz);
  }

  /** Position-level correction (XPBD): moves and turns the body as an impulse would its velocity. */
  applyCorrection(cx: f64, cz: f64, px: f64, pz: f64): void {
    let rz = pz - this.z, rx = px - this.x;
    this.x += cx * this.invMass;
    this.z += cz * this.invMass;
    this.a += this.invInertia * (rz * cx - rx * cz);
  }

  addForce(fx: f64, fz: f64, px: f64, pz: f64): void {
    this.fx += fx;
    this.fz += fz;
    this.tq += (pz - this.z) * fx - (px - this.x) * fz;
  }
}

/** A contact between a body and a wall (b null) or another body. */
class Contact {
  a: Body;
  b: Body?;
  px: f64 = 0;
  pz: f64 = 0;
  /** Unit normal pushing a out of b. */
  nx: f64 = 0;
  nz: f64 = 0;
  depth: f64 = 0;
  lambda: f64 = 0;
  /** Closing speed before the solve, for restitution. */
  vn: f64 = 0;

  constructor(a: Body, b: Body?) {
    this.a = a;
    this.b = b;
  }
}

/** Hook for things solved inside the substep loop (cables, the vault's friction). */
export abstract class Solver {
  /** Before integration: add forces. */
  forces(h: f64): void {}
  /** After the body positions moved: position constraints. */
  positions(h: f64): void {}
  /** After velocities are derived: velocity-level effects. */
  velocities(h: f64): void {}
}

export class PhysicsWorld {
  bodies: Array<Body> = [];
  solvers: Array<Solver> = [];
  world: StaticWorld;
  contacts: Array<Contact> = [];
  pool: Array<Contact> = [];
  used: i32 = 0;
  substeps: i32 = 6;
  step: f64 = 1.0 / 120.0;
  accumulator: f64 = 0;

  constructor(world: StaticWorld) {
    this.world = world;
  }

  add(b: Body): Body {
    this.bodies.push(b);
    return b;
  }

  private contact(a: Body, b: Body?): Contact {
    let c: Contact;
    if (this.used < this.pool.length) {
      c = this.pool[this.used];
      c.a = a;
      c.b = b;
      c.lambda = 0;
    } else {
      c = new Contact(a, b);
      this.pool.push(c);
    }
    this.used++;
    this.contacts.push(c);
    return c;
  }

  /** Advances by `dt` in fixed steps; returns the number of steps taken. */
  advance(dt: f64): i32 {
    this.accumulator = Math.min(this.accumulator + dt, this.step * 4);
    let n = 0;
    while (this.accumulator >= this.step) {
      this.accumulator -= this.step;
      this.fixedStep(this.step);
      n++;
    }
    return n;
  }

  fixedStep(dt: f64): void {
    for (let i = 0; i < this.bodies.length; i++) {
      let b = this.bodies[i];
      b.impact = 0;
      b.scrape = 0;
    }
    let h = dt / <f64>this.substeps;
    for (let s = 0; s < this.substeps; s++) this.substep(h);
  }

  substep(h: f64): void {
    let bodies = this.bodies;
    for (let i = 0; i < this.solvers.length; i++) this.solvers[i].forces(h);
    for (let i = 0; i < bodies.length; i++) {
      let b = bodies[i];
      b.px = b.x;
      b.pz = b.z;
      b.pa = b.a;
      b.vx += h * b.fx * b.invMass;
      b.vz += h * b.fz * b.invMass;
      b.w += h * b.tq * b.invInertia;
      b.x += h * b.vx;
      b.z += h * b.vz;
      b.a += h * b.w;
      b.fx = 0;
      b.fz = 0;
      b.tq = 0;
    }

    this.detect();
    this.solveContacts();
    for (let i = 0; i < this.solvers.length; i++) this.solvers[i].positions(h);

    for (let i = 0; i < bodies.length; i++) {
      let b = bodies[i];
      b.vx = (b.x - b.px) / h;
      b.vz = (b.z - b.pz) / h;
      b.w = (b.a - b.pa) / h;
    }
    this.contactVelocities(h);
    for (let i = 0; i < this.solvers.length; i++) this.solvers[i].velocities(h);
  }

  // ------------------------------------------------------------ detection

  private detect(): void {
    this.contacts.length = 0;
    this.used = 0;
    let bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      let a = bodies[i];
      if (a.invMass == 0) continue;
      this.againstWalls(a);
      for (let j = i + 1; j < bodies.length; j++) {
        let b = bodies[j];
        if ((a.group & b.mask) == 0 || (b.group & a.mask) == 0) continue;
        let dx = a.x - b.x, dz = a.z - b.z;
        let reach = Math.sqrt(a.hx * a.hx + a.hz * a.hz) + Math.sqrt(b.hx * b.hx + b.hz * b.hz);
        if (dx * dx + dz * dz > reach * reach) continue;
        this.cornersInBox(a, b);
        this.cornersInBox(b, a);
      }
    }
  }

  /** Corners of `a` inside box `b`: contacts pushing a out along b's nearest face. */
  private cornersInBox(a: Body, b: Body): void {
    for (let k = 0; k < 4; k++) {
      let lx = (k == 0 || k == 3) ? -a.hx : a.hx;
      let lz = k < 2 ? -a.hz : a.hz;
      let wx = a.worldX(lx, lz), wz = a.worldZ(lx, lz);
      let bx = b.localX(wx, wz), bz = b.localZ(wx, wz);
      let ox = b.hx - Math.abs(bx), oz = b.hz - Math.abs(bz);
      if (ox <= 0 || oz <= 0) continue;
      let c = this.contact(a, b);
      c.px = wx;
      c.pz = wz;
      if (ox < oz) {
        let s: f64 = bx >= 0 ? 1 : -1;
        c.nx = b.leftX() * s;
        c.nz = b.leftZ() * s;
        c.depth = ox;
      } else {
        let s: f64 = bz >= 0 ? 1 : -1;
        c.nx = b.fwdX() * s;
        c.nz = b.fwdZ() * s;
        c.depth = oz;
      }
    }
  }

  /** The box against building footprints: its corners in walls, wall corners in it. */
  private againstWalls(a: Body): void {
    let r = Math.sqrt(a.hx * a.hx + a.hz * a.hz) + 0.5;
    let world = this.world;
    let list = world.near(a.x - r, a.z - r, a.x + r, a.z + r);
    if (list.length == 0) return;
    // `near` reuses its array; copy what we need before closestEdge/pushOut touch it.
    for (let q = 0; q < list.length; q++) {
      let bld = world.map.buildings[list[q]];
      for (let k = 0; k < 4; k++) {
        let lx = (k == 0 || k == 3) ? -a.hx : a.hx;
        let lz = k < 2 ? -a.hz : a.hz;
        let wx = a.worldX(lx, lz), wz = a.worldZ(lx, lz);
        if (wx < bld.minX || wx > bld.maxX || wz < bld.minZ || wz > bld.maxZ) continue;
        if (!pointIn(bld.pts, wx, wz)) continue;
        let e = world.closestEdge(bld, wx, wz);
        let c = this.contact(a, null);
        c.px = wx;
        c.pz = wz;
        c.nx = e.nx;
        c.nz = e.nz;
        c.depth = e.dist;
      }
      // Wall corners poking into the box (a car against a building's corner).
      let p = bld.pts;
      for (let v = 0; v < p.length; v += 2) {
        let lx = a.localX(p[v], p[v + 1]), lz = a.localZ(p[v], p[v + 1]);
        let ox = a.hx - Math.abs(lx), oz = a.hz - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        let c = this.contact(a, null);
        c.px = p[v];
        c.pz = p[v + 1];
        if (ox < oz) {
          let s: f64 = lx >= 0 ? -1 : 1;
          c.nx = a.leftX() * s;
          c.nz = a.leftZ() * s;
          c.depth = ox;
        } else {
          let s: f64 = lz >= 0 ? -1 : 1;
          c.nx = a.fwdX() * s;
          c.nz = a.fwdZ() * s;
          c.depth = oz;
        }
      }
    }
  }

  // ------------------------------------------------------------ solving

  private solveContacts(): void {
    for (let i = 0; i < this.contacts.length; i++) {
      let c = this.contacts[i];
      let a = c.a;
      let b = c.b;
      // Closing speed before the push, for restitution later.
      let rvx = a.pointVX(c.px, c.pz), rvz = a.pointVZ(c.px, c.pz);
      if (b != null) {
        rvx -= b.pointVX(c.px, c.pz);
        rvz -= b.pointVZ(c.px, c.pz);
      }
      c.vn = rvx * c.nx + rvz * c.nz;
      let wa = a.invMassAt(c.px, c.pz, c.nx, c.nz);
      let wb = b != null ? b.invMassAt(c.px, c.pz, c.nx, c.nz) : 0;
      if (wa + wb <= 0) continue;
      let dl = c.depth / (wa + wb);
      c.lambda = dl;
      a.applyCorrection(c.nx * dl, c.nz * dl, c.px, c.pz);
      if (b != null) b.applyCorrection(-c.nx * dl, -c.nz * dl, c.px, c.pz);
    }
  }

  private contactVelocities(h: f64): void {
    for (let i = 0; i < this.contacts.length; i++) {
      let c = this.contacts[i];
      let a = c.a;
      let b = c.b;
      let rvx = a.pointVX(c.px, c.pz), rvz = a.pointVZ(c.px, c.pz);
      if (b != null) {
        rvx -= b.pointVX(c.px, c.pz);
        rvz -= b.pointVZ(c.px, c.pz);
      }
      let vn = rvx * c.nx + rvz * c.nz;
      let e = b != null ? Math.max(a.restitution, b.restitution) : a.restitution;
      let wa = a.invMassAt(c.px, c.pz, c.nx, c.nz);
      let wb = b != null ? b.invMassAt(c.px, c.pz, c.nx, c.nz) : 0;
      if (wa + wb <= 0) continue;
      // Bounce: restore a fraction of the closing speed (not for slow touches).
      let target = c.vn < -1.5 ? -e * c.vn : 0;
      let dvn = target - vn;
      if (dvn > 0) {
        let j = dvn / (wa + wb);
        a.applyImpulse(c.nx * j, c.nz * j, c.px, c.pz);
        if (b != null) b.applyImpulse(-c.nx * j, -c.nz * j, c.px, c.pz);
      }
      if (-c.vn > a.impact) {
        a.impact = -c.vn;
        a.impactX = c.px;
        a.impactZ = c.pz;
      }
      if (b != null && -c.vn > b.impact) {
        b.impact = -c.vn;
        b.impactX = c.px;
        b.impactZ = c.pz;
      }
      // Friction: slow the sliding, no more than mu times the normal impulse.
      let tx = rvx - vn * c.nx, tz = rvz - vn * c.nz;
      let vt = Math.sqrt(tx * tx + tz * tz);
      if (vt < 1e-6) continue;
      tx /= vt;
      tz /= vt;
      let mu = b != null ? Math.sqrt(a.friction * b.friction) : a.friction;
      let wta = a.invMassAt(c.px, c.pz, tx, tz);
      let wtb = b != null ? b.invMassAt(c.px, c.pz, tx, tz) : 0;
      let jt = Math.min(vt / (wta + wtb), mu * c.lambda / h);
      a.applyImpulse(-tx * jt, -tz * jt, c.px, c.pz);
      if (b != null) b.applyImpulse(tx * jt, tz * jt, c.px, c.pz);
      if (b == null && vt > a.scrape) {
        a.scrape = vt;
        a.scrapeX = c.px;
        a.scrapeZ = c.pz;
      }
    }
  }
}

function pointIn(p: StaticArray<f64>, x: f64, z: f64): bool {
  let inside = false;
  let n = p.length / 2;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    let xi = p[i * 2], zi = p[i * 2 + 1];
    let xj = p[j * 2], zj = p[j * 2 + 1];
    if ((zi > z) != (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    j = i;
  }
  return inside;
}
