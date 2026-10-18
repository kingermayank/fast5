import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CarModel } from './carModel';
import { buildFigure, type Figure } from './people';
import type { VehicleSpec } from './vehicle';

/*
 * Police motorbikes: quick, nimble and fragile. They weave up alongside the convoy,
 * and anything solid (the vault above all) takes them down: the rider is thrown clear
 * and tumbles to a stop, the bike goes over and slides. Our own design: a white touring
 * bike with a windscreen, panniers and a red-and-blue light mast, and a rider in a navy
 * uniform and white helmet (a generic figure, nobody in particular).
 *
 * Drawn cheaply: the bike's parts are merged into a few vertex-coloured meshes, and the
 * seated rider is one baked mesh, swapped for the jointed figure only when they're thrown.
 */

export const BIKE_SPEC: VehicleSpec = {
  mass: 320,
  accel: 30,
  topSpeed: 62,
  turnRate: 2.8,
  grip: 10,
  model: { body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true },
  half: { x: 0.45, y: 0.55, z: 1.15 },
};

const WHEEL_R = 0.33;
/** Seat height above the road. */
const SEAT_Y = 0.9;

const WHITE = 0xf4f4f4;
const DARK = 0x1b1d21;
const CHROME = 0xb8bcc2;
const STRIPE = 0x1f4fa8;
const TYRE = 0x111111;

/** Pieces of one rigid part, merged into a single vertex-coloured geometry. */
class Parts {
  private geos: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0): this {
    const g = (geo.index ? geo.toNonIndexed() : geo).rotateX(rx).translate(x, y, z);
    const c = new THREE.Color(color);
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geos.push(g);
    return this;
  }

  merged(): THREE.BufferGeometry {
    return mergeGeometries(this.geos)!;
  }

  mesh(mat: THREE.Material, shadow = true): THREE.Mesh {
    const m = new THREE.Mesh(this.merged(), mat);
    m.castShadow = shadow;
    return m;
  }
}

/** A figure in its current pose as one vertex-coloured geometry, in the figure's own frame. */
function bakeFigure(f: Figure): THREE.BufferGeometry {
  const parts = new Parts();
  const root = f.group;
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Each part where it sits in the pose (scaled parts, like reflective bands, come through scaled).
    const g = mesh.geometry.clone().applyMatrix4(inv.clone().multiply(mesh.matrixWorld));
    parts.add(g, (mesh.material as THREE.MeshStandardMaterial).color.getHex(), 0, 0, 0);
  });
  return parts.merged();
}

export interface BikeModel {
  model: CarModel;
  /** The jointed rider (hidden while they ride: `seated` is drawn instead). */
  rider: Figure;
  seated: THREE.Object3D;
}

