// The partner's driver: holds formation beside the player (the two cars side
// by side, the vault trailing between them), matching speed, steering for a
// point ahead of its slot, easing off when its own cable is about to go, and
// steering away from walls it is about to hit.
import { Car } from "./car";
import { Cable } from "./cable";
import { StaticWorld } from "./world";
import { clamp, wrapAngle } from "./util";

export class Partner {
  car: Car;
  leader: Car;
  cable: Cable;
  world: StaticWorld;
  /** +1 holds the leader's left, -1 its right. */
  side: f64;
  gap: f64 = 5.6;

  constructor(car: Car, leader: Car, cable: Cable, world: StaticWorld, side: f64) {
    this.car = car;
    this.leader = leader;
    this.cable = cable;
    this.world = world;
    this.side = side;
  }

  update(dt: f64): void {
    let me = this.car.body;
    let lead = this.leader.body;
    let lf = this.leader.forwardSpeed;
    let fx = lead.fwdX(), fz = lead.fwdZ();
    let lx = lead.leftX(), lz = lead.leftZ();
    // The slot beside the leader, and a point to aim for ahead of it.
    let slotX = lead.x + lx * this.side * this.gap;
    let slotZ = lead.z + lz * this.side * this.gap;
    let ahead = Math.max(7, Math.abs(lf) * 0.7);
    let aimX = slotX + fx * ahead, aimZ = slotZ + fz * ahead;
    let want = Math.atan2(aimX - me.x, aimZ - me.z);
    let err = wrapAngle(want - me.a);
    let steer = clamp(err * 2.6, -1, 1);

    // Walls ahead: look left and right of the nose and lean away from the nearer.
    let speed = Math.abs(this.car.forwardSpeed);
    let reach = 6 + speed * 0.6;
    let a = me.a;
    let dl = this.world.raycast(me.x, me.z, Math.sin(a + 0.35), Math.cos(a + 0.35), reach);
    let dr = this.world.raycast(me.x, me.z, Math.sin(a - 0.35), Math.cos(a - 0.35), reach);
    if (dl < reach || dr < reach) steer = clamp(steer + (dr - dl) / reach * 1.2, -1, 1);

    // Speed: the leader's, plus what closes the gap to the slot along the road.
    let along = (slotX - me.x) * fx + (slotZ - me.z) * fz;
    let target = lf + clamp(along * 0.9, -6, 8);
    let c = this.car.controls;
    let mine = this.car.forwardSpeed;
    c.throttle = 0;
    c.brake = 0;
    if (target > mine + 0.5) c.throttle = clamp((target - mine) / 4, 0.25, 1);
    else if (target < mine - 2) c.brake = clamp((mine - target) / 8, 0.1, 1);
    // Don't be the one that snaps the cable.
    let strain = this.cable.strain();
    if (strain > 0.65) c.throttle *= clamp((0.9 - strain) / 0.25, 0, 1);
    c.steer = steer;
    c.handbrake = false;
    c.nos = this.leader.controls.nos && this.leader.nosActive;
    this.car.nosActive = c.nos;
  }
}
