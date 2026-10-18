import * as THREE from 'three';
import { NEWS } from './broadcast';
import { ease, type Shot } from './cutscene';
import type { MomentContext } from './moments';
import { RAPIER, yawQuat } from './physics';
import { inTunnel, TUNNEL } from './roadmap';
import { CABLE_TOW_LENGTH } from './vault';
import type { Vehicle } from './vehicle';

/*
 * The swap's layout, in the tunnel's frame: x across (left positive), z along it
 * from the entrance.
 */
/** Where the cars stop, and the line they settle on. */
const STOP = 72;
const LANE = -1;
/** Car centres to the vault's centre. */
const TOW = CABLE_TOW_LENGTH + 2.5;
/** Half the gap between the two cars' centres. */
const BESIDE = 2.75;
/** The decoy waits in the left lanes, level with where the real vault stops. */
const DECOY_X = 8;
/** The truck is parked in the right lanes, facing out; its bed is 1.3 m up, its tailgate 4.8 m behind its middle. */
const TRUCK_X = -9;
const TRUCK_Z = 72;
const TAIL = 4.8;
const BED = 1.3;
const RAMP = 5;
/** The ramp's foot on the road (z), and how high the vault rides (its half height). */
const RAMP_FOOT = TRUCK_Z - TAIL - Math.sqrt(RAMP * RAMP - BED * BED);
const VAULT_Y = 1.27;
/** On the decoy, the cars pull away at this rate (m/s²) for the scene's last seconds. */
const PULL_AWAY = 3.5;
const PULL_START = 2.2;
const DECOY_SHOT = 4.8;
const ROLL_OUT = 0.5 * PULL_AWAY * (DECOY_SHOT - PULL_START) ** 2;
const ROLL_SPEED = PULL_AWAY * (DECOY_SHOT - PULL_START);
/** The gate's height (up to the portal's header). */
const GATE_H = 6.2;

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.hud.radio(who, line);
  ctx.voice.speak(who, line);
}

interface SwapTruck {
  group: THREE.Group;
  /** The rear doors, each on its hinge. */
  doors: THREE.Group[];
  /** The loading ramp, hinged at the tailgate. */
  ramp: THREE.Group;
  /** Tail and head lamps, and the work lamp in the box. */
  lamps: THREE.MeshStandardMaterial[];
  work: THREE.MeshStandardMaterial;
  /** The winch drum on the bulkhead, in the truck's frame. */
  winch: THREE.Vector3;
}

/**
 * Han and Roman's box truck: a cab, a cargo box big enough for the vault, swing
 * doors at the back and a ramp down to the road. Origin on the ground at its
 * middle, facing +z.
 */
