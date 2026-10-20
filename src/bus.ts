import * as THREE from 'three';
import type { CarModel } from './carModel';
import { RAPIER } from './physics';
import { leftOf, Path } from './roads';
import { BANK, MAP, nearOverpass, type MapEdge, type MapNode, PLAN, SPIKES } from './roadmap';
import { Vehicle, type VehicleSpec } from './vehicle';

/*
 * The bus: at one busy crossing on Mia's route, a city bus pulls across just as the
 * convoy gets there. Thread it round its tail and the passengers are pressed to the
 * windows, heads turning to follow you, with a beat of slow motion; clip it and it rocks
 * and limps on with its hazards going. Our own design: a two-tone city bus with a lit
 * route sign; the people inside are silhouettes (nobody in particular).
 */

const BUS_SPEC: VehicleSpec = {
  mass: 9000,
  accel: 4,
  topSpeed: 14,
  turnRate: 1.2,
  grip: 6,
  model: { body: 0xffffff, trim: 0x111111, rim: 0x999999 },
  half: { x: 1.3, y: 1.45, z: 5.8 },
};

/** How fast it crosses (m/s), and how fast it limps on after a knock. */
const CRUISE = 10;
const LIMP = 4;

interface Crossing {
  node: MapNode;
  /** Its drive across: in along one cross street, through the junction, out along the other. */
  path: Path;
  /** How far along `path` the junction's middle is. */
  middle: number;
}

/** A painted sign: the route number and where it's going, lit. */
function signTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121212';
  g.fillRect(0, 0, 256, 48);
  g.fillStyle = '#ffb22e';
  g.font = 'bold 34px sans-serif';
  g.textBaseline = 'middle';
  g.fillText('414', 10, 25);
  g.font = 'bold 26px sans-serif';
  g.fillText('CENTRO', 92, 26);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The bus, facing +z, origin on the road; and the passengers' heads (to turn and watch). */
function buildBusModel(): { model: CarModel; heads: THREE.Object3D[]; hazards: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const paint = new THREE.MeshPhysicalMaterial({ color: 0xf1ead8, roughness: 0.45, clearcoat: 0.3 });
  const teal = new THREE.MeshStandardMaterial({ color: 0x1f7f86, roughness: 0.5 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe8792b, roughness: 0.5 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x1c2a36, roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.7 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  const brake = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 1.2 });
  const hazards = new THREE.MeshStandardMaterial({ color: 0x402000, emissive: 0xffa020, emissiveIntensity: 0 });
  const sign = new THREE.MeshBasicMaterial({ map: signTexture() });
  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = body) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  // Lower body, window band, roof; a teal skirt and an orange stripe under the windows.
  box(2.5, 1.3, 11.6, paint, 0, 1.0, 0);
  box(2.52, 0.35, 11.62, teal, 0, 0.45, 0);
  box(2.53, 0.12, 11.63, orange, 0, 1.58, 0);
  box(2.46, 1.15, 11.4, glass, 0, 2.22, 0);
  box(2.5, 0.28, 11.6, paint, 0, 2.93, 0);
  box(1.6, 0.3, 3.2, dark, 0, 3.2, -2.5); // roof unit
  // Pillars between the windows.
  for (let z = -5.1; z <= 5.2; z += 1.7) for (const x of [-1.24, 1.24]) box(0.06, 1.15, 0.14, paint, x, 2.22, z);
  // The front: windscreen, route sign, lamps; the back: lamps.
  box(2.3, 1.3, 0.05, glass, 0, 2.1, 5.81);
  const s = box(1.8, 0.32, 0.04, sign, 0, 2.86, 5.83);
  s.castShadow = false;
  box(0.4, 0.18, 0.05, brake, -0.9, 0.9, -5.82);
  box(0.4, 0.18, 0.05, brake, 0.9, 0.9, -5.82);
  for (const [x, z] of [[-1.26, 5.6], [1.26, 5.6], [-1.26, -5.6], [1.26, -5.6]] as const) box(0.05, 0.14, 0.3, hazards, x, 1.2, z);
  // Wheels: two at the front (they steer), two at the back.
  const spinners: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  for (const [x, z, front] of [[-1.05, 3.9, true], [1.05, 3.9, true], [-1.05, -3.4, false], [1.05, -3.4, false]] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.5, z);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.34, 16).rotateZ(Math.PI / 2), tyre);
    pivot.add(w);
    body.add(pivot);
    spinners.push(w);
    if (front) frontPivots.push(pivot);
  }
  // Passengers at the windows, both sides: heads and shoulders, a few of them kids.
  const person = new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.9 });
  const heads: THREE.Object3D[] = [];
  let k = 0;
  for (let z = -4.6; z <= 4.4; z += 1.15) {
    for (const x of [-0.8, 0.8]) {
      if ((k++ * 7) % 5 === 0) continue;
      const kid = k % 4 === 0;
      const p = new THREE.Group();
      p.position.set(x, kid ? 1.72 : 1.95, z);
      box(0.4, 0.3, 0.26, person, 0, -0.2, 0, p);
      const head = new THREE.Mesh(new THREE.SphereGeometry(kid ? 0.13 : 0.15, 10, 8), person);
      head.position.y = 0.12;
      p.add(head);
      body.add(p);
      heads.push(p);
    }
  }
  const model: CarModel = { group, body, spinners, frontPivots, paint, brake, wheelRadius: 0.5 };
  return { model, heads, hazards };
}

