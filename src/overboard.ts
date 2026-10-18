import * as THREE from 'three';
import { RAPIER } from './physics';
import type { Vehicle } from './vehicle';

/**
 * A car thrown over the bridge rail into the bay. The ground is one flat slab
 * under the water (city.ts), so nothing can really fall in: the car leaves the
 * physics (kinematic) and flies a scripted arc instead, up over the barrier,
 * tumbling, down into the water with a splash, and sinks.
 */
export interface Plunge {
  v: Vehicle;
  from: THREE.Vector3;
  /** Out over the rail (unit, level), and along the deck (its speed that way, m/s). */
  out: THREE.Vector3;
  along: THREE.Vector3;
  /** How far out it lands beyond where it started (m). */
  reach: number;
  /** Which way it rolls, its rotation when it went, and seconds since. */
  roll: number;
  start: THREE.Quaternion;
  t: number;
  splashed: boolean;
  done: boolean;
}

/** Seconds from the deck to the water, and the water's height. */
const FLIGHT = 1.3;
const WATER = -4;

/** Send `v` over the rail: `out` points off the deck, `toRail` is how far the barrier is (m). */
export function startPlunge(v: Vehicle, out: THREE.Vector3, toRail: number): Plunge {
  const b = v.body;
  const vel = b.linvel();
  const o = out.clone().setY(0).normalize();
  const along = new THREE.Vector3(vel.x, 0, vel.z).addScaledVector(o, -(vel.x * o.x + vel.z * o.z));
  b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
  const r = b.rotation();
  const t = b.translation();
  return {
    v,
    from: new THREE.Vector3(t.x, t.y, t.z),
    out: o,
    along: along.multiplyScalar(0.6),
    reach: Math.max(2, toRail) + 6,
    roll: Math.random() < 0.5 ? 1 : -1,
    start: new THREE.Quaternion(r.x, r.y, r.z, r.w),
    t: 0,
    splashed: false,
    done: false,
  };
}

/** Advance a plunge by `dt`; `onSplash` once, where it hits the water. */
export function stepPlunge(p: Plunge, dt: number, onSplash: (at: THREE.Vector3) => void): void {
  if (p.done) return;
  p.t += dt;
  const k = p.t / FLIGHT;
  const b = p.v.body;
  let pos: THREE.Vector3;
  let tip: number;
  if (k < 1) {
    // Up over the barrier and out, tipping toward the water as it goes.
    pos = p.from
      .clone()
      .addScaledVector(p.out, p.reach * (1 - (1 - k) ** 2))
      .addScaledVector(p.along, p.t);
    pos.y = p.from.y + 10 * k - (15.2 + p.from.y - 0.7) * k * k;
    tip = 2.4 * k;
  } else {
    if (!p.splashed) {
      p.splashed = true;
      onSplash(p.from.clone().addScaledVector(p.out, p.reach).addScaledVector(p.along, FLIGHT).setY(WATER));
    }
    // Under it goes, nose first, slowly.
    const s = Math.min(1, (k - 1) / 1.6);
    pos = p.from.clone().addScaledVector(p.out, p.reach + s * 1.5).addScaledVector(p.along, FLIGHT + s * 0.6);
    pos.y = -4.5 - 4 * s;
    tip = 2.4 + 0.5 * s;
    if (s >= 1) p.done = true;
  }
  // Roll about the line along the deck (over the rail), then a little yaw.
  const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), p.out).normalize();
  const q = new THREE.Quaternion().setFromAxisAngle(axis, tip * p.roll).multiply(p.start);
  b.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
  b.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
}