function buildSwapTruck(): SwapTruck {
  const g = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xe6e3dc, roughness: 0.6, metalness: 0.15 });
  const cabPaint = new THREE.MeshStandardMaterial({ color: 0x1d4e7a, roughness: 0.45, metalness: 0.4 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0xd9822b, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.8 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0c1218, metalness: 0.9, roughness: 0.1 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 1.6 });
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 2.4 });
  const work = new THREE.MeshStandardMaterial({ color: 0x2a2620, emissive: 0xffd8a0, emissiveIntensity: 0 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const w = 3.4;
  const back = -TAIL;
  const front = 2.6;
  const len = front - back;
  const mid = (back + front) / 2;
  const tall = 3.1;
  const top = BED + tall;
  // Chassis, then the box: floor, sides, roof and bulkhead, open at the back.
  add(new THREE.BoxGeometry(2.3, 0.35, 10.2), dark, 0, 0.85, 0.3);
  add(new THREE.BoxGeometry(w, 0.12, len), steel, 0, BED - 0.06, mid);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.08, tall, len), paint, s * (w / 2 - 0.04), BED + tall / 2, mid);
  add(new THREE.BoxGeometry(w, 0.08, len), paint, 0, top - 0.04, mid);
  add(new THREE.BoxGeometry(w, tall, 0.08), paint, 0, BED + tall / 2, front - 0.04);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.35, len - 0.4), stripe, s * (w / 2 + 0.01), BED + 1, mid);
  // Inside: a work lamp under the roof, and the winch on the bulkhead.
  add(new THREE.BoxGeometry(1.2, 0.05, 0.3), work, 0, top - 0.11, mid);
  const winch = new THREE.Vector3(0, BED + 0.6, front - 0.45);
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.9, 12).rotateZ(Math.PI / 2), dark, winch.x, winch.y, winch.z);
  // The cab.
  add(new THREE.BoxGeometry(2.5, 1.5, 2.6), cabPaint, 0, 1.25, front + 1.35);
  add(new THREE.BoxGeometry(2.4, 1.15, 2.0), cabPaint, 0, 2.55, front + 1.1);
  add(new THREE.BoxGeometry(2.2, 0.75, 0.05), glass, 0, 2.65, front + 2.12).rotation.x = -0.15;
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.6, 1.2), glass, s * 1.21, 2.65, front + 1.2);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.4, 0.2, 0.05), head, s * 0.85, 1.25, front + 2.66);
  // One axle under the cab, two under the box.
  for (const z of [front + 1.4, -1.6, -2.9]) {
    for (const s of [-1, 1]) add(new THREE.CylinderGeometry(0.55, 0.55, 0.45, 18).rotateZ(Math.PI / 2), tire, s * 1.1, 0.55, z);
  }
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.3, 0.18, 0.05), tail, s * 1.45, 0.95, back - 0.02);
  // Rear doors, hinged at the box's back corners.
  const doors: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set((s * w) / 2, 0, back);
    add(new THREE.BoxGeometry(w / 2 - 0.02, tall - 0.1, 0.06), paint, (-s * w) / 4, BED + tall / 2, -0.03, hinge);
    g.add(hinge);
    doors.push(hinge);
  }
  const ramp = new THREE.Group();
  ramp.position.set(0, BED, back);
  add(new THREE.BoxGeometry(3.1, 0.08, RAMP), steel, 0, -0.04, -RAMP / 2, ramp);
  g.add(ramp);
  return { group: g, doors, ramp, lamps: [tail, head], work, winch };
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

/**
 * The swap, in the tunnel on the expressway. Han and Roman wait inside with a box
 * truck and a decoy that looks just like the vault. Han drops the gate behind the
 * convoy, so no cop sees it: the cables come off, the real vault is winched up into
 * the truck, the cars are hooked to the decoy, and the convoy rolls on out of the
 * tunnel with every cop in Rio still chasing it. The truck waits inside with its
 * lights off until they've all gone by.
 */
export class TunnelSwap {
  state: 'waiting' | 'called' | 'swapping' | 'swapped' | 'clear' = 'waiting';
  private truck = buildSwapTruck();
  private gate: THREE.Group;
  /** The real vault once it's off the cables (a copy of the vault's mesh). */
  private real: THREE.Object3D;
  /** The decoy, until the vault in the physics takes its place. */
  private decoy: THREE.Object3D;
  private decoyCollider: RAPIER.Collider | null;
  /** The winch cable, while the real vault goes up the ramp. */
  private winchLine: THREE.Mesh;
  private hooked: 'real' | 'none' | 'decoy' = 'real';
  private shut = false;
  private time = 0;
  private swappedAt = 0;
  /** The gate: how far down it is (0 open, 1 shut), and where it's going. */
  private gateNow = 0;
  private gateTo = 0;
  private bump = new Set<string>();

