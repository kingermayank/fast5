import * as THREE from 'three';
import { RAPIER, syncMesh, yawQuat } from './physics';
import type { Vehicle } from './vehicle';
import { TOW_POINT } from './vehicle';

const HALF = { x: 1.5, y: 1.25, z: 1.5 };
export const VAULT_MASS = 4000;

/** Steel vault: a heavy sliding box. Its local +z face is the door, where the cables attach. */
export class Vault {
  readonly body: RAPIER.RigidBody;
  readonly mesh = new THREE.Group();

  constructor(world: RAPIER.World, position: THREE.Vector3, heading: number) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, HALF.y + 0.02, position.z)
        .setRotation(yawQuat(heading))
        .setCcdEnabled(true)
        .setAngularDamping(0.6)
        .setLinearDamping(0.05),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setMass(VAULT_MASS).setFriction(0.45).setRestitution(0.05),
      this.body,
    );
    this.buildMesh();
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** Local cable anchor on the door face; side -1 = right, 1 = left. */
  anchorLocal(side: number): RAPIER.Vector {
    return { x: side * 0.9, y: -0.7, z: HALF.z };
  }

  anchorWorld(side: number): THREE.Vector3 {
    const a = this.anchorLocal(side);
    const r = this.body.rotation();
    const t = this.body.translation();
    return new THREE.Vector3(a.x, a.y, a.z).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  place(position: THREE.Vector3, heading: number): void {
    this.body.setTranslation({ x: position.x, y: HALF.y + 0.02, z: position.z }, true);
    this.body.setRotation(yawQuat(heading), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  render(): void {
    syncMesh(this.mesh, this.body);
  }

  private buildMesh(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.85, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a3e44, metalness: 0.8, roughness: 0.5 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(HALF.x * 2, HALF.y * 2, HALF.z * 2), steel);
    box.castShadow = box.receiveShadow = true;
    this.mesh.add(box);
    // Door, hinges and wheel lock on the +z face.
    const door = new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.0, 0.12), dark);
    door.position.z = HALF.z + 0.06;
    door.castShadow = true;
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.06, 8, 20), steel);
    wheel.position.z = HALF.z + 0.16;
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.2, 10).rotateX(Math.PI / 2), steel);
    hub.position.z = HALF.z + 0.16;
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.06), steel);
      spoke.position.z = HALF.z + 0.16;
      spoke.rotation.z = (i * Math.PI) / 3;
      this.mesh.add(spoke);
    }
    for (const y of [-0.6, 0.6]) {
      const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.35, 8), dark);
      hinge.position.set(-1.15, y, HALF.z + 0.12);
      this.mesh.add(hinge);
    }
    this.mesh.add(door, wheel, hub);
  }
}

/**
 * Steel cable from a car's winch to the vault. A rope joint: slack below its
 * length, rigid at it. The length can be reeled in (the joint is recreated).
 */
export class Cable {
  private joint: RAPIER.ImpulseJoint;
  private mesh: THREE.Mesh;
  private reelTimer = 0;
  length: number;

  constructor(
    private world: RAPIER.World,
    scene: THREE.Scene,
    readonly car: Vehicle,
    readonly vault: Vault,
    readonly side: number,
    length: number,
  ) {
    this.length = length;
    this.joint = this.createJoint();
    this.mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.4 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);
  }

  private createJoint(): RAPIER.ImpulseJoint {
    return this.world.createImpulseJoint(
      RAPIER.JointData.rope(this.length, TOW_POINT, this.vault.anchorLocal(this.side)),
      this.car.body,
      this.vault.body,
      true,
    );
  }

  /** Pay out cable to `length` (the winch reels it back in over the next second or so). */
  payOut(length: number): void {
    if (length <= this.length) return;
    this.length = length;
    this.world.removeImpulseJoint(this.joint, true);
    this.joint = this.createJoint();
    // Hold the slack long enough for the swing to play out.
    this.reelTimer = 1.6;
  }

  /** Winch toward `target` length, never longer than the current distance allows. */
  reel(target: number, dt: number): void {
    this.reelTimer -= dt;
    if (this.reelTimer > 0 || this.length <= target) return;
    this.reelTimer = 0.2;
    const dist = this.car.towPoint().distanceTo(this.vault.anchorWorld(this.side));
    const next = Math.max(target, Math.min(this.length, dist + 0.2) - 1);
    if (next >= this.length - 0.05) return;
    this.length = next;
    this.world.removeImpulseJoint(this.joint, true);
    this.joint = this.createJoint();
  }

  render(): void {
    const a = this.car.towPoint();
    const b = this.vault.anchorWorld(this.side);
    const d = a.distanceTo(b);
    const sag = Math.sqrt(Math.max(0, this.length * this.length - d * d)) * 0.35;
    const mid = a.clone().lerp(b, 0.5);
    mid.y = Math.max(0.05, mid.y - sag);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(curve, 12, 0.05, 5, false);
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.world.removeImpulseJoint(this.joint, true);
  }
}
