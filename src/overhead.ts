import * as THREE from 'three';
import { MAP, PLAN, RAW } from './roadmap';

/**
 * Bird's-eye camera for the chase: high and angled rather than straight down,
 * and behind the car, so forward is always up the screen. It swings round
 * after the car smoothly (a slide or a yank from the vault doesn't whip it),
 * looks ahead along the car's velocity and pulls back with speed, so there's
 * always road to read.
 */

/**
 * Degrees below the horizon the camera looks: low enough that the street's
 * facades, awnings and lamp posts stand up off the map (the 2.5D look), with a
 * long lens so the city reads as a diorama rather than a wide-angle swirl.
 */
const PITCH = THREE.MathUtils.degToRad(50);
/** Distance from the point it looks at (m), parked and at full pull-back. */
const NEAR = 62;
const FAR = 112;
const FOV = 30;

/** The main street direction, as a bearing mod 90 degrees, weighted by length. */
function gridBearing(): number {
  let c = 0;
  let s = 0;
  for (const e of MAP.edges) {
    // Not the bridge: it runs off at its own angle for kilometres.
    if (e.bridge) continue;
    for (let i = 1; i < e.pts.length; i++) {
      const dx = e.pts[i].x - e.pts[i - 1].x;
      const dz = e.pts[i].z - e.pts[i - 1].z;
      // Four times the bearing, so streets at right angles to each other count as one direction.
      const b = Math.atan2(dx, dz) * 4;
      const len = Math.hypot(dx, dz);
      c += len * Math.cos(b);
      s += len * Math.sin(b);
    }
  }
  return Math.atan2(s, c) / 4;
}

/**
 * A bearing along the street grid (so streets run straight across and up the
 * screen), in whichever of the four directions faces most toward the bridge
 * from the station: the title screen's view, and where the camera starts.
 */
export const OVERHEAD_YAW = (() => {
  const grid = gridBearing();
  const from = PLAN[0].pos;
  // Toward the middle of the bridge (where the data's route ends).
  const to = MAP.node(RAW.poi.goal).pos;
  const want = Math.atan2(to.x - from.x, to.z - from.z);
  let best = grid;
  for (let k = 1; k < 4; k++) {
    const yaw = grid + (k * Math.PI) / 2;
    if (Math.cos(yaw - want) > Math.cos(best - want)) best = yaw;
  }
  return best;
})();

export interface OverheadFrame {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

/** Signed smallest angle from bearing `a` to bearing `b`. */
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export class OverheadCamera {
  /** The bearing that is up on screen: behind the car. */
  yaw = OVERHEAD_YAW;
  private lead = new THREE.Vector3();
  private dist = NEAR;

  /** Screen-up, on the ground. */
  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  /** Forget the look-ahead and zoom, and swing straight round behind a car facing `heading` (when gameplay starts). */
  reset(heading = this.yaw): void {
    this.lead.set(0, 0, 0);
    this.dist = NEAR;
    this.yaw = heading;
  }

  /** `heading` is where the car points; `forwardSpeed` is negative when it reverses. */
  update(dt: number, at: THREE.Vector3, vel: THREE.Vector3, boost: boolean, heading: number, forwardSpeed: number): OverheadFrame {
    const speed = Math.hypot(vel.x, vel.z);
    // Behind the car: where it's going as much as where it points (a drift aims the nose
    // off line), but only where it points when reversing. Slow to swing when nearly
    // stopped, so turning on the spot doesn't spin the city round.
    let target = heading;
    if (speed > 6 && forwardSpeed > 3) target += angleDiff(heading, Math.atan2(vel.x, vel.z)) * 0.5;
    const rate = 2.4 * THREE.MathUtils.clamp(speed / 8, 0.25, 1);
    this.yaw += angleDiff(this.yaw, target) * (1 - Math.exp(-rate * dt));
    // About two thirds of a second ahead, at most 30 m; eased, so a slide doesn't whip the view.
    const ahead = new THREE.Vector3(vel.x, 0, vel.z).multiplyScalar(Math.min(0.65, 30 / Math.max(speed, 1)));
    this.lead.lerp(ahead, 1 - Math.exp(-1.8 * dt));
    const want = THREE.MathUtils.clamp(NEAR + speed * 1.1, NEAR, FAR) + (boost ? 8 : 0);
    this.dist += (want - this.dist) * (1 - Math.exp(-1.2 * dt));
    const look = at.clone().setY(0).add(this.lead);
    const pos = look
      .clone()
      .addScaledVector(this.forward, -this.dist * Math.cos(PITCH))
      .setY(this.dist * Math.sin(PITCH));
    return { pos, look, fov: FOV + (boost ? 4 : 0) };
  }

  /** Signed angle on screen from straight up to the direction from `from` to `to`; positive = left. */
  screenAngle(from: THREE.Vector3, to: THREE.Vector3): number {
    const f = this.forward;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    return Math.atan2(dx * f.z - dz * f.x, dx * f.x + dz * f.z);
  }
}
