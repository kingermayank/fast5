// Small shared helpers: scalar maths, 4x4 matrices (column-major, WebGPU depth
// range 0..1), hashing and number formatting. Physics runs in f64; only GPU
// uploads are f32.

export const PI: f64 = 3.141592653589793;
export const TAU: f64 = 6.283185307179586;
export const G: f64 = 9.81;

export function clamp(x: f64, lo: f64, hi: f64): f64 {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: f64, b: f64, t: f64): f64 {
  return a + (b - a) * t;
}

export function smoothstep(a: f64, b: f64, x: f64): f64 {
  let t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Moves `x` toward `target` by an exponential ease with rate `k` (1/s). */
export function ease(x: f64, target: f64, k: f64, dt: f64): f64 {
  return x + (target - x) * (1 - Math.exp(-k * dt));
}

/** Angle wrapped into -PI..PI. */
export function wrapAngle(a: f64): f64 {
  let r = a % TAU;
  if (r > PI) r -= TAU;
  if (r < -PI) r += TAU;
  return r;
}

export function sign(x: f64): f64 {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Integer hash to 0..1. */
export function hash(n: i32): f64 {
  let x = <u32>n;
  x ^= x >> 16;
  x *= 0x7feb352d;
  x ^= x >> 15;
  x *= 0x846ca68b;
  x ^= x >> 16;
  return <f64>x / 4294967295.0;
}

/** Deterministic random stream (xorshift). */
export class Rng {
  state: u32;
  constructor(seed: u32) {
    this.state = seed == 0 ? 0x9e3779b9 : seed;
  }
  next(): f64 {
    let x = this.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.state = x;
    return <f64>x / 4294967296.0;
  }
  range(a: f64, b: f64): f64 {
    return a + (b - a) * this.next();
  }
}

/** `x` with `digits` decimals, for the HUD. */
export function fmt(x: f64, digits: i32): string {
  let neg = x < 0;
  let v = Math.abs(x);
  let scale = Math.pow(10, <f64>digits);
  let n = <i64>Math.round(v * scale);
  let whole = n / <i64>scale;
  let s = whole.toString();
  if (digits > 0) {
    let frac = (n % <i64>scale).toString();
    while (frac.length < digits) frac = "0" + frac;
    s += "." + frac;
  }
  return neg && n != 0 ? "-" + s : s;
}

// ---------------------------------------------------------------- matrices

/** A 4x4 matrix as 16 f64s, column-major (m[col * 4 + row]). */
export class M4 {
  m: StaticArray<f64> = new StaticArray<f64>(16);

  static identity(): M4 {
    let r = new M4();
    r.m[0] = 1; r.m[5] = 1; r.m[10] = 1; r.m[15] = 1;
    return r;
  }

  /** this * b */
  mul(b: M4): M4 {
    let r = new M4();
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < 4; row++) {
        let s: f64 = 0;
        for (let k = 0; k < 4; k++) s += this.m[k * 4 + row] * b.m[c * 4 + k];
        r.m[c * 4 + row] = s;
      }
    }
    return r;
  }

  /** Rotation about +y by `yaw`, then translation. Pitch and roll (small) tilt the result. */
  static pose(x: f64, y: f64, z: f64, yaw: f64, pitch: f64, roll: f64, scale: f64): M4 {
    // R = Ry(yaw) * Rx(pitch) * Rz(roll)
    let cy = Math.cos(yaw), sy = Math.sin(yaw);
    let cp = Math.cos(pitch), sp = Math.sin(pitch);
    let cr = Math.cos(roll), sr = Math.sin(roll);
    let r = new M4();
    // Columns of Ry*Rx*Rz.
    r.m[0] = (cy * cr + sy * sp * sr) * scale;
    r.m[1] = (cp * sr) * scale;
    r.m[2] = (-sy * cr + cy * sp * sr) * scale;
    r.m[4] = (-cy * sr + sy * sp * cr) * scale;
    r.m[5] = (cp * cr) * scale;
    r.m[6] = (sy * sr + cy * sp * cr) * scale;
    r.m[8] = (sy * cp) * scale;
    r.m[9] = (-sp) * scale;
    r.m[10] = (cy * cp) * scale;
    r.m[12] = x;
    r.m[13] = y;
    r.m[14] = z;
    r.m[15] = 1;
    return r;
  }

  /** Perspective with depth 0..1 (WebGPU). */
  static perspective(fovY: f64, aspect: f64, near: f64, far: f64): M4 {
    let f = 1 / Math.tan(fovY / 2);
    let r = new M4();
    r.m[0] = f / aspect;
    r.m[5] = f;
    r.m[10] = far / (near - far);
    r.m[11] = -1;
    r.m[14] = (near * far) / (near - far);
    return r;
  }

  /** Orthographic with depth 0..1 (WebGPU). */
  static ortho(l: f64, rt: f64, b: f64, t: f64, near: f64, far: f64): M4 {
    let r = new M4();
    r.m[0] = 2 / (rt - l);
    r.m[5] = 2 / (t - b);
    r.m[10] = 1 / (near - far);
    r.m[12] = -(rt + l) / (rt - l);
    r.m[13] = -(t + b) / (t - b);
    r.m[14] = near / (near - far);
    r.m[15] = 1;
    return r;
  }

  /** View matrix looking from eye to target. */
  static lookAt(ex: f64, ey: f64, ez: f64, tx: f64, ty: f64, tz: f64, ux: f64, uy: f64, uz: f64): M4 {
    let fx = ex - tx, fy = ey - ty, fz = ez - tz;
    let fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx /= fl; fy /= fl; fz /= fl;
    // s = up x f
    let sx = uy * fz - uz * fy, sy = uz * fx - ux * fz, sz = ux * fy - uy * fx;
    let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx /= sl; sy /= sl; sz /= sl;
    // u = f x s
    let vx = fy * sz - fz * sy, vy = fz * sx - fx * sz, vz = fx * sy - fy * sx;
    let r = new M4();
    r.m[0] = sx; r.m[4] = sy; r.m[8] = sz;
    r.m[1] = vx; r.m[5] = vy; r.m[9] = vz;
    r.m[2] = fx; r.m[6] = fy; r.m[10] = fz;
    r.m[12] = -(sx * ex + sy * ey + sz * ez);
    r.m[13] = -(vx * ex + vy * ey + vz * ez);
    r.m[14] = -(fx * ex + fy * ey + fz * ez);
    r.m[15] = 1;
    return r;
  }

  /** Writes the matrix as 16 f32s at float index `at`. */
  write(out: Float32Array, at: i32): void {
    for (let i = 0; i < 16; i++) out[at + i] = <f32>this.m[i];
  }
}

