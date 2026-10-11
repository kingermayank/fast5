import * as THREE from 'three';
import { angleTo, avoidance } from './ai';
import type { City } from './city';
import type { ControlState } from './input';
import type { RAPIER } from './physics';
import { exits, lanePath, leftOf, nextIntersection, Path, roadHalfWidth, routeExit, snapDir, streetCenter } from './roads';
import type { Vehicle } from './vehicle';

/** Lateral distance kept from the player's line. */
const FORMATION_OFFSET = 5;
/** Keep this far from the curb (car half-width plus margin). */
const CURB_MARGIN = 2.3;
/** Never plan a line closer than this to the player's. */
const MIN_SEPARATION = 3.2;

export interface Obstacle {
  pos: THREE.Vector3;
  radius: number;
  /** Steer around it, but never brake for it (the vault we're towing, the player). */
  soft?: boolean;
}

export interface PartnerContext {
  player: Vehicle;
  me: Vehicle;
  vault: THREE.Vector3;
  vaultVel: THREE.Vector3;
  /** Mia's remaining route waypoints (intersections), next one first. */
  route: THREE.Vector3[];
  /** Cops, parked cars, kiosks... anything that moves or can be knocked over. */
  obstacles: Obstacle[];
  /** True if a point is on screen (teleporting there would be noticed). */
  visible(p: THREE.Vector3): boolean;
}

/** Debug readout of what the partner is thinking. */
export interface PartnerThoughts {
  mode: 'lane' | 'trail' | 'recover';
  turn: 'straight' | 'left' | 'right' | 'none';
  shift: number;
  blocked: boolean;
}

/**
 * The AI partner. It reads the street grid like a driver would:
 *  - route knowledge: it knows the streets and Mia's route, so it plans its own
 *    lane through the next intersection instead of chasing the player;
 *  - prediction: it guesses the player's turn from their heading, steering and
 *    the route, before the player commits;
 *  - sensing: cops, parked cars, the vault and the player are obstacles; it
 *    shifts lane around them or brakes;
 *  - teamwork: it positions itself for corners and pulls against the vault's
 *    swing to steady it;
 *  - assists: a little catch-up help and off-screen recovery, as most racing
 *    games do for AI teammates.
 */
export class PartnerDriver {
  private steerMemory = 0;
  private stuck = 0;
  private reversing = 0;
  private reverseSteer = 0;
  private lost = 0;
  /** `exit` is the expected way out; `committed` once the player has actually started that turn. */
  private plan: { corner: THREE.Vector3; exit: THREE.Vector3 | null; committed: boolean } | null = null;
  private trail: THREE.Vector3[] = [];
  thoughts: PartnerThoughts = { mode: 'lane', turn: 'none', shift: 0, blocked: false };
  /** Set when the partner should be teleported back into formation (off-screen only). */
  wantsRecovery = false;

  constructor(
    private world: RAPIER.World,
    private city: City,
    /** +1 = drive on the player's left, -1 = right. */
    private side: number,
  ) {}

  reset(player: Vehicle): void {
    this.plan = null;
    this.trail = [player.position];
    this.stuck = this.reversing = this.lost = 0;
    this.wantsRecovery = false;
  }

