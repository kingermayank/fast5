import * as THREE from 'three';
import { RAPIER, syncMesh, yawQuat } from './physics';
import type { Vehicle } from './vehicle';
import { CAUGHT_BIT, HERO_BIT, STREET_BIT, TOW_POINT } from './vehicle';

const HALF = { x: 1.5, y: 1.25, z: 1.5 };
/** Cable the winches keep between each car and the vault (m). */
export const CABLE_TOW_LENGTH = 10;
/** Rounded edges on the collider, so the vault glances off a building's corner instead of hooking on it. */
const ROUNDING = 0.35;
export const VAULT_MASS = 4000;
/** How far sideways it may stray from the cars' trail before it's steered back (m), and how hard (1/s). */
const TRAIL_SLACK = 1.5;
const TRAIL_PULL = 1.6;
/** Wedged this long (s) while the cars pull, it's popped free along their trail... */
const WEDGED_FOR = 0.8;
/** ...and after this many pops that leave it where it was, it's put back on the road. */
const POPS = 2;
/**
 * It hits everything but thin street furniture (see STREET_BIT) and a car being thrown
 * out of the rig (CAUGHT_BIT); ghosting, it misses the hero cars too.
 */
const VAULT_GROUPS = (0xffff << 16) | (0xffff & ~STREET_BIT & ~CAUGHT_BIT);
const VAULT_GHOST_GROUPS = (0xffff << 16) | (0xffff & ~STREET_BIT & ~CAUGHT_BIT & ~HERO_BIT);
/** Fastest it may run up on a car that's ahead of it (m/s): an overrun brake, as trailers have. */
const OVERRUN = 1.5;

/** Steel vault: a heavy sliding box. Its local +z face is the door, where the cables attach. */
export class Vault {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh = new THREE.Group();

