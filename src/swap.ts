import * as THREE from 'three';
import { NEWS } from './broadcast';
import { ease, type Shot } from './cutscene';
import { BODY_BACK, FLOOR, FRONT, GarbageTruck, INSIDE, RAMP_FOOT, STEP } from './garbageTruck';
import type { MomentContext } from './moments';
import { beckon, buildFigure, cheer, type Figure, reach, stand, wave } from './people';
import { RAPIER, yawQuat } from './physics';
import { Path } from './roads';
import { OVERPASS, underOverpass } from './roadmap';
import { CABLE_TOW_LENGTH, CableLine } from './vault';
import type { Vehicle } from './vehicle';

/*
 * The swap, as the film has it, under the Barbosa overpass: Gisele's garbage truck
 * is parked under the deck with its hopper up and the ramp down, the decoy waiting
 * in front of it under a tarp. The convoy straddles the truck and the vault rides up
 * the ramp; Tej, on the back step, pulls the pins as it goes in and the hopper comes
 * down on it; the cars roll on past the truck dragging the hooks, Han and Roman clip
 * them onto the decoy, and the convoy pulls it out from under its tarp and away into
 * the rain. A cruiser or two come through after and drive straight past the parked
 * truck, its back under a tarp, Tej waving.
 *
 * Laid out in the overpass's frame (OVERPASS.frame): z along the expressway the way
 * the route runs, 0 under the middle of the deck; x across, left positive.
 */

/** The truck's line, in the right-hand lanes. */
const LINE = -4;
/** The truck's middle, parked under the deck: its ramp's foot just out from under the near edge. */
const TRUCK_Z = -4;
/** Car centres to the vault's centre. */
const TOW = CABLE_TOW_LENGTH + 2.5;
/** Each car's distance from the line: in formation, and spread round the truck. */
const BESIDE = 2.75;
const WIDE = 3.4;
const VAULT_Y = 1.27;
/** The decoy's middle, in front of the truck, under the far edge of the deck. */
const DECOY_Z = TRUCK_Z + FRONT + 7;
/** The scene starts with the cars' noses this far short of the ramp's foot... */
const TRIGGER_GAP = 6;
/** ...the convoy's centre this far behind the truck's middle; and this far ahead when the vault's nose reaches the sill. */
const R0 = RAMP_FOOT - TRIGGER_GAP - 2.5;
const R_POP = BODY_BACK + TOW - 1.5;
/** The vault's nose reaches the sill (s into the scene) with the convoy doing V_POP m/s; it takes T_IN s to slide in. */
const T_POP = 2.2;
const V_POP = 10;
const T_IN = 0.75;
/** After the pop the cars ease down to a crawl past the truck, and floor it once the hooks are on the decoy. */
const V_CRAWL = 2.5;
const A_SLOW = 6;
const A_OUT = 4;
const V_OUT = 24;
/** The loose hooks drag this far behind each car's tow point. */
const HOOK_TRAIL = 2.8;
/** Han and Roman wait at the decoy's front corners. */
const CATCH_Z = DECOY_Z + 2.1;
const BY_TIME = 4.6;

/** Cubic Hermite from 0 to 1 leaving at slope m0 and arriving at m1, and its slope. */
const hermite = (k: number, m0: number, m1: number) => (k ** 3 - 2 * k ** 2 + k) * m0 + (-2 * k ** 3 + 3 * k ** 2) + (k ** 3 - k ** 2) * m1;
const hermiteSlope = (k: number, m0: number, m1: number) => (3 * k ** 2 - 4 * k + 1) * m0 + (-6 * k ** 2 + 6 * k) + (3 * k ** 2 - 2 * k) * m1;
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
/** How high the ramp is under a point `z` in the truck's frame (0 on the road, FLOOR at the sill). */
const rampLift = (z: number) => THREE.MathUtils.clamp((z - RAMP_FOOT) / (BODY_BACK - RAMP_FOOT), 0, 1) * FLOOR;

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.voice.speak(who, line, { channel: 'radio', onStart: () => ctx.hud.radio(who, line) });
}