  controls(dt: number, ctx: PartnerContext): ControlState {
    const { player, me } = ctx;
    const pc = player.controls;
    this.recordTrail(player);
    this.steerMemory += (pc.steer - this.steerMemory) * Math.min(1, dt * 3);
    this.wantsRecovery = false;

    // Player reversing or holding the brake at a standstill: back up with them.
    if (player.forwardSpeed < -1 || (pc.brake > 0 && player.forwardSpeed < 1)) {
      return { throttle: 0, brake: pc.brake || 1, steer: pc.steer, handbrake: false };
    }
    if (this.reversing > 0) {
      this.reversing -= dt;
      this.thoughts.mode = 'recover';
      return { throttle: 0, brake: 1, steer: this.reverseSteer, handbrake: false };
    }

    const pPos = player.position;
    const pDir = snapDir(player.forward);
    const aligned = player.forward.dot(pDir) > 0.82;
    const onRoad = this.city.isStreet(pPos.x, pPos.z);

    // Plan along the street grid when the player is on a street and roughly lined up with it;
    // otherwise (mid-drift, on a sidewalk) follow their actual trail.
    let path: Path;
    let playerPath: Path;
    let cornerAhead = Infinity;
    let turnSign = 0;
    if (onRoad && (aligned || this.plan)) {
      this.thoughts.mode = 'lane';
      const plan = this.predict(player, pDir, ctx.route);
      const center = streetCenter(pPos, pDir);
      const playerOffset = pPos.clone().sub(center).dot(leftOf(pDir));
      const half = roadHalfWidth(pPos) - CURB_MARGIN;
      const corner = plan?.corner ?? null;
      const predicted = plan?.exit ?? null;
      const straight = !!predicted && predicted.dot(pDir) > 0.9;
      // Steer into a turn only once the player commits to it; until then keep going straight
      // (a wrong guess would send us down the wrong street). The guess still sets our speed.
      const exit = predicted && (plan?.committed || straight) ? predicted : corner ? pDir.clone() : null;
      if (corner && predicted) {
        cornerAhead = corner.clone().sub(pPos).dot(pDir);
        const cross = pDir.x * predicted.z - pDir.z * predicted.x;
        turnSign = Math.abs(cross) < 0.5 ? 0 : cross < 0 ? 1 : -1; // +1 left turn
        this.thoughts.turn = turnSign === 0 ? 'straight' : turnSign > 0 ? 'left' : 'right';
      } else {
        this.thoughts.turn = 'none';
      }
      playerPath = lanePath(pPos, pDir, playerOffset, corner, exit);

      // Our lane: beside the player on our side, inside the curbs, shifted around obstacles.
      let base = playerOffset + this.side * FORMATION_OFFSET;
      base = THREE.MathUtils.clamp(base, -half, half);
      const roomBeside = Math.abs(base - playerOffset) >= MIN_SEPARATION;
      const { offset, blockedAt, inLine } = this.chooseLane(me, pDir, base, playerOffset, half, corner, exit, ctx);
      this.thoughts.shift = +(offset - base).toFixed(1);
      this.thoughts.blocked = blockedAt < Infinity;
      path = lanePath(me.position, pDir, offset, corner, exit);
      if (!roomBeside || inLine) {
        // No room beside them (they're hugging our curb): drop in behind on their line.
        path = playerPath;
      }
      return this.drive(dt, ctx, path, playerPath, cornerAhead, turnSign, blockedAt, roomBeside && !inLine);
    }

    this.thoughts.mode = 'trail';
    this.plan = null;
    path = this.trailPath(player);
    playerPath = path;
    return this.drive(dt, ctx, path, playerPath, Infinity, 0, Infinity, true);
  }

  /** Where the player is going next: which intersection, and which way out of it. */
  private predict(player: Vehicle, dir: THREE.Vector3, route: THREE.Vector3[]) {
    const p = player.position;
    // Keep the current plan while we're still working through its intersection.
    if (this.plan) {
      const past = p.clone().sub(this.plan.corner).dot(this.plan.exit ?? dir) > 12;
      const sameStreet = !this.plan.exit || this.plan.exit.dot(dir) > 0.9 || p.distanceTo(this.plan.corner) < 22;
      if (!past && sameStreet) {
        this.refineTurn(player, dir);
        return this.plan;
      }
    }
    const corner = nextIntersection(p, dir);
    if (!corner) {
      this.plan = null;
      return null;
    }
    const exit = routeExit(corner, dir, route);
    this.plan = { corner, exit, committed: false };
    this.refineTurn(player, dir);
    return this.plan;
  }