// ---------------------------------------------------------------- vertices

/** Vertex layout shared by the lit and shadow pipelines: 5 words. */
export const VERTEX_WORDS: i32 = 5;
export const VERTEX_BYTES: u32 = 20;

/** Material roles; must match lit.wgsl. */
export const ROLE_MATTE: u32 = 0;
export const ROLE_PAINT: u32 = 1;
export const ROLE_CHROME: u32 = 2;
export const ROLE_GLASS: u32 = 3;
export const ROLE_TAIL: u32 = 4;
export const ROLE_HEAD: u32 = 5;
export const ROLE_RUBBER: u32 = 6;
export const ROLE_WALL: u32 = 16;
export const ROLE_ROOF: u32 = 17;
export const ROLE_ASPHALT: u32 = 18;
export const ROLE_CONCRETE: u32 = 19;
export const ROLE_GRASS: u32 = 20;
export const ROLE_STEEL: u32 = 21;
export const ROLE_CABLE: u32 = 22;
export const ROLE_LINE: u32 = 23;
export const ROLE_WATER: u32 = 24;
export const ROLE_GROUND: u32 = 25;
export const ROLE_SHOP: u32 = 26;

export function packNormal(x: f64, y: f64, z: f64): u32 {
  let ix = <u32>(<i32>Math.round(clamp(x, -1, 1) * 127) & 0xff);
  let iy = <u32>(<i32>Math.round(clamp(y, -1, 1) * 127) & 0xff);
  let iz = <u32>(<i32>Math.round(clamp(z, -1, 1) * 127) & 0xff);
  return ix | (iy << 8) | (iz << 16);
}

