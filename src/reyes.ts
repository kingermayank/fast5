import * as THREE from 'three';
import type { Sound } from './audio';
import type { CarModel } from './carModel';
import type { Director } from './director';
import type { Effects } from './fx';
import { type Plunge, startPlunge, stepPlunge } from './overboard';
import { buildFigure, type Figure } from './people';
import { RAPIER } from './physics';
import { leftOf, type Path } from './roads';
import type { Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';

/*
 * Reyes's convoy on the bridge: two black SUVs that come through the cops head-on at
 * the lone car, swing round and ride alongside it, and have gunmen standing up through the sunroofs. Swing the
 * vault into one and it's wrecked (over the rail if it's near enough); swing it
 * into Reyes's and the finale takes over.
 */

const SUV_WHEEL = 0.46;
const FRONT_AXLE = 1.5;
const REAR_AXLE = -1.5;
const WIDTH = 2.0;

const SUV_SPEC: VehicleSpec = {
  mass: 2400,
  accel: 22,
  topSpeed: 60,
  turnRate: 2.2,
  grip: 7,
  model: { body: 0x0c0d0f, trim: 0x08090a, rim: 0x2a2c2f },
};

function extrude(shape: THREE.Shape, width: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width - 0.12, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, curveSegments: 8 });
  // Drawn in (z, y), extruded along +z: turn so the extrusion runs across the car, centred.
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - 0.12) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

/** A big, square-shouldered black SUV with a sunroof (our own design). Origin on the ground at its middle, facing +z. */
function buildSuvModel(): CarModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ color: 0x0c0d0f, metalness: 0.6, roughness: 0.28, clearcoat: 0.9, clearcoatRoughness: 0.15 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x08090a, roughness: 0.7 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x050709, metalness: 0.9, roughness: 0.06, clearcoat: 1 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.15 });
  const brake = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 1.2 });
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f6ff, emissiveIntensity: 3.2 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    body.add(m);
    return m;
  };
  const arch = SUV_WHEEL + 0.1;
  const sill = 0.42;
  const lower = new THREE.Shape();
  lower.moveTo(-2.45, sill);
  lower.lineTo(REAR_AXLE - arch, sill);
  lower.absarc(REAR_AXLE, SUV_WHEEL, arch, Math.PI, 0, true);
  lower.lineTo(FRONT_AXLE - arch, sill);
  lower.absarc(FRONT_AXLE, SUV_WHEEL, arch, Math.PI, 0, true);
  lower.lineTo(2.42, sill);
  lower.lineTo(2.52, 0.86);
  lower.lineTo(2.45, 1.12);
  lower.lineTo(1.15, 1.2);
  lower.lineTo(-2.32, 1.24);
  lower.lineTo(-2.5, 1.08);
  lower.lineTo(-2.45, sill);
  add(extrude(lower, WIDTH), paint);
  const cabin = new THREE.Shape();
  cabin.moveTo(1.15, 1.18);
  cabin.lineTo(0.35, 1.84);
  cabin.lineTo(-2.12, 1.88);
  cabin.lineTo(-2.32, 1.22);
  cabin.lineTo(1.15, 1.18);
  add(extrude(cabin, WIDTH - 0.2), glass);
  // Roof panel with the sunroof opening (dark), roof rails, pillars.
  add(new THREE.BoxGeometry(WIDTH - 0.26, 0.06, 2.3), paint, 0, 1.9, -0.92);
  add(new THREE.BoxGeometry(1.0, 0.07, 0.95), new THREE.MeshStandardMaterial({ color: 0x020203, roughness: 1 }), 0, 1.925, -0.75);
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, 0.06, 2.1), chrome, s * 0.78, 1.97, -0.9);
    add(new THREE.BoxGeometry(0.06, 0.6, 0.12), paint, s * (WIDTH / 2 - 0.12), 1.52, -0.45);
    add(new THREE.BoxGeometry(0.24, 0.14, 0.22), trim, s * 1.06, 1.3, 0.95);
    add(new THREE.BoxGeometry(0.5, 0.12, 0.05), head, s * 0.66, 0.92, 2.5);
    add(new THREE.BoxGeometry(0.34, 0.2, 0.05), brake, s * 0.75, 1.0, -2.49);
  }
  // A tall grille in a chrome frame, a black bumper skirt.
  add(new THREE.BoxGeometry(1.0, 0.42, 0.06), trim, 0, 0.78, 2.52);
  add(new THREE.BoxGeometry(1.08, 0.05, 0.07), chrome, 0, 1.0, 2.53);
  add(new THREE.BoxGeometry(1.08, 0.05, 0.07), chrome, 0, 0.56, 2.53);
  add(new THREE.BoxGeometry(WIDTH - 0.1, 0.18, 0.3), trim, 0, 0.45, 2.38);
  add(new THREE.BoxGeometry(WIDTH - 0.1, 0.18, 0.3), trim, 0, 0.45, -2.4);

  const tire = new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.92 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, metalness: 0.85, roughness: 0.3 });
  const spinners: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  for (const [x, z, front] of [
    [-0.88, FRONT_AXLE, true],
    [0.88, FRONT_AXLE, true],
    [-0.88, REAR_AXLE, false],
    [0.88, REAR_AXLE, false],
  ] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(x, SUV_WHEEL, z);
    const spinner = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(SUV_WHEEL, SUV_WHEEL, 0.34, 22).rotateZ(Math.PI / 2), tire);
    t.castShadow = true;
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.36, 10).rotateZ(Math.PI / 2), rim);
    spinner.add(t, r);
    pivot.add(spinner);
    group.add(pivot);
    spinners.push(spinner);
    if (front) frontPivots.push(pivot);
  }
  return { group, body, spinners, frontPivots, paint, brake, wheelRadius: SUV_WHEEL };
}