  constructor(
    private world: RAPIER.World,
    position: THREE.Vector3,
    heading: number,
  ) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, HALF.y + 0.02, position.z)
        .setRotation(yawQuat(heading))
        .setCcdEnabled(true)
        .setAngularDamping(0.6)
        .setLinearDamping(0.05),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(HALF.x - ROUNDING, HALF.y - ROUNDING, HALF.z - ROUNDING, ROUNDING)
        .setMass(VAULT_MASS)
        .setFriction(0.45)
        .setRestitution(0.05)
        .setCollisionGroups(VAULT_GROUPS),
      this.body,
    );
    this.buildMesh();
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** Local cable anchor on the door face; side -1 = right, 1 = left. */
  anchorLocal(side: number): RAPIER.Vector {
    return { x: side * 0.9, y: -0.7, z: HALF.z };
  }

  anchorWorld(side: number): THREE.Vector3 {
    const a = this.anchorLocal(side);
    const r = this.body.rotation();
    const t = this.body.translation();
    return new THREE.Vector3(a.x, a.y, a.z).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  /** Pass through the hero cars (while it's flung at the bank, so it can't clip the partner). */
  ghostHeroes(on: boolean): void {
    this.collider.setCollisionGroups(on ? VAULT_GHOST_GROUPS : VAULT_GROUPS);
  }

  place(position: THREE.Vector3, heading: number): void {
    this.body.setTranslation({ x: position.x, y: HALF.y + 0.02, z: position.z }, true);
    this.body.setRotation(yawQuat(heading), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.wedged = 0;
    this.pops = 0;
    this.wantsRescue = false;
  }

  private wedged = 0;
  /** Hops in a row that left it where it was, and where that is. */
  private pops = 0;
  private readonly popFrom = new THREE.Vector3();
  /** Wedged for good: the game should put it back on the road (see rescue()). */
  wantsRescue = false;

  /**
   * Trailer behaviour, per physics step in the chase: keep the vault on the road the
   * cars just drove. The further it strays sideways from their trail (cutting a corner
   * toward a building), the more of its sideways speed is turned back toward it, but
   * not while the player swings it on purpose. If it's wedged anyway while the cars
   * pull, it's popped free along the trail. `trail` runs oldest first; `shift` is how
   * far left of it the cars' midpoint runs (the partner's side).
   */
  followTrail(dt: number, trail: readonly THREE.Vector3[], shift: number, swinging: boolean, pulled: boolean): void {
    if (trail.length < 3 || !this.body.isDynamic()) return;
    const p = this.position.setY(0);
    // The nearest point on the trail.
    let best = 0;
    let bestD = Infinity;
    let bestT = 0;
    for (let i = 0; i < trail.length - 1; i++) {
      const a = trail[i];
      const ab = trail[i + 1].clone().sub(a);
      const len2 = ab.lengthSq();
      if (len2 < 1e-6) continue;
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / len2, 0, 1);
      const d = a.clone().addScaledVector(ab, t).distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
        bestT = t;
      }
    }
    const a = trail[best];
    const tan = trail[best + 1].clone().sub(a).normalize();
    const left = new THREE.Vector3(tan.z, 0, -tan.x);
    const e = p.clone().sub(a.clone().addScaledVector(trail[best + 1].clone().sub(a), bestT)).dot(left) - shift;
    const v = this.body.linvel();
    if (!swinging && Math.abs(e) > TRAIL_SLACK) {
      const vN = v.x * left.x + v.z * left.z;
      const want = -Math.sign(e) * Math.min(6, (Math.abs(e) - TRAIL_SLACK) * TRAIL_PULL);
      const dv = (want - vN) * Math.min(1, dt * 2.5);
      this.body.setLinvel({ x: v.x + left.x * dv, y: v.y, z: v.z + left.z * dv }, true);
    }
    // Wedged on something while the cars strain: hop it back onto their trail, a little ahead.
    const speed = Math.hypot(v.x, v.z);
    this.wedged = pulled && speed < 0.8 ? this.wedged + dt : Math.min(this.wedged, 0);
    if (this.wedged > WEDGED_FOR) {
      this.wedged = -0.6;
      // Hopped a few times without getting anywhere: it needs putting back on the road.
      if (p.distanceTo(this.popFrom) > 3) {
        this.pops = 0;
        this.popFrom.copy(p);
      }
      if (++this.pops > POPS) {
        this.wantsRescue = true;
        return;
      }
      let k = best + 1;
      for (let s = 0; k < trail.length - 1 && s < 4; k++) s += trail[k].distanceTo(trail[k - 1]);
      const to = trail[k].clone().addScaledVector(left, shift).sub(p).setY(0);
      if (to.lengthSq() > 1e-4) to.setLength(5);
      this.body.setLinvel({ x: to.x, y: 2.5, z: to.z }, true);
    }
  }

  /**
   * Put the vault back on the cars' trail, at the first spot clear of buildings at least
   * `back` m behind its newest point. Returns where, or null if there's nowhere.
   */
  rescue(trail: readonly THREE.Vector3[], back: number): THREE.Vector3 | null {
    let walked = 0;
    for (let i = trail.length - 1; i > 0; i--) {
      walked += trail[i].distanceTo(trail[i - 1]);
      if (walked < back) continue;
      const at = trail[i - 1];
      const along = trail[i].clone().sub(at);
      const heading = Math.atan2(along.x, along.z);
      if (!this.fits(at, heading)) continue;
      this.place(at, heading);
      return at.clone();
    }
    return null;
  }

  /** No building where the vault would sit at `p`. */
  private fits(p: THREE.Vector3, heading: number): boolean {
    let hit = false;
    this.world.intersectionsWithShape(
      { x: p.x, y: HALF.y + 0.2, z: p.z },
      yawQuat(heading),
      new RAPIER.Cuboid(HALF.x, HALF.y - 0.1, HALF.z),
      () => {
        hit = true;
        return false;
      },
      RAPIER.QueryFilterFlags.ONLY_FIXED,
    );
    return !hit;
  }

  /**
   * Overrun brake: when the cars stop short, the vault mustn't slide on into them and
   * pin them (it would climb onto a car and wedge it). Running up on a car ahead of it,
   * it's held to a crawl toward that car.
   */
  overrun(dt: number, cars: Vehicle[]): void {
    if (!this.body.isDynamic()) return;
    const p = this.position.setY(0);
    for (const car of cars) {
      const rel = car.position.sub(p);
      const dist = rel.length();
      if (dist > 9 || dist < 1e-3) continue;
      rel.divideScalar(dist);
      const v = this.body.linvel();
      const cv = car.body.linvel();
      // Only the vault's own run at the car counts (a car backing onto a still vault doesn't shove it).
      const closing = v.x * rel.x + v.z * rel.z - Math.max(0, cv.x * rel.x + cv.z * rel.z);
      if (closing <= OVERRUN) continue;
      const dv = (closing - OVERRUN) * Math.min(1, dt * 8);
      this.body.setLinvel({ x: v.x - rel.x * dv, y: v.y, z: v.z - rel.z * dv }, true);
    }
  }

  render(): void {
    syncMesh(this.mesh, this.body);
  }

  /** The warm light its steel catches from the tunnel's sodium lamps (0..1); copies of its mesh share it. */
  glow(k: number): void {
    for (const m of this.steel) m.emissiveIntensity = k;
  }

  private steel: THREE.MeshStandardMaterial[] = [];

  private buildMesh(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.85, roughness: 0.45, emissive: 0x47301a, emissiveIntensity: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.8, roughness: 0.5, emissive: 0x2a1c10, emissiveIntensity: 0 });
    this.steel = [steel, dark];
    const box = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2), steel);
    box.castShadow = box.receiveShadow = true;
    this.mesh.add(box);
    // Behind the door: the dark inside (seen when it swings open), and the money, if there is any.
    const cavity = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.8), new THREE.MeshBasicMaterial({ map: cavityTexture() }));
    cavity.position.z = HALF.z + 0.005;
    this.mesh.add(cavity);
    const cash = new THREE.Group();
    cash.name = 'cash';
    cash.visible = false;
    const notes = new THREE.MeshStandardMaterial({ color: 0x6f9a62, roughness: 0.8 });
    const band = new THREE.MeshStandardMaterial({ color: 0xe8dcb5, roughness: 0.7 });
    for (let y = -0.75; y < 0.8; y += 0.21) {
      for (let x = -0.85; x < 0.9; x += 0.42) {
        const brick = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.17, 0.5), notes);
        brick.position.set(x + (Math.random() - 0.5) * 0.05, y, HALF.z - 0.15 + Math.random() * 0.12);
        brick.rotation.y = (Math.random() - 0.5) * 0.12;
        const strap = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.175, 0.505), band);
        brick.add(strap);
        cash.add(brick);
      }
    }
    this.mesh.add(cash);
    // Door, hinges and wheel lock on the +z face; the door swings on its hinges at the left.
    const door = new THREE.Group();
    door.name = 'door';
    door.position.set(-1.15, 0, HALF.z + 0.06);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.0, 0.12), dark);
    slab.position.x = 1.15;
    slab.castShadow = true;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 8, 20), steel);
    wheel.position.set(1.15, 0, 0.1);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 10).rotateX(Math.PI / 2), steel);
    hub.position.set(1.15, 0, 0.1);
    door.add(slab, wheel, hub);
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.06), steel);
      spoke.position.set(1.15, 0, 0.1);
      spoke.rotation.z = (i * Math.PI) / 3;
      door.add(spoke);
    }
    for (const y of [-0.6, 0.6]) {
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.35, 8), dark);
      hinge.position.set(-1.15, y, HALF.z + 0.12);
      this.mesh.add(hinge);
    }
    this.mesh.add(door);
  }
}

