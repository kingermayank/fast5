// Particles: sparks off the vault and from wall scrapes, tyre smoke, dust and
// the flash of a snapping cable. Simulated here, drawn by the renderer as
// camera-facing quads (sparks streak along their velocity).
import { GameRenderer } from "./render";
import { Rng, clamp } from "./util";

const SPARK: i32 = 0;
const SMOKE: i32 = 1;
const DUST: i32 = 2;
const FLASH: i32 = 3;

class Particle {
  kind: i32 = 0;
  x: f64 = 0;
  y: f64 = 0;
  z: f64 = 0;
  vx: f64 = 0;
  vy: f64 = 0;
  vz: f64 = 0;
  age: f64 = 0;
  life: f64 = 1;
  size: f64 = 1;
  grow: f64 = 0;
  alpha: f64 = 1;
}

export class Fx {
  pool: Array<Particle> = [];
  count: i32 = 0;
  rng: Rng = new Rng(77);
  max: i32 = 2400;

  private take(): Particle? {
    if (this.count >= this.max) return null;
    if (this.count == this.pool.length) this.pool.push(new Particle());
    let p = this.pool[this.count++];
    p.age = 0;
    return p;
  }

  /** A burst of sparks at a point, flying roughly along (dx, dz). */
  sparks(x: f64, y: f64, z: f64, dx: f64, dz: f64, speed: f64, n: i32): void {
    let r = this.rng;
    for (let i = 0; i < n; i++) {
      let p = this.take();
      if (p == null) return;
      p.kind = SPARK;
      p.x = x;
      p.y = y;
      p.z = z;
      let s = speed * r.range(0.4, 1.1);
      p.vx = dx * s + r.range(-1, 1) * speed * 0.45;
      p.vz = dz * s + r.range(-1, 1) * speed * 0.45;
      p.vy = r.range(0.5, 1) * speed * 0.35 + 1.5;
      p.life = r.range(0.25, 0.75);
      p.size = r.range(0.035, 0.07);
      p.alpha = 1;
    }
  }

  smoke(x: f64, y: f64, z: f64, vx: f64, vz: f64, strength: f64): void {
    let p = this.take();
    if (p == null) return;
    let r = this.rng;
    p.kind = SMOKE;
    p.x = x + r.range(-0.3, 0.3);
    p.y = y;
    p.z = z + r.range(-0.3, 0.3);
    p.vx = vx * 0.25 + r.range(-0.8, 0.8);
    p.vz = vz * 0.25 + r.range(-0.8, 0.8);
    p.vy = r.range(0.3, 1.0);
    p.life = r.range(1.2, 2.0);
    p.size = r.range(0.35, 0.55);
    p.grow = r.range(0.9, 1.5);
    p.alpha = clamp(strength, 0, 1) * 0.28;
  }

  dust(x: f64, y: f64, z: f64, vx: f64, vz: f64, strength: f64): void {
    let p = this.take();
    if (p == null) return;
    let r = this.rng;
    p.kind = DUST;
    p.x = x + r.range(-0.5, 0.5);
    p.y = y;
    p.z = z + r.range(-0.5, 0.5);
    p.vx = vx * 0.15 + r.range(-0.6, 0.6);
    p.vz = vz * 0.15 + r.range(-0.6, 0.6);
    p.vy = r.range(0.2, 0.7);
    p.life = r.range(1.0, 1.8);
    p.size = r.range(0.6, 1.0);
    p.grow = r.range(0.8, 1.4);
    p.alpha = clamp(strength, 0, 1) * 0.4;
  }

  flash(x: f64, y: f64, z: f64, size: f64): void {
    let p = this.take();
    if (p == null) return;
    p.kind = FLASH;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.life = 0.18;
    p.size = size;
    p.alpha = 1;
  }

  update(dt: f64): void {
    let i = 0;
    while (i < this.count) {
      let p = this.pool[i];
      p.age += dt;
      if (p.age >= p.life) {
        // Swap with the last live particle.
        this.count--;
        this.pool[i] = this.pool[this.count];
        this.pool[this.count] = p;
        continue;
      }
      if (p.kind == SPARK) {
        p.vy -= 9.81 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        if (p.y < 0.03) {
          // Skip off the asphalt.
          p.y = 0.03;
          p.vy = -p.vy * 0.35;
          p.vx *= 0.6;
          p.vz *= 0.6;
        }
      } else if (p.kind != FLASH) {
        let drag = Math.max(0, 1 - 1.5 * dt);
        p.vx *= drag;
        p.vz *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
        p.size += p.grow * dt;
      }
      i++;
    }
  }

  draw(gfx: GameRenderer): void {
    for (let i = 0; i < this.count; i++) {
      let p = this.pool[i];
      let t = p.age / p.life;
      if (p.kind == SPARK) {
        // White hot, through orange, to a dull red.
        let r: u32 = 255;
        let g = <u32>clamp(240 - t * 200, 40, 255);
        let b = <u32>clamp(170 - t * 300, 10, 255);
        let a = <u32>clamp((1 - t) * 255, 0, 255);
        gfx.particle(true, p.x, p.y, p.z, p.size, p.vx, p.vy, p.vz, 0.035, r, g, b, a);
      } else if (p.kind == FLASH) {
        let a = <u32>clamp((1 - t) * 255, 0, 255);
        gfx.particle(true, p.x, p.y, p.z, p.size * (1 + t * 2), 0, 0, 0, 0, 255, 230, 190, a);
      } else {
        let a = <u32>clamp(p.alpha * (1 - t) * Math.min(1, p.age * 6) * 255, 0, 255);
        if (p.kind == SMOKE) gfx.particle(false, p.x, p.y, p.z, p.size, 0, 0, 0, 0, 225, 222, 218, a);
        else gfx.particle(false, p.x, p.y, p.z, p.size, 0, 0, 0, 0, 176, 152, 120, a);
      }
    }
  }
}
