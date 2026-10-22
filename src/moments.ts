import * as THREE from 'three';
import type { Sound } from './audio';
import { buildCarModel } from './carModel';
import { type City, type Prop, VAULT_START } from './city';
import { ease, type Shot } from './cutscene';
import type { Director } from './director';
import type { Effects } from './fx';
import { NEWS } from './broadcast';
import { BEACONS } from './groundfx';
import type { Hud } from './hud';
import type { Obstacle, PartnerDriver } from './partner';
import { RAPIER } from './physics';
import type { Police } from './police';
import type { Reyes } from './reyes';
import { leftOf, Path, roadHalfWidth } from './roads';
import { BANK, BRIDGE, onBridge, SPIKES } from './roadmap';
import { type Cable, CABLE_TOW_LENGTH, CableLine, type Vault } from './vault';
import type { Vehicle } from './vehicle';
import type { Voice } from './voice';

/** Everything a set piece needs from the game. */
export interface MomentContext {
  world: RAPIER.World;
  scene: THREE.Scene;
  city: City;
  fx: Effects;
  sound: Sound;
  hud: Hud;
  voice: Voice;
  director: Director;
  police: Police;
  /** Reyes's SUVs (the bridge finale brings them on). */
  reyes: Reyes;
  player: Vehicle;
  partner: Vehicle;
  partnerDriver: PartnerDriver;
  vault: Vault;
  cables: Cable[];
  /** Who's driving and who's alongside (for their lines), and the side the player's car runs on (+1 left). */
  crew: { player: string; partner: string; side: number };
  /** The GPS route: intersections still to drive through, next first. */
  route(): THREE.Vector3[];
  /** Award style points and nitrous (0..1). */
  reward(style: number, nos: number): void;
  addDamage(amount: number): void;
  /** Play shots as an in-engine cutscene mid-chase; `finish` leaves the world in the scene's end state (on a skip too). */
  cutscene(shots: Shot[], finish: () => void): void;
  /** Line the crew up side by side at `center`, facing `f`, with the vault at `vaultAt`. */
  placeConvoy(center: THREE.Vector3, f: THREE.Vector3, vaultAt: THREE.Vector3): void;
  /** Cables from both cars onto the vault; every cable off. */
  hook(): void;
  unhook(): void;
  /** Keep the police off the road (every cruiser gone, none coming) until let go. */
  holdPolice(hold: boolean): void;
  /** Take cops and traffic off the road where `where` says (everywhere if it's left out). */
  clearStreets(where?: (p: THREE.Vector3) => boolean): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.voice.speak(who, line, { channel: 'radio', onStart: () => ctx.hud.radio(who, line) });
}

// ---------------------------------------------------------------- The Pull

/**
 * Ripping the vault out. It stays pinned in its room until the player has held
 * the throttle long enough to fill the STRAIN meter: rear tires spin and smoke,
 * the wall cracks and dust falls, the camera shakes harder. Then it lets go in
 * slow motion, seen from the street, and the convoy lurches forward.
 */
export class ThePull {
  strain = 0;
  done = false;
  private active = false;
  private creak = 0;

  constructor(private ctx: MomentContext) {}

  start(): void {
    this.active = true;
    this.ctx.vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  }

  update(dt: number): void {
    if (!this.active || this.done) return;
    const { player, partner, fx, hud, director, sound } = this.ctx;
    const t = player.controls.throttle;
    this.strain = THREE.MathUtils.clamp(this.strain + (t > 0 ? dt * 0.3 * t : -dt * 0.35), 0, 1);

    director.shake = Math.max(director.shake, this.strain * 0.7);
    for (const car of [player, partner]) {
      if (car.wheelspin > 0.2) for (const w of car.rearWheels()) fx.tireSmoke(w, car.wheelspin, car.forward.multiplyScalar(-3));
    }
    // The wall gives a little: dust and grit, and the steel groans.
    if (Math.random() < dt * this.strain * 8) fx.puff(v3(183.5, Math.random() * 3, 147 + Math.random() * 6), 2);
    this.creak -= dt;
    if (this.strain > 0.25 && this.creak <= 0) {
      this.creak = 0.5 + Math.random() * 0.6;
      sound.clank();
    }
    hud.meter('STRAIN', this.strain, this.strain < 0.05 ? 'HOLD W TO PULL' : this.strain < 0.7 ? 'KEEP PULLING!' : 'ALMOST…');
    if (this.strain >= 1) this.breakFree();
  }

  private breakFree(): void {
    const { vault, player, partner, director, sound, fx, hud } = this.ctx;
    this.done = true;
    vault.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const mid = player.position.add(partner.position).multiplyScalar(0.5);
    const dir = mid.sub(vault.position.setY(0)).setY(0).normalize();
    const m = vault.body.mass();
    vault.body.applyImpulse({ x: dir.x * m * 7, y: m * 0.6, z: dir.z * m * 7 }, true);
    director.slowmo(0.28, 1.7);
    director.shake = 1.4;
    director.play({
      duration: 1.7,
      // Low on the sidewalk beside the hole, looking into it as the vault bursts out.
      frame: (k) => ({
        pos: v3(192, 0.9, 144.2).lerp(v3(191, 1.3, 145.5), k),
        look: vault.position.clone().setY(1.2).lerp(v3(VAULT_START.x + 7, 1.2, 150), 0.4),
        fov: 52,
      }),
    });
    sound.crash(1.3);
    fx.burst(v3(184, 1.5, 150), 1.6);
    fx.puff(v3(184, 0.5, 150), 14);
    hud.meter(null);
    hud.banner('THE PULL', 'THE VAULT IS FREE  +500');
    this.ctx.reward(500, 0.3);
    say(this.ctx, 'DOM', 'Go, go, go!');
  }
}

// ---------------------------------------------------------------- Spike strip

/**
 * Cops lay a spike strip across Mia's route down Ponce de León, leaving a gap
 * on one side. Mia calls the side; the approach drops into slow motion so the
 * player can pick the gap. Spikes blow tires (less grip and speed, rim sparks).
 * Laid out in the strip's frame: x across the street (left positive), z along it.
 */
export class SpikeStrip {
  private state: 'idle' | 'armed' | 'done' = 'idle';
  /** Both cars went through the gap. */
  clean = false;
  /** The player's car ran over the spikes. */
  playerBlown = false;
  /** +1: the gap is on the left. */
  private gapSide = Math.random() < 0.5 ? 1 : -1;
  private group = new THREE.Group();
  private hit = new Set<Vehicle>();
  private slowed = false;
  private x0 = 0;
  private x1 = 0;
  private half = roadHalfWidth(SPIKES.origin);
  private bars: { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial }[] = [];
  private time = 0;

  constructor(private ctx: MomentContext) {}

  /** Lateral offset (left of the street's center) of the open gap while the strip is down (for the test autopilot), else null. */
  gapOffset(): number | null {
    if (this.state !== 'armed') return null;
    return this.gapSide > 0 ? (this.x1 + this.half) / 2 : (-this.half + this.x0) / 2;
  }

  /** Points the partner AI must treat as solid. */
  obstacles(): Obstacle[] {
    if (this.state !== 'armed') return [];
    const list: Obstacle[] = [];
    for (let x = this.x0 + 0.6; x <= this.x1; x += 1.4) list.push({ pos: SPIKES.toWorld(x, 0), radius: 0.9 });
    return list;
  }

