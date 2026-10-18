import * as THREE from 'three';
import { RAPIER } from './physics';
import type { Vault } from './vault';
import { CAUGHT_GROUPS, type Vehicle } from './vehicle';

/**
 * Keeps the inside of the rig clear. A car that ends up between the two hero cars, or
 * between them and the vault (overtaken in its lane, or shoved in by a hero car), is
 * caught in a vice: the cables draw the vault and the cars together around it, and both
 * outrank it in a collision, so it can't be pushed out of the way and the whole convoy
 * stops dead. Instead it's thrown out of the side of the rig, passing through the hero
 * cars and the vault until it's clear of them.
 */

/** Half the rig's width at the vault end, and at least at the cars' end (m, for a car's center). */
const VAULT_HALF = 2.2;
const CARS_HALF = 1.2;
/** A car's center this close to a hero car's center counts as on top of it (m). */
const ON_TOP = 0.3;
/** Clear of the rig: this far from the vault and from every hero car (m, center to center). */
const CLEAR = 5.5;
/** How hard it's thrown out sideways and up (m/s). */
const THROW_OUT = 8;
const THROW_UP = 3.5;

interface Thrown {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  groups: number;
}

export class Rig {
  /** How many things have been thrown out of the rig (for play-tests). */
  throws = 0;
  private readonly thrown: Thrown[] = [];
  // This step's frame: the vault's center, the axis from it to the cars, and across it.
  private readonly origin = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly across = new THREE.Vector3();
  private length = 0;
  private mid = 0;
  private spread = 0;
  private cars: Vehicle[] = [];
  private vault: Vault | null = null;

  constructor(private world: RAPIER.World) {}

  /** Measure the rig for this physics step. `cars` are the cars still hooked to the vault. */
  frame(cars: Vehicle[], vault: Vault): boolean {
    this.cars = cars;
    this.vault = vault;
    this.origin.copy(vault.position).setY(0);
    const center = new THREE.Vector3();
    for (const c of cars) center.add(c.position);
    center.divideScalar(cars.length);
    this.axis.copy(center).sub(this.origin);
    this.length = this.axis.length();
    if (this.length < 3) return false;
    this.axis.divideScalar(this.length);
    this.across.set(this.axis.z, 0, -this.axis.x);
    const offsets = cars.map((c) => c.position.sub(this.origin).dot(this.across));
    const lo = Math.min(...offsets);
    const hi = Math.max(...offsets);
    this.mid = (lo + hi) / 2;
    this.spread = hi - lo;
    return true;
  }

  /**
   * If `p` is caught inside the rig, the way out (across the rig, toward the side it's
   * nearer); otherwise null.
   */
  inside(p: THREE.Vector3): THREE.Vector3 | null {
    const r = p.clone().setY(0).sub(this.origin);
    const along = r.dot(this.axis);
    // In front of the vault's middle, and no further forward than the cars' noses.
    if (along < 1 || along > this.length + 2) return null;
    const rear = Math.max(1, this.length - 2.5);
    const carsHalf = Math.max(CARS_HALF, this.spread / 2 + ON_TOP);
    const k = Math.min(1, along / rear);
    const center = this.mid * k;
    const half = VAULT_HALF + (carsHalf - VAULT_HALF) * k;
    const off = r.dot(this.across) - center;
    if (Math.abs(off) >= half) return null;
    return this.across.clone().multiplyScalar(off >= 0 ? 1 : -1);
  }

  isThrown(collider: RAPIER.Collider): boolean {
    return this.thrown.some((t) => t.collider === collider);
  }

  /**
   * Throw a body out of the rig the way `out` points, carried on with the convoy's
   * velocity and tumbling, and let it pass through the rig until it's clear.
   */
  throwOut(body: RAPIER.RigidBody, collider: RAPIER.Collider, out: THREE.Vector3, convoy: THREE.Vector3): void {
    this.throws++;
    this.thrown.push({ body, collider, groups: collider.collisionGroups() });
    collider.setCollisionGroups(CAUGHT_GROUPS);
    body.setEnabledRotations(true, true, true, true);
    body.wakeUp();
    body.setLinvel({ x: convoy.x * 0.9 + out.x * THROW_OUT, y: THROW_UP, z: convoy.z * 0.9 + out.z * THROW_OUT }, true);
    // Rolling over away from the rig (its roof goes the way it's thrown), and some spin.
    const roll = new THREE.Vector3(0, 1, 0).cross(out).multiplyScalar(3);
    body.setAngvel({ x: roll.x, y: (Math.random() - 0.5) * 4, z: roll.z }, true);
  }

  /**
   * Per physics step, after frame(): thrown bodies get their collisions back once they're
   * clear of the rig (out of it, and away from the vault and the cars).
   */
  step(): void {
    for (let i = this.thrown.length - 1; i >= 0; i--) {
      const t = this.thrown[i];
      // Gone (despawned): forget it.
      if (this.world.getRigidBody(t.body.handle) !== t.body) {
        this.thrown.splice(i, 1);
        continue;
      }
      const p = t.body.translation();
      const at = new THREE.Vector3(p.x, 0, p.z);
      const near = (q: THREE.Vector3) => at.distanceTo(q.setY(0)) < CLEAR;
      if (this.inside(at) || (this.vault && near(this.vault.position)) || this.cars.some((c) => near(c.position))) continue;
      t.collider.setCollisionGroups(t.groups);
      this.thrown.splice(i, 1);
    }
  }
}