/** A gunman in dark clothes, standing up through the sunroof with a rifle at his shoulder. */
function buildGunner(): { figure: Figure; muzzle: THREE.Object3D } {
  const figure = buildFigure({ suit: 0x1b1d21, skin: [0x8a5a3c, 0x6b4630, 0xb98a68][Math.floor(Math.random() * 3)], hat: 0x101112 });
  // Hips just under the roof, so the chest and the gun are out in the air.
  figure.group.position.set(0, 0.88, -0.75);
  const gun = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x1e2022, metalness: 0.7, roughness: 0.4 });
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.9), steel);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6).rotateX(Math.PI / 2), steel);
  barrel.position.z = 0.68;
  gun.add(stock, barrel);
  gun.position.set(-0.12, 0.42, 0.3);
  figure.upper.add(gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.z = 0.95;
  gun.add(muzzle);
  // Arms forward, holding it.
  figure.armL.rotation.set(-1.35, 0, 0.25);
  figure.armR.rotation.set(-1.45, 0, -0.1);
  return { figure, muzzle };
}

interface Suv {
  v: Vehicle;
  gunner: Figure;
  muzzle: THREE.Object3D;
  /** Reyes rides in this one. */
  boss: boolean;
  /** The side of the player's car it rides on (+1 left). */
  side: number;
  wrecked: boolean;
  plunge: Plunge | null;
  /** Seconds to its next burst, rounds left in this one, and to the next round. */
  fire: number;
  burst: number;
  round: number;
  /** Hits it can still take (Reyes's takes three), and seconds it's reeling from the last one. */
  hp: number;
  reeling: number;
}

/** A tracer round in flight: a thin streak of light, there for a frame or two. */
interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