/** A tarp: a box a size up from what it covers, its sides pushed in and out a little like cloth (origin at its foot). */
function buildTarp(w: number, h: number, d: number): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d, 6, 5, 6);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Folds hang off the top edge; the hem flares at the bottom.
    const fold = Math.sin(x * 3.1 + z * 1.7) * 0.06 + Math.sin(z * 4.3 - x) * 0.04;
    const flare = y < -h * 0.35 ? (-h * 0.35 - y) * 0.18 : 0;
    const k = 1 + flare / (w / 2);
    p.setXYZ(i, x * k + fold, y - (Math.abs(x) > w * 0.47 && Math.abs(z) > d * 0.47 ? 0.05 : 0), z * k - fold);
  }
  geo.translate(0, h / 2, 0);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2c3a4a, roughness: 0.92, side: THREE.DoubleSide }));
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** The convoy's centre along the expressway (z), its speed, and the moments the take turns on, worked out once at the start. */
interface Plan {
  /** Seconds into the scene: the hooks reach Han and Roman, the cables go taut on the decoy. */
  tCatch: number;
  tYank: number;
  /** Where the convoy's centre is and how fast it's going `t` s in. */
  at(t: number): { z: number; v: number };
}

/** Where the scene puts everyone, for the frame it's on. */
interface Staging {
  t: number;
  plan: Plan;
  /** How far off their staged start everyone was (world offsets and headings), eased away as the scene runs. */
  off: { player: THREE.Vector3; partner: THREE.Vector3; vault: THREE.Vector3 };
  turn: { player: number; partner: number; vault: THREE.Quaternion };
  /** The convoy's centre (z in the overpass's frame) and speed. */
  cz: number;
  speed: number;
  /** Held while the camera is away at the drive-by. */
  frozen: boolean;
}

export class OverpassSwap {
  state: 'waiting' | 'called' | 'lineup' | 'swapping' | 'clear' = 'waiting';
  /** How well the vault was lined up with the ramp when the scene took over (0..1). */
  quality = 0;
  private truck = new GarbageTruck();
  /** The real vault once it's off the cables (a copy of the vault's mesh), and the decoy until the vault in the physics takes its place. */
  private real: THREE.Object3D;
  private decoy: THREE.Object3D;
  private tarp = buildTarp(3.75, 2.85, 3.75);
  private tarpFly: { vel: THREE.Vector3; spin: THREE.Vector3; landed: number } | null = null;
  /** The tarp Tej pulls over the truck's back once the vault's in. */
  private cover = buildTarp(3.9, 3.5, 2.3);
  /** The cables while they're loose: off the real vault, dragging behind the cars to the decoy. */
  private loose: CableLine[] = [];
  private tej: Figure;
  private han: Figure;
  private roman: Figure;
  private hooked: 'real' | 'none' | 'decoy' = 'real';
  private time = 0;
  private lineupTime = 0;
  private slowed = false;
  private stage: Staging | null = null;
  private once = new Set<string>();
  /** The cruisers that come through in the drive-by. */
  private cops: { v: Vehicle; x: number; z: number }[] = [];
  /** Solid once the swap's done (till then traffic would pile into it). */
  private parked: RAPIER.Collider | null = null;
  private road = new Path(OVERPASS.road);
  /** The crossing, along the expressway's line. */
  private s0 = this.road.project(OVERPASS.frame.origin);

  constructor(private ctx: MomentContext) {
    const f = OVERPASS.frame;
    const { scene, vault } = ctx;
    scene.add(this.truck.group);
    this.truck.group.position.copy(f.toWorld(LINE, TRUCK_Z));
    this.truck.group.rotation.y = f.heading;
    // The decoy waits in front of it under its tarp.
    const d = f.toWorld(LINE, DECOY_Z);
    this.decoy = vault.mesh.clone();
    this.decoy.position.copy(d).setY(VAULT_Y);
    this.decoy.rotation.set(0, f.heading, 0);
    this.real = vault.mesh.clone();
    this.real.visible = false;
    this.tarp.position.copy(d);
    this.tarp.rotation.y = f.heading + 0.04;
    // The cover rides on the truck, over the hopper, once it's down.
    this.cover.position.set(0, 0.95, BODY_BACK - 0.85);
    this.cover.visible = false;
    this.truck.group.add(this.cover);
    scene.add(this.decoy, this.real, this.tarp);
    for (let i = 0; i < 2; i++) this.loose.push(new CableLine(scene));
    // Tej rides the truck's left-hand back step, facing the convoy coming in; Han and Roman wait at the decoy's front corners.
    this.tej = buildFigure({ suit: 0xff7a1a, skin: 0x7a5236, hat: 0xf2c200, bands: true });
    this.tej.group.position.set(STEP.x, STEP.y, STEP.z);
    this.tej.group.rotation.y = Math.PI;
    this.truck.group.add(this.tej.group);
    this.han = buildFigure({ suit: 0xff7a1a, skin: 0xb98a63, hat: 0xf2c200, bands: true });
    this.roman = buildFigure({ suit: 0xff7a1a, skin: 0x5b3a26, hat: 0xf2c200, bands: true });
    for (const [fig, side] of [[this.han, 1], [this.roman, -1]] as const) {
      fig.group.position.copy(f.toWorld(LINE + side * 1.1, CATCH_Z));
      fig.group.rotation.y = f.heading + Math.PI + side * 0.5;
      scene.add(fig.group);
    }
  }

