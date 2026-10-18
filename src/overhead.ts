import * as THREE from 'three';
import { GOAL, MAP, PLAN } from './roadmap';

/**
 * Bird's-eye camera for the chase: high and angled rather than straight down,
 * with a fixed yaw so the city doesn't swing round as you steer (screen-up is
 * always the same way). It looks ahead of the car along its velocity and pulls
 * back with speed, so there's always road to read.
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
 * The bearing that is up on screen: along the street grid (so streets run
 * straight across and up the screen), in whichever of the four directions
 * faces most toward the bridge from the station. The drive then goes across
 * and up the screen, never down it.
 */
export const OVERHEAD_YAW = (() => {
  const grid = gridBearing();
  const from = PLAN[0].pos;
  const want = Math.atan2(GOAL.pos.x - from.x, GOAL.pos.z - from.z);
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

export class OverheadCamera {
  /** Screen-up, on the ground. */
  readonly forward = new THREE.Vector3(Math.sin(OVERHEAD_YAW), 0, Math.cos(OVERHEAD_YAW));
  private lead = new THREE.Vector3();
  private dist = NEAR;

  /** Forget the look-ahead and zoom (when gameplay starts). */
  reset(): void {
    this.lead.set(0, 0, 0);
    this.dist = NEAR;
  }

  update(dt: number, at: THREE.Vector3, vel: THREE.Vector3, boost: boolean): OverheadFrame {
    const speed = Math.hypot(vel.x, vel.z);
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
