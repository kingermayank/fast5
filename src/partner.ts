import * as THREE from 'three';
import { RAPIER } from './physics';
import { leftOf, type Path } from './roads';
import type { Vehicle } from './vehicle';

/**
 * The AI partner as a wingman: it holds a place beside the player, on its own
 * side, and goes wherever the player goes. Rather than drive a line of its own
 * (and risk taking a different street, or wedging itself on a building while
 * the vault drags behind), it matches the player's speed and heading and keeps
 * closing on that place, so the two cars move as one rig with the vault behind.
 *
 *  - Room: the place moves in toward the player when a wall is close on its side,
 *    and drops back into single file when there's no room beside them, or when
 *    something solid (a spike strip) is in its lane.
 *  - Catch-up: knocked off its place, it drives back along the player's own trail
 *    (which is road), so it never cuts a corner through a building.
 *  - Wedged anyway: it asks to be put back in its place.
 * It's still a physical car: cops bounce off it, it shoves props aside and its
 * cable pulls on the vault.
 */

/** How far beside the player it runs (m, center to center). */
const SPACING = 4.6;
/** How close to a wall a car's center may come (half its width plus a little). */
const WALL_MARGIN = 1.7;
/** Less room than this beside the player and it drops back into single file (m). */
const SINGLE_FILE = 3.2;
/** How far behind the player it runs in single file (m). */
const FILE_GAP = 6.5;
/** Farther than this from its place, it catches up along the player's trail (m). */
const OFF_STATION = 7;
/** How hard it closes on its place: closing speed per meter off it (1/s), and at most (m/s). */
const CLOSING_RATE = 2.2;
const MAX_CLOSING = 10;
/** Cut loose at the bridge: it falls back behind the player, out to the side (m). */
const RELEASED_BACK = 22;
const RELEASED_OUT = 7;

export interface Obstacle {
  pos: THREE.Vector3;
  radius: number;
  /** Steer around it, but never brake for it (the vault we're towing, the player). */
  soft?: boolean;
}

export interface PartnerContext {
  player: Vehicle;
  me: Vehicle;
  /** Solid things it must not drive over (a spike strip's segments): it tucks in behind the player. */
  hazards: Obstacle[];
}

/** Debug readout of what the partner is doing. */
export interface PartnerThoughts {
  mode: 'station' | 'file' | 'catch-up' | 'released';
  /** Its place: how far beside and behind the player (m), and how far it is from it. */
  beside: number;
  behind: number;
  off: number;
}