  /** The swap has happened (the vault on the cables is the decoy). */
  get done(): boolean {
    return this.state === 'clear';
  }

  /** Waiting for the convoy (for the beacon and the map). */
  get pending(): boolean {
    return this.state === 'waiting' || this.state === 'called' || this.state === 'lineup';
  }

  /** The line to drive while lining up (painted on the road), else null. */
  guide(): Path | null {
    if (this.state !== 'lineup' && this.state !== 'called') return null;
    const f = OVERPASS.frame;
    if (this.state === 'called' && f.toLocal(this.ctx.player.position).z < -110) return null;
    return new Path([f.toWorld(LINE, -70), f.toWorld(LINE, TRUCK_Z + RAMP_FOOT - 0.6)]);
  }

  /** While lining up, the foot of the truck's ramp (the overhead view looks through the deck to it), else null. */
  focus(): THREE.Vector3 | null {
    return this.state === 'lineup' ? this.truck.toWorld(0, 0, RAMP_FOOT) : null;
  }

  /** While lining up: where the player's car should run, left of the road's middle (m), for the test autopilot. */
  lineupOffset(): number | null {
    return this.state === 'lineup' || this.state === 'called' ? LINE + this.ctx.crew.side * BESIDE : null;
  }

  /** Per frame of the chase. */
  update(dt: number): void {
    this.time += dt;
    this.animateTarp(dt);
    const { player, vault } = this.ctx;
    vault.glow(underOverpass(vault.position, 2) ? 1 : 0);
    const f = OVERPASS.frame;
    const l = f.toLocal(this.convoyCentre());
    const along = player.forward.dot(f.z);
    if (this.state === 'waiting' && l.z > -320 && l.z < -120 && Math.abs(l.x) < OVERPASS.hw + 10 && along > 0.5) {
      this.state = 'called';
      say(this.ctx, 'MIA', 'Barbosa overpass coming up. Gisele’s parked under it with the truck, ramp down. Line the vault up with her ramp!');
    }
    if ((this.state === 'waiting' || this.state === 'called') && l.z > -110 && l.z < TRUCK_Z + R0 && Math.abs(l.x) < OVERPASS.hw && along > 0.3) this.startLineup();
    if (this.state === 'lineup') this.lineup(dt, l);
    if (this.state === 'waiting' || this.state === 'called') {
      stand(this.han);
      stand(this.roman);
      stand(this.tej);
    }
    if (this.state === 'clear') wave(this.tej, this.time, 'L');
  }

  /** Debug starts past the overpass: the swap happened off screen. */
  skipAhead(): void {
    if (this.state === 'clear') return;
    this.state = 'clear';
    this.endState(false);
  }

  // ---------------------------------------------------------------- the line-up

  private startLineup(): void {
    const { ctx } = this;
    this.state = 'lineup';
    this.lineupTime = 0;
    // Nobody else in the way under there, and the cops out of sight behind are lost under the deck.
    ctx.clearStreets((p) => (underOverpass(p, 30) || OVERPASS.frame.toLocal(p).z < -60) && !ctx.police.visible(p));
    say(ctx, 'GISELE', 'I see you. Bring it straight up my ramp, and don’t you brake till I say.');
  }

  private lineup(dt: number, l: { x: number; z: number }): void {
    const { ctx } = this;
    const { hud, director } = ctx;
    this.lineupTime += dt;
    beckon(this.tej, this.time);
    // Time slows as they come up on the truck, so there's a moment to line it up.
    if (!this.slowed && l.z > TRUCK_Z + R0 - 40) {
      this.slowed = true;
      director.slowmo(0.45, 3.2);
    }
    this.quality = THREE.MathUtils.clamp(1 - Math.abs(l.x - LINE) / 3.2, 0, 1);
    const prompt = this.quality > 0.85 ? 'DEAD CENTRE  —  KEEP IT STRAIGHT' : l.x > LINE ? 'EASE RIGHT  —  ONTO THE LINE' : 'EASE LEFT  —  ONTO THE LINE';
    hud.meter('LINE UP', this.quality, prompt);
    // The cars' noses are coming up on the foot of the ramp: the scene takes it from here.
    if (l.z >= TRUCK_Z + R0 || this.lineupTime > 25) this.begin();
  }