  /** The player's hands override the plan: steering into a turn, or already turning. */
  private refineTurn(player: Vehicle, dir: THREE.Vector3): void {
    if (!this.plan) return;
    const { corner } = this.plan;
    const dist = corner.clone().sub(player.position).dot(dir);
    const options = exits(corner, dir);
    const left = leftOf(dir);
    const heading = player.forward;
    // Already turning: the exit closest to where they're pointing.
    const turned = heading.dot(dir) < 0.85 && dist < 30;
    if (turned) {
      this.plan.exit = options.reduce((a, e) => (e.dot(heading) > a.dot(heading) ? e : a), options[0]) ?? this.plan.exit;
      this.plan.committed = true;
      return;
    }
    // Committed steering near the corner.
    if (dist < 28 && Math.abs(this.steerMemory) > 0.45) {
      const want = this.steerMemory > 0 ? left : left.clone().negate();
      const e = options.find((o) => o.dot(want) > 0.9);
      if (e) {
        this.plan.exit = e;
        this.plan.committed = true;
      }
    }
  }

  /**
   * Pick our lane offset: the formation lane if it's clear for the next 30 m,
   * otherwise the nearest clear shift that stays on the road and away from the
   * player's line. Returns how far ahead the formation lane is blocked.
   */
  private chooseLane(
    me: Vehicle,
    dir: THREE.Vector3,
    base: number,
    playerOffset: number,
    half: number,
    corner: THREE.Vector3 | null,
    exit: THREE.Vector3 | null,
    ctx: PartnerContext,
  ): { offset: number; blockedAt: number; inLine?: boolean } {
    const near = ctx.obstacles.filter((o) => o.pos.distanceTo(me.position) < 45);
    /** Distance along a lane to the first obstacle in it (hard ones only, if asked). */
    const blockedAt = (offset: number, hardOnly: boolean) => {
      const path = lanePath(me.position, dir, offset, corner, exit, 40);
      const s0 = path.project(me.position);
      for (let s = s0 + 3; s < s0 + 30; s += 2) {
        const p = path.at(s);
        for (const o of near) {
          if (hardOnly && o.soft) continue;
          if (o.pos.distanceToSquared(p) < (o.radius + 1.4) ** 2) return s - s0;
        }
      }
      return Infinity;
    };
    if (blockedAt(base, false) === Infinity) return { offset: base, blockedAt: Infinity };
    for (const shift of [2, -2, 4, -4, 6, -6]) {
      const o = base + shift;
      if (Math.abs(o) > half || Math.abs(o - playerOffset) < MIN_SEPARATION) continue;
      // Don't swap sides with the player: the cables would cross.
      if (Math.sign(o - playerOffset) !== this.side) continue;
      if (blockedAt(o, false) === Infinity) return { offset: o, blockedAt: Infinity };
    }
    // No clear lane on our side, but something solid in it (a spike strip with one
    // gap): drop in single file behind the player through their line.
    const hard = blockedAt(base, true);
    if (hard < Infinity && blockedAt(playerOffset, true) === Infinity) return { offset: playerOffset, blockedAt: Infinity, inLine: true };
    // Otherwise keep our lane, braking only for something solid.
    return { offset: base, blockedAt: hard };
  }