/** sRGB colour 0xRRGGBB plus a material role. */
export function packColor(rgb: u32, role: u32): u32 {
  let r = (rgb >> 16) & 0xff;
  let g = (rgb >> 8) & 0xff;
  let b = rgb & 0xff;
  return r | (g << 8) | (b << 16) | (role << 24);
}

/** Scales an 0xRRGGBB colour (clamped). */
export function shade(rgb: u32, k: f64): u32 {
  let r = <u32>clamp(<f64>((rgb >> 16) & 0xff) * k, 0, 255);
  let g = <u32>clamp(<f64>((rgb >> 8) & 0xff) * k, 0, 255);
  let b = <u32>clamp(<f64>(rgb & 0xff) * k, 0, 255);
  return (r << 16) | (g << 8) | b;
}

/** Growable vertex and index arrays in the GPU layout. */
export class MeshBuilder {
  words: Uint32Array;
  floats: Float32Array;
  vertexCount: i32 = 0;
  indices: Uint32Array;
  indexCount: i32 = 0;

  /** Room for this many vertices and indices before it has to grow. */
  constructor(vertices: i32 = 4096, indices: i32 = 8192) {
    this.words = new Uint32Array(vertices * VERTEX_WORDS);
    this.floats = Float32Array.wrap(this.words.buffer);
    this.indices = new Uint32Array(indices);
  }

  private growVertices(n: i32): void {
    let need = (this.vertexCount + n) * VERTEX_WORDS;
    if (need <= this.words.length) return;
    let size = this.words.length * 2;
    while (size < need) size *= 2;
    let next = new Uint32Array(size);
    next.set(this.words);
    this.words = next;
    this.floats = Float32Array.wrap(next.buffer);
  }

  private growIndices(n: i32): void {
    let need = this.indexCount + n;
    if (need <= this.indices.length) return;
    let size = this.indices.length * 2;
    while (size < need) size *= 2;
    let next = new Uint32Array(size);
    next.set(this.indices);
    this.indices = next;
  }

  /** Adds a vertex and returns its index. */
  vertex(x: f64, y: f64, z: f64, normal: u32, color: u32): u32 {
    this.growVertices(1);
    let o = this.vertexCount * VERTEX_WORDS;
    this.floats[o] = <f32>x;
    this.floats[o + 1] = <f32>y;
    this.floats[o + 2] = <f32>z;
    this.words[o + 3] = normal;
    this.words[o + 4] = color;
    return <u32>this.vertexCount++;
  }