  private begin(): void {
    const { ctx } = this;
    const { player, partner, vault } = ctx;
    const f = OVERPASS.frame;
    this.state = 'swapping';
    ctx.hud.meter(null);
    ctx.holdPolice(true);
    ctx.clearStreets((p) => underOverpass(p, 60));
    const cz0 = TRUCK_Z + R0;
    const start = this.lineUp(cz0, BESIDE);
    const vaultStart = f.toWorld(LINE, cz0 - TOW, VAULT_Y);
    const v0 = Math.max(0, player.forwardSpeed);
    this.stage = {
      t: 0,
      plan: this.plan(v0),
      off: { player: player.position.sub(start.player), partner: partner.position.sub(start.partner), vault: vault.position.sub(vaultStart) },
      turn: { player: angleDiff(f.heading, player.heading), partner: angleDiff(f.heading, partner.heading), vault: vault.mesh.quaternion.clone() },
      cz: cz0,
      speed: v0,
      frozen: false,
    };
    vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    ctx.cutscene(this.shots(), () => this.finish());
  }

  /**
   * The convoy through the take, from `v0` m/s: braking onto the ramp to reach the sill at
   * V_POP, easing to a crawl past the truck till Han and Roman have the hooks, then flat out
   * (the cables go taut on the decoy on the way).
   */
  private plan(v0: number): Plan {
    const d = R_POP - R0;
    const m0 = THREE.MathUtils.clamp((v0 * T_POP) / d, 0, 2.6);
    const m1 = (V_POP * T_POP) / d;
    // March it through from the pop, in small steps, to find the catch and the yank.
    const DT = 1 / 240;
    const zs: number[] = [];
    const vs: number[] = [];
    let z = TRUCK_Z + R_POP;
    let v = V_POP;
    let tCatch = 0;
    let tYank = 0;
    for (let i = 0; i < 240 * 30 && !(tYank && v >= V_OUT); i++) {
      const t = T_POP + i * DT;
      zs.push(z);
      vs.push(v);
      // The hooks reach Han and Roman's hands; the cables go taut on the decoy.
      if (!tCatch && z - 2.6 - HOOK_TRAIL >= CATCH_Z - 0.6) tCatch = t;
      if (!tYank && z - TOW >= DECOY_Z) tYank = t;
      v = tCatch ? Math.min(V_OUT, v + A_OUT * DT) : Math.max(V_CRAWL, v - A_SLOW * DT);
      z += v * DT;
    }
    return {
      tCatch,
      tYank,
      at: (t: number) => {
        if (t <= T_POP) {
          const k = t / T_POP;
          return { z: TRUCK_Z + R0 + d * hermite(k, m0, m1), v: (d * hermiteSlope(k, m0, m1)) / T_POP };
        }
        const i = Math.floor((t - T_POP) / DT);
        if (i < zs.length) return { z: zs[i], v: vs[i] };
        return { z: zs[zs.length - 1] + V_OUT * (t - T_POP - (zs.length - 1) * DT), v: V_OUT };
      },
    };
  }

  // ---------------------------------------------------------------- the scene

