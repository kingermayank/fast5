import * as THREE from 'three';
import { buildArmoredTruck, buildCarModel, type CarModel } from './carModel';
import { ease, type Shot } from './cutscene';
import { GarbageTruck, RAMP_FOOT } from './garbageTruck';
import { SUN_DIR } from './graphics';
import type { MomentContext } from './moments';
import { buildFigure, cheer, type Figure, stand, wave } from './people';
import { RAPIER } from './physics';
import { leftOf, type Path } from './roads';
import { BRIDGE } from './roadmap';
import { openVault } from './vault';
import type { Vehicle } from './vehicle';

/*
 * The last scene, from the last swing to payday:
 *  1 the vault slams into Reyes's SUV and rolls it onto its roof,
 *  2 the vault stops dead and the car on its cable is yanked over and comes down on the wreck,
 *  3 smoke, quiet, the radio,
 *  4 the partner comes back for them,
 *  5 Hobbs's truck arrives with what's left of the police,
 *  6 he takes Reyes and gives the crew a day's head start,
 *  7 they drive off,
 *  8 the vault's door swings open: empty (it's the decoy),
 *  9 and in the hideout the real one opens: payday.
 * Dialogue is all over the radio and in subtitles; nobody's face is on screen.
 */

/** The hideout yard, well off the map (nothing of the city in sight from inside it). */
const HIDEOUT = new THREE.Vector3(-2600, 0, -2600);
/** Toward the low sun, flat: the way the vaults' doors face, so they're shot with the light behind the camera. */
const SUNWARD = SUN_DIR.clone().setY(0).normalize();
/** The hideout yard is laid out with its +z toward the sun: the vault's door that way, the truck behind it. */
const YARD_YAW = Math.atan2(SUNWARD.x, SUNWARD.z);

/** A car's pose: where, and its rotation. */
interface Pose {
  pos: THREE.Vector3;
  q: THREE.Quaternion;
}

const yaw = (h: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h);

function setPose(body: RAPIER.RigidBody, p: THREE.Vector3, q: THREE.Quaternion): void {
  body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
  body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
}

/** A model-only car (no physics) for the scene: Hobbs's escort cruisers. */
function propCar(scene: THREE.Scene, police: boolean): CarModel {
  const m = police
    ? buildCarModel({ body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true, asset: 'police' })
    : buildCarModel({ body: 0x141416, trim: 0x0b0b0c, rim: 0x3a3a3c, matte: true });
  scene.add(m.group);
  return m;
}

export class Finale {
  /** The vault on the cables was the decoy (the swap happened). */
  readonly decoy: boolean;
  private hobbs = buildArmoredTruck();
  private escort: CarModel[] = [];
  private set: THREE.Group | null = null;
  /** The hideout yard's work lamps, which light it at night (through the street light map). */
  readonly yardLights: THREE.Vector3[] = [];
  private realVault: THREE.Object3D | null = null;
  private crew: Figure[] = [];
  private time = 0;
  private once = new Set<string>();
  /** The wreck site: where the SUV was hit, the way it's thrown, and the deck's frame there. */
  private site: THREE.Vector3;
  private away: THREE.Vector3;
  private along: THREE.Vector3;
  private across: THREE.Vector3;
  private start: { suv: Pose; car: Pose; vault: Pose; partner: Pose } | null = null;
  private suvEnd: Pose;
  private carEnd: Pose;
  private vaultEnd: Pose;
  /** The way the vault's door faces once it's come to rest. */
  private door: THREE.Vector3;
  /** From the resting vault toward the wreck (flat), how far that is, and the side of that line the close shots are taken from. */
  private axis: THREE.Vector3;
  private span: number;
  private side: THREE.Vector3;
  private partnerStop: Pose;

