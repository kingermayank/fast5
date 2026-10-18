import * as THREE from 'three';
import { NEWS } from './broadcast';
import { ease, type Shot } from './cutscene';
import { BODY_BACK, FLOOR, GarbageTruck, INSIDE, RAMP_FOOT, STEP } from './garbageTruck';
import type { MomentContext } from './moments';
import { beckon, buildFigure, cheer, type Figure, stand, wave } from './people';
import { RAPIER, yawQuat } from './physics';
import { Path } from './roads';
import { inTunnel, TUNNEL } from './roadmap';
import { CABLE_TOW_LENGTH } from './vault';
import type { Vehicle } from './vehicle';

/*
 * The rolling swap, laid out in the tunnel's frame: x across (left positive), z
 * along it from the entrance. Gisele's garbage truck waits inside with its hopper
 * up and the ramp down, and rolls off along the line as the convoy comes in. The
 * player threads the vault onto the ramp (the line-up); then, in one take, the
 * cars straddle the truck, the vault rides up into the hopper, the cables come off
 * and the hopper slams shut, the trailing hooks catch the rings on the decoy's
 * cables further on, and the decoy is yanked out from under its tarp.
 */

/** The line the truck drives and the convoy threads. */
const LINE = 0;
/** Car centres to the vault's centre. */
const TOW = CABLE_TOW_LENGTH + 2.5;
/** Each car's distance from the line: in formation, and spread round the truck and the decoy. */
const BESIDE = 2.75;
const WIDE = 3.4;
const VAULT_Y = 1.27;
/** The truck waits here (its middle) and rolls off at ROLL m/s as the convoy comes in, stopping at HOLD if it isn't caught. */
const WAIT_Z = 30;
const HOLD_Z = 50;
const ROLL = 4.5;
/** Where the truck is when the scene starts, as staged (the real start is eased into it). */
const Z0 = 44;
/** The scene starts with the cars' noses this far short of the ramp's foot... */
const TRIGGER_GAP = 6;
/** ...the convoy's centre this far behind the truck's then (m), and this far ahead when the vault's nose reaches the sill. */
const R0 = RAMP_FOOT - TRIGGER_GAP - 2.5;
const R_POP = BODY_BACK + TOW - 1.5;
/** The vault's nose reaches the sill (s into the scene), with the convoy doing V_POP m/s; it takes T_IN s to slide in. */
const T_POP = 2.5;
const V_POP = 12;
const T_IN = 0.85;
/** Then the truck pulls over to the right-hand lanes and stops, over T_PARK s. */
const T_VEER = T_POP + T_IN + 0.3;
const T_PARK = 6;
const PARK_X = -7.5;
const PARK_Z = Z0 + ROLL * T_VEER + (ROLL * T_PARK) / 1.5;
/** The convoy gathers speed slowly with the hooks trailing, then floors it once the decoy is on. */
const A_DRAG = 0.4;
const A_OUT = 3.6;
/** The decoy waits on the line under a tarp; its own cables lie out ahead of it to rings on the road. */
const DECOY_Z = 96;
const RING_OUT = 4.6;
const RING_Z = DECOY_Z + 1.5 + RING_OUT;
/** The cut cables' hooks drag this far behind each car's tow point. */
const HOOK_TRAIL = 2.8;
/** Convoy centre (z) as the scene stages it: at the pop, when the hooks catch the rings, and when the decoy's cables go taut. */
const CZ_POP = Z0 + ROLL * T_POP + R_POP;
const CZ_CATCH = RING_Z + 2.6 + HOOK_TRAIL;
const CZ_YANK = DECOY_Z + TOW;
const dragTime = (z: number) => (-V_POP + Math.sqrt(V_POP * V_POP + 2 * A_DRAG * (z - CZ_POP))) / A_DRAG;
const T_CATCH = T_POP + dragTime(CZ_CATCH);
const T_YANK = T_POP + dragTime(CZ_YANK);
const V_YANK = V_POP + A_DRAG * (T_YANK - T_POP);
/** Shot boundaries (s into the scene). */
const S_RIDE = 1.4;
const S_JAW = T_POP - 0.3;
const S_CATCH = T_POP + 1.9;
const S_OUT = T_YANK + 0.8;
const S_BY = S_OUT + 1.9;
const BY_TIME = 4.6;
/** The gate's height (up to the portal's header). */
const GATE_H = 6.2;