/** The crossing on Mia's route it pulls across: a straight-through junction with a cross street both sides. */
function pickCrossing(): Crossing | null {
  const spikes = SPIKES.toWorld(0, 0, 0);
  let travelled = 0;
  for (let k = 1; k < PLAN.length - 1; k++) {
    const node = PLAN[k];
    travelled += node.pos.distanceTo(PLAN[k - 1].pos);
    if (travelled < 450) continue;
    if (node.pos.distanceTo(BANK.corner) < 220 || nearOverpass(node.pos, 320) || node.pos.distanceTo(spikes) < 160) continue;
    const route = new Set<MapEdge | null>([MAP.between(PLAN[k - 1], node), MAP.between(node, PLAN[k + 1])]);
    const away = (e: MapEdge) => {
      const pts = MAP.from(e, node);
      return pts[Math.min(2, pts.length - 1)].clone().sub(node.pos).setY(0).normalize();
    };
    const cross = node.edges.filter((e) => !route.has(e) && !e.bridge && e.length > 45);
    for (const a of cross) {
      for (const b of cross) {
        if (a === b || away(a).dot(away(b)) > -0.85) continue;
        const into = [...MAP.from(a, node)].reverse();
        const out = MAP.from(b, node);
        const centre = [...trim(into, 70, true), ...trim(out, 80, false).slice(1)];
        // Keep to the right of the road.
        const lane = centre.map((p, i) => {
          const t = centre[Math.min(centre.length - 1, i + 1)].clone().sub(centre[Math.max(0, i - 1)]).setY(0).normalize();
          return p.clone().addScaledVector(leftOf(t), -Math.min(a.hw, b.hw) * 0.45);
        });
        const path = new Path(lane);
        return { node, path, middle: path.project(node.pos) };
      }
    }
  }
  return null;
}

/** The last `len` m of a line (`end`), or its first `len` m. */
function trim(pts: THREE.Vector3[], len: number, end: boolean): THREE.Vector3[] {
  const seq = end ? [...pts].reverse() : pts;
  const out = [seq[0].clone()];
  let d = 0;
  for (let i = 1; i < seq.length && d < len; i++) {
    d += seq[i].distanceTo(seq[i - 1]);
    out.push(seq[i].clone());
  }
  return end ? out.reverse() : out;
}