export class PartnerDriver {
  thoughts: PartnerThoughts = { mode: 'station', beside: SPACING, behind: 0, off: 0 };
  /** Set when the partner is wedged or lost and should be put back in its place. */
  wantsRecovery = false;
  /** Where it should be right now. */
  readonly slot = new THREE.Vector3();
  /** Cut loose from the vault (the bridge finale): it falls back and follows at a distance. */
  released = false;
  /** Gone to lead the cops away (the bridge finale): it drives back down this road to its start. */
  private leaving: Path | null = null;
  private leaveDir = 1;
  private trail: THREE.Vector3[] = [];
  private beside = SPACING;
  private behind = 0;
  private wedged = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });

  constructor(
    private world: RAPIER.World,
    /** +1 = runs on the player's left, -1 = right. */
    private side: number,
  ) {}

  reset(player: Vehicle): void {
    this.trail = [player.position];
    this.wedged = 0;
    this.wantsRecovery = false;
  }

  /** The player's recent path, oldest first (road they've just driven). */
  get playerTrail(): readonly THREE.Vector3[] {
    return this.trail;
  }

  /** Cut loose and sent away along `path`: on along it (`dir` 1, the way the split goes in the film), or back toward its start (-1). */
  leave(path: Path, dir = 1): void {
    this.leaving = path;
    this.leaveDir = dir;
    this.released = true;
  }

  /** Per physics step, instead of the partner's pedals: hold the place beside the player. */
  drive(dt: number, ctx: PartnerContext): void {
    const { player, me } = ctx;
    this.recordTrail(player);
    this.wantsRecovery = false;
    if (this.leaving) {
      this.driveAway(dt, me, this.leaving);
      return;
    }
    const at = player.position;
    const f = player.forward;
    const out = leftOf(f).multiplyScalar(this.side);
    const pv = player.body.linvel();
    const pVel = new THREE.Vector3(pv.x, 0, pv.z);

    // How far out it can run: as far as the street allows on its side, but on the
    // player's own line when something solid is in its lane.
    let beside = Math.min(SPACING, this.room(at, out) - WALL_MARGIN);
    if (this.hazardInLane(ctx.hazards, at, f, out)) beside = 0;
    beside = Math.max(0, beside);
    let behind = beside < SINGLE_FILE ? FILE_GAP * (1 - beside / SINGLE_FILE) : 0;
    if (this.released) {
      beside = RELEASED_OUT;
      behind = RELEASED_BACK;
    }
    this.beside += (beside - this.beside) * Math.min(1, dt * 4);
    this.behind += (behind - this.behind) * Math.min(1, dt * 2.5);
    this.slot.copy(at).addScaledVector(out, this.beside).addScaledVector(f, -this.behind);

    const toSlot = this.slot.clone().sub(me.position).setY(0);
    const off = toSlot.length();
    let vel: THREE.Vector3;
    let heading = player.heading;
    if (off < OFF_STATION) {
      // On station: the player's own velocity, plus a closing speed toward the place.
      const closing = toSlot.multiplyScalar(CLOSING_RATE);
      if (closing.length() > MAX_CLOSING) closing.setLength(MAX_CLOSING);
      vel = pVel.clone().add(closing);
      this.thoughts.mode = this.released ? 'released' : this.behind > 2 ? 'file' : 'station';
    } else {
      // Off station: back along the player's trail (it's road), faster than they're going.
      const target = this.trailTarget(me.position, 9);
      const dir = target.sub(me.position).setY(0);
      if (dir.lengthSq() < 1e-4) dir.copy(toSlot);
      dir.normalize();
      vel = dir.multiplyScalar(pVel.length() + Math.min(14, off * 0.8));
      this.thoughts.mode = 'catch-up';
    }
    // Point the way it's going (a little), as a driver would, unless it's backing up with the player.
    const speed = vel.length();
    if (speed > 3 && vel.dot(f) > 0) {
      const bearing = Math.atan2(vel.x, vel.z);
      heading += Math.atan2(Math.sin(bearing - heading), Math.cos(bearing - heading)) * (off < OFF_STATION ? 0.5 : 1);
    }
    me.follow(dt, vel, heading);

    // Wedged (barely moving while off its place) or hopelessly far: ask to be put back.
    const lv = me.body.linvel();
    const moving = Math.hypot(lv.x, lv.z);
    this.wedged = off > 4 && moving < 2.5 ? this.wedged + dt : Math.max(0, this.wedged - dt);
    if (this.wedged > 1.2 || off > 35) {
      this.wedged = 0;
      this.wantsRecovery = true;
    }
    this.thoughts.beside = +this.beside.toFixed(1);
    this.thoughts.behind = +this.behind.toFixed(1);
    this.thoughts.off = +off.toFixed(1);
  }

  /** A clear place to put the partner back: its slot, or failing that a spot on the player's trail behind them. */
  recoveryPoint(player: Vehicle): { pos: THREE.Vector3; heading: number } | null {
    if (this.clear(this.slot, player.heading)) return { pos: this.slot.clone(), heading: player.heading };
    for (let i = this.trail.length - 5; i >= 1; i--) {
      const p = this.trail[i];
      if (p.distanceTo(player.position) < 7) continue;
      const t = this.trail[i + 1].clone().sub(this.trail[i - 1]);
      const heading = Math.atan2(t.x, t.z);
      if (this.clear(p, heading)) return { pos: p.clone(), heading };
    }
    return null;
  }

  /** Flat out back along the road it was sent down, then parked at its far end out of the way. */
  private driveAway(dt: number, me: Vehicle, path: Path): void {
    this.thoughts.mode = 'released';
    const s = path.project(me.position);
    if (s < 40 || s > path.length - 40) {
      me.follow(dt, new THREE.Vector3(), me.heading);
      return;
    }
    const dir = path.at(s + this.leaveDir * 25).sub(me.position).setY(0).normalize();
    me.follow(dt, dir.clone().multiplyScalar(30), Math.atan2(dir.x, dir.z));
  }

  /** Distance to the nearest wall (fixed geometry) from `at` along `dir`, up to a few meters past the spacing. */
  private room(at: THREE.Vector3, dir: THREE.Vector3): number {
    const reach = SPACING + WALL_MARGIN + 0.5;
    this.ray.origin = { x: at.x, y: 0.8, z: at.z };
    this.ray.dir = { x: dir.x, y: 0, z: dir.z };
    const hit = this.world.castRay(this.ray, reach, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return hit ? hit.timeOfImpact : reach;
  }

  /** Something solid within 30 m ahead in the lane beside the player. */
  private hazardInLane(hazards: Obstacle[], at: THREE.Vector3, f: THREE.Vector3, out: THREE.Vector3): boolean {
    const lane = at.clone().addScaledVector(out, SPACING);
    return hazards.some((h) => {
      const r = h.pos.clone().sub(lane).setY(0);
      const ahead = r.dot(f);
      return ahead > -3 && ahead < 30 && Math.abs(r.dot(out)) < h.radius + 2.2;
    });
  }

  /** No building where a car would sit at `p`. */
  private clear(p: THREE.Vector3, heading: number): boolean {
    let hit = false;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.world.intersectionsWithShape(
      { x: p.x, y: 0.8, z: p.z },
      { x: q.x, y: q.y, z: q.z, w: q.w },
      new RAPIER.Cuboid(1.1, 0.5, 2.6),
      () => {
        hit = true;
        return false;
      },
      RAPIER.QueryFilterFlags.ONLY_FIXED,
    );
    return !hit;
  }

  private recordTrail(player: Vehicle): void {
    const p = player.position;
    const last = this.trail[this.trail.length - 1];
    if (!last || last.distanceTo(p) > 1.5) this.trail.push(p);
    if (this.trail.length > 120) this.trail.shift();
  }

  /** The point `lookAhead` m further along the player's trail than the trail point nearest `p`. */
  private trailTarget(p: THREE.Vector3, lookAhead: number): THREE.Vector3 {
    const t = this.trail;
    if (t.length < 2) return t[0]?.clone() ?? p.clone();
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < t.length; i++) {
      const d = t[i].distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    let left = lookAhead;
    for (let i = best; i < t.length - 1; i++) {
      const seg = t[i].distanceTo(t[i + 1]);
      if (seg >= left) return t[i].clone().lerp(t[i + 1], left / seg);
      left -= seg;
    }
    return t[t.length - 1].clone();
  }
}