/** Cubic Hermite from 0 to 1 leaving at slope m0 and arriving at m1, and its slope. */
const hermite = (k: number, m0: number, m1: number) => (k ** 3 - 2 * k ** 2 + k) * m0 + (-2 * k ** 3 + 3 * k ** 2) + (k ** 3 - k ** 2) * m1;
const hermiteSlope = (k: number, m0: number, m1: number) => (3 * k ** 2 - 4 * k + 1) * m0 + (-6 * k ** 2 + 6 * k) + (3 * k ** 2 - 2 * k) * m1;
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
/** How high the ramp is under a point `z` in the truck's frame (0 on the road, FLOOR at the sill). */
const rampLift = (z: number) => THREE.MathUtils.clamp((z - RAMP_FOOT) / (BODY_BACK - RAMP_FOOT), 0, 1) * FLOOR;

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.hud.radio(who, line);
  ctx.voice.speak(who, line);
}

/** A roller shutter across the tunnel's mouth: grey slats over a hazard-striped bottom rail. */
function buildGate(width: number): THREE.Group {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#8d9196';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#5d6166';
  for (let y = 0; y < 64; y += 16) ctx.fillRect(0, y, 64, 4);
  const map = new THREE.CanvasTexture(c);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.repeat.set(width / 2, 1);
  const g = new THREE.Group();
  // The slats hang from the header (the group's origin is at the top), scaled down as it rolls up.
  const slats = new THREE.Mesh(new THREE.BoxGeometry(width, 1, 0.12).translate(0, -0.5, 0), new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.4 }));
  slats.name = 'slats';
  const rail = new THREE.Mesh(new THREE.BoxGeometry(width, 0.35, 0.2), new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 }));
  rail.name = 'rail';
  slats.castShadow = rail.castShadow = true;
  g.add(slats, rail);
  return g;
}

/** A tarp thrown over the decoy: a box a size up from the vault's, its sides pushed in and out a little like cloth. */
function buildTarp(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(3.75, 2.85, 3.75, 6, 5, 6);
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    // Folds hang off the top edge; the hem flares at the bottom.
    const fold = Math.sin(x * 3.1 + z * 1.7) * 0.06 + Math.sin(z * 4.3 - x) * 0.04;
    const flare = y < -1 ? (-1 - y) * 0.18 : 0;
    const k = 1 + flare / 1.85;
    p.setXYZ(i, x * k + fold, y - (Math.abs(x) > 1.75 && Math.abs(z) > 1.75 ? 0.05 : 0), z * k - fold);
  }
  geo.translate(0, 1.42, 0);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x2c3a4a, roughness: 0.92, side: THREE.DoubleSide }));
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** A length of cable drawn as a tube through three points (redrawn when it moves). */
class CableLine {
  readonly mesh: THREE.Mesh;
  constructor(scene: THREE.Scene, radius = 0.045) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.4 }));
    this.mesh.castShadow = true;
    this.mesh.userData.radius = radius;
    scene.add(this.mesh);
  }
  draw(a: THREE.Vector3, mid: THREE.Vector3, b: THREE.Vector3): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a, mid, b), 10, this.mesh.userData.radius, 5, false);
    this.mesh.visible = true;
  }
}

/** Where the scene puts everyone, for the frame it's on. */
interface Staging {
  /** Seconds into the scene. */
  t: number;
  /** The convoy's speed as the scene took over, to leave at that speed. */
  v0: number;
  /** How far off their staged start everyone was (world offsets and headings), eased away as the scene runs. */
  off: { player: THREE.Vector3; partner: THREE.Vector3; vault: THREE.Vector3; truck: number };
  turn: { player: number; partner: number; vault: THREE.Quaternion };
  /** The convoy's centre (z and x in the tunnel's frame) and speed. */
  cz: number;
  cx: number;
  speed: number;
  /** Frozen while the camera is away at the drive-by. */
  frozen: boolean;
}

/**
 * The swap, in the tunnel on the expressway. Mia calls it; the gate drops behind
 * the convoy so no cop sees; the player lines the vault up with the ramp of the
 * garbage truck rolling ahead; then the scene: the real vault goes into the truck
 * and the decoy comes out from under its tarp on the cables, and the convoy bursts
 * out of the tunnel with every cop in Rio still chasing it. The cops come through
 * the gate behind them and drive straight past the parked garbage truck.
 */