  constructor(private ctx: MomentContext) {
    const f = TUNNEL.frame;
    const { scene, world, vault } = ctx;
    const t = this.truck;
    t.group.position.copy(f.toWorld(TRUCK_X, TRUCK_Z));
    t.group.rotation.y = f.heading;
    scene.add(t.group);
    this.openDoors(1);
    this.stowRamp(0);
    // The parked truck and the waiting decoy are solid.
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const at = f.toWorld(TRUCK_X, TRUCK_Z + 0.3);
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.75, 2.2, 5.1).setTranslation(at.x, 2.2, at.z).setRotation(yawQuat(f.heading)), body);
    const d = f.toWorld(DECOY_X, STOP - TOW);
    this.decoyCollider = world.createCollider(RAPIER.ColliderDesc.cuboid(1.5, 1.25, 1.5).setTranslation(d.x, VAULT_Y, d.z).setRotation(yawQuat(f.heading)), body);
    this.decoy = vault.mesh.clone();
    this.decoy.position.copy(d).setY(VAULT_Y);
    this.decoy.rotation.set(0, f.heading, 0);
    this.real = vault.mesh.clone();
    this.real.visible = false;
    scene.add(this.decoy, this.real);
    this.winchLine = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 1, 6), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.4 }));
    this.winchLine.visible = false;
    scene.add(this.winchLine);
    this.gate = buildGate((TUNNEL.hw + 0.7) * 2);
    this.gate.position.copy(f.toWorld(0, 1.4, GATE_H));
    this.gate.rotation.y = f.heading;
    scene.add(this.gate);
    this.applyGate();
  }

  /** The swap has happened (the vault on the cables is the decoy). */
  get done(): boolean {
    return this.state === 'swapped' || this.state === 'clear';
  }

  /** Waiting for the convoy (for the beacon and the map). */
  get pending(): boolean {
    return this.state === 'waiting' || this.state === 'called';
  }

  /** Per frame of the chase. */
  update(dt: number): void {
    this.time += dt;
    this.animateGate(dt);
    const { player, vault } = this.ctx;
    vault.glow(inTunnel(vault.position, 2) ? 1 : 0);
    const f = TUNNEL.frame;
    const l = f.toLocal(player.position);
    const along = player.forward.dot(f.z);
    if (this.state === 'waiting' && l.z > -260 && l.z < -40 && Math.abs(l.x) < TUNNEL.hw + 10 && along > 0.5) {
      this.state = 'called';
      say(this.ctx, 'MIA', 'Tunnel ahead! Han and Roman are waiting inside with a truck. Get in there.');
    }
    if (this.pending && l.z > 10 && l.z < TUNNEL.length - 40 && Math.abs(l.x) < TUNNEL.hw && along > 0.3) this.begin();
    // Out the far end (and a breather), or long enough that the cops have got the gate open: here they come.
    const since = this.time - this.swappedAt;
    if (this.state === 'swapped' && ((l.z > TUNNEL.length + 6 && since > 7) || since > 16)) {
      this.state = 'clear';
      this.ctx.holdPolice(false);
      this.gateTo = 0;
      say(this.ctx, 'MIA', 'They’re through the gate! Here they come!');
    }
  }

  /** Debug starts past the tunnel: the swap happened off screen. */
  skipAhead(): void {
    if (this.state === 'clear') return;
    this.state = 'clear';
    this.handOver(false);
    this.load(1);
    this.stowRamp(1);
    this.openDoors(0);
    this.lightsOff();
  }

  private begin(): void {
    const { ctx } = this;
    this.state = 'swapping';
    ctx.holdPolice(true);
    ctx.clearStreets((p) => inTunnel(p, 40));
    ctx.cutscene(this.shots(), () => this.finish());
  }

  private shots(): Shot[] {
    const { player, partner, vault, crew, fx, sound } = this.ctx;
    const f = TUNNEL.frame;
    // Rolling in: from wherever they are to a stop beside the truck, braking all the way.
    const left = f.x;
    const center = player.position.addScaledVector(left, -crew.side * BESIDE);
    const z0 = f.toLocal(center).z;
    const v0 = Math.max(4, player.forwardSpeed);
    const dz = Math.max(10, STOP - z0);
    const T = THREE.MathUtils.clamp((2 * dz) / v0, 3.6, 5);
    // A Hermite ease: leaves at their speed, arrives at rest.
    const m = THREE.MathUtils.clamp((v0 * T) / dz, 0, 2.6);
    const H = (k: number) => (k ** 3 - 2 * k ** 2 + k) * m + (-2 * k ** 3 + 3 * k ** 2);
    const dH = (k: number) => (3 * k ** 2 - 4 * k + 1) * m + (-6 * k ** 2 + 6 * k);
    const z = (k: number) => STOP - dz + dz * H(k);
    // Where each of them is now, off its place in the line-up (eased away as they settle).
    const ideal = (k: number) => this.lineUp(LANE, z(k));
    const start = ideal(0);
    const off = {
      player: player.position.sub(start.player),
      partner: partner.position.sub(start.partner),
      vault: vault.position.setY(VAULT_Y).sub(start.vault),
    };
    const turn = {
      player: angleDiff(f.heading, player.heading),
      partner: angleDiff(f.heading, partner.heading),
      vault: vault.mesh.quaternion.clone(),
    };
    const rollIn = (k: number) => {
      const p = ideal(k);
      const fade = 1 - ease(Math.min(1, k / 0.6));
      const speed = (dz * dH(k)) / T;
      this.drive(player, p.player.addScaledVector(off.player, fade), f.heading + turn.player * fade, speed);
      this.drive(partner, p.partner.addScaledVector(off.partner, fade), f.heading + turn.partner * fade, speed);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.heading).slerp(turn.vault, fade);
      this.setVault(p.vault.addScaledVector(off.vault, fade), q);
    };
    const look = (k: number) => f.toWorld(LANE, z(k) - 5, 1.2);
    const me = crew.player;
    const other = crew.partner;

    return [
      {
        // Inside, ahead of them: the convoy rolls in out of the light, the gate drops behind it.
        duration: T,
        start: () => {
          vault.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
          vault.glow(1);
          this.truck.work.emissiveIntensity = 2.5;
        },
        update: (t, dt) => {
          const k = Math.min(1, t / T);
          rollIn(k);
          if (k > 0.3) this.gateTo = 1;
          this.animateGate(dt);
          // Braking hard at the end, tires smoking.
          if (k > 0.55 && k < 0.95) for (const car of [player, partner]) for (const w of car.rearWheels()) if (Math.random() < 0.5) fx.tireSmoke(w, 0.5, f.z.clone().multiplyScalar(2));
        },
        camera: (k) => ({ pos: f.toWorld(-4.5 + k * 0.5, 101, 2.1), look: look(k), fov: 46 }),
        lines: [[0.4, 'HAN', 'Right on time. Gate’s coming down behind you.']],
      },
      {
        // At the vault's door as the cables come off.
        duration: 3.2,
        start: () => rollIn(1),
        update: (t, dt) => {
          this.animateGate(dt);
          if (t > 1.0 && this.hooked === 'real') this.unhook();
        },
        camera: (k) => ({
          pos: f.toWorld(LANE + 7.5 - k * 0.6, STOP - TOW + 4.2, 1.8 + k * 0.2),
          look: f.toWorld(LANE - 0.5, STOP - TOW + 4.6, 0.8),
          fov: 56,
        }),
        lines: [[0.3, other, 'Cables off. Make it quick, Roman.']],
      },
      {
        // Wide, from behind the convoy: the real vault is dragged across and winched up into the truck.
        duration: 6,
        start: () => this.handOver(true),
        update: (t, dt) => {
          this.animateGate(dt);
          this.load(Math.min(1, t / 5.4), dt);
        },
        camera: (k) => ({ pos: f.toWorld(5.6 - k * 0.8, 46.5 + k * 1.2, 4), look: f.toWorld(-6.5, 64, 1.9), fov: 50 }),
        lines: [
          [0.3, 'ROMAN', 'Quick? This thing weighs more than my first apartment.'],
          [3.8, me, 'Easy with it. That one’s the real one.'],
        ],
      },
      {
        // Behind the truck: the ramp comes up, the doors swing shut, the lights go out.
        duration: 3.8,
        start: () => this.load(1),
        update: (t, dt) => {
          this.animateGate(dt);
          const k = t / 3.8;
          this.stowRamp(THREE.MathUtils.clamp(k / 0.35, 0, 1));
          this.openDoors(1 - ease(THREE.MathUtils.clamp((k - 0.35) / 0.4, 0, 1)));
          if (k > 0.75 && !this.shut) {
            this.shut = true;
            sound.clank();
            sound.crash(0.3);
          }
          if (k > 0.88) this.lightsOff();
        },
        camera: (k) => ({ pos: f.toWorld(TRUCK_X + 1.6 - k, TRUCK_Z - TAIL - 11 + k * 1.5, 1.7), look: f.toWorld(TRUCK_X, TRUCK_Z - TAIL, 2.5), fov: 46 }),
        lines: [[0.8, 'HAN', 'We wait in here till every cop has gone by.']],
      },
      {
        // Low behind the decoy: the cables go on, and the convoy pulls away toward the light.
        duration: DECOY_SHOT,
        start: () => this.onDecoy(0),
        update: (t, dt) => {
          this.animateGate(dt);
          if (t > 0.5 && this.hooked !== 'decoy') this.hookDecoy();
          this.onDecoy(t);
        },
        camera: (k) => ({ pos: f.toWorld(DECOY_X - 5.5, STOP - TOW - 7 + k * 6, 5.4), look: f.toWorld(DECOY_X - 0.5, STOP - 4 + k * 8, 0.8), fov: 52 }),
        lines: [
          [0.6, other, 'Decoy’s hooked up.'],
          [2.1, me, 'Then let’s give them something to chase.'],
        ],
      },
    ];
  }

  /** The end of the scene, however far it got (it can be skipped): the real vault shut away, the convoy rolling on the decoy. */
  private finish(): void {
    if (this.state !== 'swapping') return;
    const { ctx } = this;
    const { vault, player, partner } = ctx;
    const f = TUNNEL.frame;
    this.state = 'swapped';
    this.swappedAt = this.time;
    this.handOver(false);
    this.load(1);
    this.stowRamp(1);
    this.openDoors(0);
    this.lightsOff();
    this.gateNow = this.gateTo = 1;
    this.applyGate();
    if (this.hooked === 'real') ctx.unhook();
    vault.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    ctx.placeConvoy(f.toWorld(DECOY_X, STOP + ROLL_OUT), f.z, f.toWorld(DECOY_X, STOP + ROLL_OUT - TOW));
    if (this.hooked !== 'decoy') {
      this.hooked = 'decoy';
      ctx.hook();
    }
    const v = f.z.clone().multiplyScalar(ROLL_SPEED);
    for (const b of [player.body, partner.body, vault.body]) b.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    ctx.hud.banner('THE SWAP', 'THE REAL VAULT IS IN THE TRUCK  +750', 2.4);
    ctx.reward(750, 0.3);
    setTimeout(() => say(ctx, 'MIA', 'Swap’s done. Now drag that decoy to the bridge, and make it look good.'), 900);
    setTimeout(() => ctx.hud.news(NEWS.tunnel), 2600);
  }

  // ---------------------------------------------------------------- staging

  /** The two cars side by side on line `x`, `z` along, and the vault behind them (world positions). */
  private lineUp(x: number, z: number): { player: THREE.Vector3; partner: THREE.Vector3; vault: THREE.Vector3 } {
    const f = TUNNEL.frame;
    const s = this.ctx.crew.side;
    return { player: f.toWorld(x + s * BESIDE, z), partner: f.toWorld(x - s * BESIDE, z), vault: f.toWorld(x, z - TOW, VAULT_Y) };
  }

  /** Put a car at `p` facing `heading`, rolling forward at `speed` (so its wheels turn). */
  private drive(car: Vehicle, p: THREE.Vector3, heading: number, speed: number): void {
    car.place(p, heading);
    car.body.setLinvel({ x: Math.sin(heading) * speed, y: 0, z: Math.cos(heading) * speed }, true);
  }

  private setVault(p: THREE.Vector3, q: THREE.Quaternion): void {
    const b = this.ctx.vault.body;
    b.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
  }

  /** On the decoy, `t` s into the last shot: still, then pulling away. */
  private onDecoy(t: number): void {
    const { player, partner } = this.ctx;
    const f = TUNNEL.frame;
    const run = Math.max(0, t - PULL_START);
    const d = 0.5 * PULL_AWAY * run * run;
    const p = this.lineUp(DECOY_X, STOP + d);
    this.drive(player, p.player, f.heading, PULL_AWAY * run);
    this.drive(partner, p.partner, f.heading, PULL_AWAY * run);
    this.setVault(p.vault, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.heading));
  }

  private unhook(): void {
    const { ctx } = this;
    this.hooked = 'none';
    for (const c of ctx.cables) ctx.fx.burst(ctx.vault.anchorWorld(c.side), 0.45);
    ctx.unhook();
    ctx.sound.clank();
    setTimeout(() => ctx.sound.clank(), 260);
  }

  private hookDecoy(): void {
    const { ctx } = this;
    this.hooked = 'decoy';
    ctx.hook();
    ctx.sound.clank();
  }

  /**
   * The real vault comes out of the physics (a copy of its mesh goes into the truck),
   * and the vault in the physics takes the decoy's place: from here on, that's what
   * the convoy tows.
   */
  private handOver(live: boolean): void {
    if (this.real.visible) return;
    const { vault, world } = this.ctx;
    this.real.visible = true;
    this.decoy.visible = false;
    if (this.decoyCollider) world.removeCollider(this.decoyCollider, false);
    this.decoyCollider = null;
    if (!live) return;
    vault.render();
    this.real.position.copy(vault.mesh.position);
    this.real.quaternion.copy(vault.mesh.quaternion);
    const f = TUNNEL.frame;
    vault.place(f.toWorld(DECOY_X, STOP - TOW), f.heading);
    vault.render();
  }

  /**
   * The real vault on its way into the truck, `k` 0..1: dragged across the road to the
   * foot of the ramp (turning toward the winch as it comes), then up the ramp and in.
   */
  private load(k: number, dt = 0): void {
    const f = TUNNEL.frame;
    let x: number;
    let z: number;
    let yaw = 0;
    const footZ = RAMP_FOOT - 1.5;
    if (k < 0.45) {
      const e = ease(k / 0.45);
      x = THREE.MathUtils.lerp(LANE, TRUCK_X, e);
      z = THREE.MathUtils.lerp(STOP - TOW, footZ, e) + Math.sin(e * Math.PI) * 0.8;
      yaw = -0.5 * Math.sin(e * Math.PI);
    } else {
      x = TRUCK_X;
      z = THREE.MathUtils.lerp(footZ, TRUCK_Z - 1.4, ease((k - 0.45) / 0.55));
    }
    // Riding up the ramp: height and tilt from the ramp under its front and back.
    const h = (zz: number) => THREE.MathUtils.clamp((zz - RAMP_FOOT) / (TRUCK_Z - TAIL - RAMP_FOOT), 0, 1) * BED;
    const front = h(z + 1.5);
    const back = h(z - 1.5);
    const pitch = Math.atan2(front - back, 3);
    const before = this.real.position.clone();
    this.real.position.copy(f.toWorld(x, z, VAULT_Y + (front + back) / 2));
    this.real.quaternion.setFromEuler(new THREE.Euler(-pitch, f.heading + yaw, 0, 'YXZ'));
    this.real.updateMatrixWorld();

    // Sparks off the road as it's dragged, a clank onto the ramp and a thud inside.
    if (dt > 0 && k < 0.45) {
      const vel = this.real.position.clone().sub(before).divideScalar(dt);
      for (const [cx, cz] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
        if (Math.random() < 0.35) this.ctx.fx.scrape(this.real.localToWorld(new THREE.Vector3(cx, -1.2, cz)).setY(0.08), vel, 0.5);
      }
    }
    if (dt > 0) {
      if (k > 0.45) this.once('ramp', () => this.ctx.sound.clank());
      if (k > 0.97) this.once('in', () => this.ctx.sound.crash(0.25));
    }

    // The winch cable, from the drum to the vault's door.
    const line = this.winchLine;
    line.visible = k < 0.97;
    if (line.visible) {
      this.truck.group.updateMatrixWorld();
      const a = this.truck.group.localToWorld(this.truck.winch.clone());
      const b = this.real.localToWorld(new THREE.Vector3(0, -0.3, 1.55));
      const d = b.clone().sub(a);
      line.position.copy(a).addScaledVector(d, 0.5);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      line.scale.set(1, d.length(), 1);
    }
  }

  private once(key: string, fn: () => void): void {
    if (this.bump.has(key)) return;
    this.bump.add(key);
    fn();
  }

  /** Doors open by `k` (0 shut, 1 swung right round against the sides). */
  private openDoors(k: number): void {
    this.truck.doors.forEach((hinge, i) => {
      const s = i === 0 ? -1 : 1;
      hinge.rotation.y = -s * k * 4.3;
    });
  }

  /** Ramp stowed by `k` (0 down on the road, 1 lifted level and slid away under the bed). */
  private stowRamp(k: number): void {
    const r = this.truck.ramp;
    const down = -Math.asin(BED / RAMP);
    const lift = ease(Math.min(1, k / 0.5));
    const slide = ease(Math.max(0, (k - 0.5) / 0.5));
    r.rotation.x = down * (1 - lift);
    r.position.set(0, BED - 0.2 * slide, -TAIL + RAMP * slide);
  }

  private lightsOff(): void {
    for (const l of this.truck.lamps) l.emissiveIntensity = 0;
    this.truck.work.emissiveIntensity = 0;
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

const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