  update(dt: number): void {
    const { player, partner, hud, director } = this.ctx;
    this.time += dt;
    const flash = Math.floor(this.time * 6) % 2 === 0;
    for (const b of this.bars) {
      b.red.emissiveIntensity = flash ? 4 : 0.2;
      b.blue.emissiveIntensity = flash ? 0.2 : 4;
    }
    const p = SPIKES.toLocal(player.position);
    const onApproach = Math.abs(p.x) < this.half + 2 && p.z > -140 && p.z < -25 && player.forward.dot(SPIKES.z) > 0.6;
    if (this.state === 'idle' && onApproach) this.arm();
    if (this.state !== 'armed') return;

    const side = this.gapSide > 0 ? 'LEFT' : 'RIGHT';
    hud.hint(p.z < 0 ? `SPIKE STRIP AHEAD — GAP ON THE ${side}` : '');
    if (!this.slowed && p.z > -32 && p.z < 0) {
      this.slowed = true;
      director.slowmo(0.35, 1.4);
    }
    for (const car of [player, partner]) {
      if (this.hit.has(car)) continue;
      if (car.wheels().some((w) => {
        const l = SPIKES.toLocal(w);
        return Math.abs(l.z) < 0.5 && l.x > this.x0 && l.x < this.x1;
      })) this.blow(car);
    }
    if (p.z > 10 || player.position.distanceTo(SPIKES.origin) > 200) this.resolve();
  }

  private arm(): void {
    const { scene, city, sound } = this.ctx;
    this.state = 'armed';
    // Strip covers the street except an 8.5 m gap on the open side.
    const half = this.half;
    if (this.gapSide > 0) {
      this.x0 = -half + 0.5;
      this.x1 = half - 8.5;
    } else {
      this.x0 = -half + 8.5;
      this.x1 = half - 0.5;
    }
    const len = this.x1 - this.x0;
    // Built in the strip's frame: local x across, z along.
    const g = this.group;
    g.position.copy(SPIKES.origin);
    g.rotation.y = SPIKES.heading;
    const base = new THREE.Mesh(new THREE.BoxGeometry(len, 0.06, 0.55), new THREE.MeshStandardMaterial({ map: hazardTexture(len), roughness: 0.6 }));
    base.position.set((this.x0 + this.x1) / 2, 0.09, 0);
    const spikeGeo = new THREE.ConeGeometry(0.05, 0.16, 5);
    const steel = new THREE.MeshStandardMaterial({ color: 0xc0c4c8, metalness: 0.9, roughness: 0.25 });
    const count = Math.floor(len / 0.18) * 2;
    const spikes = new THREE.InstancedMesh(spikeGeo, steel, count);
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const x = this.x0 + 0.1 + (i >> 1) * 0.18;
      m.makeTranslation(x, 0.19, (i & 1) ? 0.12 : -0.12);
      spikes.setMatrixAt(i, m);
    }
    // Yellow and black hazard ends.
    const hazard = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 });
    for (const x of [this.x0, this.x1]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.7), hazard);
      cap.position.set(x, 0.11, 0);
      g.add(cap);
    }
    g.add(base, spikes);
    // Cones along the blocked part and red road flares at both ends, so it reads from far away.
    const cone = new THREE.MeshStandardMaterial({ color: 0xff5a1a, roughness: 0.6 });
    const flare = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2010, emissiveIntensity: 6 });
    for (let x = this.x0 + 1; x < this.x1; x += 3) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.75, 10), cone);
      c.position.set(x, 0.43, -2.5);
      g.add(c);
    }
    for (const x of [this.x0 - 0.3, this.x1 + 0.3]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), flare);
      f.position.set(x, 0.25, -0.6);
      g.add(f);
    }
    scene.add(g);

    // Two cruisers parked on the blocked side, lights going.
    const blockedX = this.gapSide > 0 ? -half + 3 : half - 3;
    for (const [dz, h] of [[7, 0.5], [16, -0.4]]) {
      const model = buildCarModel({ body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true });
      const holder = new THREE.Group();
      if (model.lightBar) {
        this.bars.push(model.lightBar);
        BEACONS.push({ at: holder, bar: model.lightBar });
      }
      model.group.position.y = -0.7;
      holder.add(model.group);
      city.addProp(holder, SPIKES.toWorld(blockedX, dz, 0.7), RAPIER.ColliderDesc.cuboid(1.0, 0.55, 2.5).setMass(1700).setFriction(0.8), 25000, SPIKES.heading + h);
    }
    sound.ping(1400, 0.12, 0.3);
    say(this.ctx, 'MIA', `Spike strip ahead! Gap's on the ${this.gapSide > 0 ? 'left' : 'right'}!`);
  }

  private blow(car: Vehicle): void {
    const { sound, fx, hud, player } = this.ctx;
    this.hit.add(car);
    car.tireBlown = 9;
    sound.bang();
    for (const w of car.wheels()) if (Math.abs(SPIKES.toLocal(w).z) < 1.2) fx.burst(w.setY(0.3), 0.4);
    if (car === player) {
      this.playerBlown = true;
      hud.banner('TIRE BLOWN', 'SPEED AND GRIP DOWN', 1.6);
      say(this.ctx, 'MIA', 'You lost a tire! Hold it together!');
      setTimeout(() => hud.news(NEWS.tireBlown), 1800);
    }
  }

  private resolve(): void {
    const { hud } = this.ctx;
    this.state = 'done';
    hud.hint('');
    if (this.hit.size === 0) {
      this.clean = true;
      hud.banner('SPIKES DODGED', 'CLEAN THROUGH THE GAP  +400');
      setTimeout(() => hud.news(NEWS.spikesDodged), 1500);
      this.ctx.reward(400, 0.35);
      this.ctx.sound.ping(1800, 0.15, 0.4);
    } else if (!this.hit.has(this.ctx.player)) {
      hud.banner('PARTNER CLIPPED THE SPIKES', '', 1.6);
    }
    // Leave the strip where it lies (it's behind us now); it no longer counts.
  }
}

// ---------------------------------------------------------------- Bank job

/**
 * How long the thrown vault is left to fly into the lobby (s): it's steered onto it,
 * the cables free-spool, and nothing pulls it back toward the road until it's there.
 */
const FLING_TIME = 3;

/**
 * Mia's route turns onto the expressway past a glass-fronted bank. She tells
 * the player to swing the vault through it; a handbrake flick near the corner
 * throws the vault wide (with a helping shove so it reliably connects). When the
 * vault enters the lobby: slow motion, interior camera, glass, banknotes, alarm,
 * big damage. Worked out in the bank's frame: x across (away from the avenue),
 * z along the approach; the lobby spans x 0..w, z 0..d.
 */
export class BankJob {
  private state: 'idle' | 'hinted' | 'done' = 'idle';
  /** The vault went through the lobby. */
  smashed = false;
  private swungAt = -10;
  private time = 0;
  private shatterCooldown = 0;
  /** The corner in the bank's frame. */
  private corner = BANK.frame.toLocal(BANK.corner);

  constructor(private ctx: MomentContext) {}

  /** Where the fling aims: just inside the lobby's corner. */
  private target(): THREE.Vector3 {
    return BANK.frame.toWorld(6, 6);
  }

  /**
   * Per physics step: for a moment after the swing, steer the flying vault onto the
   * lobby (set-piece magnetism, as arcade racers do for takedowns), so its spin and
   * the cables can't drag it off line.
   */
  step(dt: number): void {
    if (this.state !== 'hinted' || this.time - this.swungAt > FLING_TIME - 0.4) return;
    const { vault } = this.ctx;
    const vv = vault.body.linvel();
    const to = this.target().sub(vault.position.setY(0));
    const want = to.normalize().multiplyScalar(Math.max(Math.hypot(vv.x, vv.z), 16));
    const k = Math.min(1, dt * 8);
    vault.body.setLinvel({ x: vv.x + (want.x - vv.x) * k, y: vv.y, z: vv.z + (want.z - vv.z) * k }, true);
    const w = vault.body.angvel();
    vault.body.setAngvel({ x: w.x, y: w.y * (1 - k), z: w.z }, true);
  }

