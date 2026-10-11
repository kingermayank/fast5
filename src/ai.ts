import * as THREE from 'three';
import type { ControlState } from './input';
import { RAPIER } from './physics';
import type { Vehicle } from './vehicle';

/** Signed angle (radians) from the car's heading to `target`; positive = target is to the left. */
export function angleTo(v: Vehicle, target: THREE.Vector3): number {
  const f = v.forward;
  const p = v.position;
  const dx = target.x - p.x;
  const dz = target.z - p.z;
  const side = dx * f.z - dz * f.x;
  const ahead = dx * f.x + dz * f.z;
  return Math.atan2(side, ahead);
}

const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });

/**
 * Steering bias away from static obstacles (buildings, walls) using two
 * forward feelers. Returns -1..1 to add to steer.
 */
export function avoidance(world: RAPIER.World, v: Vehicle, range = 16): number {
  const p = v.body.translation();
  const h = v.heading;
  const cast = (angle: number) => {
    const a = h + angle;
    ray.origin = { x: p.x, y: 0.8, z: p.z };
    ray.dir = { x: Math.sin(a), y: 0, z: Math.cos(a) };
    const hit = world.castRay(ray, range, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, v.collider);
    return hit ? hit.timeOfImpact : range;
  };
  const left = cast(0.4);
  const right = cast(-0.4);
  if (left >= range && right >= range) return 0;
  // Steer toward the side with more room, harder the closer the wall.
  return THREE.MathUtils.clamp(((left - right) / range) * 2.5, -1, 1);
}

/** Drive toward a point at full throttle, slowing for sharp turns. */
export function seek(world: RAPIER.World, v: Vehicle, target: THREE.Vector3, aggression = 1): ControlState {
  const angle = angleTo(v, target);
  const steer = THREE.MathUtils.clamp(angle * 2.5 + avoidance(world, v), -1, 1);
  const sharp = Math.abs(angle) > 1.2;
  return {
    throttle: sharp ? 0.4 : aggression,
    brake: sharp && v.forwardSpeed > 25 ? 0.5 : 0,
    steer,
    handbrake: false,
  };
}
