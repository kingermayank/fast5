import * as THREE from 'three';
import { angleTo, avoidance, seek } from './ai';
import type { ControlState } from './input';
import { BIKE_SPEC, buildBikeModel, stepThrown, type Thrown, throwRider } from './bikes';
import type { City } from './city';
import type { Figure } from './people';
import { RAPIER } from './physics';
import { Path } from './roads';
import { type Plunge, startPlunge, stepPlunge } from './overboard';
import { BRIDGE } from './roadmap';
import type { Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';

const COP_SPEC: VehicleSpec = {
  mass: 1700,
  accel: 22,
  topSpeed: 52,
  turnRate: 2.4,
  grip: 7,
  model: { body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true, asset: 'police' },
};

export interface Cop {
  v: Vehicle;
  wrecked: boolean;
  lastSpeed: number;
  stuck: number;
  reversing: number;
  wreckedFor: number;
  /** Closing speed on the player last step (m/s), and whether they were touching. */
  closing: number;
  touching: boolean;
  /** A motorbike, not a cruiser: its rider (until thrown), the side of the convoy it rides, its weave, how far it leans. */
  bike?: { rider: Figure; seated: THREE.Object3D; side: number; phase: number; lean: number; thrown: Thrown | null; jumped: number };
}

/** Bikes pass through each other (two riding side by side mustn't take each other out). */
const BIKE_BIT = 0x0020;
const BIKE_GROUPS = (BIKE_BIT << 16) | (0xffff & ~BIKE_BIT);
/** A feeler that sees everything but bikes. */
const NOT_BIKES = (0xffff << 16) | (0xffff & ~BIKE_BIT);
const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

/** Bikes ride in pairs, at most this many on the road at once, from this heat up. */
const MAX_BIKES = 2;
const BIKE_HEAT = 2;

const BRIDGE_PATH = new Path(BRIDGE.pts);

export class Police {
  readonly cops: Cop[] = [];
  wreckedCount = 0;
  /** Called when a cruiser is wrecked, with where it happened, the wreck, and whether the vault hit it. */
  onWreck?: (at: THREE.Vector3, car: Vehicle, byVault: boolean) => void;
  /** Called when a cruiser rams the player, with where and how hard (0..1). */
  onBump?: (at: THREE.Vector3, strength: number) => void;
  /** Set by the game: true if a point is on screen. Cops never appear where you can see them. */
  visible: (p: THREE.Vector3) => boolean = () => false;
  /** How hard a vault hit throws a cruiser (the finale on the bridge turns it up). */
  launch = 1;
  /** Called when a cruiser that went over the rail hits the water. */
  onSplash?: (at: THREE.Vector3) => void;
  /** Cruisers on their way over the rail and down into the bay. */
  private plunges: Plunge[] = [];
  /** A cruiser close behind fires from its window: where from, and where the round lands. */
  onShoot?: (from: THREE.Vector3, to: THREE.Vector3) => void;
  /** The first pair of bikes is on its way (for the radio). */
  onBikes?: () => void;
  /** A thrown rider hit the road. */
  onRiderDown?: (at: THREE.Vector3) => void;
  private bikesSeen = false;
  /** Debug (?bikes): the first spawn is a pair of bikes, whatever the heat. */
  forceBikes = false;
  /** Set by the game: the road the convoy has just driven, oldest first (the bikes ride up it). */
  trail: () => readonly THREE.Vector3[] = () => [];
  /** Set by the game: where the crew's cars are (the bikes ride outside them). */
  heroes: () => THREE.Vector3[] = () => [];
  /** Shooting from the windows (once the heat's up): when the next burst comes, and the one going on. */
  private shootIn = 6;
  private burst: { c: Cop; left: number; next: number } | null = null;
  private spawnTimer = 2;
  private time = 0;

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
    private city: City,
  ) {}

  /**
   * From the windows: every few seconds a cruiser close behind or alongside leans out
   * and fires a few rounds at the convoy. It's pressure, not damage: flashes, sparks
   * and the sound of it.
   */
  private shoot(dt: number, target: Vehicle, vault: Vault): void {
    if (this.burst) {
      const b = this.burst;
      b.next -= dt;
      if (b.next > 0) return;
      if (b.c.wrecked || b.left <= 0) {
        this.burst = null;
        return;
      }
      b.left--;
      b.next = 0.14 + Math.random() * 0.08;
      const r = b.c.v.body.rotation();
      const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
      const t = b.c.v.body.translation();
      // The driver's window, on the left.
      const from = new THREE.Vector3(1.05, 0.55, 0.4).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
      const aim = Math.random() < 0.5 ? target.position.setY(0.9) : vault.position;
      const to = aim.add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 0.8, (Math.random() - 0.5) * 3));
      this.onShoot?.(from, to);
      return;
    }
    this.shootIn -= dt;
    if (this.shootIn > 0) return;
    this.shootIn = 4 + Math.random() * 4;
    const p = target.position;
    const f = target.forward;
    const shooter = this.cops.find((c) => !c.wrecked && !c.bike && c.reversing <= 0 && c.v.position.distanceTo(p) < 28 && c.v.position.sub(p).dot(f) < 4);
    if (shooter) this.burst = { c: shooter, left: 2 + Math.floor(Math.random() * 3), next: 0 };
  }

  /** Cops close enough to box the player in. */
  closeTo(p: THREE.Vector3, radius: number): number {
    return this.cops.filter((c) => !c.wrecked && c.v.position.distanceTo(p) < radius).length;
  }

  /** Called every physics step before world.step(). */
  step(dt: number, target: Vehicle, vault: Vault, heat: number, onBridge: boolean): void {
    this.time += dt;
    this.spawn(dt, target, heat, onBridge);

    const lead = target.position.add(new THREE.Vector3(target.body.linvel().x, 0, target.body.linvel().z).multiplyScalar(0.35));
    const vaultPos = vault.position;
    const vaultVel = vault.body.linvel();
    this.pickSides(target);

    for (const c of this.cops) {
      const pos = c.v.position;
      const speed = Math.hypot(c.v.body.linvel().x, c.v.body.linvel().z);

      if (!c.wrecked) {
        // Hit by the swinging vault, or a violent stop (wall, hero car): wrecked.
        const cv = c.v.body.linvel();
        const rel = Math.hypot(vaultVel.x - cv.x, vaultVel.z - cv.z);
        const vaultHit = pos.distanceTo(vaultPos.clone().setY(0)) < 4.3 && rel > 6;
        // A bike that hits something far from the convoy just wobbles on: it's yours to take down.
        const crashed = c.lastSpeed - speed > 24 && (!c.bike || pos.distanceTo(target.position) < 60);
        if (vaultHit || crashed) this.wreck(c, vaultHit ? vaultPos : null);
        this.bump(c, target);
      }
      c.lastSpeed = speed;
      if (c.wrecked) {
        c.wreckedFor += dt;
        continue;
      }

      if (c.reversing > 0) {
        c.reversing -= dt;
        c.v.controls = { throttle: 0, brake: 1, steer: -Math.sign(c.v.steer || 1), handbrake: false };
      } else if (c.bike) {
        // Bikes don't ram. Far off they come up the road the convoy took (quicker than any
        // cruiser, braking for the corners); close up, each weaves alongside the car on its
        // own side and sits there, drifting forward and back, just where a swing comes round.
        const f = target.forward;
        const left = new THREE.Vector3(f.z, 0, -f.x);
        const b = c.bike;
        const gap = pos.distanceTo(target.position);
        const far = gap > 35;
        c.v.assist = far ? 1.3 : 1;
        // Way back and out of sight: it closes the distance the way a chase does (a jump up the
        // convoy's trail to just out of view behind it, at the convoy's speed), then rides in.
        if (gap > 85 && !this.visible(pos) && this.time - b.jumped > 4) {
          const s = [60, 75, 45].map((d) => this.trailBack(target, d)).find((x) => x && !this.visible(x.at));
          if (s) {
            b.jumped = this.time;
            c.v.place(s.at.clone().add(new THREE.Vector3(Math.cos(s.heading), 0, -Math.sin(s.heading)).multiplyScalar(b.side * 1.5)), s.heading);
            const tv = target.body.linvel();
            c.v.body.setLinvel({ x: tv.x, y: 0, z: tv.z }, true);
          }
        }
        if (far) {
          // Far enough up the road to stop for a corner from this speed. Closing in, it pulls out
          // wide to come past the vault on the outside instead of riding into the back of it.
          const v = Math.abs(c.v.forwardSpeed);
          const road = this.alongTrail(pos, b.side * (gap < 70 ? 6.5 : 1.5), (v * v) / 50 + 12);
          c.v.controls = road ? this.ride(c, road.near, 1, road.far) : this.ride(c, lead, 1);
        } else {
          // Outside the convoy, never in between the cars (that's the rig, and it throws them out).
          const xs = this.heroes().map((h) => h.clone().sub(target.position).dot(left));
          const outer = b.side > 0 ? Math.max(0, ...xs) : Math.min(0, ...xs);
          const slot = lead
            .clone()
            .addScaledVector(left, outer + b.side * (3.6 + Math.sin(this.time * 1.7 + b.phase) * 1.4))
            .addScaledVector(f, -2 + Math.sin(this.time * 0.6 + b.phase) * 4);
          const ahead = pos.clone().sub(slot).dot(f);
          const ctl = this.ride(c, slot.clone().addScaledVector(f, 7), ahead > 2 ? 0.15 : ahead < -8 ? 1 : 0.8);
          if (ahead > 4) ctl.brake = Math.max(ctl.brake, 0.4);
          c.v.controls = ctl;
        }
        c.stuck = speed < 2 && pos.distanceTo(target.position) > 12 ? c.stuck + dt : 0;
        if (c.stuck > 1.5) {
          c.stuck = 0;
          // Wedged somewhere out of sight: back on the convoy's trail it goes; otherwise it backs off and tries again.
          const back = far && !this.visible(pos) ? this.trailSpot(target) : null;
          if (back) c.v.place(back.at, back.heading);
          else c.reversing = 1;
        }
      } else {
        c.v.controls = seek(this.world, c.v, lead, 0.85 + heat * 0.05);
        c.stuck = speed < 2 && pos.distanceTo(target.position) > 12 ? c.stuck + dt : 0;
        if (c.stuck > 1.5) {
          c.stuck = 0;
          c.reversing = 1.2;
        }
      }
      c.v.step(dt);
    }

    for (const p of this.plunges) stepPlunge(p, dt, (at) => this.onSplash?.(at));
    if (heat >= 2) this.shoot(dt, target, vault);

    // Despawn far-away and long-wrecked cops (one in the air over the rail once it's sunk).
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      const plunge = this.plunges.find((p) => p.v === c.v);
      if (plunge && !plunge.done) continue;
      if (plunge) this.plunges.splice(this.plunges.indexOf(plunge), 1);
      const d = c.v.position.distanceTo(target.position);
      const fell = c.v.body.translation().y < -3;
      if (fell || d > 380 || (c.wrecked && ((c.wreckedFor > 6 && d > 50) || c.wreckedFor > 14))) {
        this.remove(c);
        this.cops.splice(i, 1);
      }
    }
  }

  /**
   * A bike's pedals toward `target`: steer for it (and away from walls, looking further ahead
   * the faster it goes), at `throttle`, slowing for the corner the sharper the turn it needs.
   */
  private ride(c: Cop, target: THREE.Vector3, throttle: number, look = target): ControlState {
    const v = c.v;
    const angle = angleTo(v, target);
    const speed = Math.abs(v.forwardSpeed);
    const cars = this.feelCars(v, Math.max(10, speed * 0.7));
    const steer = THREE.MathUtils.clamp(angle * 2.5 + avoidance(this.world, v, Math.max(16, speed * 0.8)) + cars.steer, -1, 1);
    // Corner speed from how far round the road ahead turns (`look` is far enough up it to brake in
    // time); the little wobbles of a straight road don't count.
    const turn = Math.max(0, Math.max(Math.abs(angle), Math.abs(angleTo(v, look))) - 0.1);
    const corner = 14 + 46 * Math.max(0, 1 - turn / 0.9);
    const over = speed - corner;
    // Boxed in by cars ahead: brake at speed, but never sit still behind them (a bike threads round at a crawl).
    const boxed = cars.brake > 0 && speed > 8;
    const brake = Math.max(over > 4 ? Math.min(1, over / 12) : 0, boxed ? cars.brake : 0);
    return { throttle: over > 0 || boxed ? 0 : cars.brake > 0 ? Math.min(throttle, 0.4) : throttle, brake, steer, handbrake: false };
  }

  /**
   * Cars ahead of a bike (cruisers, traffic, the convoy; not other bikes): which way to
   * swerve round them, and how hard to brake if both feelers are blocked close in.
   */
  private feelCars(v: Vehicle, range: number): { steer: number; brake: number } {
    const p = v.body.translation();
    const h = v.heading;
    const cast = (a: number) => {
      ray.origin = { x: p.x, y: 0.8, z: p.z };
      ray.dir = { x: Math.sin(h + a), y: 0, z: Math.cos(h + a) };
      // Only car-sized things: not the palms and bins, or the debris the convoy leaves in the road.
      const hit = this.world.castRay(ray, range, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED, NOT_BIKES, v.collider, undefined, (col) => col.mass() > 900);
      return hit ? hit.timeOfImpact : range;
    };
    const left = cast(0.2);
    const right = cast(-0.2);
    if (left >= range && right >= range) return { steer: 0, brake: 0 };
    const near = Math.min(left, right) / range;
    return { steer: THREE.MathUtils.clamp(((left - right) / range) * 2, -1, 1), brake: left < range * 0.5 && right < range * 0.5 ? 1 - near : 0 };
  }

  /**
   * Up the convoy's trail from where it passes nearest `p`, `side` m to the left of it: the
   * point 14 m on to steer for, and one `ahead` m on to judge the corners by (null if there's
   * no trail to follow).
   */
  private alongTrail(p: THREE.Vector3, side: number, ahead: number): { near: THREE.Vector3; far: THREE.Vector3 } | null {
    const t = this.trail();
    if (t.length < 4) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = t[i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Off the trail (just spawned up a side street): head for where it is, first.
    if (bestD > 25 * 25) return { near: t[best], far: t[best] };
    const walk = (from: number, len: number) => {
      let i = from;
      for (let walked = 0; i < t.length - 1 && walked < len; i++) walked += t[i + 1].distanceTo(t[i]);
      const dir = t[Math.min(t.length - 1, i + 1)].clone().sub(t[Math.max(0, i - 1)]).setY(0).normalize();
      return t[i].clone().add(new THREE.Vector3(dir.z, 0, -dir.x).multiplyScalar(side));
    };
    return { near: walk(best, 14), far: walk(best, Math.max(14, ahead)) };
  }

  /** The point on the convoy's trail about `back` m behind it (as the crow flies), and the way along it there. */
  private trailBack(target: Vehicle, back: number): { at: THREE.Vector3; heading: number } | null {
    const t = this.trail();
    for (let i = t.length - 3; i >= 0; i--) {
      if (t[i].distanceTo(target.position) < back) continue;
      const d = t[i + 2].clone().sub(t[i]);
      return { at: t[i].clone(), heading: Math.atan2(d.x, d.z) };
    }
    return null;
  }

  /** A place on the convoy's trail, out of sight and at least 90 m back, and the way along it there (null if there isn't one yet). */
  private trailSpot(target: Vehicle): { at: THREE.Vector3; heading: number } | null {
    const t = this.trail();
    for (let i = 0; i < t.length - 2; i++) {
      const p = t[i];
      if (p.distanceTo(target.position) < 90 || this.visible(p)) continue;
      const d = t[i + 2].clone().sub(p);
      return { at: p.clone(), heading: Math.atan2(d.x, d.z) };
    }
    return null;
  }

  /** Each bike rides its own side of the convoy: with two, the one further left takes the left. */
  private pickSides(target: Vehicle): void {
    const bikes = this.cops.filter((c) => c.bike && !c.wrecked);
    if (!bikes.length) return;
    const f = target.forward;
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const x = (c: Cop) => c.v.position.sub(target.position).dot(left);
    if (bikes.length >= 2) {
      bikes.sort((a, b) => x(b) - x(a));
      bikes.forEach((c, i) => (c.bike!.side = i === 0 ? 1 : -1));
    } else if (Math.abs(x(bikes[0])) > 2) {
      bikes[0].bike!.side = Math.sign(x(bikes[0]));
    }
  }

  /** Off the road for good: the car (or bike) and a thrown rider. */
  private remove(c: Cop): void {
    c.v.dispose(this.scene);
    if (c.bike?.thrown) this.scene.remove(c.bike.thrown.pivot);
  }

  /** Is this one of the motorbikes? */
  isBike(v: Vehicle): boolean {
    return !!this.cops.find((c) => c.v === v)?.bike;
  }

  render(dt: number): void {
    const flash = Math.floor(this.time * 6) % 2 === 0;
    for (const c of this.cops) {
      c.v.render(dt);
      if (c.bike) {
        // Bikes lean into their turns (well past what a car's body roll would show).
        const b = c.bike;
        const want = c.wrecked ? b.lean : -c.v.steer * Math.min(1, Math.abs(c.v.forwardSpeed) / 14) * 0.55;
        b.lean += (want - b.lean) * Math.min(1, dt * 6);
        c.v.model.body.rotation.z = b.lean;
        if (b.thrown && stepThrown(b.thrown, dt)) this.onRiderDown?.(b.thrown.pivot.position.clone().setY(0));
      }
      c.v.model.brake.emissiveIntensity = c.wrecked ? 0 : c.v.controls.brake > 0 ? 4 : 1.2;
      const bar = c.v.model.lightBar;
      if (bar && !c.wrecked) {
        bar.red.emissiveIntensity = flash ? 3 : 0.2;
        bar.blue.emissiveIntensity = flash ? 0.2 : 3;
      }
    }
  }

  clear(): void {
    for (const c of this.cops) this.remove(c);
    this.cops.length = 0;
    this.wreckedCount = 0;
    this.spawnTimer = 2;
  }

  /**
   * Take cruisers off the road (those `where` picks, or all of them) without counting
   * them as wrecked: they've lost the convoy, or gone after someone else. The next
   * ones come a few seconds after the chase picks up again.
   */
  dismiss(where?: (p: THREE.Vector3) => boolean, keepWrecks = false): void {
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      if (where && !where(c.v.position)) continue;
      if (keepWrecks && c.wrecked) continue;
      this.remove(c);
      this.cops.splice(i, 1);
    }
    this.spawnTimer = Math.max(this.spawnTimer, 3);
  }

  /** A cruiser at `at` facing `heading`, for a cutscene to drive (it isn't stepped while the scene runs). */
  spawnAt(at: THREE.Vector3, heading: number): Vehicle {
    const v = new Vehicle(this.world, COP_SPEC, at, heading);
    this.scene.add(v.model.group);
    this.cops.push({ v, wrecked: false, lastSpeed: 0, stuck: 0, reversing: 0, wreckedFor: 0, closing: 0, touching: false });
    return v;
  }

  /**
   * A cruiser ramming the player. The hero cars shrug off most of a hit in the
   * physics (main.ts) so it can't spin you out; instead you get a shove you can
   * feel and drive through, with a crunch and a camera kick.
   */
  private bump(c: Cop, target: Vehicle): void {
    let touching = false;
    this.world.contactPair(c.v.collider, target.collider, (m) => {
      if (m.numContacts() > 0 && m.contactDist(0) < 0.1) touching = true;
    });
    if (touching && !c.touching && c.closing > 3) {
      const away = target.position.sub(c.v.position).normalize();
      // A bike glancing off you is a nudge, not a cruiser's shove.
      const push = Math.min(1.5, c.closing * 0.12) * target.spec.mass * (c.bike ? 0.25 : 1);
      target.body.applyImpulse({ x: away.x * push, y: 0, z: away.z * push }, true);
      this.onBump?.(target.position.add(c.v.position).multiplyScalar(0.5), Math.min(1, c.closing / 20));
    }
    c.touching = touching;
    const toTarget = target.position.sub(c.v.position).normalize();
    const cv = c.v.body.linvel();
    const tv = target.body.linvel();
    c.closing = (cv.x - tv.x) * toTarget.x + (cv.z - tv.z) * toTarget.z;
  }

  /**
   * Over the rail it goes: the cruiser for `car` (wrecked first if it isn't) flies off
   * the deck along `out` into the bay. `toRail` is how far the barrier is (m).
   */
  overboard(car: Vehicle, out: THREE.Vector3, toRail: number): boolean {
    const c = this.cops.find((x) => x.v === car);
    if (!c || this.plunges.some((p) => p.v === car)) return false;
    if (!c.wrecked) this.wreck(c, null);
    this.plunges.push(startPlunge(car, out, toRail));
    return true;
  }

  /** Wreck a cruiser; hit by something at `from`, it's knocked away from it. */
  wreck(c: Cop, from: THREE.Vector3 | null): void {
    c.wrecked = true;
    c.v.enabled = false;
    this.wreckedCount++;
    this.onWreck?.(c.v.position, c.v, from !== null);
    const b = c.v.body;
    // A cruiser can roll and cartwheel; a bike just goes down on its side (drawn) and scrapes to a stop, spinning.
    if (!c.bike) b.setEnabledRotations(true, true, true, true);
    else b.setLinearDamping(1.4);
    if (from) {
      const away = c.v.position.sub(from.clone().setY(0)).setY(0).normalize();
      const m = c.v.spec.mass * this.launch;
      b.applyImpulse({ x: away.x * m * 6, y: m * 5, z: away.z * m * 6 }, true);
      // Rolled over sideways about its own length, so it cartwheels.
      const roll = (Math.random() < 0.5 ? -1 : 1) * m * (1.5 + Math.random() * 2);
      const f = c.v.forward;
      b.applyTorqueImpulse({ x: f.x * roll + (Math.random() - 0.5) * m * 6, y: (Math.random() - 0.5) * m * 4, z: f.z * roll + (Math.random() - 0.5) * m * 6 }, true);
    }
    const bar = c.v.model.lightBar;
    if (bar) bar.red.emissiveIntensity = bar.blue.emissiveIntensity = 0;
    c.v.model.paint.color.multiplyScalar(0.55);
    // Off a bike: the rider's thrown clear (up, and away from whatever hit them), the bike goes over.
    if (c.bike && !c.bike.thrown) {
      const v = c.v.body.linvel();
      const away = from ? c.v.position.sub(from.clone().setY(0)).setY(0).normalize() : c.v.forward;
      const push = new THREE.Vector3(v.x * 0.6, 0, v.z * 0.6).addScaledVector(away, from ? 7 : 3).setY(5.5 + Math.random() * 2.5);
      c.bike.thrown = throwRider(this.scene, c.bike.rider, c.bike.seated, push);
      c.bike.lean = (Math.random() < 0.5 ? -1 : 1) * 1.45;
    }
  }

  private spawn(dt: number, target: Vehicle, heat: number, onBridge: boolean): void {
    this.spawnTimer -= dt;
    const active = this.cops.filter((c) => !c.wrecked).length;
    if (this.spawnTimer > 0 || active >= 2 + heat || this.cops.length >= 10) return;
    this.spawnTimer = Math.max(1.2, 4.5 - heat * 0.6);

    // Cops come from behind and the side streets, out of sight, never head-on from a street
    // you're about to drive down. (Head-on surprises read as unfair crashes.)
    const tp = target.position;
    const fwd = target.forward;
    let spot: THREE.Vector3 | undefined;
    if (onBridge) {
      // On the deck, 130 m behind.
      const s = BRIDGE_PATH.project(tp) - 130;
      if (s < 0) return;
      const t = BRIDGE_PATH.tangent(s);
      spot = BRIDGE_PATH.at(s).addScaledVector(new THREE.Vector3(t.z, 0, -t.x), (Math.random() - 0.5) * 16);
    } else {
      const options = this.city.intersections.filter((p) => {
        const d = p.distanceTo(tp);
        if (d < 110 || d > 260 || this.visible(p)) return false;
        return p.clone().sub(tp).normalize().dot(fwd) < 0.2;
      });
      spot = options[Math.floor(Math.random() * options.length)];
    }
    if (!spot) return;
    if (this.cops.some((c) => c.v.position.distanceTo(spot!) < 9)) return;
    const heading = Math.atan2(tp.x - spot.x, tp.z - spot.z);
    // Once the heat's up, now and then a pair of motorbikes instead of a cruiser.
    const bikes = this.cops.filter((c) => c.bike && !c.wrecked).length;
    const forced = this.forceBikes && !this.bikesSeen;
    if (!onBridge && (heat >= BIKE_HEAT || forced) && bikes + 2 <= MAX_BIKES && this.cops.length <= 8 && (forced || Math.random() < 0.35)) {
      // On the road the convoy came by, out of sight behind it, if it's come far enough to have one;
      // in single file, a little staggered: they split to either side as they close.
      const on = this.trailSpot(target);
      // Called up on purpose (?bikes): wait until there's a road behind the convoy for them to come up.
      if (!on && forced) return;
      const at = on?.at ?? spot;
      const h = on?.heading ?? heading;
      const left = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
      const back = new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h));
      for (const side of [1, -1]) this.spawnBike(at.clone().addScaledVector(left, side * 1.2).addScaledVector(back, side > 0 ? 0 : 8), h, side);
      if (!this.bikesSeen) {
        this.bikesSeen = true;
        this.onBikes?.();
      }
      return;
    }
    const v = new Vehicle(this.world, { ...COP_SPEC, topSpeed: COP_SPEC.topSpeed + heat * 3 }, spot, heading);
    this.scene.add(v.model.group);
    this.cops.push({ v, wrecked: false, lastSpeed: 0, stuck: 0, reversing: 0, wreckedFor: 0, closing: 0, touching: false });
  }

  /** A police motorbike at `at`; it rides the convoy's `side` (1: left). */
  private spawnBike(at: THREE.Vector3, heading: number, side: number): void {
    const { model, rider, seated } = buildBikeModel();
    const v = new Vehicle(this.world, BIKE_SPEC, at, heading, model);
    v.collider.setCollisionGroups(BIKE_GROUPS);
    this.scene.add(v.model.group);
    this.cops.push({
      v,
      wrecked: false,
      lastSpeed: 0,
      stuck: 0,
      reversing: 0,
      wreckedFor: 0,
      closing: 0,
      touching: false,
      bike: { rider, seated, side, phase: Math.random() * 6, lean: 0, thrown: null, jumped: -10 },
    });
  }
}