  constructor(
    private ctx: MomentContext,
    private path: Path,
    decoy: boolean,
    at: THREE.Vector3,
  ) {
    this.decoy = decoy;
    const { vault } = ctx;
    const s = path.project(at);
    this.along = path.tangent(s);
    this.across = leftOf(this.along);
    const v = vault.position.setY(0);
    this.away = at.clone().setY(0).sub(v).setY(0);
    if (this.away.lengthSq() < 0.01) this.away.copy(this.across);
    this.away.normalize();
    // Keep the wreck on the deck: where it's thrown, at least 4 m in from the rails.
    const deckX = (p: THREE.Vector3) => p.clone().sub(path.at(path.project(p))).dot(leftOf(path.tangent(path.project(p))));
    let land = at.clone().setY(0).addScaledVector(this.away, 4);
    const x = deckX(land);
    const lim = BRIDGE.hw - 4;
    if (Math.abs(x) > lim) land = land.addScaledVector(this.across, (Math.sign(x) * lim - x) * Math.sign(this.across.dot(this.across)));
    this.site = land;
    const heading = Math.atan2(this.along.x, this.along.z);
    // The SUV ends on its roof, the car on its back on top of it, the vault stopped where it hit.
    this.suvEnd = { pos: land.clone().setY(1.25), q: yaw(heading + 0.5).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI)) };
    this.carEnd = {
      pos: land.clone().addScaledVector(this.along, 0.4).setY(2.55),
      q: yaw(heading - 0.35).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)),
    };
    // The vault comes to rest upright where it hit, clear of the rails, its door toward the low sun
    // (the reveal is shot with the light behind the camera), never straight at the wreck or the rail.
    const rest = at.clone().setY(0).addScaledVector(this.away, -2.6);
    const rx = deckX(rest);
    const rlim = BRIDGE.hw - 2.4;
    if (Math.abs(rx) > rlim) rest.addScaledVector(this.across, Math.sign(rx) * rlim - rx);
    this.door = this.along;
    let best = -Infinity;
    for (const d of [this.along, this.along.clone().negate(), this.across.clone().multiplyScalar(this.sideToCentre())]) {
      if (d.dot(this.away) > 0.6 || d.dot(SUNWARD) <= best) continue;
      best = d.dot(SUNWARD);
      this.door = d;
    }
    // The close shots of the hit are taken across the line from the vault to the wreck, from the
    // side that looks away from the low sun, unless that puts the camera out past a rail.
    this.axis = land.clone().sub(rest).setY(0);
    this.span = this.axis.length();
    if (this.span < 0.5) this.axis.copy(this.away);
    this.axis.normalize();
    const mid = rest.clone().lerp(land, 0.5);
    const p = new THREE.Vector3(this.axis.z, 0, -this.axis.x);
    const [first, second] = p.dot(SUNWARD) > 0 ? [p, p.clone().negate()] : [p.clone().negate(), p];
    const room = (q: THREE.Vector3) => BRIDGE.hw - Math.abs(deckX(mid.clone().addScaledVector(q, 10)));
    this.side = room(first) > 1 || room(first) >= room(second) ? first : second;
    this.vaultEnd = { pos: rest.setY(1.27), q: yaw(Math.atan2(this.door.x, this.door.z)) };
    this.partnerStop = { pos: land.clone().addScaledVector(this.along, -14).addScaledVector(this.across, this.sideToCentre() * 6), q: yaw(heading + 1.1) };
  }

  /** Which way is the middle of the deck from the wreck (+1: left). */
  private sideToCentre(): number {
    const x = this.site.clone().sub(this.path.at(this.path.project(this.site))).dot(this.across);
    return x > 0 ? -1 : 1;
  }

  shots(): Shot[] {
    const { ctx } = this;
    const me = ctx.crew.player;
    const other = ctx.crew.partner;
    const site = this.site;
    const c = this.sideToCentre();
    const deck = (a: number, x: number, y: number) => site.clone().addScaledVector(this.along, a).addScaledVector(this.across, c * x).setY(y);
    const tick = (dt: number) => this.advance(dt);
    const span = this.span;
    const shots: Shot[] = [
      {
        // Low on the deck, side on: the vault comes round and folds Reyes's SUV over onto its roof.
        duration: 2.4,
        start: () => this.stage(),
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: this.byWreck(span * 0.5 - 2.5 + k, 10, 1.1), look: this.byWreck(span, 0, 1.1), fov: 44 }),
      },
      {
        // Wide from the side: the vault stops dead and the car on its cable is thrown over onto the wreck.
        duration: 2.6,
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: this.byWreck(span * 0.5 + 3 - k * 2, 19, 5.5 + k), look: this.byWreck(span * 0.6, 0, 1.5), fov: 48 }),
      },
      {
        // Smoke and quiet, low and close on the wreck.
        duration: 2.8,
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: this.byWreck(span + 1.5 - k * 0.8, 6.5 - k * 1.5, 0.9), look: this.byWreck(span, 0, 1.5), fov: 46 }),
        lines: [
          [0.4, 'MIA', 'Talk to me! Are you okay?'],
          [1.8, me, 'Still breathing. The car’s not.'],
        ],
      },
      {
        // Back down the bridge: the partner comes flat out and slides to a stop beside the wreck.
        duration: 3.2,
        update: (_t, dt) => tick(dt),
        camera: () => ({ pos: deck(4, 3, 2.0), look: deck(-30, 3, 0.8), fov: 44 }),
        lines: [[1.9, other, 'Miss me?']],
      },
      {
        // Low up the bridge, looking back at the wreck: Hobbs's truck comes past, cruisers either side.
        duration: 3.8,
        update: (_t, dt) => tick(dt),
        camera: () => ({ pos: deck(40, -4.5, 1.6), look: deck(0, 0, 1.5), fov: 40 }),
        lines: [[1.6, 'HOBBS', 'Reyes is mine. He’s not walking away from this one.']],
      },
      {
        // The standoff, wide and high from across the deck (the side that has the low sun behind
        // the camera): the truck one side of the vault, the partner's car the other.
        duration: 4.0,
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: deck(1 + k * 2, 0, 8).addScaledVector(this.across, Math.sign(this.across.dot(SUNWARD)) * 22), look: deck(2, 0, 1.0), fov: 46 }),
        lines: [
          [0.3, 'HOBBS', 'You two, start driving. Sunrise tomorrow, I’m coming after you myself.'],
          [2.7, me, 'Then bring a bigger truck.'],
        ],
      },
      {
        // High and wide, looking back toward the city: they drive off the way they came.
        duration: 3.0,
        update: (_t, dt) => tick(dt),
        camera: (k) => ({ pos: deck(8, 13, 10 + k * 3), look: deck(-25 - k * 30, 0, 0.5), fov: 50 }),
        lines: [[0.5, 'MIA', 'Go. Get out of there.']],
      },
      {
        // Close on the vault's door as it swings open, from the side it swings away from.
        duration: 2.9,
        start: () => this.event('reveal', () => ctx.sound.clank()),
        update: (t, dt) => {
          tick(dt);
          openVault(ctx.vault.mesh, ease(THREE.MathUtils.clamp((t - 0.4) / 1.5, 0, 1)), !this.decoy);
        },
        camera: (k) => ({ pos: this.byVault(1.0, 1.55, 5.6 - k * 1.3), look: this.byVault(-0.15, 1.05, 1.5), fov: 40 }),
        lines: [[1.9, 'HOBBS', this.decoy ? 'It’s empty.' : 'Well. Would you look at that.']],
      },
      {
        // Up and away from it: the open vault on the deck, the wreck, Hobbs's truck, the bay.
        duration: 3.0,
        title: this.decoy ? 'THE DECOY' : '',
        update: (_t, dt) => {
          tick(dt);
          openVault(ctx.vault.mesh, 1, !this.decoy);
        },
        camera: (k) => ({ pos: this.byVault(3 + k, 3.4 + k * 3.2, 7.5 + k * 4.5), look: this.byVault(-0.8, 0.8, 0), fov: 46 }),
        lines: this.decoy ? [[0.5, 'MIA', 'Of course it is.']] : [],
      },
    ];
    if (this.decoy) {
      shots.push(
        {
          // The hideout, high and wide: the garbage truck backed in with its ramp down, the real vault on the floor in front of it, the crew round it.
          duration: 3.0,
          title: 'PAYDAY',
          start: () => this.hideout(),
          update: (t) => this.payday(t, false),
          camera: (k) => ({ pos: this.inYard(4 - k * 1.2, 6.8 - k * 1.4, 14 - k * 2.5), look: this.inYard(0, 2.2, -4), fov: 44 }),
          lines: [[0.7, 'TEJ', 'Last lock. Everybody stand back.']],
        },
        {
          // Close: the door swings open on a wall of money.
          duration: 4.4,
          update: (t) => this.payday(t, true),
          camera: (k) => ({ pos: this.inYard(1.3, 1.75 - k * 0.2, 5.8 - k * 1.4), look: this.inYard(-0.1, 1.0, 1.5), fov: 42 }),
          lines: [
            [1.2, 'ROMAN', 'Ten tons of garbage, and every bit of it ours.'],
            [2.8, 'TEJ', 'Told you I could open it.'],
          ],
        },
      );
    }
    return shots;
  }

  /** A point by the wreck: `a` m from the resting vault toward the pile, `x` m out to the camera side, `y` m up. */
  private byWreck(a: number, x: number, y: number): THREE.Vector3 {
    return this.vaultEnd.pos.clone().addScaledVector(this.axis, a).addScaledVector(this.side, x).setY(y);
  }

  /** A point `z` m out in front of the vault's door (where it came to rest on the deck), `x` m to the door's right (looking at it), `y` m up. */
  private byVault(x: number, y: number, z: number): THREE.Vector3 {
    const d = this.door;
    return this.vaultEnd.pos.clone().addScaledVector(d, z).add(new THREE.Vector3(d.z, 0, -d.x).multiplyScalar(x)).setY(y);
  }

  /** A point in the hideout yard, in its frame: +z toward the sun (out of the real vault's door), +x to the door's right (looking at it). */
  private inYard(x: number, y: number, z: number): THREE.Vector3 {
    return new THREE.Vector3(x, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), YARD_YAW).add(HIDEOUT);
  }

  /** Where the camera holds after the scene, behind the end screen: on the money, or on the open vault on the bridge. */
  outroCamera(t: number): { pos: THREE.Vector3; look: THREE.Vector3 } {
    const a = 0.2 + t * 0.05;
    if (this.set) return { pos: this.inYard(Math.sin(a) * 7, 2.6, Math.cos(a) * 7), look: this.inYard(0, 1.1, 0) };
    return { pos: this.byVault(Math.sin(a) * 9, 4, Math.cos(a) * 9), look: this.byVault(0, 1, 0) };
  }

  /** Off the road for the scene: the live cops and Reyes's other car go, the wrecks stay; everyone else is ours to place. */
  private stage(): void {
    const { ctx } = this;
    const { player, vault, reyes, police } = ctx;
    police.dismiss(undefined, true);
    for (const s of reyes.suvs) if (!s.boss && !s.wrecked && !s.plunge) s.v.model.group.visible = false;
    const boss = reyes.boss ?? reyes.suvs.find((s) => s.boss);
    const pose = (v: Vehicle | { body: RAPIER.RigidBody }): Pose => {
      const t = v.body.translation();
      const r = v.body.rotation();
      return { pos: new THREE.Vector3(t.x, t.y, t.z), q: new THREE.Quaternion(r.x, r.y, r.z, r.w) };
    };
    for (const b of [player.body, vault.body, ...(boss ? [boss.v.body] : [])]) b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.start = {
      suv: boss ? pose(boss.v) : { pos: this.site.clone().setY(0.7), q: yaw(0) },
      car: pose(player),
      vault: pose(vault),
      partner: { pos: this.site.clone().addScaledVector(this.along, -150).addScaledVector(this.across, this.sideToCentre() * 6), q: yaw(Math.atan2(this.along.x, this.along.z)) },
    };
    if (boss) boss.gunner.group.visible = false;
    // Hobbs and two cruisers wait out of sight up the bridge.
    this.ctx.scene.add(this.hobbs);
    this.hobbs.visible = false;
    for (let i = 0; i < 2; i++) this.escort.push(propCar(this.ctx.scene, true));
    for (const e of this.escort) e.group.visible = false;
  }

  /** Everyone where the scene puts them `this.time` s in. */
  private advance(dt: number): void {
    const st = this.start;
    if (!st) return;
    this.time += dt;
    const t = this.time;
    const { ctx } = this;
    const { player, partner, vault, reyes, fx, sound, director } = ctx;
    const boss = reyes.suvs.find((s) => s.boss);
    // 1. The vault comes round into the SUV (0..0.45 s), which rolls over onto its roof and slides (0.45..1.9 s).
    const hitAt = 0.45;
    const vk = Math.min(1, t / hitAt);
    setPose(vault.body, st.vault.pos.clone().lerp(this.vaultEnd.pos, ease(vk) * vk), st.vault.q.clone().slerp(this.vaultEnd.q, vk));
    if (t >= hitAt)
      this.event('hit', () => {
        sound.crash(1.6);
        sound.bang();
        fx.burst(this.vaultEnd.pos.clone().addScaledVector(this.away, 1.5).setY(1.2), 2);
        fx.shatter(this.vaultEnd.pos.clone().addScaledVector(this.away, 2), this.away.clone().multiplyScalar(6), 90);
        director.shake = 1.4;
      });
    if (boss) {
      const k = THREE.MathUtils.clamp((t - hitAt) / 1.45, 0, 1);
      const pos = st.suv.pos.clone().lerp(this.suvEnd.pos, ease(k));
      pos.y += Math.sin(k * Math.PI) * 1.8;
      setPose(boss.v.body, pos, st.suv.q.clone().slerp(this.suvEnd.q, ease(k)));
      if (k >= 1)
        this.event('suvDown', () => {
          sound.crash(1);
          fx.puff(this.suvEnd.pos.clone().setY(0), 12);
          fx.burst(this.suvEnd.pos.clone().setY(1.6), 0.8);
        });
    }
    // 2. The car: yanked back off its line (from 2.4 s), over its tail, down on its roof on the wreck (at 4.2 s).
    const ck = THREE.MathUtils.clamp((t - 2.5) / 1.7, 0, 1);
    if (ck > 0) {
      const pos = st.car.pos.clone().lerp(this.carEnd.pos, ease(ck));
      pos.y += Math.sin(ck * Math.PI) * 4.5;
      setPose(player.body, pos, st.car.q.clone().slerp(this.carEnd.q, ease(ck)));
      if (ck >= 1)
        this.event('carDown', () => {
          sound.crash(1.8);
          fx.burst(this.carEnd.pos.clone(), 1.6);
          fx.shatter(this.carEnd.pos.clone(), new THREE.Vector3(0, 2, 0), 70);
          director.shake = 1.5;
        });
    } else {
      setPose(player.body, st.car.pos, st.car.q);
    }
    player.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    // 3. Smoke off the pile.
    if (t > 4.2 && Math.random() < dt * 6) fx.puff(this.carEnd.pos.clone().setY(1.5), 1);
    // 4. The partner flat out up the bridge (from 7.6 s), sliding to a stop by 10.4 s.
    const pk = THREE.MathUtils.clamp((t - 7.6) / 2.8, 0, 1);
    const pStart = st.partner;
    const pPos = pStart.pos.clone().lerp(this.partnerStop.pos, 1 - (1 - pk) ** 2.2);
    const pQ = pStart.q.clone().slerp(this.partnerStop.q, ease(THREE.MathUtils.clamp((pk - 0.6) / 0.4, 0, 1)));
    // 7. ...and away back down the bridge, toward the city, at the end (from 18.2 s).
    const gk = THREE.MathUtils.clamp((t - 18.2) / 3, 0, 1);
    if (gk > 0) {
      const h = Math.atan2(-this.along.x, -this.along.z);
      const pos = this.partnerStop.pos.clone().addScaledVector(this.along, -70 * gk * gk);
      partner.place(pos, h + (1.1 - Math.PI) * (1 - ease(Math.min(1, gk * 3))));
    } else {
      partner.place(pPos, 0);
      partner.body.setRotation({ x: pQ.x, y: pQ.y, z: pQ.z, w: pQ.w }, true);
    }
    partner.forwardSpeed = pk > 0 && pk < 1 ? 30 * (1 - pk) : gk > 0 ? 24 * gk : 0;
    if (pk > 0.55 && pk < 0.98) for (const w of partner.rearWheels()) if (Math.random() < 0.6) fx.tireSmoke(w, 0.9);
    if (pk > 0.55) this.event('skid', () => sound.tires(0.9, false));
    if (pk >= 1) this.event('skidEnd', () => sound.tires(0, false));
    // 5. Hobbs's truck and two cruisers up the bridge head-on (from 10.6 s), stopping by 13.4 s.
    const hk = THREE.MathUtils.clamp((t - 10.6) / 2.8, 0, 1);
    if (hk > 0) {
      const h = Math.atan2(-this.along.x, -this.along.z);
      const from = 70;
      const stopAt = 17;
      const a = from + (stopAt - from) * (1 - (1 - hk) ** 2);
      this.hobbs.visible = true;
      this.hobbs.position.copy(this.site).addScaledVector(this.along, a).addScaledVector(this.across, -this.sideToCentre() * 1);
      this.hobbs.rotation.y = h;
      // The site's offset across the deck, so the escorts stay on it whichever side the wreck is.
      const siteX = this.site.clone().sub(this.path.at(this.path.project(this.site))).dot(this.across);
      this.escort.forEach((e, i) => {
        e.group.visible = true;
        const x = THREE.MathUtils.clamp(siteX + (i ? 1 : -1) * 6.5, -BRIDGE.hw + 2.2, BRIDGE.hw - 2.2);
        e.group.position.copy(this.site).addScaledVector(this.along, a + 6 + i * 2).addScaledVector(this.across, x - siteX);
        e.group.rotation.y = h + (i ? 0.25 : -0.25) * hk;
        const flash = Math.floor(t * 6) % 2 === 0;
        if (e.lightBar) {
          e.lightBar.red.emissiveIntensity = flash ? 3 : 0.2;
          e.lightBar.blue.emissiveIntensity = flash ? 0.2 : 3;
        }
      });
      if (hk >= 1) this.event('hobbsStop', () => sound.tires(0, false));
      else if (hk > 0.7) this.event('hobbsBrake', () => sound.tires(0.7, false));
    }
  }

  /**
   * The hideout yard, laid out in its own frame (+z toward the sun): the real vault on the
   * concrete with its door to the light, the garbage truck backed up behind it with its ramp
   * still down, tall walls with work lamps behind and to the sides, a low wall on the sun
   * side (so the low sun comes in over it), drums and pallets, and the crew round the vault.
   */
  private hideout(): void {
    if (this.set) return;
    const { ctx } = this;
    const g = new THREE.Group();
    g.position.copy(HIDEOUT);
    g.rotation.y = YARD_YAW;
    const concrete = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.95 });
    const wall = new THREE.MeshStandardMaterial({ color: 0x8a6f58, roughness: 0.9 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x2a2620, emissive: 0xffd9a0, emissiveIntensity: 3 });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(42, 0.2, 46), concrete);
    floor.position.set(0, -0.1, -4);
    floor.receiveShadow = true;
    g.add(floor);
    // [x, z, width, depth, height]: the back wall, the two sides, the low wall on the sun side.
    for (const [x, z, w, d, h] of [[0, -27, 42, 0.6, 9], [-21, -4, 0.6, 46, 7], [21, -4, 0.6, 46, 7], [0, 19, 42, 0.6, 1.1]] as const) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wall);
      m.position.set(x, h / 2, z);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      if (h < 2) continue;
      // Work lamps along it, on the inside face.
      const lampAt = (k: number) => (w > 1 ? new THREE.Vector3(k * 7, h - 1.6, z + 0.4) : new THREE.Vector3(x - Math.sign(x) * 0.4, h - 1.6, -4 + k * 7));
      for (let k = -2; k <= 2; k++) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(w > 1 ? 1.4 : 0.15, 0.25, d > 1 ? 1.4 : 0.15), lamp);
        l.position.copy(lampAt(k));
        g.add(l);
        const at = lampAt(k);
        this.yardLights.push(this.inYard(at.x, at.y, at.z));
      }
    }
    // And the lamp on the truck's back, over the vault's door.
    this.yardLights.push(this.inYard(0, 4, 1.5));
    // The truck the real vault came home in, backed up with its ramp down to the vault's back.
    const truck = new GarbageTruck();
    const truckZ = -1.5 - 1 + RAMP_FOOT;
    truck.group.position.set(0, 0, truckZ);
    truck.group.rotation.y = Math.PI;
    truck.setHopper(0.75);
    truck.setRamp(1);
    truck.workLamp = true;
    g.add(truck.group);
    // Drums and pallets along the walls.
    const drum = new THREE.MeshStandardMaterial({ color: 0x2f5d8a, roughness: 0.6, metalness: 0.3 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x8a4a2a, roughness: 0.8, metalness: 0.2 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x9a7a4e, roughness: 0.9 });
    for (const [x, z, m] of [[-9, -8, drum], [-8.2, -9.1, rust], [-9.6, -9.4, drum], [10, -3, rust], [10.8, -4.1, drum]] as const) {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.2, 14), m);
      d.position.set(x, 0.6, z);
      d.castShadow = true;
      g.add(d);
    }
    for (const [x, z, n] of [[-11, 2, 3], [12, -12, 2], [-12.5, -14, 4]] as const) {
      for (let i = 0; i < n; i++) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.2), wood);
        p.position.set(x + (i % 2) * 0.1, 0.35 + i * 0.72, z);
        p.rotation.y = i * 0.12;
        p.castShadow = p.receiveShadow = true;
        g.add(p);
      }
    }
    const real = ctx.vault.mesh.clone();
    real.position.set(0, 1.27, 0);
    real.rotation.set(0, 0, 0);
    openVault(real, 0, true);
    g.add(real);
    this.realVault = real;
    // The crew round it, in their overalls: one at the door (the side it swings away from), one each side.
    for (const [x, z, face, suit] of [
      [1.9, 2.4, -1.95, 0xff7a1a],
      [-2.9, 0.4, 1.35, 0xff7a1a],
      [2.9, -0.7, -1.2, 0x2b4a6e],
    ] as const) {
      const f = buildFigure({ suit, skin: [0x7a5236, 0x5b3a26, 0xc89f7e][this.crew.length % 3], hat: suit === 0xff7a1a ? 0xf2c200 : undefined, bands: suit === 0xff7a1a });
      f.group.position.set(x, 0, z);
      f.group.rotation.y = face;
      g.add(f.group);
      this.crew.push(f);
    }
    ctx.scene.add(g);
    this.set = g;
    this.ctx.voice.stop();
  }

  /** The hideout, `t` s into a shot: the crew waiting, then (`open`) the door swinging wide on the money and the crew cheering. */
  private payday(t: number, open: boolean): void {
    const real = this.realVault;
    if (!real) return;
    if (!open) {
      openVault(real, 0, true);
      this.crew.forEach((f, i) => (i === 0 ? wave(f, t, 'R') : stand(f)));
      return;
    }
    if (t > 0.3) this.event('payClank', () => this.ctx.sound.clank());
    openVault(real, ease(THREE.MathUtils.clamp((t - 0.3) / 1.3, 0, 1)), true);
    if (t > 0.9)
      this.event('cash', () => {
        this.ctx.fx.money(this.inYard(0, 1.2, 2), 320);
        this.ctx.sound.ping(1568, 0.14, 0.5);
      });
    this.crew.forEach((f, i) => (t > 1.0 ? cheer(f, t + i * 0.3) : stand(f)));
  }

  /** The end of it, however far the scene got (it can be skipped): everything as the scene leaves it. */
  finish(): void {
    const { ctx } = this;
    if (!this.start) this.stage();
    this.time = Math.max(this.time, 22);
    this.advance(0);
    openVault(ctx.vault.mesh, 1, !this.decoy);
    ctx.hud.hint('');
  }

  private event(key: string, fn: () => void): void {
    if (this.once.has(key)) return;
    this.once.add(key);
    fn();
  }
}
