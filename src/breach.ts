import * as THREE from 'three';
import type { Sound } from './audio';
import { buildArmoredTruck, buildCarModel } from './carModel';
import { CAR_STARTS, type City, VAULT_START } from './city';
import { type CameraFrame, ease, lerpFrame, type Shot } from './cutscene';
import type { Effects } from './fx';
import { BEACONS } from './groundfx';
import { RAPIER, yawQuat } from './physics';
import type { Vehicle } from './vehicle';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Hobbs's truck: up the east side of the street, swing left, straight through the vault-room wall. */
const CHARGE = new THREE.CatmullRomCurve3([v3(206, 0, -10), v3(206, 0, 90), v3(205.5, 0, 128), v3(201, 0, 145), v3(194, 0, 150), v3(183.5, 0, 150)]);
/** Backing out and parking on the corner, clear of the getaway. */
const BACKOUT = new THREE.CatmullRomCurve3([v3(183.5, 0, 150), v3(196, 0, 148), v3(207, 0, 138), v3(212, 0, 122)]);
/** Cops on the station steps who open fire on the truck. */
const SHOOTERS = [v3(187.6, 1.5, 126), v3(187.6, 1.5, 133), v3(187.8, 1.5, 170), v3(214, 1.5, 168)];
/** Hobbs and Elena, beside their parked truck, firing back while the cables go on. */
const COVER = [v3(209.6, 1.55, 125.2), v3(211.2, 1.5, 127.6)];
/** The barrier across the forecourt the truck turns into: its post, and the arm out across the way. */
const GATE_POST = v3(198, 0, 153.4);
const GATE_ARM = 7.2;

/** Red and white stripes along a barrier arm. */
function stripeTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 8;
  const ctx = c.getContext('2d')!;
  for (let x = 0; x < 128; x += 16) {
    ctx.fillStyle = x % 32 ? '#f4f4f0' : '#d01818';
    ctx.fillRect(x, 0, 16, 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A stop sign: a red octagon with PARE across it. */
function stopSignTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    ctx.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62);
  }
  ctx.fill();
  ctx.fillStyle = '#c8141c';
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * Math.PI) / 4;
    ctx.lineTo(64 + Math.cos(a) * 55, 64 + Math.sin(a) * 55);
  }
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PARE', 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type TruckMode = 'waiting' | 'charge' | 'backout' | 'parked';

export interface BreachCast {
  /** The car that waits on the left (+x when facing north) and the one on the right. */
  left: Vehicle;
  right: Vehicle;
  /** Attach the cables to the vault. */
  hook(): void;
}

/**
 * The opening set piece, as in the film: Hobbs and Elena ram the station in an
 * armored truck while the cops open fire, the truck breaks the vault-room wall
 * and backs out, Dom and Brian reverse their cars up to the hole, and the
 * cables go on the vault.
 */
export class BreachScene {
  readonly truck: THREE.Group;
  private body: RAPIER.RigidBody;
  private mode: TruckMode = 'waiting';
  private progress = 0;
  private impacted = false;
  private copBars: { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial }[] = [];
  private shotTimer = 0;
  private coverTimer = 0;
  private time = 0;
  /** The barrier the truck snaps on its way in, and the arm in flight once it has. */
  private gateArm: THREE.Group;
  private armFly: { vel: THREE.Vector3; spin: THREE.Vector3 } | null = null;
  /** Station cops keep shooting until the vault is out. */
  shooting = false;
  /** Hobbs and Elena fire back from beside their truck (while the cables go on and the cars pull). */
  covering = false;
  onImpact?: () => void;

  constructor(
    private world: RAPIER.World,
    scene: THREE.Scene,
    city: City,
    private fx: Effects,
    private sound: Sound,
  ) {
    this.truck = buildArmoredTruck();
    scene.add(this.truck);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(206, 0, -10));
    world.createCollider(RAPIER.ColliderDesc.cuboid(1.3, 1.5, 3.3).setTranslation(0, 1.6, 0), this.body);
    this.placeTruck(CHARGE.getPointAt(0), 0);

