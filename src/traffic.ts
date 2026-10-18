import * as THREE from 'three';
import { angleTo } from './ai';
import { City } from './city';
import { RAPIER } from './physics';
import { offsetLine, Path } from './roads';
import { BANK, MAP, type MapEdge, type MapNode, SPIKES } from './roadmap';
import { Vehicle, type VehicleSpec } from './vehicle';

/**
 * Civilian traffic: a handful of cars driving their lanes round the blocks near
 * the chase, mostly straight on at intersections, sometimes turning. They slow
 * for corners and brake for whatever is in front of them. Hit one hard, or swing
 * the vault into it, and it's a wreck in the road (and property damage). They
 * come and go out of sight.
 */

const SPEC: VehicleSpec = { mass: 1300, accel: 8, topSpeed: 22, turnRate: 2.2, grip: 7, model: { body: 0xffffff, trim: 0x111111, rim: 0x999999 } };
const COLORS = [0xc0392b, 0x2e86de, 0xf1c40f, 0xecf0f1, 0x16a085, 0x7f8c8d, 0x8e44ad, 0x1f2a36, 0xd35400, 0xe8e4da, 0x2c3e50];
const MAX_CARS = 14;
/** Where they spawn and how far they live (m from the player). */
const SPAWN_MIN = 55;
const SPAWN_MAX = 170;
const DESPAWN = 230;
/** Property damage for a wrecked car. */
const WRECK_DAMAGE = 9000;
/** Keep the set pieces' streets clear (m around the bank corner and the spike strip). */
const KEEP_CLEAR = 70;

interface Civilian {
  v: Vehicle;
  /** Its lane on the street it's on, heading for `to`. */
  lane: Path;
  edge: MapEdge;
  to: MapNode;
  /** Cruising speed (m/s). */
  cruise: number;
  /** Wrecked: no longer driving, just a body in the road. */
  loose: boolean;
  looseFor: number;
  lastVel: THREE.Vector3;
}