/** The bike, facing +z with its origin on the road, and its rider in the saddle. */
export function buildBikeModel(): BikeModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const painted = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.25 });
  const matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4dc, transparent: true, opacity: 0.45, roughness: 0.1 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff0c8, emissiveIntensity: 2.5 });
  const brake = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1a1a, emissiveIntensity: 1.2 });
  const red = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2020, emissiveIntensity: 0.2 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x000a40, emissive: 0x2050ff, emissiveIntensity: 0.2 });
  // The paint material only stands in for the owner (darkened when it's wrecked); the bike's white is vertex colour.
  const paint = new THREE.MeshPhysicalMaterial({ color: 0xffffff });
  const lit = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
  };

  // The frame and everything on it, which lean together.
  const frame = new Parts()
    .add(new THREE.BoxGeometry(0.34, 0.24, 0.52), WHITE, 0, 0.94, 0.18) // tank
    .add(new THREE.BoxGeometry(0.36, 0.06, 0.53), STRIPE, 0, 0.86, 0.18)
    .add(new THREE.BoxGeometry(0.3, 0.09, 0.62), DARK, 0, SEAT_Y, -0.24) // seat
    .add(new THREE.BoxGeometry(0.36, 0.34, 0.46), DARK, 0, 0.52, 0.04) // engine
    .add(new THREE.BoxGeometry(0.4, 0.14, 0.3), CHROME, 0, 0.42, 0.12)
    .add(new THREE.CylinderGeometry(0.05, 0.06, 0.78, 8), CHROME, 0.22, 0.36, -0.42, Math.PI / 2) // exhaust
    .add(new THREE.BoxGeometry(0.14, 0.08, 0.7), DARK, 0, 0.4, -0.45) // swing arm
    .add(new THREE.BoxGeometry(0.22, 0.08, 0.42), WHITE, 0, 0.76, -0.86) // tail
    .add(new THREE.BoxGeometry(0.03, 0.42, 0.03), DARK, 0, 1.0, -0.8); // light mast
  for (const s of [1, -1]) {
    frame.add(new THREE.BoxGeometry(0.22, 0.32, 0.44), WHITE, s * 0.31, 0.7, -0.58); // panniers
    frame.add(new THREE.BoxGeometry(0.225, 0.06, 0.445), STRIPE, s * 0.31, 0.66, -0.58);
  }
  body.add(frame.mesh(painted));
  lit(body, new THREE.BoxGeometry(0.16, 0.07, 0.04), brake, 0, 0.78, -1.08);
  lit(body, new THREE.BoxGeometry(0.1, 0.08, 0.07), red, 0.07, 1.22, -0.8);
  lit(body, new THREE.BoxGeometry(0.1, 0.08, 0.07), blue, -0.07, 1.22, -0.8);

  const wheel = () => {
    const w = new Parts()
      .add(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.13, 18).rotateZ(Math.PI / 2), TYRE, 0, 0, 0)
      .add(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 12).rotateZ(Math.PI / 2), CHROME, 0, 0, 0)
      // A spoke bar, so you can see it turn.
      .add(new THREE.BoxGeometry(0.15, 0.3, 0.04), DARK, 0, 0, 0)
      .mesh(matte);
    return w;
  };
  const rear = wheel();
  rear.position.set(0, WHEEL_R, -0.73);
  body.add(rear);

  // The front end turns with the steering: fork, fairing, screen, bars, lamp and wheel.
  const front = new THREE.Group();
  front.position.set(0, 0.95, 0.55);
  body.add(front);
  const fork = new Parts()
    .add(new THREE.BoxGeometry(0.5, 0.42, 0.34), WHITE, 0, 0.05, 0.08) // fairing
    .add(new THREE.BoxGeometry(0.505, 0.07, 0.345), STRIPE, 0, -0.06, 0.08)
    .add(new THREE.BoxGeometry(0.72, 0.035, 0.035), DARK, 0, 0.2, -0.06); // bars
  for (const s of [1, -1]) fork.add(new THREE.BoxGeometry(0.04, 0.66, 0.04), CHROME, s * 0.09, -0.33, 0.12, 0.25);
  front.add(fork.mesh(painted));
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.38, 0.02), glass);
  screen.position.set(0, 0.42, 0.2);
  screen.rotation.x = -0.35;
  front.add(screen);
  lit(front, new THREE.CylinderGeometry(0.09, 0.09, 0.05, 12).rotateX(Math.PI / 2), lamp, 0, 0.04, 0.26);
  const frontWheel = wheel();
  frontWheel.position.set(0, WHEEL_R - 0.95, 0.17);
  front.add(frontWheel);

  // The rider, sitting forward, hands on the bars, in a white helmet with a dark visor.
  const rider = buildFigure({ suit: 0x1d2a44, skin: [0x7a5236, 0xc89f7e, 0x5b3a26][Math.floor(Math.random() * 3)] });
  rider.group.position.set(0, SEAT_Y + 0.04 - 0.98, -0.28);
  rider.upper.rotation.x = 0.3;
  rider.armL.rotation.set(-1.15, 0, 0.12);
  rider.armR.rotation.set(-1.15, 0, -0.12);
  rider.legL.rotation.set(-1.0, 0, 0.12);
  rider.legR.rotation.set(-1.0, 0, -0.12);
  const helmet = new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.25, metalness: 0.1 });
  const visor = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.3 });
  const h = new THREE.Mesh(new THREE.SphereGeometry(0.165, 14, 10), helmet);
  h.position.y = 0.8;
  const v = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.06), visor);
  v.position.set(0, 0.8, 0.14);
  rider.upper.add(h, v);
  for (const m of [h, v]) m.castShadow = true;
  // Riding, they're one baked mesh; the jointed figure only comes out when they're thrown.
  const seated = new THREE.Mesh(bakeFigure(rider), matte);
  seated.castShadow = true;
  seated.position.copy(rider.group.position);
  rider.group.visible = false;
  body.add(rider.group, seated);

  const model: CarModel = {
    group,
    body,
    spinners: [frontWheel, rear],
    frontPivots: [front],
    lightBar: { red, blue },
    paint,
    brake,
    wheelRadius: WHEEL_R,
  };
  return { model, rider, seated };
}