/** Open the door of a vault's mesh (this one, or a copy of it) by `k` (0 shut, 1 swung wide); `cash` shows the money inside. */
export function openVault(mesh: THREE.Object3D, k: number, cash = false): void {
  const door = mesh.getObjectByName('door');
  // All three angles: a copy of an open vault's mesh can carry its door's turn as x = z = 180°.
  if (door) door.rotation.set(0, -1.95 * k, 0);
  const money = mesh.getObjectByName('cash');
  if (money) money.visible = cash && k > 0.02;
}

/** The inside of an empty vault: dark, a little lighter at the edges where the light gets in. */
function cavityTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 30, 4, 32, 32, 44);
  g.addColorStop(0, '#040404');
  g.addColorStop(0.7, '#0d0e10');
  g.addColorStop(1, '#2a2c30');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Cable stiffness (N/m) and damping (N·s/m): steel with a little give, so a yank is firm but not instant. */
const STIFFNESS = 60_000;
const DAMPING = 12_000;
/** Most force one cable transmits through the spring (N); beyond that the hard stop takes over. */
const MAX_PULL = 220_000;
/** The hard stop (a rope joint) sits this far beyond the cable's length. */
const STRETCH_LIMIT = 1.6;
/**
 * Winch slip clutch (N): past this tension the drum pays cable out rather than
 * stopping the car dead (after a wide swing the vault can be lying still 30 m
 * back as you floor it). The winch reels the slack back in afterwards.
 */
const SLIP_TENSION = 70_000;
/** Winch speed (m/s). */
const REEL_SPEED = 4;

/** Velocity of a body at a world point. */
function pointVelocity(body: RAPIER.RigidBody, p: THREE.Vector3): THREE.Vector3 {
  const v = body.linvel();
  const w = body.angvel();
  const c = body.translation();
  const r = p.clone().sub(new THREE.Vector3(c.x, c.y, c.z));
  return new THREE.Vector3(v.x, v.y, v.z).add(new THREE.Vector3(w.x, w.y, w.z).cross(r));
}

/**
 * Steel cable from a car's winch to the vault: a stiff, damped spring that only
 * pulls (slack when shorter than its length), with a rope joint a little beyond
 * as a hard stop. The spring takes the edge off yanks that a rigid rope would
 * deliver in a single step. The winch can pay out and reel in cable.
 */
