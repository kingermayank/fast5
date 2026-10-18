import * as THREE from 'three';
import type { Sound } from './audio';
import { buildCarModel } from './carModel';
import { type City, VAULT_START } from './city';
import type { Director } from './director';
import type { Effects } from './fx';
import { NEWS } from './broadcast';
import { BEACONS } from './groundfx';
import type { Hud } from './hud';
import type { Obstacle } from './partner';
import { RAPIER } from './physics';
import { roadHalfWidth } from './roads';
import { BANK, SPIKES } from './roadmap';
import type { Cable, Vault } from './vault';
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
  player: Vehicle;
  partner: Vehicle;
  vault: Vault;
  cables: Cable[];
  /** The GPS route: intersections still to drive through, next first. */
  route(): THREE.Vector3[];
  /** Award style points and nitrous (0..1). */
  reward(style: number, nos: number): void;
  addDamage(amount: number): void;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.hud.radio(who, line);
  ctx.voice.speak(who, line);
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
    if (this.state !== 'hinted' || this.time - this.swungAt > 1.4) return;
    const { vault } = this.ctx;
    const vv = vault.body.linvel();
    const to = this.target().sub(vault.position.setY(0));
    const want = to.normalize().multiplyScalar(Math.max(Math.hypot(vv.x, vv.z), 16));
    const k = Math.min(1, dt * 8);
    vault.body.setLinvel({ x: vv.x + (want.x - vv.x) * k, y: vv.y, z: vv.z + (want.z - vv.z) * k }, true);
    const w = vault.body.angvel();
    vault.body.setAngvel({ x: w.x, y: w.y * (1 - k), z: w.z }, true);
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
      // The winches pay out enough cable for it to get there; they reel back in afterwards.
      for (const c of this.ctx.cables) c.payOut(THREE.MathUtils.clamp(c.car.towPoint().distanceTo(target) + 8, 22, 40));
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