  tri(a: u32, b: u32, c: u32): void {
    this.growIndices(3);
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  /** Quad a b c d, counter-clockwise seen from its front. */
  quad(a: u32, b: u32, c: u32, d: u32): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Axis-aligned box in local space with a uniform colour (for the vault and props). */
  box(cx: f64, cy: f64, cz: f64, hx: f64, hy: f64, hz: f64, color: u32): void {
    // +x, -x, +y, -y, +z, -z faces.
    this.face(cx + hx, cy, cz, 0, 1, 0, 0, 0, 1, hy, hz, 1, 0, 0, color);
    this.face(cx - hx, cy, cz, 0, 0, 1, 0, 1, 0, hz, hy, -1, 0, 0, color);
    this.face(cx, cy + hy, cz, 0, 0, 1, 1, 0, 0, hz, hx, 0, 1, 0, color);
    this.face(cx, cy - hy, cz, 1, 0, 0, 0, 0, 1, hx, hz, 0, -1, 0, color);
    this.face(cx, cy, cz + hz, 1, 0, 0, 0, 1, 0, hx, hy, 0, 0, 1, color);
    this.face(cx, cy, cz - hz, 0, 1, 0, 1, 0, 0, hy, hx, 0, 0, -1, color);
  }

  /** Rectangle centred at c spanning axes a (half ha) and b (half hb), normal n = a x b. */
  face(cx: f64, cy: f64, cz: f64, ax: f64, ay: f64, az: f64, bx: f64, by: f64, bz: f64,
       ha: f64, hb: f64, nx: f64, ny: f64, nz: f64, color: u32): void {
    let n = packNormal(nx, ny, nz);
    let v0 = this.vertex(cx - ax * ha - bx * hb, cy - ay * ha - by * hb, cz - az * ha - bz * hb, n, color);
    let v1 = this.vertex(cx + ax * ha - bx * hb, cy + ay * ha - by * hb, cz + az * ha - bz * hb, n, color);
    let v2 = this.vertex(cx + ax * ha + bx * hb, cy + ay * ha + by * hb, cz + az * ha + bz * hb, n, color);
    let v3 = this.vertex(cx - ax * ha + bx * hb, cy - ay * ha + by * hb, cz - az * ha + bz * hb, n, color);
    this.quad(v0, v1, v2, v3);
  }

  /** Cylinder along `axis` (0 x, 1 y, 2 z) centred at c. */
  cylinder(cx: f64, cy: f64, cz: f64, radius: f64, half: f64, axis: i32, sides: i32, color: u32): void {
    let ring = <u32>this.vertexCount;
    for (let i = 0; i <= sides; i++) {
      let t = TAU * <f64>i / <f64>sides;
      let c = Math.cos(t), s = Math.sin(t);
      for (let e = 0; e < 2; e++) {
        let h = e == 0 ? -half : half;
        if (axis == 0) this.vertex(cx + h, cy + c * radius, cz + s * radius, packNormal(0, c, s), color);
        else if (axis == 1) this.vertex(cx + c * radius, cy + h, cz + s * radius, packNormal(c, 0, s), color);
        else this.vertex(cx + c * radius, cy + s * radius, cz + h, packNormal(c, s, 0), color);
      }
    }
    for (let i = 0; i < sides; i++) {
      let a = ring + <u32>(i * 2);
      if (axis == 1) this.quad(a, a + 1, a + 3, a + 2);
      else this.quad(a, a + 2, a + 3, a + 1);
    }
    // Caps.
    for (let e = 0; e < 2; e++) {
      let h = e == 0 ? -half : half;
      let sgn: f64 = e == 0 ? -1 : 1;
      let n = axis == 0 ? packNormal(sgn, 0, 0) : axis == 1 ? packNormal(0, sgn, 0) : packNormal(0, 0, sgn);
      let center = axis == 0 ? this.vertex(cx + h, cy, cz, n, color) : axis == 1 ? this.vertex(cx, cy + h, cz, n, color) : this.vertex(cx, cy, cz + h, n, color);
      let first = <u32>this.vertexCount;
      for (let i = 0; i <= sides; i++) {
        let t = TAU * <f64>i / <f64>sides;
        let c = Math.cos(t) * radius, s = Math.sin(t) * radius;
        if (axis == 0) this.vertex(cx + h, cy + c, cz + s, n, color);
        else if (axis == 1) this.vertex(cx + c, cy + h, cz + s, n, color);
        else this.vertex(cx + c, cy + s, cz + h, n, color);
      }
      for (let i = 0; i < sides; i++) {
        let a = first + <u32>i;
        let flip = (axis == 1) ? e == 0 : e == 1;
        if (flip) this.tri(center, a, a + 1);
        else this.tri(center, a + 1, a);
      }
    }
  }

  /** The vertex words as an ArrayBuffer of exactly the used size. */
  vertexBytes(): ArrayBuffer {
    return this.words.buffer.slice(0, this.vertexCount * VERTEX_WORDS * 4);
  }

  indexBytes(): ArrayBuffer {
    return this.indices.buffer.slice(0, this.indexCount * 4);
  }
}