export class TunnelSwap {
  state: 'waiting' | 'called' | 'lineup' | 'swapping' | 'clear' = 'waiting';
  /** How well the vault was lined up with the ramp when the scene took over (0..1). */
  quality = 0;
  private truck = new GarbageTruck();
  /** The truck's place in the tunnel's frame, its heading off the tunnel's, and its speed. */
  private truckX = LINE;
  private truckZ = WAIT_Z;
  private truckYaw = 0;
  private truckSpeed = 0;
  private gate: THREE.Group;
  /** The gate: how far down it is (0 open, 1 shut), and where it's going. */
  private gateNow = 0;
  private gateTo = 0;
  /** The real vault once it's off the cables (a copy of the vault's mesh), and the decoy until the vault in the physics takes its place. */
  private real: THREE.Object3D;
  private decoy: THREE.Object3D;
  private decoyCollider: RAPIER.Collider | null;
  private tarp = buildTarp();
  private tarpFly: { vel: THREE.Vector3; spin: THREE.Vector3; landed: number } | null = null;
  /** The decoy's own cables, laid out to rings on the road; and the cut cables' hooks, dragging behind the cars. */
  private ringLines: CableLine[] = [];
  private rings: THREE.Mesh[] = [];
  private hookLines: CableLine[] = [];
  private hooks: THREE.Mesh[] = [];
  private tej: Figure;
  private roman: Figure;
  private hooked: 'real' | 'none' | 'decoy' = 'real';
  private time = 0;
  private lineupTime = 0;
  private slowed = false;
  private gateCalled = false;
  private lockedOut = false;
  private stage: Staging | null = null;
  private once = new Set<string>();
  /** The cruisers that come through the gate in the drive-by. */
  private cops: { v: Vehicle; x: number; z: number }[] = [];
  /** Solid once it's parked. */
  private parked: RAPIER.Collider | null = null;
  private road = new Path(TUNNEL.road);
  /** The tunnel's entrance, along its road. */
  private s0 = this.road.project(TUNNEL.frame.origin);