export class Traffic {
  readonly cars: Civilian[] = [];
  /** Set by the game: true if a point is on screen (cars never pop in where you can see them). */
  visible: (p: THREE.Vector3) => boolean = () => false;
  /** Called when one is wrecked. */
  onWreck?: (at: THREE.Vector3) => void;
  private damage = 0;
  private spawnTimer = 0;
  private readonly spikes = SPIKES.toWorld(0, 0, 0);

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
  ) {}

  /** Property damage since the last call. */
  collectDamage(): number {
    const d = this.damage;
    this.damage = 0;
    return d;
  }

  /** The right-hand lane along `edge`, starting at `from`. */
  private lane(edge: MapEdge, from: MapNode): Path {
    const offset = edge.hw > 5 ? Math.min(edge.hw * 0.5, 3.4) : edge.hw * 0.4;
    return new Path(offsetLine(MAP.from(edge, from), -offset));
  }

  /** At the end of its street: on through the intersection, mostly straight. */
  private turn(c: Civilian): void {
    const node = c.to;
    const inDir = MAP.arriving(c.edge, node);
    let options = node.edges.filter((e) => e !== c.edge && !e.bridge);
    if (!options.length) options = [c.edge];
    const weights = options.map((e) => (MAP.leaving(e, node).dot(inDir) > 0.8 ? 4 : 1));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    let pick = options[0];
    for (const [i, e] of options.entries()) {
      r -= weights[i];
      if (r <= 0) {
        pick = e;
        break;
      }
    }
    c.edge = pick;
    c.to = MAP.other(pick, node);
    c.lane = this.lane(pick, node);
  }

  /**
   * Per physics step. `blockers` are everything else on the road (heroes, cops);
   * a hit from the vault or any hard knock wrecks a car.
   */
  step(dt: number, player: THREE.Vector3, playerFwd: THREE.Vector3, blockers: THREE.Vector3[], vault: { pos: THREE.Vector3; vel: THREE.Vector3 }, spawning: boolean): void {
    if (spawning) this.spawn(dt, player, playerFwd);
    for (const c of this.cars) {
      const lv = c.v.body.linvel();
      const vel = new THREE.Vector3(lv.x, 0, lv.z);
      const p = c.v.position;
      if (!c.loose) {
        const vaultHit = p.distanceTo(vault.pos) < 4.2 && vel.distanceTo(vault.vel) > 5;
        if (vaultHit || vel.distanceTo(c.lastVel) > 7) this.wreck(c, vaultHit ? vault.pos : null);
      }
      c.lastVel = vel;
      if (c.loose) {
        c.looseFor += dt;
        continue;
      }
      let s = c.lane.project(p);
      if (s > c.lane.length - 3) {
        this.turn(c);
        s = c.lane.project(p);
      }
      const speed = Math.max(0, c.v.forwardSpeed);
      const target = c.lane.at(s + 6 + speed * 0.45);
      // Slow for the corner at the end of the street, then for anything in the lane ahead.
      const toEnd = c.lane.length - s;
      let want = toEnd < 24 ? Math.min(c.cruise, 6 + toEnd * 0.3) : c.cruise;
      const f = c.v.forward;
      const ahead = (o: THREE.Vector3) => {
        const rx = o.x - p.x;
        const rz = o.z - p.z;
        const along = rx * f.x + rz * f.z;
        const side = Math.abs(rx * f.z - rz * f.x);
        if (along > 0 && along < 18 && side < 2.6) want = Math.min(want, Math.max(0, (along - 6.5) * 0.9));
      };
      for (const o of blockers) ahead(o);
      ahead(vault.pos);
      for (const o of this.cars) if (o !== c) ahead(o.v.position);
      const err = want - c.v.forwardSpeed;
      c.v.controls = {
        throttle: THREE.MathUtils.clamp(err * 0.35, 0, 1),
        brake: err < -1.2 ? THREE.MathUtils.clamp(-err * 0.3, 0.2, 1) : 0,
        steer: THREE.MathUtils.clamp(angleTo(c.v, target) * 2.2, -1, 1),
        handbrake: false,
      };
      c.v.step(dt);
    }

    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const p = c.v.position;
      const d = p.distanceTo(player);
      const gone = c.v.body.translation().y < -3 || (!this.visible(p) && (d > DESPAWN || (c.loose && c.looseFor > 12)));
      if (gone) {
        c.v.dispose(this.scene);
        this.cars.splice(i, 1);
      }
    }
  }

  render(dt: number): void {
    for (const c of this.cars) {
      c.v.render(dt);
      c.v.model.brake.emissiveIntensity = c.loose ? 0 : c.v.controls.brake > 0 ? 3.5 : 0.7;
    }
  }

  private wreck(c: Civilian, from: THREE.Vector3 | null): void {
    c.loose = true;
    c.v.enabled = false;
    const b = c.v.body;
    b.setEnabledRotations(true, true, true, true);
    b.setLinearDamping(0.9);
    b.setAngularDamping(1.5);
    if (from) {
      const away = c.v.position.sub(from.clone().setY(0)).setY(0).normalize();
      const m = SPEC.mass;
      b.applyImpulse({ x: away.x * m * 5, y: m * 3.5, z: away.z * m * 5 }, true);
      b.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 6, y: (Math.random() - 0.5) * m * 3, z: (Math.random() - 0.5) * m * 6 }, true);
    }
    this.damage += WRECK_DAMAGE;
    this.onWreck?.(c.v.position);
  }

  /** A car on a street 55-170 m away, out of sight, mostly ahead of the player. */
  private spawn(dt: number, player: THREE.Vector3, fwd: THREE.Vector3): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || this.cars.length >= MAX_CARS) return;
    this.spawnTimer = 0.4;
    const near = MAP.edges.filter((e) => {
      if (e.bridge || e.length < 30) return false;
      const mid = e.pts[Math.floor(e.pts.length / 2)];
      const d = mid.distanceTo(player);
      return d > SPAWN_MIN && d < SPAWN_MAX && mid.distanceTo(BANK.corner) > KEEP_CLEAR && mid.distanceTo(this.spikes) > KEEP_CLEAR;
    });
    for (let tries = 0; tries < 6 && near.length; tries++) {
      const edge = near[Math.floor(Math.random() * near.length)];
      const from = Math.random() < 0.5 ? edge.a : edge.b;
      const lane = this.lane(edge, from);
      const s = lane.length * (0.15 + Math.random() * 0.55);
      const at = lane.at(s);
      // Mostly where the chase is heading.
      if (at.clone().sub(player).normalize().dot(fwd) < -0.3 && Math.random() < 0.7) continue;
      if (at.distanceTo(player) < SPAWN_MIN || this.visible(at)) continue;
      if (this.cars.some((c) => c.v.position.distanceTo(at) < 14)) continue;
      const t = lane.tangent(s);
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      const v = new Vehicle(this.world, SPEC, at, Math.atan2(t.x, t.z), City.civilianCar(color));
      const cruise = edge.rank <= 2 ? 15 + Math.random() * 4 : 10 + Math.random() * 3;
      v.body.setLinvel({ x: t.x * cruise * 0.8, y: 0, z: t.z * cruise * 0.8 }, true);
      this.scene.add(v.model.group);
      this.cars.push({ v, lane, edge, to: MAP.other(edge, from), cruise, loose: false, looseFor: 0, lastVel: new THREE.Vector3(t.x, 0, t.z).multiplyScalar(cruise * 0.8) });
      return;
    }
  }
}
