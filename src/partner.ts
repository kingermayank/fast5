import * as THREE from 'three';
import { angleTo, avoidance } from './ai';
import type { City } from './city';
import type { ControlState } from './input';
import type { RAPIER } from './physics';
import type { Vehicle } from './vehicle';

const TRAIL_SPACING = 1.5;
const TRAIL_MAX = 400;
/** Lateral distance from the player's driving line. */
const FORMATION_OFFSET = 6;

/**
 * The AI partner. It follows the line the player actually drove (a breadcrumb
 * trail), offset to its own side, so it takes the same corners instead of
 * steering at a point beside the player that may be inside a building.
 */
export class PartnerDriver {
  private trail: THREE.Vector3[] = [];
  /** Trail index nearest to the partner. */
  private index = 0;
  private stuck = 0;
  private reversing = 0;
  private reverseSteer = 0;

  constructor(
    private world: RAPIER.World,
    private city: City,
    /** +1 = drive on the player's left, -1 = right. */
    private side: number,
  ) {}

  reset(player: Vehicle): void {
    this.trail = [player.position];
    this.index = 0;
    this.stuck = this.reversing = 0;
  }

  controls(dt: number, player: Vehicle, me: Vehicle, vault: THREE.Vector3): ControlState {
    this.record(player);
    const pc = player.controls;

    // Player reversing or braking at a standstill: back up with them.
    if (player.forwardSpeed < -1 || (pc.brake > 0 && player.forwardSpeed < 1)) {
      return { throttle: 0, brake: pc.brake || 1, steer: pc.steer, handbrake: false };
    }

    // Wedged against something while trying to drive: back out briefly.
    if (this.reversing > 0) {
      this.reversing -= dt;
      return { throttle: 0, brake: 1, steer: this.reverseSteer, handbrake: false };
    }

    // Fell behind the vault (it slid between us): go around it on our side, and
    // never back up into it, which would drag the vault backwards.
    const fwd = player.forward;
    const behindVault = vault.clone().setY(0).sub(me.position).dot(fwd) > 1;
    const target = behindVault
      ? vault.clone().setY(0).addScaledVector(new THREE.Vector3(fwd.z, 0, -fwd.x), this.side * FORMATION_OFFSET).addScaledVector(fwd, 6)
      : this.target(player, me);
    const steer = THREE.MathUtils.clamp(angleTo(me, target) * 2.2 + avoidance(this.world, me, 10) * 0.5, -1, 1);

    // Speed: match the player, close any gap along their direction of travel.
    const gap = player.position.sub(me.position).dot(player.forward);
    const speedErr = player.forwardSpeed - me.forwardSpeed;
    let throttle = THREE.MathUtils.clamp(0.35 + gap * 0.12 + speedErr * 0.06, 0, 1);
    if (pc.throttle > 0 && gap > -2) throttle = Math.max(throttle, pc.throttle * 0.9);
    let brake = 0;
    if (gap < -4) {
      throttle = 0;
      brake = 0.3;
    }
    if (player.forwardSpeed < 1 && pc.throttle === 0) throttle = 0;

    const tryingToMove = throttle > 0.5;
    this.stuck = tryingToMove && Math.abs(me.forwardSpeed) < 1.5 ? this.stuck + dt : 0;
    if (this.stuck > 1.2 && !behindVault) {
      this.stuck = 0;
      this.reversing = 0.8;
      this.reverseSteer = -Math.sign(steer || 1);
    }

    return { throttle, brake, steer, handbrake: pc.handbrake };
  }

  private record(player: Vehicle): void {
    const p = player.position;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(p) > TRAIL_SPACING) this.trail.push(p);
    if (this.trail.length > TRAIL_MAX) {
      this.trail.shift();
      this.index = Math.max(0, this.index - 1);
    }
  }

  /** A point a little ahead of the partner on the player's line, shifted to the partner's side. */
  private target(player: Vehicle, me: Vehicle): THREE.Vector3 {
    const pos = me.position;
    const trail = this.trail;

    // Nearest trail point, searching forward from the last one.
    let best = this.index;
    let bestD = Infinity;
    for (let i = Math.max(0, this.index - 10); i < trail.length; i++) {
      const d = trail[i].distanceToSquared(pos);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.index = best;

    // Walk ahead along the trail; past its end, continue along the player's heading.
    let remaining = 7 + Math.abs(me.forwardSpeed) * 0.35;
    let point = trail[best].clone();
    let tangent = player.forward;
    for (let i = best; i < trail.length - 1; i++) {
      const seg = trail[i + 1].clone().sub(trail[i]);
      const len = seg.length();
      if (len < 1e-3) continue;
      tangent = seg.divideScalar(len);
      if (len >= remaining) {
        point = trail[i].clone().addScaledVector(tangent, remaining);
        remaining = 0;
        break;
      }
      remaining -= len;
      point = trail[i + 1].clone();
    }
    if (remaining > 0) {
      tangent = player.forward;
      point = player.position.addScaledVector(tangent, remaining);
    }

    const left = new THREE.Vector3(tangent.z, 0, -tangent.x);
    const beside = point.clone().addScaledVector(left, this.side * FORMATION_OFFSET);
    // No room beside the player (narrow spot, corner): fall in on their line.
    return this.city.isStreet(beside.x, beside.z) ? beside : point;
  }
}