export class Cable {
  private joint: RAPIER.ImpulseJoint;
  private jointLength: number;
  private mesh: THREE.Mesh;
  private reelTimer = 0;
  length: number;
  /** Current tension (N), for effects. */
  tension = 0;
  /** The slip clutch can pay out cable; off, the cable holds however hard the car pulls (a pull off the mark). */
  clutch = true;

  constructor(
    private world: RAPIER.World,
    scene: THREE.Scene,
    readonly car: Vehicle,
    readonly vault: Vault,
    readonly side: number,
    length: number,
  ) {
    this.length = length;
    this.jointLength = length + STRETCH_LIMIT;
    this.joint = this.createJoint();
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.4 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);
  }

  private createJoint(): RAPIER.ImpulseJoint {
    return this.world.createImpulseJoint(
      RAPIER.JointData.rope(this.jointLength, TOW_POINT, this.vault.anchorLocal(this.side)),
      this.car.body,
      this.vault.body,
      true,
    );
  }

  /** Move the hard stop to match the cable length (joints can't be resized, so it's recreated). */
  private syncJoint(): void {
    const want = this.length + STRETCH_LIMIT;
    if (Math.abs(want - this.jointLength) < 0.3) return;
    this.jointLength = want;
    this.world.removeImpulseJoint(this.joint, true);
    this.joint = this.createJoint();
  }

  /** Take up the slack at once (after the vault has been moved): as long as the gap, but no shorter than `min`. */
  fit(min: number): void {
    this.length = Math.max(min, this.car.towPoint().distanceTo(this.vault.anchorWorld(this.side)) + 0.6);
    this.syncJoint();
  }

  /** Spring force for this physics step. Call before world.step(). */
  step(dt: number): void {
    const a = this.car.towPoint();
    const b = this.vault.anchorWorld(this.side);
    const d = b.clone().sub(a);
    const dist = d.length();
    const stretch = dist - this.length;
    this.tension = 0;
    if (stretch <= 0 || dist < 1e-3) return;
    const n = d.divideScalar(dist);
    // Positive when the ends are moving apart.
    const opening = pointVelocity(this.vault.body, b).sub(pointVelocity(this.car.body, a)).dot(n);
    let f = Math.min(MAX_PULL, STIFFNESS * stretch + DAMPING * opening);
    if (f <= 0) return; // a cable can only pull
    if (this.clutch && f > SLIP_TENSION && opening > 2) {
      // Snatched hard: the clutch slips, letting out cable at the rate the ends are parting.
      this.length += opening * dt;
      this.syncJoint();
      f = SLIP_TENSION;
    }
    this.tension = f;
    const j = f * dt;
    this.car.body.applyImpulseAtPoint({ x: n.x * j, y: n.y * j, z: n.z * j }, a, true);
    if (this.vault.body.isDynamic()) this.vault.body.applyImpulseAtPoint({ x: -n.x * j, y: -n.y * j, z: -n.z * j }, b, true);
  }

  /** Pay out cable to `length`, free-spooling for `hold` seconds (the winch reels it back in after). */
  payOut(length: number, hold = 1.6): void {
    if (length <= this.length) return;
    this.length = length;
    this.syncJoint();
    // Hold the slack long enough for the swing to play out.
    this.reelTimer = hold;
  }

  /** Winch toward `target` length, without ever loading the spring with a sudden jerk. */
  reel(target: number, dt: number): void {
    this.reelTimer -= dt;
    const dist = this.car.towPoint().distanceTo(this.vault.anchorWorld(this.side));
    if (this.reelTimer > 0) {
      // Just paid out: the drum free-spools while the vault flies, so nothing yanks it back.
      if (dist > this.length) {
        this.length = dist;
        this.syncJoint();
      }
      return;
    }
    if (this.length <= target) return;
    // Never wind in more than a little past the current distance: the winch stalls under load.
    this.length = Math.max(target, this.length - REEL_SPEED * dt, Math.min(this.length, dist - 0.8));
    this.syncJoint();
  }

  render(): void {
    const a = this.car.towPoint();
    const b = this.vault.anchorWorld(this.side);
    const d = a.distanceTo(b);
    const sag = Math.sqrt(Math.max(0, this.length * this.length - d * d)) * 0.35;
    const mid = a.clone().lerp(b, 0.5);
    mid.y = Math.max(0.05, mid.y - sag);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(curve, 12, 0.05, 5, false);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.world.removeImpulseJoint(this.joint, true);
  }
}