export class Reyes {
  readonly suvs: Suv[] = [];
  /** Seconds since they came alongside (the fallback runs on it). */
  escortTime = 0;
  /** Reyes's car has been hit (the finale has it from here). */
  bossHit = false;
  /** The vault slammed into Reyes's SUV; `forced` if it was the fallback. */
  onBossHit?: (at: THREE.Vector3, forced: boolean) => void;
  /** One of his SUVs wrecked by the vault. */
  onWreck?: (at: THREE.Vector3) => void;
  /** Reyes's SUV took a hit and kept going: hits left. */
  onBossDamaged?: (at: THREE.Vector3, left: number) => void;
  onSplash?: (at: THREE.Vector3) => void;
  private tracers: Tracer[] = [];
  private marker: THREE.Mesh;
  private time = 0;

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
    private fx: Effects,
    private sound: Sound,
    private director: Director,
  ) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    for (let i = 0; i < 14; i++) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 4).translate(0, 0.5, 0), mat.clone());
      (mesh.material as THREE.MeshBasicMaterial).color.setRGB(3, 2.4, 1.2);
      mesh.visible = false;
      scene.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    // A red marker over Reyes's SUV, so you know which one.
    this.marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.1, 4).rotateX(Math.PI),
      new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a2a, emissiveIntensity: 3 }),
    );
    this.marker.visible = false;
    scene.add(this.marker);
  }

  get active(): boolean {
    return this.suvs.length > 0;
  }

  /** Reyes's SUV, while it's on the road. */
  get boss(): Suv | null {
    return this.suvs.find((s) => s.boss && !s.wrecked) ?? null;
  }

  /** Both SUVs come out along the bridge from `back` m toward the city of the player (head-on, after the split's turn), fast. */
  arrive(path: Path, player: Vehicle, back = 80): void {
    const s0 = path.project(player.position);
    for (const [i, side] of [1, -1].entries()) {
      const s = Math.max(5, s0 - back - i * 14);
      const t = path.tangent(s);
      const at = path.at(s).addScaledVector(leftOf(t), side * 5);
      const v = new Vehicle(this.world, SUV_SPEC, at, Math.atan2(t.x, t.z), buildSuvModel());
      v.body.setLinvel({ x: t.x * 30, y: 0, z: t.z * 30 }, true);
      this.scene.add(v.model.group);
      const g = buildGunner();
      v.model.body.add(g.figure.group);
      this.suvs.push({ v, gunner: g.figure, muzzle: g.muzzle, boss: i === 1, side, wrecked: false, plunge: null, fire: 2 + i, burst: 0, round: 0, hp: i === 1 ? 3 : 1, reeling: 0 });
    }
  }

  /**
   * Per physics step: drive them (up alongside the player, between the car and the
   * vault, where a swing will find them), see what the vault hit, fly the plunges.
   */
  step(dt: number, player: Vehicle, vault: Vault, rail: (p: THREE.Vector3) => { out: THREE.Vector3; toRail: number } | null): void {
    if (!this.active) return;
    const pv = player.body.linvel();
    const playerVel = new THREE.Vector3(pv.x, 0, pv.z);
    const f = player.forward;
    const left = leftOf(f);
    const vv = vault.body.linvel();
    // The vault's own swing: its velocity off the player's.
    const swing = new THREE.Vector3(vv.x, 0, vv.z).sub(playerVel);
    let alongside = false;
    for (const s of this.suvs) {
      if (s.plunge) {
        stepPlunge(s.plunge, dt, (at) => this.onSplash?.(at));
        continue;
      }
      if (s.wrecked) continue;
      const pos = s.v.position;
      s.reeling = Math.max(0, s.reeling - dt);
      // Hit, it drops back and out wide for a moment before it comes again.
      const back = s.reeling > 0 ? -14 : s.boss ? -5.5 : -7.5;
      const target = player.position.addScaledVector(left, s.side * (s.reeling > 0 ? 9 : 6.2)).addScaledVector(f, back);
      const err = target.clone().sub(pos);
      const want = playerVel.clone().addScaledVector(err, 1.3);
      if (err.length() > 40) want.setLength(Math.max(playerVel.length() + 14, 30));
      if (want.length() > 42) want.setLength(42);
      const heading = want.length() > 2 ? Math.atan2(want.x, want.z) : s.v.heading;
      s.v.follow(dt, want, heading, 3);
      if (err.length() < 14) alongside = true;
      // The vault swung into it.
      const d = pos.distanceTo(vault.position.setY(0));
      const toward = pos.clone().sub(vault.position.setY(0)).normalize();
      if (d < 4.6 && swing.dot(toward) > 3 && s.reeling <= 0) this.hit(s, vault, rail);
    }
    if (alongside) this.escortTime += dt;
    // Too long without the swing landing: Reyes swerves into the vault himself.
    const boss = this.boss;
    if (boss && !this.bossHit && this.escortTime > 45) {
      this.bossHit = true;
      this.onBossHit?.(boss.v.position, true);
    }
  }

  private hit(s: Suv, vault: Vault, rail: (p: THREE.Vector3) => { out: THREE.Vector3; toRail: number } | null): void {
    const at = s.v.position;
    if (s.boss) {
      if (this.bossHit) return;
      if (--s.hp > 0) {
        // Stove in and shoved aside, smoking, but still coming.
        s.reeling = 2.2;
        const away = at.clone().sub(vault.position.setY(0)).setY(0).normalize();
        const v = s.v.body.linvel();
        s.v.body.setLinvel({ x: v.x + away.x * 9, y: v.y, z: v.z + away.z * 9 }, true);
        s.v.model.paint.color.multiplyScalar(0.8);
        this.fx.burst(at.clone().setY(1.1), 1.1);
        this.fx.shatter(at.clone().setY(1.2), away.multiplyScalar(5), 50);
        this.sound.crash(1);
        this.director.shake = Math.max(this.director.shake, 0.9);
        this.onBossDamaged?.(at, s.hp);
        return;
      }
      this.bossHit = true;
      this.onBossHit?.(at, false);
      return;
    }
    s.wrecked = true;
    s.v.enabled = false;
    s.gunner.group.visible = false;
    s.v.model.paint.color.multiplyScalar(0.6);
    this.fx.burst(at.clone().setY(1), 1.4);
    this.sound.crash(1.2);
    const r = rail(at);
    if (r && r.toRail < 8) {
      s.plunge = startPlunge(s.v, r.out, r.toRail);
    } else {
      const b = s.v.body;
      b.setEnabledRotations(true, true, true, true);
      const away = at.clone().sub(vault.position.setY(0)).setY(0).normalize();
      const m = s.v.spec.mass * 1.6;
      b.applyImpulse({ x: away.x * m * 6, y: m * 5, z: away.z * m * 6 }, true);
      b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 6, y: (Math.random() - 0.5) * m * 3, z: (Math.random() - 0.5) * m * 6 }, true);
    }
    this.onWreck?.(at);
  }

  /** Per frame: gunmen aim and fire (flashes, tracers, sparks off the car), the marker bobs, the models follow. */
  update(dt: number, player: Vehicle, shooting: boolean): void {
    if (!this.active) return;
    this.time += dt;
    for (const t of this.tracers) {
      t.life -= dt;
      t.mesh.visible = t.life > 0;
    }
    for (const s of this.suvs) {
      s.v.render(dt);
      if (s.wrecked || s.plunge) continue;
      // Damaged, it trails smoke.
      if (s.hp < 3 && s.boss && Math.random() < dt * (4 - s.hp) * 4) this.fx.puff(s.v.position.setY(1.4), 1);
      // Turn the gunman to face the car.
      const local = s.v.model.group.worldToLocal(player.position.setY(1.2));
      s.gunner.group.rotation.y = Math.atan2(local.x, local.z - s.gunner.group.position.z);
      const d = s.v.position.distanceTo(player.position);
      if (!shooting || d > 38) continue;
      s.fire -= dt;
      if (s.fire <= 0 && s.burst === 0) {
        s.burst = 7 + Math.floor(Math.random() * 4);
        s.fire = 1.6 + Math.random() * 1.2;
      }
      if (s.burst > 0) {
        s.round -= dt;
        if (s.round <= 0) {
          s.round = 0.085;
          s.burst--;
          this.shoot(s, player);
        }
      }
    }
    const boss = this.boss;
    this.marker.visible = !!boss && !this.bossHit;
    if (boss) {
      this.marker.position.copy(boss.v.position).setY(4.2 + Math.sin(this.time * 5) * 0.25);
      this.marker.rotation.y += dt * 2.5;
    }
  }

  /** One round: a flash at the muzzle, a tracer to the car (or past it), and sparks where it lands. */
  private shoot(s: Suv, player: Vehicle): void {
    const from = s.muzzle.getWorldPosition(new THREE.Vector3());
    const hit = Math.random() < 0.6;
    const r = player.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const spot = new THREE.Vector3((Math.random() - 0.5) * 1.8, 0.4 + Math.random() * 0.9, (Math.random() - 0.5) * 4.2).applyQuaternion(q).add(player.position);
    const to = hit ? spot : spot.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)).setY(0.05);
    this.fx.muzzle(from);
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
    const d = to.clone().sub(from);
    t.mesh.position.copy(from);
    t.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    t.mesh.scale.set(1, d.length(), 1);
    t.mesh.visible = true;
    t.life = 0.05;
    if (Math.random() < 0.7) this.sound.gunshot();
    if (hit) {
      this.fx.scrape(to, d.clone().normalize().multiplyScalar(-4), 0.6);
      if (Math.random() < 0.3) this.sound.ping(2600 + Math.random() * 1800, 0.05, 0.12);
      this.director.shake = Math.max(this.director.shake, 0.18);
    } else {
      this.fx.puff(to, 1);
    }
  }

  /** Off the road: everything goes (the finale stages its own). */
  clear(): void {
    for (const s of this.suvs) s.v.dispose(this.scene);
    this.suvs.length = 0;
    this.marker.visible = false;
    for (const t of this.tracers) t.mesh.visible = false;
  }
}
