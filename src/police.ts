import * as THREE from 'three';
import { seek } from './ai';
import type { City } from './city';
import { BRIDGE_X } from './city';
import { RAPIER } from './physics';
import type { Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';

const COP_SPEC: VehicleSpec = {
  mass: 1700,
  accel: 22,
  topSpeed: 52,
  turnRate: 2.4,
  grip: 7,
  model: { body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true },
};

interface Cop {
  v: Vehicle;
  wrecked: boolean;
  lastSpeed: number;
  stuck: number;
  reversing: number;
  wreckedFor: number;
}

export class Police {
  readonly cops: Cop[] = [];
  wreckedCount = 0;
  /** Called when a cruiser is wrecked, with where it happened. */
  onWreck?: (at: THREE.Vector3) => void;
  private spawnTimer = 2;
  private time = 0;

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
    private city: City,
  ) {}

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

    for (const c of this.cops) {
      const pos = c.v.position;
      const speed = Math.hypot(c.v.body.linvel().x, c.v.body.linvel().z);

      if (!c.wrecked) {
        // Hit by the swinging vault, or a violent stop (wall, hero car): wrecked.
        const cv = c.v.body.linvel();
        const rel = Math.hypot(vaultVel.x - cv.x, vaultVel.z - cv.z);
        const vaultHit = pos.distanceTo(vaultPos.clone().setY(0)) < 4.3 && rel > 6;
        if (vaultHit || c.lastSpeed - speed > 24) this.wreck(c, vaultHit ? vaultPos : null);
      }
      c.lastSpeed = speed;
      if (c.wrecked) {
        c.wreckedFor += dt;
        continue;
      }

      if (c.reversing > 0) {
        c.reversing -= dt;
        c.v.controls = { throttle: 0, brake: 1, steer: -Math.sign(c.v.steer || 1), handbrake: false };
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

    // Despawn far-away and long-wrecked cops.
    for (let i = this.cops.length - 1; i >= 0; i--) {
      const c = this.cops[i];
      const d = c.v.position.distanceTo(target.position);
      const fell = c.v.body.translation().y < -3;
      if (fell || d > 380 || (c.wrecked && ((c.wreckedFor > 6 && d > 50) || c.wreckedFor > 14))) {
        c.v.dispose(this.scene);
        this.cops.splice(i, 1);
      }
    }
  }

  render(dt: number): void {
    const flash = Math.floor(this.time * 6) % 2 === 0;
    for (const c of this.cops) {
      c.v.render(dt);
      c.v.model.brake.emissiveIntensity = c.wrecked ? 0 : c.v.controls.brake > 0 ? 4 : 1.2;
      const bar = c.v.model.lightBar;
      if (bar && !c.wrecked) {
        bar.red.emissiveIntensity = flash ? 3 : 0.2;
        bar.blue.emissiveIntensity = flash ? 0.2 : 3;
      }
    }
  }

  clear(): void {
    for (const c of this.cops) c.v.dispose(this.scene);
    this.cops.length = 0;
    this.wreckedCount = 0;
    this.spawnTimer = 2;
  }

  private wreck(c: Cop, from: THREE.Vector3 | null): void {
    c.wrecked = true;
    c.v.enabled = false;
    this.wreckedCount++;
    this.onWreck?.(c.v.position);
    const b = c.v.body;
    b.setEnabledRotations(true, true, true, true);
    if (from) {
      const away = c.v.position.sub(from.clone().setY(0)).setY(0).normalize();
      const m = c.v.spec.mass;
      b.applyImpulse({ x: away.x * m * 6, y: m * 5, z: away.z * m * 6 }, true);
      b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 8, y: (Math.random() - 0.5) * m * 4, z: (Math.random() - 0.5) * m * 8 }, true);
    }
    const bar = c.v.model.lightBar;
    if (bar) bar.red.emissiveIntensity = bar.blue.emissiveIntensity = 0;
    c.v.model.paint.color.multiplyScalar(0.55);
  }

  private spawn(dt: number, target: Vehicle, heat: number, onBridge: boolean): void {
    this.spawnTimer -= dt;
    const active = this.cops.filter((c) => !c.wrecked).length;
    if (this.spawnTimer > 0 || active >= 2 + Math.round(heat * 1.5) || this.cops.length >= 14) return;
    this.spawnTimer = Math.max(1.2, 4.5 - heat * 0.6);

    const tp = target.position;
    let spot: THREE.Vector3 | undefined;
    if (onBridge) {
      // Behind the player on the bridge, or ahead coming the other way.
      const ahead = Math.random() < 0.4;
      spot = new THREE.Vector3(BRIDGE_X + (Math.random() - 0.5) * 16, 0, tp.z + (ahead ? 220 : -130));
    } else {
      const options = this.city.intersections.filter((p) => {
        const d = p.distanceTo(tp);
        return d > 110 && d < 260;
      });
      spot = options[Math.floor(Math.random() * options.length)];
    }
    if (!spot) return;
    if (this.cops.some((c) => c.v.position.distanceTo(spot!) < 9)) return;
    const heading = Math.atan2(tp.x - spot.x, tp.z - spot.z);
    const v = new Vehicle(this.world, { ...COP_SPEC, topSpeed: COP_SPEC.topSpeed + heat * 3 }, spot, heading);
    this.scene.add(v.model.group);
    this.cops.push({ v, wrecked: false, lastSpeed: 0, stuck: 0, reversing: 0, wreckedFor: 0 });
  }
}