  private shots(): Shot[] {
    const { ctx } = this;
    const f = OVERPASS.frame;
    const me = ctx.crew.player;
    const plan = this.stage!.plan;
    const step = (dt: number) => this.advance(dt);
    const truckPt = (x: number, y: number, z: number) => this.truck.toWorld(x, y, z);
    const sIn = 1.6;
    const sBack = T_POP + T_IN + 0.5;
    const sSide = Math.max(sBack + 0.9, plan.tCatch - 0.8);
    const sOut = Math.max(sSide + 1.5, plan.tYank + 1.0);
    const sExit = sOut + 2.3;
    return [
      {
        // Riding on top of the vault: the truck's open hopper dead ahead under the deck, a car either side.
        duration: sIn,
        update: (_t, dt) => step(dt),
        camera: () => {
          const v = this.ctx.vault.position;
          return { pos: v.clone().addScaledVector(f.z, -0.6).setY(v.y + 1.9), look: truckPt(0, 2.0, BODY_BACK + 1.0), fov: 62 };
        },
        lines: [[0.1, 'GISELE', 'Steady… steady… now!']],
      },
      {
        // Off the truck's left-rear quarter, close: the vault goes up the ramp and in, Tej pulls the pins, the hopper comes down.
        duration: sBack - sIn,
        update: (_t, dt) => step(dt),
        camera: (k) => ({ pos: truckPt(4.9 - k * 0.3, 2.0 + k * 0.4, BODY_BACK - 5.0 + k * 0.8), look: truckPt(0.2, 1.9, BODY_BACK - 0.4), fov: 50 }),
        lines: [
          [T_POP - sIn + 0.05, 'TEJ', 'Pins out!'],
          [T_POP + T_IN - sIn + 0.2, 'GISELE', 'It’s in. Shutting it.'],
        ],
      },
      {
        // Low beside the truck's back, looking up its side: the car rolls on past the cab, its hook dragging and sparking behind it.
        duration: sSide - sBack,
        update: (_t, dt) => step(dt),
        // Tilted up a little so the edge of the deck overhead is in the frame.
        camera: (k) => ({ pos: truckPt(5.6, 1.1, BODY_BACK + 0.5 + k * 1.5), look: truckPt(3.6, 3.2, FRONT + 14), fov: 44 }),
      },
      {
        // Low in front of the decoy, off to one side: the cars roll by, Han and Roman catch the hooks and clip them on, and it's yanked out from under the tarp.
        duration: sOut - sSide,
        update: (_t, dt) => step(dt),
        camera: () => ({ pos: f.toWorld(LINE + 7.5, DECOY_Z + 10, 1.2), look: f.toWorld(LINE + 0.5, DECOY_Z, 1.1), fov: 48 }),
        lines: [
          [Math.max(0.1, plan.tCatch - sSide), 'HAN', 'Hooked!'],
          [plan.tYank - sSide + 0.05, 'ROMAN', 'Go, go, go!'],
        ],
      },
      {
        // Out past the deck, low on the road: the convoy comes out from under it, dragging the decoy into the rain.
        duration: sExit - sOut,
        update: (_t, dt) => step(dt),
        camera: (k) => ({ pos: f.toWorld(LINE - 7.5, OVERPASS.deckHalf + 34 + k * 2, 1.0), look: f.toWorld(LINE - 1, OVERPASS.deckHalf + 4, 1.3), fov: 44 }),
        lines: [[0.3, me, 'Now let’s give them a show.']],
      },
      {
        // Beside the truck's cab, looking back past its covered-up back (Tej waving on the step): the cruisers come under the deck and race straight past.
        duration: BY_TIME,
        start: () => {
          if (this.stage) this.stage.frozen = true;
        },
        update: (t, dt) => {
          step(dt);
          this.driveBy(t, dt);
        },
        camera: (k) => ({ pos: truckPt(4.4 + k * 0.3, 1.5, FRONT - 1.5), look: truckPt(3.4, 1.4, BODY_BACK - 30), fov: 50 }),
        lines: [
          [1.7, 'TEJ', 'Evening, officers!'],
          [3.4, 'HAN', 'Not one of them looked twice.'],
        ],
      },
    ];
  }