  /** The vault is in flight toward the lobby (leave it be: no steering back to the road, no yanking it back). */
  get flinging(): boolean {
    return this.state === 'hinted' && this.time - this.swungAt < FLING_TIME;
  }

  /** Not pulled off yet (the bank shows on the minimap until then). */
  get pending(): boolean {
    return this.state !== 'done';
  }

  /** Coming down the avenue toward the corner, with the GPS turning there toward the bank's side. */
  private approaching(): boolean {
    const { player } = this.ctx;
    const p = BANK.frame.toLocal(player.position);
    if (Math.abs(p.x - this.corner.x) > 14 || p.z > this.corner.z || player.forward.dot(BANK.frame.z) < 0.5) return false;
    const route = this.ctx.route();
    const k = route.findIndex((n) => n.distanceTo(BANK.corner) < 5);
    return k >= 0 && !!route[k + 1] && BANK.frame.toLocal(route[k + 1]).x > this.corner.x + 50;
  }

  update(dt: number): void {
    const { player, vault, city, fx, sound, hud } = this.ctx;
    this.time += dt;
    this.shatterCooldown -= dt;

    // Glass shatters as soon as anything knocks a pane.
    for (const pane of [...city.bankGlass]) {
      if (pane.body.isSleeping()) continue;
      const v = pane.body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z < 1.2) continue;
      const t = pane.body.translation();
      fx.shatter(v3(t.x, 0.3, t.z), v3(v.x, 0, v.z), 45);
      if (this.shatterCooldown <= 0) {
        sound.shatter();
        this.shatterCooldown = 0.12;
      }
      city.removeProp(pane);
      city.bankGlass.splice(city.bankGlass.indexOf(pane), 1);
    }

    if (this.state === 'done') return;
    const p = player.position;
    const local = BANK.frame.toLocal(p);
    const toCorner = p.distanceTo(BANK.corner);
    // Wait until the spike strip is behind us so the two callouts don't overlap.
    if (this.state === 'idle' && SPIKES.toLocal(p).z > 12 && toCorner < 110 && this.approaching()) {
      this.state = 'hinted';
      say(this.ctx, 'MIA', 'There’s a bank on the corner where we turn. Swing that vault right through it!');
    }
    if (this.state !== 'hinted') return;

    hud.hint(toCorner < 110 && local.x < 24 ? 'HANDBRAKE (SPACE) THROUGH THE TURN TO SWING THE VAULT' : '');

    // The swing: handbrake near the corner throws the vault wide toward the lobby.
    const vp = vault.position;
    const vv = vault.body.linvel();
    const vSpeed = Math.hypot(vv.x, vv.z);
    // Generous window: any handbrake while the convoy is working through the corner.
    const inCorner = toCorner < 45 && vp.distanceTo(BANK.corner) < 40 && BANK.frame.toLocal(vp).x < 4;
    if (player.controls.handbrake && this.time - this.swungAt > 1.5 && inCorner && vSpeed > 4) {
      this.swungAt = this.time;
      // Fling it at the lobby with a little hop, fast enough to slide all the way in from
      // wherever the swing started (friction takes about 4.5 m/s² off it on the ground).
      const target = this.target();
      const toLobby = target.clone().sub(vp.clone().setY(0));
      const dist = toLobby.length();
      const dir = toLobby.normalize();
      const speed = THREE.MathUtils.clamp(Math.sqrt(2 * 5 * dist) + 3, 14, 29);
      vault.body.setLinvel({ x: dir.x * speed, y: 4, z: dir.z * speed }, true);
      // The winches pay out enough cable for it to get there, free-spooling until it has; they reel back in afterwards.
      for (const c of this.ctx.cables) c.payOut(THREE.MathUtils.clamp(c.car.towPoint().distanceTo(target) + 8, 22, 40), FLING_TIME);
      vault.ghostHeroes(true);
      this.ctx.fx.burst(vp.clone().setY(0.3), 0.8);
      this.ctx.sound.clank();
      this.ctx.director.shake = Math.max(this.ctx.director.shake, 0.6);
    }

    if (this.time - this.swungAt > 1.4) vault.ghostHeroes(false);

    const lv = BANK.frame.toLocal(vp);
    const inside = lv.x > 0.3 && lv.x < BANK.w && lv.z > 0.3 && lv.z < BANK.d;
    if (inside && vSpeed > 3) this.smash();
    else if (local.x > this.corner.x + 130 || local.z > this.corner.z + 120) {
      this.state = 'done';
      vault.ghostHeroes(false);
      hud.hint('');
      hud.banner('MISSED THE BANK', '', 1.4);
    }
  }

  private smash(): void {
    const { vault, director, fx, sound, hud } = this.ctx;
    this.state = 'done';
    this.smashed = true;
    vault.ghostHeroes(false);
    hud.hint('');
    const vp = vault.position;
    const vv = vault.body.linvel();
    director.slowmo(0.25, 2.0);
    director.shake = 1.2;
    // Inside the lobby, a few meters ahead of the vault and off to one side: it comes straight at us.
    const heading = v3(vv.x, 0, vv.z).normalize();
    const side = v3(heading.z, 0, -heading.x);
    const guess = BANK.frame.toLocal(vp.clone().addScaledVector(heading, 11).addScaledVector(side, 4));
    const cam = BANK.frame.toWorld(THREE.MathUtils.clamp(guess.x, 2, BANK.w - 2), THREE.MathUtils.clamp(guess.z, 2, BANK.d - 2), 1.8);
    director.play({
      duration: 2.0,
      frame: (k) => ({ pos: cam.clone().add(v3(0, k * 0.6, 0)), look: vault.position.setY(1.2), fov: 58 }),
    });
    fx.shatter(vp, v3(vv.x, 0, vv.z), 160);
    fx.money(vp, 260);
    fx.puff(vp.clone().setY(0), 12);
    sound.crash(1.4);
    sound.shatter();
    sound.alarm(7);
    this.ctx.addDamage(2_500_000);
    this.ctx.reward(1000, 0.4);
    hud.banner('BANK JOB', '+$2,500,000 DAMAGE  +1,000');
    setTimeout(() => say(this.ctx, 'BRIAN', 'Did we just drive a vault through a bank?'), 1600);
    setTimeout(() => hud.news(NEWS.bank), 2600);
  }
}

// ---------------------------------------------------------------- Roadblocks

/**
 * A police roadblock: cruisers parked across the road, nose to tail and lights
 * going. Ram it or swing the vault into it; when the line breaks, `onBust` gets
 * the point of impact (the game makes the slow-motion moment of it).
 */
export class Roadblock {
  state: 'idle' | 'set' | 'busted' = 'idle';
  /** Its middle, and the way the convoy meets it. */
  readonly at = new THREE.Vector3();
  readonly dir = new THREE.Vector3();
  private cars: Prop[] = [];
  private bars: { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial }[] = [];
  private time = 0;
  /** The fastest-moving cruiser in it this frame (m/s), for play-tests. */
  fastest = 0;

  constructor(
    private ctx: MomentContext,
    private onBust: (at: THREE.Vector3, cars: Prop[]) => void,
  ) {}