  constructor(private ctx: MomentContext) {
    const f = TUNNEL.frame;
    const { scene, world, vault } = ctx;
    scene.add(this.truck.group);
    this.placeTruck();
    // The decoy waits on the line, solid, under its tarp.
    const d = f.toWorld(LINE, DECOY_Z);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.decoyCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 1.25, 1.5).setTranslation(d.x, VAULT_Y, d.z).setRotation(yawQuat(f.heading)), body);
    this.decoy = vault.mesh.clone();
    this.decoy.position.copy(d).setY(VAULT_Y);
    this.decoy.rotation.set(0, f.heading, 0);
    this.real = vault.mesh.clone();
    this.real.visible = false;
    this.tarp.position.copy(d);
    this.tarp.rotation.y = f.heading + 0.04;
    scene.add(this.decoy, this.real, this.tarp);
    // Its cables lie out ahead of it to two rings, one under each car's line.
    for (const s of [-1, 1]) {
      const line = new CableLine(scene);
      const anchor = f.toWorld(LINE + s * 0.9, DECOY_Z + 1.55, VAULT_Y - 0.7);
      const ringAt = f.toWorld(LINE + s * WIDE, RING_Z, 0.06);
      line.draw(anchor, anchor.clone().lerp(ringAt, 0.4).setY(0.04), ringAt);
      this.ringLines.push(line);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.045, 6, 16), new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.8, roughness: 0.3 }));
      ring.position.copy(ringAt);
      ring.rotation.set(Math.PI / 2, 0, f.heading);
      scene.add(ring);
      this.rings.push(ring);
      const hookLine = new CableLine(scene);
      hookLine.mesh.visible = false;
      this.hookLines.push(hookLine);
      const hook = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.34), new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.85, roughness: 0.35 }));
      hook.visible = false;
      scene.add(hook);
      this.hooks.push(hook);
    }
    // Tej rides the truck's left-hand step, facing back down the tunnel; Roman waits by the decoy.
    this.tej = buildFigure({ suit: 0xff7a1a, skin: 0x7a5236, hat: 0xf2c200, bands: true });
    this.tej.group.position.set(STEP.x, STEP.y, STEP.z);
    this.tej.group.rotation.y = Math.PI;
    this.truck.group.add(this.tej.group);
    this.roman = buildFigure({ suit: 0xff7a1a, skin: 0x5b3a26, hat: 0xf2c200, bands: true });
    this.roman.group.position.copy(f.toWorld(LINE + 5.6, DECOY_Z - 3));
    this.roman.group.rotation.y = f.heading + Math.PI - 0.5;
    scene.add(this.roman.group);
    this.gate = buildGate((TUNNEL.hw + 0.7) * 2);
    this.gate.position.copy(f.toWorld(0, 1.4, GATE_H));
    this.gate.rotation.y = f.heading;
    scene.add(this.gate);
    this.applyGate();
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
    const f = TUNNEL.frame;
    if (this.state === 'called' && f.toLocal(this.ctx.player.position).z < -70) return null;
    return new Path([f.toWorld(LINE, -25), f.toWorld(LINE, this.truckZ + RAMP_FOOT - 0.6)]);
  }

  /** While lining up, the foot of the truck's ramp (the overhead view opens the tunnel's roof up to it), else null. */
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
    this.animateGate(dt);
    this.truck.update(dt, this.truckSpeed);
    this.animateTarp(dt);
    const { player, vault } = this.ctx;
    vault.glow(inTunnel(vault.position, 2) ? 1 : 0);
    const f = TUNNEL.frame;
    const l = f.toLocal(this.convoyCentre());
    const along = player.forward.dot(f.z);
    if (this.state === 'waiting' && l.z > -260 && l.z < -40 && Math.abs(l.x) < TUNNEL.hw + 10 && along > 0.5) {
      this.state = 'called';
      say(this.ctx, 'MIA', 'Tunnel coming up. Gisele’s in there with a garbage truck, ramp down. Thread the vault right up it!');
    }
    if ((this.state === 'waiting' || this.state === 'called') && l.z > -18 && l.z < TUNNEL.length - 60 && Math.abs(l.x) < TUNNEL.hw && along > 0.3) this.startLineup();
    if (this.state === 'lineup') this.lineup(dt, l);
    if (this.state === 'waiting' || this.state === 'called' || this.state === 'lineup') stand(this.roman);
    if (this.state === 'clear') wave(this.tej, this.time, 'L');
  }

  /** Debug starts past the tunnel: the swap happened off screen. */
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
    // No civilians in the way in there (out of sight, they're gone).
    ctx.clearStreets((p) => inTunnel(p, 2) && !ctx.police.visible(p));
    say(ctx, 'GISELE', 'I see you. Line it up with my ramp and keep it straight.');
  }

  private lineup(dt: number, l: { x: number; z: number }): void {
    const { ctx } = this;
    const { player, vault, hud, director, fx } = ctx;
    const f = TUNNEL.frame;
    this.lineupTime += dt;
    // The truck rolls off down the line (no faster than the convoy can catch it) and waits at HOLD_Z.
    const v = Math.max(0, player.forwardSpeed);
    const want = this.truckZ < HOLD_Z ? Math.min(ROLL, Math.max(0, v - 3)) : 0;
    this.truckSpeed += (want - this.truckSpeed) * Math.min(1, dt * 2);
    this.truckZ += this.truckSpeed * dt;
    this.placeTruck();
    // The ramp's lip drags on the road while it rolls.
    if (this.truckSpeed > 0.5) {
      for (const x of [-1.3, 1.3]) if (Math.random() < 0.5) fx.scrape(this.truck.toWorld(x, 0.05, RAMP_FOOT + 0.1), f.z.clone().multiplyScalar(this.truckSpeed), 0.5);
    }
    beckon(this.tej, this.time);
    // Once the vault is inside, the gate comes down behind it; anyone still out there is locked out.
    const vl = f.toLocal(vault.position);
    if (!this.gateCalled && vl.z > 6) {
      this.gateCalled = true;
      this.gateTo = 1;
      say(ctx, 'HAN', 'Gate’s coming down. Nobody’s seeing this.');
    }
    if (this.gateNow === 1 && !this.lockedOut) {
      this.lockedOut = true;
      ctx.clearStreets((p) => {
        const q = f.toLocal(p);
        return q.z < 1 && q.z > -220 && Math.abs(q.x) < TUNNEL.hw + 30;
      });
    }
    // Time slows as they come up on the truck, so there's a moment to line it up.
    if (!this.slowed && vl.z > 2) {
      this.slowed = true;
      director.slowmo(0.45, 3.2);
    }
    this.quality = THREE.MathUtils.clamp(1 - Math.abs(l.x - LINE) / 3.2, 0, 1);
    const prompt = this.quality > 0.85 ? 'DEAD CENTRE  —  KEEP IT STRAIGHT' : l.x > LINE ? 'EASE RIGHT  —  ONTO THE LINE' : 'EASE LEFT  —  ONTO THE LINE';
    hud.meter('LINE UP', this.quality, prompt);
    // The cars' noses are coming up on the foot of the ramp: the scene takes it from here.
    if (l.z >= this.truckZ + R0 || this.lineupTime > 25) this.begin();
  }

  private begin(): void {
    const { ctx } = this;
    const { player, partner, vault } = ctx;
    const f = TUNNEL.frame;
    this.state = 'swapping';
    ctx.hud.meter(null);
    ctx.holdPolice(true);
    ctx.clearStreets((p) => inTunnel(p, 40));
    // Where everyone is now, off their staged start (eased away over the first second and a half).
    const cz0 = Z0 + R0;
    const start = this.lineUp(LINE, cz0, BESIDE);
    const vaultStart = f.toWorld(LINE, cz0 - TOW, VAULT_Y);
    this.stage = {
      t: 0,
      v0: Math.max(0, player.forwardSpeed),
      off: {
        player: player.position.sub(start.player),
        partner: partner.position.sub(start.partner),
        vault: vault.position.sub(vaultStart),
        truck: this.truckZ - Z0,
      },
      turn: { player: angleDiff(f.heading, player.heading), partner: angleDiff(f.heading, partner.heading), vault: vault.mesh.quaternion.clone() },
      cz: cz0,
      cx: LINE,
      speed: player.forwardSpeed,
      frozen: false,
    };
    vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    ctx.cutscene(this.shots(), () => this.finish());
  }

  // ---------------------------------------------------------------- the scene

  private shots(): Shot[] {
    const { ctx } = this;
    const f = TUNNEL.frame;
    const me = ctx.crew.player;
    const step = (dt: number) => this.advance(dt);
    const truckPt = (x: number, y: number, z: number) => this.truck.toWorld(x, y, z);
    return [
      {
        // Off the truck's left-rear quarter, looking back: Tej waves them in, the cars fan out round the ramp.
        duration: S_RIDE,
        update: (_t, dt) => step(dt),
        camera: () => ({ pos: f.toWorld(LINE + 7.6, this.truckZ - 1.5, 3.1), look: f.toWorld(LINE, this.truckZ - 13, 1.0), fov: 50 }),
        lines: [[0.15, 'GISELE', 'Steady… steady… now!']],
      },
      {
        // Riding on the vault as it goes for the ramp: the hopper's open mouth dead ahead.
        duration: S_JAW - S_RIDE,
        update: (_t, dt) => step(dt),
        camera: () => {
          const v = this.ctx.vault.position;
          return { pos: v.clone().addScaledVector(f.z, -3.4).setY(v.y + 2.05), look: truckPt(0, 1.7, BODY_BACK + 1.5), fov: 60 };
        },
      },
      {
        // The left-rear quarter again, close: the vault slides in, the ramp stows and the hopper slams down.
        duration: S_CATCH - S_JAW,
        update: (_t, dt) => step(dt),
        camera: (k) => ({ pos: truckPt(5.3 - k * 0.4, 2.2 + k * 0.3, BODY_BACK - 4.2 + k * 0.6), look: truckPt(0, 2.1, BODY_BACK - 0.6), fov: 50 }),
        lines: [[T_POP + 0.15 - S_JAW, 'TEJ', 'She’s in! Close it up!']],
      },
      {
        // Low by the decoy: the cars come past it either side, the hooks catch the rings, and it's yanked out from under the tarp.
        duration: S_OUT - S_CATCH,
        update: (_t, dt) => step(dt),
        camera: () => ({ pos: f.toWorld(LINE + 6.5, DECOY_Z + 9, 1.15), look: f.toWorld(LINE + 0.5, DECOY_Z + 1, 1.0), fov: 48 }),
        lines: [
          [0.1, 'GISELE', 'Hopper’s shut. Ten tons of garbage, officer.'],
          [T_YANK + 0.05 - S_CATCH, 'ROMAN', 'Hooked! Go, go, go!'],
        ],
      },
      {
        // Behind the decoy as the convoy floors it for the daylight at the end.
        duration: S_BY - S_OUT,
        update: (_t, dt) => step(dt),
        camera: () => {
          const v = this.ctx.vault.position.setY(0);
          return { pos: v.clone().addScaledVector(f.z, -11).addScaledVector(f.x, -0.8).setY(4.8), look: f.toWorld(this.stage!.cx, this.stage!.cz + 22, 1.0), fov: 54 };
        },
        lines: [[0.2, me, 'Now let’s give them a show.']],
      },
      {
        // Down by the parked truck: the gate goes up and the cops come through, flat out, straight past it.
        duration: BY_TIME,
        start: () => {
          if (this.stage) this.stage.frozen = true;
          this.gateTo = 0;
        },
        update: (t, dt) => {
          step(dt);
          this.driveBy(t, dt);
        },
        camera: () => ({ pos: f.toWorld(PARK_X + 4.2, PARK_Z + 7.5, 2.4), look: f.toWorld(PARK_X + 1.2, PARK_Z - 30, 1.5), fov: 46 }),
        lines: [
          [1.6, 'TEJ', 'Evening, officers!'],
          [3.3, 'HAN', 'Not one of them looked twice.'],
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
    const f = TUNNEL.frame;
    st.t += dt;
    const t = st.t;
    const fade = 1 - ease(Math.min(1, t / 1.5));

    // The truck: rolling down the line, then pulling over to the right and stopping.
    const tr = this.truckAt(t);
    this.truckX = tr.x;
    this.truckZ = tr.z + st.off.truck * fade;
    this.truckYaw = tr.yaw;
    this.truckSpeed = tr.speed;
    this.placeTruck();
    this.truck.update(dt, tr.speed);
    this.truck.braking(t > T_VEER && t < T_VEER + T_PARK);

    // The convoy.
    if (!st.frozen) {
      let cz: number;
      let speed: number;
      if (t <= T_POP) {
        const k = t / T_POP;
        const d = R_POP - R0;
        const m0 = THREE.MathUtils.clamp(((st.v0 - ROLL) * T_POP) / d, 0, 3);
        const m1 = ((V_POP - ROLL) * T_POP) / d;
        cz = Z0 + ROLL * t + R0 + d * hermite(k, m0, m1);
        speed = ROLL + (d * hermiteSlope(k, m0, m1)) / T_POP;
      } else if (t <= T_YANK) {
        const u = t - T_POP;
        cz = CZ_POP + V_POP * u + 0.5 * A_DRAG * u * u;
        speed = V_POP + A_DRAG * u;
      } else {
        const u = t - T_YANK;
        const v = Math.min(24, V_YANK + A_OUT * u);
        const cap = (24 - V_YANK) / A_OUT;
        cz = CZ_YANK + (u < cap ? V_YANK * u + 0.5 * A_OUT * u * u : V_YANK * cap + 0.5 * A_OUT * cap * cap + 24 * (u - cap));
        speed = v;
      }
      st.cz = cz;
      st.speed = speed;
      st.cx = LINE;
      // Spread round the truck and the decoy, then back into formation.
      const spread =
        t < 1.5 ? THREE.MathUtils.lerp(BESIDE, WIDE, ease(t / 1.5)) : t < T_YANK + 0.3 ? WIDE : THREE.MathUtils.lerp(WIDE, BESIDE, ease(Math.min(1, (t - T_YANK - 0.3) / 1.2)));
      const p = this.lineUp(st.cx, cz, spread);
      this.drive(player, p.player.addScaledVector(st.off.player, fade), f.heading + st.turn.player * fade, speed);
      this.drive(partner, p.partner.addScaledVector(st.off.partner, fade), f.heading + st.turn.partner * fade, speed);
      // Hard on the brakes at first (from flat out), smoke off the rear tyres.
      if (t < 1.4 && st.v0 > 14) for (const car of [player, partner]) for (const w of car.rearWheels()) if (Math.random() < 0.4) fx.tireSmoke(w, 0.5, f.z.clone().multiplyScalar(2));
    }

    // The vault: on the cables up to the pop, riding up the ramp at the end.
    if (t < T_POP) {
      const vz = st.cz - TOW;
      const local = vz - this.truckZ;
      const front = rampLift(local + 1.5);
      const back = rampLift(local - 1.5);
      const pitch = Math.atan2(front - back, 3);
      const at = f.toWorld(st.cx, vz, VAULT_Y + (front + back) / 2).addScaledVector(st.off.vault, fade);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, f.heading, 0, 'YXZ')).slerp(st.turn.vault, fade);
      this.setVault(at, q);
      // Steel on the ramp's lip.
      if (front > 0.02 && Math.random() < 0.7) fx.scrape(this.truck.toWorld((Math.random() - 0.5) * 2.6, 0.1, RAMP_FOOT + 0.3), f.z.clone().multiplyScalar(-6), 0.8);
    } else {
      this.event('pop', () => this.pop());
      // Sliding on in to the bulkhead, in the truck's frame.
      const k = Math.min(1, (t - T_POP) / T_IN);
      const from = R_POP - TOW;
      const m0 = ((V_POP - ROLL) * T_IN) / (INSIDE - from);
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

    // The ramp stows and the hopper comes down, with a hiss and a clank.
    const rampK = THREE.MathUtils.clamp((t - T_POP - T_IN - 0.05) / 0.5, 0, 1);
    const hopK = THREE.MathUtils.clamp((t - T_POP - T_IN - 0.35) / 0.55, 0, 1);
    if (rampK > 0) this.truck.setRamp(1 - ease(rampK));
    if (hopK > 0) {
      this.event('hiss', () => sound.hiss(0.7));
      this.truck.setHopper(1 - ease(hopK));
      if (hopK >= 1) this.event('shut', () => sound.clank());
    }

    // The cut cables' hooks drag along behind the cars until they catch the rings.
    if (t >= T_POP && t < T_CATCH) {
      for (const [i, car] of [player, partner].entries()) {
        const a = car.towPoint();
        const hook = a.clone().addScaledVector(car.forward, -HOOK_TRAIL).setY(0.1);
        this.hookLines[i].draw(a, a.clone().lerp(hook, 0.6).setY(0.12), hook);
        this.hooks[i].visible = true;
        this.hooks[i].position.copy(hook);
        this.hooks[i].rotation.y = car.heading;
        if (Math.random() < 0.8) fx.scrape(hook, car.forward.multiplyScalar(st.speed), 0.6);
      }
    }
    if (t >= T_CATCH) this.event('catch', () => this.catchRings());
    if (t >= T_YANK) {
      this.event('yank', () => this.yank());
      if (!st.frozen) {
        const u = t - T_YANK;
        const hop = u < 0.35 ? Math.sin((u / 0.35) * Math.PI) * 0.28 : 0;
        this.setVault(f.toWorld(st.cx, st.cz - TOW, VAULT_Y + hop), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.heading));
        if (u < 1.2 && Math.random() < 0.8) fx.scrape(vault.position.setY(0.08).addScaledVector(f.x, (Math.random() - 0.5) * 2.6), f.z.clone().multiplyScalar(st.speed), 0.8);
      }
      cheer(this.roman, t);
    } else if (t > S_CATCH) {
      beckon(this.roman, t);
    }
    // Tej holds on through the slam, then waves at whoever's coming.
    if (t < T_POP) beckon(this.tej, t);
    else stand(this.tej);
    this.animateTarp(dt);
    this.animateGate(dt);
  }

  /** The canonical truck: rolling at ROLL, then easing over to PARK_X and stopping by PARK_Z. */
  private truckAt(t: number): { x: number; z: number; yaw: number; speed: number } {
    if (t < T_VEER) return { x: LINE, z: Z0 + ROLL * t, yaw: 0, speed: ROLL };
    const k = Math.min(1, (t - T_VEER) / T_PARK);
    const z = Z0 + ROLL * T_VEER + (ROLL * T_PARK * (1 - (1 - k) ** 1.5)) / 1.5;
    const x = LINE + (PARK_X - LINE) * ease(k);
    const dz = ROLL * Math.sqrt(1 - k);
    const dx = ((PARK_X - LINE) * 6 * k * (1 - k)) / T_PARK;
    return { x, z, yaw: k < 1 ? Math.atan2(dx, dz) : 0, speed: Math.hypot(dx, dz) };
  }

  /** The vault's nose is at the sill: the cables come off it, and the real vault becomes the truck's. */
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

  /** The trailing hooks catch the rings: the cars are on the decoy's cables. */
  private catchRings(): void {
    const { ctx } = this;
    for (const h of this.hooks) h.visible = false;
    for (const l of this.hookLines) l.mesh.visible = false;
    for (const l of this.ringLines) l.mesh.visible = false;
    for (const r of this.rings) {
      ctx.fx.burst(r.position.clone().setY(0.3), 0.35);
      r.visible = false;
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
    const f = TUNNEL.frame;
    ctx.sound.crash(0.5);
    ctx.fx.puff(f.toWorld(LINE, DECOY_Z), 10);
    ctx.director.shake = Math.max(ctx.director.shake, 0.5);
    this.tarpFly = {
      vel: f.z.clone().multiplyScalar(1.2).add(new THREE.Vector3(0, 6, 0)).addScaledVector(f.x, -2.2),
      spin: new THREE.Vector3(-2.2, 0.9, -1.4),
      landed: 0,
    };
  }

  /** The take's last shot: the gate rolls up and two cruisers come through, flat out, past the parked truck. */
  private driveBy(t: number, dt: number): void {
    const { ctx } = this;
    const f = TUNNEL.frame;
    wave(this.tej, t, 'L');
    if (!this.cops.length && this.gateNow < 0.55) {
      for (const [x, z] of [[5, 3], [1.5, -4]] as const) this.cops.push({ v: ctx.police.spawnAt(f.toWorld(x, z), f.heading), x, z });
      ctx.sound.ping(900, 0.08, 0.4);
    }
    for (const c of this.cops) {
      c.z += 27 * dt;
      this.drive(c.v, f.toWorld(c.x, c.z), f.heading, 27);
    }
  }

  /** The end of the scene, however far it got (it can be skipped): the real vault shut away in the parked truck, the convoy rolling out on the decoy. */
  private finish(): void {
    if (this.state !== 'swapping') return;
    const { ctx } = this;
    const { vault, player, partner } = ctx;
    this.state = 'clear';
    this.endState(true);
    vault.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    // Out of the tunnel's far end, rolling, on the road (which may curve past the straight).
    const s = this.s0 + TUNNEL.length + 22;
    const ahead = this.road.tangent(s);
    if (this.hooked === 'real') ctx.unhook();
    ctx.placeConvoy(this.road.at(s), ahead, this.road.at(s - TOW));
    if (this.hooked !== 'decoy') {
      this.hooked = 'decoy';
      ctx.hook();
    }
    const v = ahead.clone().multiplyScalar(17);
    for (const b of [player.body, partner.body, vault.body]) b.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    // The cruisers that came through the gate are right behind.
    for (const c of this.cops) c.v.body.setLinvel({ x: TUNNEL.frame.z.x * 26, y: 0, z: TUNNEL.frame.z.z * 26 }, true);
    this.cops = [];
    this.stage = null;
    ctx.holdPolice(false);
    const clean = this.quality > 0.85;
    const bonus = clean ? 1250 : 750;
    ctx.hud.banner('THE SWAP', clean ? `PERFECT LINE-UP  +${bonus}` : `THE REAL VAULT IS IN THE TRUCK  +${bonus}`, 2.4);
    ctx.reward(bonus, 0.35);
    setTimeout(() => say(ctx, 'MIA', 'Swap’s done. The real one’s riding off in a garbage truck. Now make them chase the fake!'), 900);
    setTimeout(() => ctx.hud.news(NEWS.tunnel), 2600);
  }

  /** Everything as the swap leaves it: the truck parked with the real vault shut in, the tarp on the road, the gate up. */
  private endState(live: boolean): void {
    const f = TUNNEL.frame;
    this.handOver(live);
    this.truck.group.add(this.real);
    this.real.position.set(0, VAULT_Y + FLOOR, INSIDE);
    this.real.rotation.set(0, 0, 0);
    this.truckX = PARK_X;
    this.truckZ = PARK_Z;
    this.truckYaw = 0;
    this.truckSpeed = 0;
    this.placeTruck();
    this.truck.setRamp(0);
    this.truck.setHopper(0);
    this.truck.braking(false);
    this.truck.workLamp = false;
    if (!this.parked) {
      const at = f.toWorld(PARK_X, PARK_Z + 0.9);
      const body = this.ctx.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.parked = this.ctx.world.createCollider(RAPIER.ColliderDesc.cuboid(1.8, 2.0, 5.4).setTranslation(at.x, 2.0, at.z).setRotation(yawQuat(f.heading)), body);
    }
    for (const x of [...this.hooks, ...this.rings]) x.visible = false;
    for (const l of [...this.hookLines, ...this.ringLines]) l.mesh.visible = false;
    if (!this.tarpFly || this.tarpFly.landed < 1) {
      // Where it came down, crumpled on the road.
      this.tarpFly = { vel: new THREE.Vector3(), spin: new THREE.Vector3(), landed: 1 };
      this.tarp.position.copy(f.toWorld(LINE + 0.8, DECOY_Z + 4, 0.12));
      this.tarp.rotation.set(0, f.heading + 0.6, 0);
      this.tarp.scale.set(1.25, 0.08, 1.15);
    }
    this.roman.group.visible = false;
    stand(this.tej);
    this.gateNow = this.gateTo = 0;
    this.applyGate();
  }

  // ---------------------------------------------------------------- staging

  /** The convoy's centre: between the two cars. */
  private convoyCentre(): THREE.Vector3 {
    return this.ctx.player.position.add(this.ctx.partner.position).multiplyScalar(0.5);
  }

  /** The two cars side by side on line `x`, `spread` m either side of it, `z` along (world positions). */
  private lineUp(x: number, z: number, spread: number): { player: THREE.Vector3; partner: THREE.Vector3 } {
    const f = TUNNEL.frame;
    const s = this.ctx.crew.side;
    return { player: f.toWorld(x + s * spread, z), partner: f.toWorld(x - s * spread, z) };
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

  private placeTruck(): void {
    const f = TUNNEL.frame;
    this.truck.group.position.copy(f.toWorld(this.truckX, this.truckZ));
    this.truck.group.rotation.y = f.heading + this.truckYaw;
  }

  /**
   * The real vault comes out of the physics (a copy of its mesh goes into the truck),
   * and the vault in the physics takes the decoy's place, under the tarp: from here
   * on, that's what the convoy tows. `live`: move the physics vault (not on a debug
   * start, which places it itself).
   */
  private handOver(live: boolean): void {
    if (this.real.visible) return;
    const { vault, world } = this.ctx;
    const f = TUNNEL.frame;
    this.real.visible = true;
    this.decoy.visible = false;
    if (this.decoyCollider) world.removeCollider(this.decoyCollider, false);
    this.decoyCollider = null;
    // The copy rides into the truck in the truck's frame.
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

  private animateGate(dt: number): void {
    if (this.gateNow === this.gateTo) return;
    const was = this.gateNow;
    this.gateNow = this.gateTo > this.gateNow ? Math.min(this.gateTo, this.gateNow + dt / 1.6) : Math.max(this.gateTo, this.gateNow - dt / 2.5);
    this.applyGate();
    if (was < 1 && this.gateNow === 1) {
      this.ctx.sound.clank();
      this.ctx.sound.crash(0.35);
    }
  }

  private applyGate(): void {
    const k = Math.max(0.02, this.gateNow);
    const slats = this.gate.getObjectByName('slats') as THREE.Mesh;
    const rail = this.gate.getObjectByName('rail')!;
    slats.scale.y = GATE_H * k;
    // Slats stay the same size as it rolls (one repeat every 2 m).
    ((slats.material as THREE.MeshStandardMaterial).map as THREE.Texture).repeat.y = (GATE_H * k) / 2;
    rail.position.y = -GATE_H * k;
    this.gate.visible = this.gateNow > 0.01;
  }
}