  /** The scene, `dt` s further on: everyone where the take puts them. */
  private advance(dt: number): void {
    const st = this.stage;
    if (!st) return;
    const { ctx } = this;
    const { player, partner, vault, fx, sound, director } = ctx;
    const f = OVERPASS.frame;
    st.t += dt;
    const t = st.t;
    const fade = 1 - ease(Math.min(1, t / 1.5));
    const { tCatch, tYank } = st.plan;

    // The convoy.
    if (!st.frozen) {
      const c = st.plan.at(t);
      st.cz = c.z;
      st.speed = c.v;
      // Spread round the truck, then back into formation once the decoy's on.
      const spread = t < 1.2 ? THREE.MathUtils.lerp(BESIDE, WIDE, ease(t / 1.2)) : t < tYank + 0.3 ? WIDE : THREE.MathUtils.lerp(WIDE, BESIDE, ease(Math.min(1, (t - tYank - 0.3) / 1.2)));
      const p = this.lineUp(st.cz, spread);
      this.drive(player, p.player.addScaledVector(st.off.player, fade), f.heading + st.turn.player * fade, st.speed);
      this.drive(partner, p.partner.addScaledVector(st.off.partner, fade), f.heading + st.turn.partner * fade, st.speed);
      // Hard on the brakes coming in, smoke off the rear tyres.
      if (t < T_POP && c.v > 12) for (const car of [player, partner]) for (const w of car.rearWheels()) if (Math.random() < 0.4) fx.tireSmoke(w, 0.5, f.z.clone().multiplyScalar(2));
    }

    // The vault: on the cables up the ramp to the sill, then sliding on in to the bulkhead.
    if (t < T_POP) {
      const vz = st.cz - TOW;
      const local = vz - TRUCK_Z;
      const front = rampLift(local + 1.5);
      const back = rampLift(local - 1.5);
      const pitch = Math.atan2(front - back, 3);
      const at = f.toWorld(LINE, vz, VAULT_Y + (front + back) / 2).addScaledVector(st.off.vault, fade);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, f.heading, 0, 'YXZ')).slerp(st.turn.vault, fade);
      this.setVault(at, q);
      // Steel on the ramp's lip.
      if (front > 0.02 && Math.random() < 0.7) fx.scrape(this.truck.toWorld((Math.random() - 0.5) * 2.6, 0.1, RAMP_FOOT + 0.3), f.z.clone().multiplyScalar(-6), 0.8);
    } else {
      this.event('pop', () => this.pop());
      const k = Math.min(1, (t - T_POP) / T_IN);
      const from = R_POP - TOW;
      const m0 = (V_POP * T_IN) / (INSIDE - from);
      const z = from + (INSIDE - from) * hermite(k, m0, 0);
      const front = rampLift(z + 1.5);
      const back = rampLift(z - 1.5);
      this.real.position.set(0, VAULT_Y + (front + back) / 2, z);
      this.real.rotation.set(-Math.atan2(front - back, 3), 0, 0);
      if (k >= 1)
        this.event('slam', () => {
          this.truck.lurch(1);
          sound.crash(0.7);
          director.shake = Math.max(director.shake, 0.6);
          fx.puff(this.truck.toWorld(0, 1.5, BODY_BACK - 0.4), 8);
          this.truck.workLamp = false;
        });
    }

    // The ramp stows and the hopper comes down, with a hiss and a clank; then Tej pulls the cover over.
    const rampK = THREE.MathUtils.clamp((t - T_POP - T_IN - 0.05) / 0.5, 0, 1);
    const hopK = THREE.MathUtils.clamp((t - T_POP - T_IN - 0.3) / 0.55, 0, 1);
    if (rampK > 0) this.truck.setRamp(1 - ease(rampK));
    if (hopK > 0) {
      this.event('hiss', () => sound.hiss(0.7));
      this.truck.setHopper(1 - ease(hopK));
      if (hopK >= 1) this.event('shut', () => sound.clank());
    }
    const coverK = THREE.MathUtils.clamp((t - T_POP - T_IN - 1.2) / 0.8, 0, 1);
    if (coverK > 0) {
      this.cover.visible = true;
      this.cover.scale.set(1, ease(coverK), 0.4 + 0.6 * ease(coverK));
    }

    // The loose cables: out of the hopper and dragging behind the cars (sparking) until Han and Roman catch them,
    // then from each car to the decoy's door, slack, until they go taut.
    if (t >= T_POP && t < tCatch) {
      for (const [i, car] of [player, partner].entries()) {
        const a = car.towPoint();
        const trail = a.clone().addScaledVector(car.forward, -HOOK_TRAIL).setY(0.1);
        // Pulled out over the sill in the first moment after the pins come out.
        const k = Math.min(1, (t - T_POP) / 0.35);
        const hook = this.truck.toWorld(this.anchorSide(car) * 0.9, FLOOR + 0.4, BODY_BACK + 0.2).lerp(trail, ease(k));
        if (k >= 1 && Math.random() < 0.8) fx.scrape(hook, car.forward.multiplyScalar(st.speed), 0.6);
        this.loose[i].draw(a, a.clone().lerp(hook, 0.6).setY(Math.min(a.y, hook.y) + 0.05), hook, car.heading);
      }
    }
    if (t >= tCatch) this.event('catch', () => this.catchHooks());
    if (t >= tYank) {
      this.event('yank', () => this.yank());
      if (!st.frozen) {
        const u = t - tYank;
        const hop = u < 0.35 ? Math.sin((u / 0.35) * Math.PI) * 0.28 : 0;
        this.setVault(f.toWorld(LINE, st.cz - TOW, VAULT_Y + hop), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.heading));
        if (u < 1.4 && Math.random() < 0.8) fx.scrape(vault.position.setY(0.08).addScaledVector(f.x, (Math.random() - 0.5) * 2.6), f.z.clone().multiplyScalar(st.speed), 0.8);
      }
    }

    // The crew: Tej beckons them up the ramp, pulls the pins, then stands and watches; Han and Roman
    // beckon, crouch for the hooks, then cheer them away and slip off.
    if (t < T_POP) beckon(this.tej, t);
    else stand(this.tej);
    for (const fig of [this.han, this.roman]) {
      if (t < tCatch - 0.5) beckon(fig, t);
      else if (t < tYank) reach(fig, Math.min(1, (t - (tCatch - 0.5)) / 0.4));
      else if (t < tYank + 2.5) {
        stand(fig);
        cheer(fig, t);
      } else fig.group.visible = false;
    }
    this.animateTarp(dt);
  }

  /** The anchor on the vault's door that `car`'s cable goes to (the vault's left as it faces the cars). */
  private anchorSide(car: Vehicle): number {
    return car === this.ctx.player ? this.ctx.crew.side : -this.ctx.crew.side;
  }

  /** The vault's nose is at the sill: the pins come out, and the real vault becomes the truck's. */
  private pop(): void {
    const { ctx } = this;
    for (const c of ctx.cables) ctx.fx.burst(ctx.vault.anchorWorld(c.side), 0.45);
    if (this.hooked === 'real') {
      this.hooked = 'none';
      ctx.unhook();
    }
    ctx.sound.clank();
    setTimeout(() => ctx.sound.clank(), 160);
    this.handOver(true);
  }

  /** Han and Roman snap the hooks onto the decoy's door. */
  private catchHooks(): void {
    const { ctx } = this;
    for (const l of this.loose) {
      ctx.fx.burst(l.hook.position.clone().setY(1.0), 0.35);
      l.hide();
    }
    if (this.hooked !== 'decoy') {
      this.hooked = 'decoy';
      ctx.hook();
    }
    ctx.sound.clank();
  }

  /** The cables go taut and the decoy jerks into motion; its tarp flies off. */
  private yank(): void {
    const { ctx } = this;
    const f = OVERPASS.frame;
    for (const l of this.loose) l.hide();
    ctx.sound.crash(0.5);
    ctx.fx.puff(f.toWorld(LINE, DECOY_Z), 10);
    ctx.director.shake = Math.max(ctx.director.shake, 0.5);
    this.tarpFly = {
      vel: f.z.clone().multiplyScalar(-1.5).add(new THREE.Vector3(0, 6, 0)).addScaledVector(f.x, 2.0),
      spin: new THREE.Vector3(-2.2, 0.9, -1.4),
      landed: 0,
    };
  }

  /** The take's last shot: two cruisers come under the deck, flat out, straight past the parked truck. */
  private driveBy(t: number, dt: number): void {
    const { ctx } = this;
    const f = OVERPASS.frame;
    wave(this.tej, t, 'L');
    if (!this.cops.length && t > 0.5) {
      for (const [x, z] of [[4.5, TRUCK_Z - 60], [8.5, TRUCK_Z - 72]] as const) this.cops.push({ v: ctx.police.spawnAt(f.toWorld(x, z), f.heading), x, z });
      ctx.sound.ping(900, 0.08, 0.4);
    }
    for (const c of this.cops) {
      c.z += 27 * dt;
      this.drive(c.v, f.toWorld(c.x, c.z), f.heading, 27);
    }
  }

  /** The end of the scene, however far it got (it can be skipped): the real vault shut away in the parked truck, the convoy rolling on with the decoy. */
  private finish(): void {
    if (this.state !== 'swapping') return;
    const { ctx } = this;
    const { vault, player, partner } = ctx;
    this.state = 'clear';
    this.endState(true);
    vault.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    // Out past the overpass, rolling, on the road (which may curve past it).
    const s = this.s0 + OVERPASS.deckHalf + 110;
    const ahead = this.road.tangent(s);
    if (this.hooked === 'real') ctx.unhook();
    ctx.placeConvoy(this.road.at(s), ahead, this.road.at(s - TOW));
    if (this.hooked !== 'decoy') {
      this.hooked = 'decoy';
      ctx.hook();
    }
    const v = ahead.clone().multiplyScalar(17);
    for (const b of [player.body, partner.body, vault.body]) b.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    // The cruisers that came through are well behind.
    for (const c of this.cops) c.v.body.setLinvel({ x: OVERPASS.frame.z.x * 26, y: 0, z: OVERPASS.frame.z.z * 26 }, true);
    this.cops = [];
    this.stage = null;
    ctx.holdPolice(false);
    const clean = this.quality > 0.85;
    const bonus = clean ? 1250 : 750;
    ctx.hud.banner('THE SWAP', clean ? `PERFECT LINE-UP  +${bonus}` : `THE REAL VAULT IS IN THE TRUCK  +${bonus}`, 2.4);
    ctx.reward(bonus, 0.35);
    setTimeout(() => say(ctx, 'MIA', 'Swap’s done. The real one’s sitting in a garbage truck under the overpass. Now make them chase the fake!'), 900);
    setTimeout(() => ctx.hud.news(NEWS.overpass), 2600);
  }

  /** Everything as the swap leaves it: the real vault shut in the parked truck under its cover, the tarp on the road. */
  private endState(live: boolean): void {
    const f = OVERPASS.frame;
    this.handOver(live);
    this.truck.group.add(this.real);
    this.real.position.set(0, VAULT_Y + FLOOR, INSIDE);
    this.real.rotation.set(0, 0, 0);
    this.truck.setRamp(0);
    this.truck.setHopper(0);
    this.truck.braking(false);
    this.truck.workLamp = false;
    this.cover.visible = true;
    this.cover.scale.set(1, 1, 1);
    for (const l of this.loose) l.hide();
    if (!this.parked) {
      const at = f.toWorld(LINE, TRUCK_Z + 0.9);
      const body = this.ctx.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.parked = this.ctx.world.createCollider(RAPIER.ColliderDesc.cuboid(1.8, 2.0, 5.4).setTranslation(at.x, 2.0, at.z).setRotation(yawQuat(f.heading)), body);
    }
    if (!this.tarpFly || this.tarpFly.landed < 1) {
      // Where it came down, crumpled on the road.
      this.tarpFly = { vel: new THREE.Vector3(), spin: new THREE.Vector3(), landed: 1 };
      this.tarp.position.copy(f.toWorld(LINE + 1.4, DECOY_Z - 1.5, 0.12));
      this.tarp.rotation.set(0, f.heading + 0.6, 0);
      this.tarp.scale.set(1.25, 0.08, 1.15);
    }
    this.han.group.visible = this.roman.group.visible = false;
    stand(this.tej);
  }

  // ---------------------------------------------------------------- staging

  /** The convoy's centre: between the two cars. */
  private convoyCentre(): THREE.Vector3 {
    return this.ctx.player.position.add(this.ctx.partner.position).multiplyScalar(0.5);
  }

  /** The two cars side by side either side of the truck's line, `spread` m out, `z` along (world positions). */
  private lineUp(z: number, spread: number): { player: THREE.Vector3; partner: THREE.Vector3 } {
    const f = OVERPASS.frame;
    const s = this.ctx.crew.side;
    return { player: f.toWorld(LINE + s * spread, z), partner: f.toWorld(LINE - s * spread, z) };
  }

  /** Put a car at `p` facing `heading`, rolling forward at `speed` (so its wheels turn). */
  private drive(car: Vehicle, p: THREE.Vector3, heading: number, speed: number): void {
    car.place(p, heading);
    car.body.setLinvel({ x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, true);
    car.forwardSpeed = speed;
  }

  private setVault(p: THREE.Vector3, q: THREE.Quaternion): void {
    const b = this.ctx.vault.body;
    b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  /**
   * The real vault comes out of the physics (a copy of its mesh goes into the truck),
   * and the vault in the physics takes the decoy's place, under the tarp: from here
   * on, that's what the convoy tows. `live`: move the physics vault (not on a debug
   * start, which places it itself).
   */
  private handOver(live: boolean): void {
    if (this.real.visible) return;
    const { vault } = this.ctx;
    const f = OVERPASS.frame;
    this.real.visible = true;
    this.decoy.visible = false;
    this.truck.group.add(this.real);
    if (!live) return;
    vault.place(f.toWorld(LINE, DECOY_Z), f.heading);
    vault.render();
  }

  private event(key: string, fn: () => void): void {
    if (this.once.has(key)) return;
    this.once.add(key);
    fn();
  }

  /** The tarp in the air after the yank: up and back, tumbling, then down in a heap. */
  private animateTarp(dt: number): void {
    const fly = this.tarpFly;
    if (!fly || fly.landed >= 1) return;
    const t = this.tarp;
    if (t.position.y > 0.15 || fly.vel.y > 0) {
      fly.vel.y -= 6 * dt;
      fly.vel.multiplyScalar(1 - 0.9 * dt);
      t.position.addScaledVector(fly.vel, dt);
      t.rotation.x += fly.spin.x * dt;
      t.rotation.y += fly.spin.y * dt;
      t.rotation.z += fly.spin.z * dt;
      // Billowing as it goes.
      const b = 1 + 0.12 * Math.sin(this.time * 11);
      t.scale.set(b, 1 / b, b);
      if (t.position.y <= 0.15 && fly.vel.y < 0) t.position.y = 0.15;
    } else {
      // Down: settling flat.
      fly.landed = Math.min(1, fly.landed + dt * 3);
      t.position.y = 0.12;
      t.rotation.x *= 1 - fly.landed;
      t.rotation.z *= 1 - fly.landed;
      t.scale.set(1.25, THREE.MathUtils.lerp(t.scale.y, 0.08, fly.landed), 1.15);
    }
  }
}