export class BusCrossing {
  state: 'waiting' | 'crossing' | 'gone' = 'waiting';
  private crossing = pickCrossing();
  private bus: Vehicle | null = null;
  private heads: THREE.Object3D[] = [];
  private hazards: THREE.MeshStandardMaterial | null = null;
  private s = 0;
  private speed = CRUISE;
  private knocked = false;
  private passed = false;
  private time = 0;
  /** The bus is pulling out (for Mia's warning). */
  onPullOut?: () => void;
  /** Threaded past it close at speed, untouched. */
  onNearMiss?: (at: THREE.Vector3) => void;
  /** Something hit it hard. */
  onKnock?: (at: THREE.Vector3) => void;
  /** Set by the game: true if a point is on screen. */
  visible: (p: THREE.Vector3) => boolean = () => false;

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
  ) {}

  /** Where it crosses (for tests), or null if the route has nowhere to put it. */
  get at(): THREE.Vector3 | null {
    return this.crossing?.node.pos ?? null;
  }

  get position(): THREE.Vector3 | null {
    return this.bus?.position ?? null;
  }

  /** Per physics step in the chase: wait for the convoy, then drive it across. */
  step(dt: number, player: Vehicle, others: { position: THREE.Vector3; body: RAPIER.RigidBody }[]): void {
    const c = this.crossing;
    if (!c || this.state === 'gone') return;
    if (this.state === 'waiting') {
      const d = player.position.distanceTo(c.node.pos);
      const v = player.body.linvel();
      const closing = -(v.x * (player.position.x - c.node.pos.x) + v.z * (player.position.z - c.node.pos.z)) / Math.max(1, d);
      if (d < 130 && d > 50 && closing > 12) this.pullOut(d / closing);
      return;
    }
    const bus = this.bus!;
    this.time += dt;
    // Until it's into the junction it keeps timing itself to the convoy (which speeds up and slows
    // down): its middle there a beat before the player is. Then it trundles on.
    if (!this.knocked) {
      if (this.s < c.middle) {
        const eta = player.position.distanceTo(c.node.pos) / Math.max(8, Math.abs(player.forwardSpeed));
        this.speed = THREE.MathUtils.clamp((c.middle - this.s) / Math.max(0.6, eta - 0.9), 5, 18);
      } else {
        this.speed += (CRUISE - this.speed) * Math.min(1, dt);
      }
    }
    this.s += this.speed * dt;
    const t = c.path.tangent(Math.min(this.s, c.path.length - 0.1));
    const want = c.path.at(Math.min(this.s, c.path.length)).sub(bus.position);
    const vel = t.clone().multiplyScalar(this.speed).addScaledVector(want.setY(0), 1.5);
    bus.follow(dt, vel, Math.atan2(t.x, t.z), 3);
    // Hit hard by anything of ours: it rocks and limps on.
    if (!this.knocked) {
      const bv = bus.body.linvel();
      for (const o of [player, ...others]) {
        const ov = o.body.linvel();
        if (o.position.distanceTo(bus.position) < 7.5 && Math.hypot(ov.x - bv.x, ov.z - bv.z) > 9 && this.touching(o.body)) {
          this.knocked = true;
          this.speed = LIMP;
          this.onKnock?.(bus.position.clone());
          break;
        }
      }
    }
    // Threaded: the player's past it, close (to its body, not its middle) and quick, without touching it.
    const local = bus.model.group.worldToLocal(player.position.setY(1));
    const h = BUS_SPEC.half!;
    const clear = Math.hypot(Math.max(0, Math.abs(local.x) - h.x), Math.max(0, Math.abs(local.z) - h.z));
    if (!this.passed && !this.knocked && clear < 3.5 && Math.abs(player.forwardSpeed) > 14) {
      this.passed = true;
      this.onNearMiss?.(bus.position.clone());
    }
    const gone = this.s > c.path.length - 1 || (player.position.distanceTo(bus.position) > 160 && !this.visible(bus.position));
    if (gone && this.time > 4) this.remove();
  }

  private touching(body: RAPIER.RigidBody): boolean {
    let hit = false;
    const col = body.collider(0);
    this.world.contactPair(this.bus!.collider, col, (m) => {
      if (m.numContacts() > 0) hit = true;
    });
    return hit;
  }

  /** Out it comes, timed to be across the junction a beat before the convoy (which arrives in `eta` s). */
  private pullOut(eta: number): void {
    const c = this.crossing!;
    this.state = 'crossing';
    // Its middle crosses the junction's a second before the player gets there: they go round its tail.
    const lead = THREE.MathUtils.clamp(CRUISE * (eta - 1), 18, c.middle);
    this.s = c.middle - lead;
    const at = c.path.at(this.s);
    const t = c.path.tangent(this.s);
    const { model, heads, hazards } = buildBusModel();
    this.bus = new Vehicle(this.world, BUS_SPEC, at, Math.atan2(t.x, t.z), model);
    this.bus.body.setLinvel({ x: t.x * CRUISE, y: 0, z: t.z * CRUISE }, true);
    this.scene.add(model.group);
    this.heads = heads;
    this.hazards = hazards;
    this.onPullOut?.();
  }

  /** Per frame: the bus drawn, its passengers turning to watch the convoy, hazards blinking after a knock. */
  render(dt: number, player: THREE.Vector3): void {
    const bus = this.bus;
    if (!bus) return;
    bus.render(dt);
    bus.model.brake.emissiveIntensity = this.knocked ? 3 : 1.2;
    if (this.hazards) this.hazards.emissiveIntensity = this.knocked && Math.floor(this.time * 3) % 2 === 0 ? 3 : 0;
    // Everyone turns to look.
    const local = bus.model.group.worldToLocal(player.clone().setY(2));
    for (const h of this.heads) {
      const want = Math.atan2(local.x - h.position.x, local.z - h.position.z);
      h.rotation.y += (want - h.rotation.y) * Math.min(1, dt * 4);
    }
  }

  private remove(): void {
    if (this.bus) this.bus.dispose(this.scene);
    this.bus = null;
    this.state = 'gone';
  }
}