    // Two cruisers parked out front, lights going. They're props: the vault can wreck them.
    for (const [x, z, h] of [[214, 176, -0.5], [191, 198, 0.35]] as const) {
      const m = buildCarModel({ body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true });
      const holder = new THREE.Group();
      if (m.lightBar) {
        this.copBars.push(m.lightBar);
        BEACONS.push({ at: holder, bar: m.lightBar });
      }
      m.group.position.y = -0.7;
      holder.add(m.group);
      city.addProp(holder, v3(x, 0.7, z), RAPIER.ColliderDesc.cuboid(1.0, 0.55, 2.5).setMass(1700).setFriction(0.8), 25000, h);
    }

    // The barrier across the forecourt: a striped arm on a post, a stop sign hanging off it.
    const gate = new THREE.Group();
    gate.position.copy(GATE_POST);
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.15, 0.35), new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 }));
    post.position.y = 0.58;
    post.castShadow = true;
    gate.add(post);
    this.gateArm = new THREE.Group();
    this.gateArm.position.y = 1.0;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, GATE_ARM), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.5 }));
    arm.position.z = -GATE_ARM / 2;
    arm.castShadow = true;
    const sign = new THREE.Mesh(new THREE.CircleGeometry(0.42, 8), new THREE.MeshStandardMaterial({ map: stopSignTexture(), side: THREE.DoubleSide, roughness: 0.4 }));
    sign.position.set(0, -0.48, -GATE_ARM * 0.55);
    sign.rotation.y = Math.PI / 2;
    this.gateArm.add(arm, sign);
    gate.add(this.gateArm);
    scene.add(gate);

    // Bollards along the pavement outside the vault room, and a stone planter on the corner:
    // in the way of the vault as it comes out.
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85 });
    const band = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 });
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.95, 10), concrete);
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.1, 10), band);
      r.position.y = 0.3;
      g.add(b, r);
      city.addProp(g, v3(189.6, 0.475, 143 + i * 2.6), RAPIER.ColliderDesc.cylinder(0.475, 0.22).setMass(140), 800);
    }
    const planter = new THREE.Group();
    const stone = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.0, 1.2), new THREE.MeshStandardMaterial({ color: 0x9c9384, roughness: 0.9 }));
    const soil = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.05, 1.0), new THREE.MeshStandardMaterial({ color: 0x3b2c20, roughness: 1 }));
    soil.position.y = 0.5;
    const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1).scale(1.6, 0.7, 0.6), new THREE.MeshStandardMaterial({ color: 0x3f6a2e, roughness: 0.9 }));
    shrub.position.y = 0.85;
    planter.add(stone, soil, shrub);
    city.addProp(planter, v3(191.2, 0.5, 166), RAPIER.ColliderDesc.cuboid(1.6, 0.5, 0.6).setMass(1400).setFriction(0.8), 3000, Math.PI / 2);
  }

  get truckPosition(): THREE.Vector3 {
    const t = this.body.translation();
    return v3(t.x, 0, t.z);
  }

  /** Per frame: move the truck, flash cruiser lights, cops fire. */
  update(dt: number): void {
    this.time += dt;
    if (this.mode === 'charge') {
      // Slow start, fast finish into the wall.
      this.progress = Math.min(1, this.progress + dt * (0.045 + this.progress * 0.5));
      const p = CHARGE.getPointAt(this.progress);
      const t = CHARGE.getTangentAt(this.progress);
      this.placeTruck(p, Math.atan2(t.x, t.z));
      // The barrier: the truck takes the arm clean off its post.
      if (!this.armFly && p.x < GATE_POST.x + 0.5 && p.z > 140) {
        this.armFly = { vel: v3(-14, 4.5, -2), spin: v3(0.6, 3.2, 5) };
        this.sound.crash(0.7);
        this.fx.burst(GATE_POST.clone().add(v3(0, 1, -2.5)), 0.6);
      }
      if (!this.impacted && p.x < 187) {
        this.impacted = true;
        this.sound.crash(1.4);
        this.fx.burst(v3(184.5, 1.5, 150), 2);
        this.blastWall();
        this.onImpact?.();
      }
    } else if (this.mode === 'backout') {
      this.progress = Math.min(1, this.progress + dt * 0.36);
      const k = ease(this.progress);
      const p = BACKOUT.getPointAt(k);
      const t = BACKOUT.getTangentAt(k);
      // Reversing: the nose points against the direction of travel.
      this.placeTruck(p, Math.atan2(-t.x, -t.z));
      if (this.progress >= 1) this.mode = 'parked';
    }

    const flash = Math.floor(this.time * 6) % 2 === 0;
    for (const bar of this.copBars) {
      bar.red.emissiveIntensity = flash ? 4 : 0.2;
      bar.blue.emissiveIntensity = flash ? 0.2 : 4;
    }

    // The barrier arm, spinning away and down onto the road.
    if (this.armFly) {
      const a = this.gateArm;
      if (a.position.y > 0.1 || this.armFly.vel.y > 0) {
        this.armFly.vel.y -= 14 * dt;
        a.position.addScaledVector(this.armFly.vel, dt);
        a.rotation.x += this.armFly.spin.x * dt;
        a.rotation.y += this.armFly.spin.y * dt;
        a.rotation.z += this.armFly.spin.z * dt;
        if (a.position.y <= 0.1) {
          a.position.y = 0.1;
          a.rotation.set(0, a.rotation.y, Math.PI / 2);
          this.armFly.vel.set(0, 0, 0);
          this.armFly.spin.set(0, 0, 0);
        }
      }
    }

    if (this.covering) {
      this.coverTimer -= dt;
      if (this.coverTimer <= 0) {
        this.coverTimer = 0.18 + Math.random() * 0.5;
        this.fx.muzzle(COVER[Math.floor(Math.random() * COVER.length)]);
        this.sound.gunshot();
      }
    }

    if (this.shooting) {
      this.shotTimer -= dt;
      if (this.shotTimer <= 0) {
        this.shotTimer = 0.12 + Math.random() * 0.45;
        this.fx.muzzle(SHOOTERS[Math.floor(Math.random() * SHOOTERS.length)]);
        this.sound.gunshot();
      }
    }
  }

  /** The ram's force carries through the whole brick wall: throw every brick around the hole. */
  private blastWall(): void {
    const origin = v3(190, 1.2, 150);
    this.world.forEachRigidBody((b) => {
      const p = b.translation();
      // Only a truck-sized hole: the vault has to tear the rest of the wall out itself.
      if (!b.isDynamic() || p.x < 182 || p.x > 185.5 || Math.abs(p.z - 150) > 1.7 || p.y > 3.2) return;
      const dir = v3(p.x, p.y, p.z).sub(origin).normalize();
      const m = b.mass();
      b.wakeUp();
      b.applyImpulse({ x: dir.x * m * (6 + Math.random() * 6), y: m * (1 + Math.random() * 3), z: dir.z * m * (8 + Math.random() * 6) }, true);
      b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m, y: (Math.random() - 0.5) * m, z: (Math.random() - 0.5) * m }, true);
    });
  }

  /** Jump straight to the end state (skip, or starting from a preset). */
  finishInstantly(cast: BreachCast): void {
    // Knock the wall out: give every brick a shove into the room.
    this.mode = 'parked';
    const end = BACKOUT.getPointAt(1);
    const t = BACKOUT.getTangentAt(1);
    this.placeTruck(end, Math.atan2(-t.x, -t.z), true);
    this.world.forEachRigidBody((b) => {
      const p = b.translation();
      if (b.isDynamic() && p.x > 182 && p.x < 185 && Math.abs(p.z - 150) < 1.7 && p.y < 3.2) {
        b.setTranslation({ x: 172 + Math.random() * 3, y: 0.3 + Math.random(), z: p.z + (Math.random() < 0.5 ? -3 : 3) }, true);
      }
    });
    cast.left.place(CAR_STARTS[1], 0);
    cast.right.place(CAR_STARTS[0], 0);
    this.covering = true;
    if (!this.armFly) {
      // The barrier's already down.
      this.armFly = { vel: v3(0, 0, 0), spin: v3(0, 0, 0) };
      this.gateArm.position.set(-9, 0.1, -3);
      this.gateArm.rotation.set(0, 1.1, Math.PI / 2);
    }
    if (!this.hooked) {
      this.hooked = true;
      cast.hook();
    }
  }

  shots(cast: BreachCast, cutsceneShake: (amount: number) => void): Shot[] {
    this.onImpact = () => cutsceneShake(1);
    const placeCars = (k: number) => {
      // Reverse in from up the street to the hole.
      const e = ease(k);
      cast.left.place(CAR_STARTS[1].clone().setZ(THREE.MathUtils.lerp(215, CAR_STARTS[1].z, e)), 0);
      cast.right.place(CAR_STARTS[0].clone().setZ(THREE.MathUtils.lerp(222, CAR_STARTS[0].z, e)), 0);
    };
    placeCars(0);
    const vault = VAULT_START;
    const truckCam = (offset: THREE.Vector3, lookAhead: number): CameraFrame => {
      const p = this.truckPosition;
      return { pos: p.clone().add(offset), look: p.clone().add(v3(0, 1.5, lookAhead)) };
    };

    return [
      {
        duration: 6.5,
        title: 'RIO DE JANEIRO',
        camera: (k) => lerpFrame([430, 230, -170], [262, 70, 40], [190, 0, 150], [186, 8, 150], k),
        lines: [
          [0.8, 'MIA', 'Reyes keeps a hundred million dollars in an evidence vault inside police headquarters.'],
          [4.2, 'MIA', 'And every cop guarding it is on his payroll.'],
        ],
      },
      {
        duration: 4.5,
        camera: (k) => lerpFrame([216, 2.2, 96], [214, 2.4, 104], [188, 4, 142], [187, 4, 146], k),
        lines: [
          [0.3, 'HOBBS', 'For the record, this is the dumbest plan I have ever signed up for.'],
          [3.0, 'DOM', 'Then hold on tight.'],
        ],
      },
      {
        duration: 4.6,
        start: () => {
          this.mode = 'charge';
          this.progress = 0;
          this.shooting = true;
        },
        camera: () => truckCam(v3(-9, 1.4, 10), -6),
        lines: [
          [0.6, 'ELENA', 'They are shooting at us!'],
          [2.3, 'HOBBS', 'Let them shoot.'],
        ],
      },
      {
        duration: 2.4,
        camera: (k) => lerpFrame([197, 4.5, 170], [196, 4.2, 168], [184, 2, 151], [183, 1.8, 150], k),
        update: () => {
          // Make sure the truck finishes the charge during this shot even on slow frames.
          if (this.mode === 'charge' && this.progress > 0.97) this.progress = 1;
        },
      },
      {
        duration: 3.6,
        start: () => {
          this.mode = 'backout';
          this.progress = 0;
        },
        camera: (k) => lerpFrame([199, 7, 174], [197, 5, 166], [182, 2, 151], [178, 1.5, 150], k),
        lines: [[0.8, 'ELENA', 'Vault is exposed. Go, go!']],
      },
      {
        duration: 4.4,
        start: () => {
          this.covering = true;
        },
        update: (t) => placeCars(Math.min(1, t / 4)),
        camera: (k) => lerpFrame([170.6, 3.7, 151.5], [171.4, 3.6, 151.5], [199, 1.2, 163], [199, 1.3, 158], k),
        lines: [
          [0.4, 'BRIAN', 'Backing in. Get the cables on it!'],
          [2.4, 'ELENA', 'Covering you! Go!'],
        ],
      },
      {
        duration: 3.2,
        start: () => placeCars(1),
        update: (t) => {
          if (t > 0.7 && !this.hooked) {
            this.hooked = true;
            cast.hook();
            this.sound.clank();
          }
        },
        camera: (k) => lerpFrame([183, 1.6, 145.5], [182.3, 1.8, 146.5], [vault.x + 1.6, 0.9, vault.z], [vault.x + 1.8, 1.0, vault.z + 1], k),
        lines: [[1.2, 'DOM', 'Hooked. Let’s ride.']],
      },
    ];
  }

  private hooked = false;

  private placeTruck(p: THREE.Vector3, heading: number, teleport = false): void {
    const q = yawQuat(heading);
    if (teleport) {
      this.body.setTranslation({ x: p.x, y: 0, z: p.z }, true);
      this.body.setRotation(q, true);
    } else {
      this.body.setNextKinematicTranslation({ x: p.x, y: 0, z: p.z });
      this.body.setNextKinematicRotation(q);
    }
    this.truck.position.set(p.x, 0, p.z);
    this.truck.quaternion.set(q.x, q.y, q.z, q.w);
  }
}