  /**
   * Park `count` cruisers across a road `width` m wide at `at`, facing the convoy coming
   * along `dir`; with `rows` 2, a second line 9 m further on, staggered into the gaps.
   */
  set(at: THREE.Vector3, dir: THREE.Vector3, width: number, count: number, rows = 1): void {
    const { city } = this.ctx;
    this.state = 'set';
    this.at.copy(at).setY(0);
    this.dir.copy(dir).setY(0).normalize();
    const across = leftOf(this.dir);
    const broadside = Math.atan2(this.dir.x, this.dir.z) + Math.PI / 2;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < count; i++) {
        const x = ((i + 0.5 + (r % 2) * 0.5) / count - 0.5) * width;
        if (Math.abs(x) > width / 2 - 1) continue;
        // A shallow V, the middle furthest back, so it reads as a barricade from behind the convoy.
        const pos = this.at.clone().addScaledVector(across, x).addScaledVector(this.dir, -Math.abs(x) * 0.18 + r * 9).setY(0.7);
        const model = buildCarModel({ body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true, asset: 'police' });
        const holder = new THREE.Group();
        model.group.position.y = -0.7;
        holder.add(model.group);
        if (model.lightBar) {
          this.bars.push(model.lightBar);
          BEACONS.push({ at: holder, bar: model.lightBar });
        }
        const heading = broadside + ((i + r) % 2 ? 0.25 : -0.2);
        this.cars.push(city.addProp(holder, pos, RAPIER.ColliderDesc.cuboid(1.0, 0.55, 2.5).setMass(1500).setFriction(0.7), 25000, heading));
      }
    }
  }

  update(dt: number): void {
    if (this.state !== 'set') return;
    this.time += dt;
    const flash = Math.floor(this.time * 6) % 2 === 0;
    for (const b of this.bars) {
      b.red.emissiveIntensity = flash ? 4 : 0.2;
      b.blue.emissiveIntensity = flash ? 0.2 : 4;
    }
    // Broken: a cruiser in the line knocked loose.
    this.fastest = 0;
    for (const c of this.cars) {
      if (c.body.isSleeping()) continue;
      const v = c.body.linvel();
      this.fastest = Math.max(this.fastest, Math.hypot(v.x, v.y, v.z));
      if (v.x * v.x + v.y * v.y + v.z * v.z < 25) continue;
      this.state = 'busted';
      for (const b of this.bars) b.red.emissiveIntensity = b.blue.emissiveIntensity = 0.2;
      const t = c.body.translation();
      this.onBust(new THREE.Vector3(t.x, 0, t.z), this.cars);
      return;
    }
  }

  /** How far the player is short of it along the convoy's way (negative once past). */
  ahead(p: THREE.Vector3): number {
    return this.at.clone().sub(p).dot(this.dir);
  }

  /** Where its cruisers stand (the finale starts them up and sends them at you), taking the parked ones away. */
  release(): THREE.Vector3[] {
    const at = this.cars.map((c) => {
      const t = c.body.translation();
      return new THREE.Vector3(t.x, 0, t.z);
    });
    this.clear();
    return at;
  }

  /** Take it down unbroken (the convoy went another way): its cruisers and their light go. */
  clear(): void {
    for (const c of this.cars) this.ctx.city.removeProp(c);
    for (let i = BEACONS.length - 1; i >= 0; i--) if (this.bars.includes(BEACONS[i].bar)) BEACONS.splice(i, 1);
    this.cars = [];
    this.bars = [];
    this.state = 'idle';
  }
}

// ---------------------------------------------------------------- The bridge

/**
 * How far along the bridge the crew splits up (m): well out, so that the fight, which
 * heads back toward the city (into the cops coming up behind), has the deck for it.
 */
export const SPLIT_AT = Math.max(300, BRIDGE.goalAlong - 850);
/** Car centres to the vault's centre, half the gap between the cars, and the vault's ride height. */
const TOW = CABLE_TOW_LENGTH + 2.5;
const BESIDE = 2.75;
const VAULT_Y = 1.27;
/** The pack pulls up in a line this far from the player's car once it's turned to face them (m). */
const PACK_GAP = 110;

/** One of the cruisers coming up the bridge behind the crew, driven by the split scene. */
interface PackCar {
  v: Vehicle;
  /** Across the bridge (m), where along it it pulls up, and when (s into the scene). */
  x: number;
  stopS: number;
  stopT: number;
}

/**
 * The finale, as the film has it. Partway across the bridge every cop in the city is
 * on the crew's tail, too many to drag ten tons through. The player's character makes
 * the call: a remote release pops the latch on the partner's cable in a spray of
 * sparks, and the partner, cut free, goes on across the bridge alone (furious; the
 * cops don't follow). The player brakes, throws the car round through 180 degrees
 * past the stopped vault, and faces the pack, which pulls up in a line across the
 * deck. Then the solo pull: one car, ten tons, from a standstill, on nitrous. The
 * line starts its engines and comes head-on, Reyes's SUVs come through it with
 * gunmen in the sunroofs, and the vault becomes a flail: SPACE throws it at whatever's
 * nearest, and a cruiser hit near the rail goes over into the bay. Swing it into
 * Reyes's SUV and the last scene takes over.
 */
export class BridgeFinale {
  state: 'idle' | 'split' | 'pull' | 'charge' | 'last' | 'done' = 'idle';
  /** The solo pull: how close the vault is to rolling (0..1). */
  strain = 0;
  /** Seconds since the nitrous was first armed for the pull (the switches on the dash), or -1. */
  private armed = -1;
  private path = new Path(BRIDGE.pts);
  private pullTime = 0;
  private creak = 0;
  /** Where the player's car stopped after the turn (along the bridge), and the convoy's line across it. */
  private stopAt = 0;
  private lane = 0;
  private pack: PackCar[] = [];
  /** After the pull: seconds of the charge. */
  private chargeTime = 0;
  private reyesCalled = false;
  /** The flail: the handbrake last frame, the cooldown, and the swing being steered home. */
  private handbrakeWas = false;
  private flailCool = 0;
  private flailFor = 0;
  private flailTarget: Vehicle | null = null;
  /** The partner's cable after the latch pops: whipping off the vault, dragged and reeled in. */
  private loose: CableLine | null = null;
  /** Cruisers sent over the rail. */
  overboards = 0;
  /** The last scene: what it does once it's over (the game's ending). */
  onLast?: (at: THREE.Vector3, forced: boolean) => void;

  constructor(
    private ctx: MomentContext,
    /** Unhook the partner's cable (the player tows alone from then on). */
    private cutLoose: () => void,
  ) {}

  /** The player is pulling the vault off the mark on their own (nitrous needed). */
  get pulling(): boolean {
    return this.state === 'pull';
  }

  /** The vault is flying at something on a flail swing (leave it be). */
  get flinging(): boolean {
    return this.flailFor > 0;
  }

  /** The head-on fight on the bridge (no getting busted in it). */
  get fighting(): boolean {
    return this.state === 'charge' || this.state === 'last';
  }

  update(dt: number): void {
    const { player, director } = this.ctx;
    const p = player.position;
    if (this.state === 'idle') {
      if (onBridge(p) && this.path.project(p) > SPLIT_AT && !director.busy) this.split();
      return;
    }
    if (this.state === 'pull') this.strainPull(dt);
    if (this.state === 'charge') this.charge(dt);
  }