  /** Steering, speed and teamwork along a planned path. */
  private drive(
    dt: number,
    ctx: PartnerContext,
    path: Path,
    playerPath: Path,
    cornerAhead: number,
    turnSign: number,
    blockedAt: number,
    roomBeside: boolean,
  ): ControlState {
    const { player, me } = ctx;
    const speed = me.forwardSpeed;
    const s = path.project(me.position);
    const target = path.at(s + 7 + Math.abs(speed) * 0.4);
    const steer = THREE.MathUtils.clamp(angleTo(me, target) * 2.4 + avoidance(this.world, me, 9) * 0.4, -1, 1);

    // Gap along the player's line: positive = we're behind.
    let gap = playerPath.project(player.position) - playerPath.project(me.position);
    if (!roomBeside) gap -= 7; // falling in behind: hold a car length back

    // Corner positioning: on the outside of a turn, run slightly ahead (longer line);
    // on the inside, tuck slightly back.
    if (cornerAhead < 35 && turnSign !== 0) {
      const outside = turnSign !== this.side; // turning left puts the right-hand car outside
      gap += outside ? 2 : -1;
    }

    let vTarget = player.forwardSpeed + THREE.MathUtils.clamp(gap * 1.3, -8, 14);

    // Teamwork with the vault: if it swings toward our side, ease off so we don't
    // add to the swing; if it swings away, pull a little harder to bring it back.
    const pDir = player.forward;
    const lateral = ctx.vaultVel.dot(leftOf(pDir)) * this.side;
    vTarget -= THREE.MathUtils.clamp(lateral * 0.5, -3, 3);

    // Our own corner speed: the inside line is tighter, so it needs to be slower.
    if (cornerAhead < 45 && cornerAhead > -8 && turnSign !== 0) {
      const inside = turnSign === this.side;
      const myDist = Math.max(0, cornerAhead - (inside ? 4 : 0));
      vTarget = Math.min(vTarget, (inside ? 8 : 11) + myDist * 0.4);
    }

    // Something in our lane we couldn't steer around: brake to stop short of it.
    if (blockedAt < Infinity) vTarget = Math.min(vTarget, Math.max(0, (blockedAt - 6) * 0.9));
    // Follow the player's intent when they stop.
    if (player.forwardSpeed < 1 && player.controls.throttle === 0) vTarget = 0;

    // Catch-up assist when we've fallen behind (as racing games do for AI teammates).
    me.assist = 1 + THREE.MathUtils.clamp((gap - 1) / 8, 0, 0.5);

    const err = vTarget - speed;
    let throttle = THREE.MathUtils.clamp(err * 0.45, 0, 1);
    let brake = err < -2 ? THREE.MathUtils.clamp(-err * 0.12, 0, 1) : 0;
    if (player.controls.throttle > 0 && gap > -1 && blockedAt === Infinity) throttle = Math.max(throttle, player.controls.throttle);

    // Stuck: back out briefly (never while the vault is right behind us).
    const behindVault = ctx.vault.clone().setY(0).sub(me.position).dot(pDir) > 1;
    this.stuck = throttle > 0.5 && Math.abs(speed) < 1.2 ? this.stuck + dt : 0;
    if (this.stuck > 1.0 && !behindVault) {
      this.stuck = 0;
      this.reversing = 0.7;
      this.reverseSteer = -Math.sign(steer || 1);
    }

    // Lost: far off, wrong way, or wedged for long. Ask to be put back, off-screen only.
    const wrongWay = Math.abs(player.forwardSpeed) > 5 && me.forward.dot(player.forward) < -0.2;
    const far = player.position.distanceTo(me.position) > 18;
    this.lost = wrongWay || far || this.stuck > 0.8 ? this.lost + dt : 0;
    if (this.lost > 2.5 && !ctx.visible(me.position)) {
      this.lost = 0;
      this.wantsRecovery = true;
    }

    if (brake > 0) throttle = 0;
    return { throttle, brake, steer, handbrake: false };
  }

  private recordTrail(player: Vehicle): void {
    const p = player.position;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(p) > 1.5) this.trail.push(p);
    if (this.trail.length > 80) this.trail.shift();
  }

  /** Fallback: the player's recent trail (only the bit near them), offset to our side. */
  private trailPath(player: Vehicle) {
    const pts = this.trail.slice(-25).map((p, i, arr) => {
      const next = arr[Math.min(arr.length - 1, i + 1)];
      const prev = arr[Math.max(0, i - 1)];
      const t = next.clone().sub(prev).setY(0);
      if (t.lengthSq() < 1e-4) t.copy(player.forward);
      t.normalize();
      const off = p.clone().addScaledVector(leftOf(t), this.side * FORMATION_OFFSET);
      return this.city.isStreet(off.x, off.z) ? off : p.clone();
    });
    const tip = player.position.addScaledVector(player.forward, 25).addScaledVector(leftOf(player.forward), this.side * FORMATION_OFFSET);
    pts.push(tip);
    if (pts.length < 2) pts.unshift(player.position);
    return new Path(pts);
  }
}