/** A rider thrown from a bike: flying, tumbling, and then lying where they came down. */
export interface Thrown {
  /** Spins about the rider's hips. */
  pivot: THREE.Group;
  figure: Figure;
  vel: THREE.Vector3;
  axis: THREE.Vector3;
  spin: number;
  bounces: number;
  down: number;
  /** Lying on their back, any which way. */
  rest: THREE.Quaternion;
}

/** Take the rider off the bike into the scene, thrown along `push` (m/s). */
export function throwRider(scene: THREE.Scene, rider: Figure, seated: THREE.Object3D, push: THREE.Vector3): Thrown {
  const fig = rider.group;
  seated.visible = false;
  fig.visible = true;
  fig.updateWorldMatrix(true, false);
  const pivot = new THREE.Group();
  pivot.position.copy(new THREE.Vector3(0, 0.98, 0).applyMatrix4(fig.matrixWorld));
  scene.add(pivot);
  pivot.attach(fig);
  // Arms and legs out as they go.
  rider.upper.rotation.set(0, 0, 0);
  const axis = new THREE.Vector3(Math.random() - 0.5, (Math.random() - 0.5) * 0.4, Math.random() - 0.5).normalize();
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2);
  const rest = yaw.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  return { pivot, figure: rider, vel: push.clone(), axis, spin: 7 + Math.random() * 5, bounces: 0, down: 0, rest };
}

/**
 * One step of a thrown rider: a tumbling arc, a bounce, a slide to a stop on their back,
 * and then (they're fine) sitting up. Returns true the moment they hit the road.
 */
export function stepThrown(r: Thrown, dt: number): boolean {
  const f = r.figure;
  if (r.down === 0) {
    r.vel.y -= 18 * dt;
    r.pivot.position.addScaledVector(r.vel, dt);
    r.pivot.rotateOnAxis(r.axis, r.spin * dt);
    const flail = Math.sin(r.pivot.position.y * 4 + r.spin);
    f.armL.rotation.set(-1.5 + flail, 0, 1.2);
    f.armR.rotation.set(-1.5 - flail, 0, -1.2);
    f.legL.rotation.set(-0.6 + flail * 0.5, 0, 0.3);
    f.legR.rotation.set(-0.6 - flail * 0.5, 0, -0.3);
    if (r.pivot.position.y < 0.3 && r.vel.y < 0) {
      if (r.bounces++ < 1 && r.vel.y < -4) {
        r.vel.set(r.vel.x * 0.5, -r.vel.y * 0.3, r.vel.z * 0.5);
        r.pivot.position.y = 0.3;
        r.spin *= 0.5;
      } else {
        r.down = 1e-3;
      }
      return true;
    }
    return false;
  }
  r.down += dt;
  const k = Math.max(0, 1 - dt * 3);
  r.vel.x *= k;
  r.vel.z *= k;
  r.pivot.position.x += r.vel.x * dt;
  r.pivot.position.z += r.vel.z * dt;
  r.pivot.position.y += (0.15 - r.pivot.position.y) * Math.min(1, dt * 10);
  r.pivot.quaternion.slerp(r.rest, Math.min(1, dt * 7));
  for (const p of [f.armL, f.armR, f.legL, f.legR]) p.rotation.x *= Math.max(0, 1 - dt * 6);
  // A couple of seconds later they sit up and shake it off.
  const sit = THREE.MathUtils.clamp((r.down - 2) / 0.6, 0, 1);
  f.upper.rotation.x = sit * 1.15;
  f.upper.rotation.z = sit > 0.99 ? Math.sin(r.down * 9) * 0.06 : 0;
  return false;
}