  /** After the pull: the line comes at them head-on, Reyes comes through it, and the vault's a flail. */
  private charge(dt: number): void {
    const { ctx } = this;
    const { player, reyes, hud } = ctx;
    this.chargeTime += dt;
    if (!this.reyesCalled && this.chargeTime > 3.5) {
      this.reyesCalled = true;
      reyes.arrive(this.path, player, 170);
      say(ctx, 'MIA', 'Reyes is on the bridge! Two black SUVs coming through the cops, and they’re armed!');
    }
    // The nose comes up as it launches, and down again.
    player.wheelie = this.chargeTime < 1.2 ? 0.2 * Math.sin((Math.PI * this.chargeTime) / 1.2) : 0;
    this.flail(dt);
    // Nearly back at the city end with Reyes still on the road: he swerves into the vault himself.
    const boss = reyes.boss;
    if (boss && !reyes.bossHit && this.path.project(player.position) < 260 && boss.v.position.distanceTo(player.position) < 30) {
      reyes.bossHit = true;
      this.lastSwing(boss.v.position, true);
      return;
    }
    hud.hint(reyes.boss ? 'SWING THE VAULT INTO REYES’S SUV  —  SPACE' : 'HERE THEY COME  —  SPACE SWINGS THE VAULT INTO THEM');
  }

  /**
   * The flail: SPACE throws the vault at whatever's nearest it (Reyes's SUV first),
   * paying out cable, and steers it home for a moment (set-piece magnetism, as with
   * the bank) so the swing lands.
   */
  private flail(dt: number): void {
    const { player, vault, cables, police, reyes, fx, sound, director } = this.ctx;
    this.flailCool -= dt;
    this.flailFor -= dt;
    const pressed = player.controls.handbrake && !this.handbrakeWas;
    this.handbrakeWas = player.controls.handbrake;
    if (this.flailFor <= 0 && this.flailTarget) {
      this.flailTarget = null;
      vault.ghostHeroes(false);
    }
    if (!pressed || this.flailCool > 0) return;
    const vp = vault.position.setY(0);
    const options: { v: Vehicle; score: number }[] = [];
    for (const c of police.cops) if (!c.wrecked) options.push({ v: c.v, score: c.v.position.distanceTo(vp) });
    for (const s of reyes.suvs) if (!s.wrecked && !s.plunge && s.reeling <= 0) options.push({ v: s.v, score: s.v.position.distanceTo(vp) * (s.boss ? 0.8 : 0.9) });
    options.sort((a, b) => a.score - b.score);
    const target = options[0]?.score < 20 ? options[0].v : null;
    if (!target) return;
    const tv = target.body.linvel();
    const aim = target.position.add(new THREE.Vector3(tv.x, 0, tv.z).multiplyScalar(0.3));
    const to = aim.clone().sub(vp);
    const dir = to.clone().normalize();
    const speed = THREE.MathUtils.clamp(Math.sqrt(2 * 5 * to.length()) + 4, 14, 27);
    vault.body.setLinvel({ x: dir.x * speed, y: 3, z: dir.z * speed }, true);
    for (const c of cables) c.payOut(THREE.MathUtils.clamp(c.car.towPoint().distanceTo(aim) + 6, 14, 34), 1.2);
    vault.ghostHeroes(true);
    this.flailTarget = target;
    this.flailFor = 0.55;
    this.flailCool = 1.1;
    fx.burst(vp.clone().setY(0.4), 0.6);
    sound.clank();
    director.shake = Math.max(director.shake, 0.5);
  }

  /** Per physics step: a flail swing steered on to its target. */
  step(dt: number): void {
    const t = this.flailTarget;
    if (!t || this.flailFor <= 0) return;
    const { vault } = this.ctx;
    const vv = vault.body.linvel();
    const to = t.position.sub(vault.position.setY(0));
    if (to.length() < 1) return;
    const want = to.normalize().multiplyScalar(Math.max(Math.hypot(vv.x, vv.z), 14));
    const k = Math.min(1, dt * 7);
    vault.body.setLinvel({ x: vv.x + (want.x - vv.x) * k, y: vv.y, z: vv.z + (want.z - vv.z) * k }, true);
  }

  /** Where `p` is against the bridge's rails: the way out over the nearer one, and how far it is (m); null off the deck. */
  railOf(p: THREE.Vector3): { out: THREE.Vector3; toRail: number } | null {
    if (!onBridge(p)) return null;
    const s = this.path.project(p);
    const t = this.path.tangent(s);
    const left = leftOf(t);
    const x = p.clone().sub(this.path.at(s)).dot(left);
    return { out: left.multiplyScalar(Math.sign(x) || 1), toRail: Math.max(0, BRIDGE.hw + 0.8 - Math.abs(x)) };
  }

  /** A cruiser wrecked by the vault in the fight: near the rail, over it goes, into the bay. */
  wrecked(car: Vehicle, byVault: boolean): void {
    if (this.state !== 'charge' || !byVault) return;
    const r = this.railOf(car.position);
    if (!r || r.toRail > 7.5) return;
    if (!this.ctx.police.overboard(car, r.out, r.toRail)) return;
    if (++this.overboards === 1) this.bayShot(car, r.out);
  }

  /** The first one over the rail, in slow motion: from the deck, watching it go. */
  private bayShot(car: Vehicle, out: THREE.Vector3): void {
    const { director } = this.ctx;
    const at = car.position;
    const t = this.path.tangent(this.path.project(at));
    const from = at.clone().addScaledVector(t, -10).addScaledVector(out, -4).setY(2.4);
    director.slowmo(0.35, 2.4);
    director.play({ duration: 2.4, frame: (k) => ({ pos: from.clone().addScaledVector(t, k * 2), look: at.clone().addScaledVector(out, 3 + k * 6).setY(1 - k * 3.5), fov: 48 }) });
  }

  /** A car hit the water. */
  splash(at: THREE.Vector3): void {
    const { fx, sound, hud } = this.ctx;
    fx.splash(at, 1.2);
    sound.splash();
    this.ctx.reward(500, 0.2);
    hud.banner('INTO THE BAY', this.overboards > 1 ? `x${this.overboards}  +500` : '+500', 1.8);
    if (this.overboards <= 1) setTimeout(() => hud.news(NEWS.bay), 1200);
  }

  /** The vault slammed into Reyes's SUV (or he swerved into it, `forced`): the last scene. */
  lastSwing(at: THREE.Vector3, forced: boolean): void {
    if (this.state !== 'charge') return;
    this.state = 'last';
    this.ctx.hud.hint('');
    this.onLast?.(at, forced);
  }

  private split(): void {
    const { ctx } = this;
    this.state = 'split';
    ctx.hud.hint('');
    ctx.holdPolice(true);
    ctx.cutscene(this.splitShots(), () => this.afterSplit());
  }

  /**
   * Debug start (?at=fight): straight to the fight, as if the split and the pull had
   * happened here: the partner gone, the player's car turned to face the city, the
   * vault just rolling free.
   */
  debugCharge(): void {
    const { ctx } = this;
    this.cutLoose();
    const s = this.path.project(ctx.player.position);
    const back = this.path.tangent(s).negate();
    ctx.placeConvoy(this.at(s, ctx.crew.side * BESIDE), back, this.at(s + TOW, 0));
    this.drive(ctx.partner, Math.min(this.path.length - 60, s + 160), -ctx.crew.side * 5, this.heading(s), 28);
    ctx.partnerDriver.leave(this.path, 1);
    for (const c of ctx.cables) c.clutch = false;
    this.state = 'pull';
    this.rollFree();
  }

