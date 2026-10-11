import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

export const FIXED_DT = 1 / 60;

export async function initPhysics(): Promise<RAPIER.World> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED_DT;
  world.numSolverIterations = 8;
  return world;
}

export function toThree(v: RAPIER.Vector, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.y, v.z);
}

export function quatToThree(q: RAPIER.Rotation, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.set(q.x, q.y, q.z, q.w);
}

export function yawQuat(heading: number): RAPIER.Rotation {
  return { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
}

/** Sync a mesh to a rigid body. */
export function syncMesh(mesh: THREE.Object3D, body: RAPIER.RigidBody, yOffset = 0): void {
  const t = body.translation();
  const r = body.rotation();
  mesh.quaternion.set(r.x, r.y, r.z, r.w);
  mesh.position.set(t.x, t.y, t.z);
  if (yOffset) mesh.position.add(new THREE.Vector3(0, yOffset, 0).applyQuaternion(mesh.quaternion));
}
