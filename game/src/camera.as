// The overhead camera: high above and behind at a fixed bearing (screen-up
// runs along the street grid toward the bridge), looking ahead of the convoy
// as it speeds up and pulling back to fit more of the road. Shake on impacts.
import { clamp, ease, PI, Rng } from "./util";

export class OverheadCamera {
  yaw: f64 = 1.457;
  pitch: f64 = (58 * PI) / 180;
  fov: f64 = (38 * PI) / 180;
  near: f64 = 46;
  far: f64 = 96;
  lookX: f64 = 0;
  lookZ: f64 = 0;
  leadX: f64 = 0;
  leadZ: f64 = 0;
  dist: f64 = 50;
  eyeX: f64 = 0;
  eyeY: f64 = 0;
  eyeZ: f64 = 0;
  targetX: f64 = 0;
  targetZ: f64 = 0;
  shakeAmount: f64 = 0;
  rng: Rng = new Rng(9);

  reset(x: f64, z: f64): void {
    this.lookX = x;
    this.lookZ = z;
    this.leadX = 0;
    this.leadZ = 0;
    this.dist = this.near;
  }

  shake(amount: f64): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  /** Puts the eye and target somewhere else for this frame: the title orbit, cutscene shots. */
  frame(eyeX: f64, eyeY: f64, eyeZ: f64, targetX: f64, targetZ: f64): void {
    this.eyeX = eyeX;
    this.eyeY = eyeY;
    this.eyeZ = eyeZ;
    this.targetX = targetX;
    this.targetZ = targetZ;
  }

  /** The bearing it looks along (forward is sin, cos), for the minimap and the route arrow. */
  bearing(): f64 {
    return Math.atan2(this.targetX - this.eyeX, this.targetZ - this.eyeZ);
  }

  /** Follow (x, z) moving at (vx, vz); `spread` widens the view to fit the convoy. */
  update(dt: f64, x: f64, z: f64, vx: f64, vz: f64, spread: f64, boost: bool): void {
    let speed = Math.sqrt(vx * vx + vz * vz);
    let k = speed > 1 ? Math.min(0.65, 30 / speed) : 0.65;
    this.leadX = ease(this.leadX, vx * k, 1.8, dt);
    this.leadZ = ease(this.leadZ, vz * k, 1.8, dt);
    this.lookX = ease(this.lookX, x + this.leadX, 6, dt);
    this.lookZ = ease(this.lookZ, z + this.leadZ, 6, dt);
    let want = clamp(this.near + speed * 1.1 + spread * 0.6, this.near, this.far) + (boost ? 8 : 0);
    this.dist = ease(this.dist, want, 1.2, dt);
    let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let flat = this.dist * Math.cos(this.pitch);
    let sx: f64 = 0, sz: f64 = 0;
    if (this.shakeAmount > 0.001) {
      sx = this.rng.range(-1, 1) * this.shakeAmount;
      sz = this.rng.range(-1, 1) * this.shakeAmount;
      this.shakeAmount *= Math.exp(-8 * dt);
    }
    this.targetX = this.lookX + sx;
    this.targetZ = this.lookZ + sz;
    this.eyeX = this.targetX - fx * flat;
    this.eyeZ = this.targetZ - fz * flat;
    this.eyeY = this.dist * Math.sin(this.pitch);
  }
}