  /** Debug start (?at=finale): Reyes's SUVs right there, and the last swing landing on his a moment later. */
  debugLast(): void {
    const { reyes, player, vault } = this.ctx;
    this.reyesCalled = true;
    reyes.arrive(this.path, player, 16);
    setTimeout(() => {
      const boss = reyes.suvs.find((s) => s.boss);
      if (!boss) return;
      // Alongside the vault, toward the middle of the deck, where a swing finds it.
      const s = this.path.project(vault.position);
      const x = vault.position.sub(this.path.at(s)).dot(leftOf(this.path.tangent(s)));
      const at = this.at(s, x + (x > 0 ? -4.5 : 4.5));
      boss.v.place(at, this.heading(s) + Math.PI);
      this.lastSwing(at, false);
    }, 1200);
  }

  /** A point on the bridge `s` m along it and `x` m left of its middle. */
  private at(s: number, x: number, y = 0): THREE.Vector3 {
    return this.path.at(s).addScaledVector(leftOf(this.path.tangent(s)), x).setY(y);
  }

  /** The heading along the bridge, away from the city. */
  private heading(s: number): number {
    const t = this.path.tangent(s);
    return Math.atan2(t.x, t.z);
  }

  /** Put a car on the bridge, moving along it at `speed` (negative: back toward the city). */
  private drive(car: Vehicle, s: number, x: number, heading: number, speed: number): void {
    const t = this.path.tangent(s);
    car.place(this.at(s, x), heading);
    car.body.setLinvel({ x: t.x * speed, y: 0, z: t.z * speed }, true);
    car.forwardSpeed = Math.abs(speed);
  }

  private splitShots(): Shot[] {
    const { player, partner, vault, crew, fx, sound, police } = this.ctx;
    const side = crew.side;
    // The convoy's line: its middle, along the bridge and across it (room either side for the turn).
    const centre = player.position.addScaledVector(leftOf(player.forward), -side * BESIDE);
    const s0 = this.path.project(centre);
    const x0 = centre.clone().sub(this.path.at(s0)).dot(leftOf(this.path.tangent(s0)));
    const lane = (this.lane = THREE.MathUtils.clamp(x0, -(BRIDGE.hw - 7), BRIDGE.hw - 7));
    const v = THREE.MathUtils.clamp(player.forwardSpeed, 16, 28);
    /** The latch pops; the braking, the spin round and the run back past the vault end at these times (s into the scene). */
    const T_POP = 7.0;
    const T_SPIN = T_POP + 2.6;
    const T_BACK = T_SPIN + 1.4;
    const T_STOP = T_BACK + 2.6;
    const T_END = 17.0;
    // Along the bridge: the cars' line at the pop; where the player's car is at the end of its braking
    // and of its turn; where the vault slides to a stop (sparking); where the car stops facing back.
    const sPop = s0 + v * T_POP;
    const brake = (v - 8) / (T_SPIN - T_POP);
    const sBraked = sPop + (v + 8) / 2 * (T_SPIN - T_POP);
    const sTurned = sBraked + 5;
    const vaultStop = v / 8;
    const sVault = sPop - TOW + (v * v) / 16;
    const sEnd = (this.stopAt = sVault - (TOW - 0.5));
    /** Each car's line across the deck: the player's, the partner's, and the open lane the player turns into (the partner's side). */
    const xMe = lane + side * BESIDE;
    const xOther = lane - side * BESIDE;
    const xOpen = lane - side * 3.6;
    const turn = -side;
    const h0 = this.heading(s0);
    // Where everyone is now, off their place in the line-up (eased away over the first second and a half).
    const start = { player: this.at(s0, xMe), partner: this.at(s0, xOther), vault: this.at(s0 - TOW, lane, VAULT_Y) };
    const off = { player: player.position.sub(start.player), partner: partner.position.sub(start.partner), vault: vault.position.sub(start.vault) };
    const twist = { player: angleDiff(h0, player.heading), partner: angleDiff(h0, partner.heading), vault: vault.mesh.quaternion.clone() };
    const settle = (t: number) => 1 - ease(Math.min(1, t / 1.5));

    /** The player's car `t` s in: along, across, heading, speed. */
    const me = (t: number): { s: number; x: number; h: number; v: number } => {
      if (t < T_POP) return { s: s0 + v * t, x: xMe, h: this.heading(s0 + v * t), v };
      if (t < T_SPIN) {
        const u = t - T_POP;
        const s = sPop + v * u - (brake * u * u) / 2;
        return { s, x: xMe, h: this.heading(s), v: v - brake * u };
      }
      if (t < T_BACK) {
        // Round through half a turn into the open lane, still sliding on a few meters.
        const k = ease((t - T_SPIN) / (T_BACK - T_SPIN));
        const s = sBraked + (sTurned - sBraked) * Math.sin((k * Math.PI) / 2);
        return { s, x: THREE.MathUtils.lerp(xMe, xOpen, k), h: this.heading(s) + turn * Math.PI * k, v: 8 * (1 - k) };
      }
      // Back toward the city past the vault in the open lane, then over onto the vault's line and stop.
      const k = Math.min(1, (t - T_BACK) / (T_STOP - T_BACK));
      const s = sTurned + (sEnd - sTurned) * ease(k);
      const past = THREE.MathUtils.clamp((sVault - 3 - s) / 8, 0, 1);
      return { s, x: THREE.MathUtils.lerp(xOpen, lane, ease(past)), h: this.heading(s) + turn * Math.PI, v: ((sTurned - sEnd) * 6 * k * (1 - k)) / (T_STOP - T_BACK) };
    };
    /** The partner `t` s in: along, speed (it keeps its line). */
    const other = (t: number) => {
      if (t < T_POP) return { s: s0 + v * t, v };
      const u = t - T_POP;
      const a = Math.min(u, 4);
      return { s: sPop + v * u + 2.5 * a * a + 10 * Math.max(0, u - 4), v: v + 5 * a };
    };
    /** The vault `t` s in: along, and how far round it's been dragged (0..1). */
    const box = (t: number) => {
      if (t < T_POP) return { s: s0 + v * t - TOW, round: 0, sliding: false };
      const u = Math.min(t - T_POP, vaultStop);
      const s = sPop - TOW + v * u - 4 * u * u;
      // Dragged round to face the car as it pulls the cable tight going back past it.
      const round = ease(THREE.MathUtils.clamp((t - T_BACK - 0.8) / 1.6, 0, 1));
      return { s: s - round * 0.8, round, sliding: t - T_POP < vaultStop };
    };

    const place = (t: number) => {
      const fade = settle(t);
      const p = me(t);
      player.place(this.at(p.s, p.x).addScaledVector(off.player, fade), p.h + twist.player * fade);
      const pv = new THREE.Vector3(Math.sin(p.h), 0, Math.cos(p.h)).multiplyScalar(p.v);
      player.body.setLinvel({ x: pv.x, y: 0, z: pv.z }, true);
      player.forwardSpeed = p.v;
      const q = other(t);
      partner.place(this.at(q.s, xOther).addScaledVector(off.partner, fade), this.heading(q.s) + twist.partner * fade);
      const qt = this.path.tangent(q.s).multiplyScalar(q.v);
      partner.body.setLinvel({ x: qt.x, y: 0, z: qt.z }, true);
      partner.forwardSpeed = q.v;
      const b = box(t);
      const at = this.at(b.s, lane, VAULT_Y).addScaledVector(off.vault, fade);
      const yaw = this.heading(b.s) + turn * Math.PI * b.round;
      const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).slerp(twist.vault, fade);
      vault.body.setTranslation({ x: at.x, y: at.y, z: at.z }, true);
      vault.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
      return { p, q, b };
    };

    // The pack: every cruiser left, up the bridge behind them, each timed to pull up in a line
    // across the deck PACK_GAP m short of where the player's car ends up facing them.
    this.pack = [];
    const PACK = 30;
    const BRAKE = 7;
    const slots: [number, number][] = [[-9, 0], [-3, 0], [3, 0], [9, 0], [-6, 9], [0, 9], [6, 9]];
    slots.forEach(([x, back], i) => {
      const stopS = sEnd - PACK_GAP - back;
      const stopT = T_END - 1.2 - (i % 4) * 0.25 - (back ? 0.6 : 0);
      const braking = PACK / BRAKE;
      const s = stopS - (PACK * PACK) / (2 * BRAKE) - PACK * (stopT - braking);
      this.pack.push({ v: police.spawnAt(this.at(s, x), this.heading(s)), x, stopS, stopT });
    });
    /** The first shot looks back at the pack from behind the vault: till it cuts away, the pack is closer than it really is, gaining. */
    const SEEN_UNTIL = 3.0;
    const movePack = (t: number) => {
      for (const [i, c] of this.pack.entries()) {
        if (t < SEEN_UNTIL) {
          const s = box(t).s - 150 + 7 * t - (i >= 4 ? 10 : 0);
          this.drive(c.v, s, c.x, this.heading(s), v + 7);
          continue;
        }
        const braking = PACK / BRAKE;
        const u = Math.min(t, c.stopT);
        const t0 = c.stopT - braking;
        const d0 = c.stopS - (PACK * PACK) / (2 * BRAKE);
        // Flat out, then on the brakes to a stop in its place (nosing round a little to face the car).
        const s = u < t0 ? d0 - PACK * (t0 - u) : d0 + PACK * (u - t0) - (BRAKE * (u - t0) ** 2) / 2;
        const speed = u < t0 ? PACK : PACK - BRAKE * (u - t0);
        const k = THREE.MathUtils.clamp((u - t0) / braking, 0, 1);
        this.drive(c.v, s, c.x * (1 - 0.1 * k), this.heading(s) - Math.sign(c.x) * 0.12 * k * k, speed);
        if (k > 0.3 && k < 0.95) for (const w of c.v.rearWheels()) if (Math.random() < 0.25) fx.tireSmoke(w, 0.5);
      }
    };
    /** The loose cable on the partner's car: from the vault's latch at the pop, dragging behind and sparking, reeled in over a few seconds. */
    const dragLoose = (t: number) => {
      if (t < T_POP || !this.loose) return;
      const u = t - T_POP;
      const a = partner.towPoint();
      const trail = THREE.MathUtils.lerp(9, 0.4, THREE.MathUtils.clamp((u - 0.8) / 3.2, 0, 1));
      const tail = a.clone().addScaledVector(partner.forward, -trail).setY(0.1);
      const from = this.at(box(T_POP).s + 1.5, lane - side * 0.9, VAULT_Y - 0.7);
      const hook = from.lerp(tail, ease(Math.min(1, u / 0.45)));
      if (trail < 0.6) {
        this.loose.hide();
        return;
      }
      this.loose.draw(a, a.clone().lerp(hook, 0.55).setY(Math.max(0.05, hook.y * 0.5)), hook, partner.heading);
      if (u > 0.45 && Math.random() < 0.8) fx.scrape(hook, partner.forward.multiplyScalar(other(t).v * 0.9), 0.7);
    };
    const smoke = (t: number) => {
      // Rear tyres: the partner flooring it, the player braking and spinning round.
      if (t > T_POP && t < T_POP + 1.2) for (const w of partner.rearWheels()) if (Math.random() < 0.6) fx.tireSmoke(w, 0.7);
      if (t > T_POP + 0.4 && t < T_STOP - 0.4) for (const w of player.rearWheels()) if (Math.random() < (t > T_SPIN && t < T_BACK + 0.6 ? 0.9 : 0.4)) fx.tireSmoke(w, 0.9);
      if (box(t).sliding && t > T_POP && Math.random() < 0.9) fx.scrape(this.at(box(t).s - 1.4, lane + (Math.random() - 0.5) * 2.6, 0.08), this.path.tangent(box(t).s).multiplyScalar(6), 0.7);
      sound.tires(t > T_POP + 0.4 && t < T_BACK + 0.6 ? 0.9 : 0, false);
    };
    let time = 0;
    const tick = (dt: number) => {
      time += dt;
      const now = place(time);
      movePack(time);
      dragLoose(time);
      smoke(time);
      if (time >= T_POP && !this.loose) this.pop();
      return now;
    };
    const mine = crew.player;
    const theirs = crew.partner;
    const cam = (s: number, x: number, y: number) => this.at(s, x, y);

    return [
      {
        // Low on the deck behind the vault, a long lens back down the bridge: the pack's lights, closing.
        duration: 3.0,
        start: () => vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true),
        update: (_t, dt) => tick(dt),
        camera: () => {
          const s = box(time).s;
          return { pos: cam(s - 5, lane + side * 1.2, 2.0), look: cam(s - 160, lane, 1.0), fov: 18 };
        },
        lines: [[0.3, theirs, 'Look behind us. That’s every cop in the city on this bridge.']],
      },
      {
        // Tracking alongside, out past the partner's car: both cars side by side, the vault on its two cables behind.
        duration: 3.2,
        update: (_t, dt) => tick(dt),
        camera: (k) => {
          const s = me(time).s;
          return { pos: cam(s + 3 - k * 3, lane - side * (BESIDE + 7), 1.4), look: cam(s - 4, lane, 0.9), fov: 42 };
        },
        lines: [
          [0.2, mine, 'We’ll never shake them dragging this. Not both of us.'],
          [2.0, theirs, 'So what, we stop?'],
        ],
      },
      {
        // Close on the latch of the partner's cable at the vault: it pops in a spray of sparks.
        duration: 1.6,
        update: (_t, dt) => tick(dt),
        camera: () => {
          const s = box(time).s;
          return { pos: cam(s + 5.2, lane - side * 4.0, 1.7), look: cam(s + 1.5, lane - side * 0.9, 0.6), fov: 34 };
        },
        lines: [[0.1, mine, 'You don’t. You keep going.']],
      },
      {
        // Up behind the vault on the player's side, looking on down the deck over it: the partner's car leaps away
        // dragging its loose cable, the player's brakes hard (back and out of the searchlight, so its beam doesn't wash the frame).
        duration: T_SPIN - T_POP - 0.8,
        update: (_t, dt) => tick(dt),
        camera: () => {
          const s = box(time).s;
          return { pos: cam(s - 16, lane + side * 3.0, 4.2), look: cam(s + 28, lane - side * 0.5, 0.6), fov: 38 };
        },
        lines: [
          [0.1, theirs, 'Hey! What did you just do?'],
          [1.0, mine, 'Get clear. I’ll handle them.'],
        ],
      },
      {
        // High over the deck: the player's car swings round through a half turn, back past the vault, and it's dragged round behind it.
        duration: T_STOP - T_SPIN + 0.4,
        update: (_t, dt) => tick(dt),
        camera: (k) => {
          const s = (sVault + sTurned) / 2;
          return { pos: cam(s - 22 + k * 4, lane + side * 20, 30), look: cam(s - 2, lane, 0), fov: 46 };
        },
        lines: [[1.4, theirs, 'You’re out of your mind!']],
      },
      {
        // Low behind the car, past the vault's cable: the pack comes up the bridge and pulls up in a line across it.
        duration: T_END - T_STOP - 0.4,
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: cam(sEnd + 7 - k, lane - side * 2.0, 1.3), look: cam(sEnd - PACK_GAP, lane - side * 0.5, 1.0), fov: 24 }),
        lines: [
          [0.3, 'MIA', 'They’re stopping… lining up across the bridge. They think you’re done.'],
          [2.4, mine, 'Not yet.'],
        ],
      },
    ];
  }

  /** The latch on the partner's cable pops: sparks at the vault, and the partner's free. */
  private pop(): void {
    const { ctx } = this;
    const c = ctx.cables.find((x) => x.car === ctx.partner);
    const at = c ? ctx.vault.anchorWorld(c.side) : ctx.vault.position;
    ctx.fx.muzzle(at);
    ctx.fx.burst(at, 1.6);
    for (let i = 0; i < 6; i++) ctx.fx.scrape(at, new THREE.Vector3((Math.random() - 0.5) * 7, 2 + Math.random() * 3, (Math.random() - 0.5) * 7), 1);
    ctx.sound.bang();
    ctx.sound.clank();
    this.cutLoose();
    this.loose = new CableLine(ctx.scene);
    ctx.director.shake = Math.max(ctx.director.shake, 0.4);
  }

  /** The end of the split, however far the scene got: the player alone facing the city, the vault behind, the pack lined up, the partner gone. */
  private afterSplit(): void {
    if (this.state !== 'split') return;
    const { ctx } = this;
    const { vault, partner, player, crew, hud, sound } = ctx;
    this.state = 'pull';
    sound.tires(0, false);
    this.cutLoose();
    this.loose?.hide();
    const s1 = this.stopAt;
    // Facing back toward the city, the vault behind them with its door to the car.
    const back = this.path.tangent(s1).negate();
    const me = this.at(s1, this.lane);
    ctx.placeConvoy(me.clone().addScaledVector(leftOf(back), -crew.side * BESIDE), back, this.at(s1 + TOW, this.lane));
    player.place(me, Math.atan2(back.x, back.z));
    vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    // The winch holds: the car strains against the vault instead of paying out cable.
    for (const c of ctx.cables) c.clutch = false;
    // The partner's well on across the bridge by now, and keeps going.
    const away = Math.min(this.path.length - 60, Math.max(s1 + 220, this.path.project(partner.position)));
    this.drive(partner, away, this.lane - crew.side * BESIDE, this.heading(away), 30);
    ctx.partnerDriver.leave(this.path, 1);
    // The pack where it pulled up, engines running, lights going.
    for (const c of this.pack) {
      const s = s1 - PACK_GAP - (c.stopS < s1 - PACK_GAP - 1 ? 9 : 0);
      if (c.v.position.distanceTo(this.at(s, c.x)) > 25) c.v.place(this.at(s, c.x * 0.9), this.heading(s) - Math.sign(c.x) * 0.12);
      c.v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      c.v.forwardSpeed = 0;
    }
    // A full tank for the pull.
    ctx.reward(0, 1);
    this.strain = 0;
    this.pullTime = 0;
    setTimeout(() => hud.news(NEWS.split), 1200);
  }

  /**
   * The solo pull: the vault won't move until the STRAIN meter fills. Gas alone only
   * gets it creaking (unless they keep at it a long while); the nitrous does the rest,
   * and it comes back fast between bursts, so it can't be wasted here.
   */
  private strainPull(dt: number): void {
    const { player, hud, director, sound } = this.ctx;
    this.pullTime += dt;
    const lit = player.nosActive;
    const gas = player.controls.throttle;
    // The first touch of the nitrous flicks the three switches on the dash and lights the button.
    if (lit && this.armed < 0) this.armed = 0;
    if (this.armed >= 0) {
      const was = this.armed;
      this.armed += dt;
      const step = (s: number) => (s < 0.12 ? 0 : s < 0.3 ? 1 : s < 0.48 ? 2 : s < 0.7 ? 3 : 4);
      if (step(this.armed) !== step(was)) sound.ping(step(this.armed) === 4 ? 880 : 2300, step(this.armed) === 4 ? 0.12 : 0.06, 0.08);
      this.ctx.hud.nosArm(this.armed < 2.4 ? step(this.armed) : -1);
    }
    const cap = this.pullTime > 15 ? 1 : 0.3;
    if (lit) this.strain += dt * 0.45;
    else if (gas > 0.1 && this.strain < cap) this.strain = Math.min(cap, this.strain + dt * (this.pullTime > 15 ? 0.04 : 0.12) * gas);
    else if (gas <= 0.1) this.strain -= dt * 0.3;
    this.strain = THREE.MathUtils.clamp(this.strain, 0, 1);
    if (!lit) this.ctx.reward(0, dt * 0.2);
    director.shake = Math.max(director.shake, this.strain * 0.6);
    this.creak -= dt;
    if (this.strain > 0.2 && this.creak <= 0) {
      this.creak = 0.45 + Math.random() * 0.5;
      sound.clank();
    }
    const prompt =
      this.strain < 0.05 ? 'HOLD SHIFT FOR NITROUS  —  PULL IT ALONE' : !lit && this.strain >= cap - 0.01 ? 'TOO HEAVY  —  HIT THE NITROUS (SHIFT)!' : this.strain < 0.75 ? 'KEEP IT LIT!' : 'ALMOST…';
    hud.meter('SOLO PULL', this.strain, prompt);
    if (this.strain >= 1) this.rollFree();
  }

  /** It's moving: slow motion from beside the cable as ten tons lurch forward, and the line of cruisers comes for them. */
  private rollFree(): void {
    const { ctx } = this;
    const { vault, player, director, sound, fx, hud } = ctx;
    this.state = 'charge';
    this.chargeTime = 0;
    hud.nosArm(-1);
    ctx.police.launch = 1.7;
    hud.meter(null);
    for (const c of ctx.cables) c.clutch = true;
    vault.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const dir = player.position.sub(vault.position.setY(0)).setY(0).normalize();
    const m = vault.body.mass();
    vault.body.applyImpulse({ x: dir.x * m * 6, y: m * 0.5, z: dir.z * m * 6 }, true);
    // Low ahead of the car on the open side of the deck (where the partner's car was), looking
    // back at it: the nose comes up and ten tons lurch after it.
    const open = leftOf(dir).multiplyScalar(-ctx.crew.side);
    director.slowmo(0.3, 1.6);
    director.shake = 1.2;
    director.play({
      duration: 1.6,
      frame: (k) => {
        const c = player.position.setY(0);
        return {
          pos: c.clone().addScaledVector(dir, 9 - k * 1.5).addScaledVector(open, 3.4).setY(1.05 + k * 0.25),
          look: c.clone().lerp(vault.position.setY(0), 0.45).setY(1.0),
          fov: 50,
        };
      },
    });
    sound.crash(1);
    fx.burst(vault.position.addScaledVector(dir, 1.6).setY(0.4), 1);
    fx.puff(vault.position.setY(0), 10);
    hud.banner('SOLO PULL', 'TEN TONS, ONE CAR  +750');
    ctx.reward(750, 0.4);
    // The line starts its engines and comes.
    ctx.holdPolice(false);
    this.pack = [];
    say(ctx, 'MIA', 'It’s moving! And here they come, head-on! Swing that thing!');
  }
}

const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

/** Yellow and black diagonal hazard stripes, one repeat per meter. */
function hazardTexture(length: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, 64, 16);
  ctx.fillStyle = '#f2c200';
  for (let x = -16; x < 64; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 16);
    ctx.lineTo(x + 8, 0);
    ctx.lineTo(x + 16, 0);
    ctx.lineTo(x + 8, 16);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(length, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
