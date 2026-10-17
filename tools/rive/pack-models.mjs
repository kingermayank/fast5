// Packs the car models (public/models/*.glb) into the mesh format the Rive
// game reads (game/assets/<name>.mesh): simplified for the overhead camera,
// textures baked into vertex colours, and every vertex tagged with the
// material role the shader gives it (paint, chrome, glass, lamps...).
//
// Every value is a little-endian 32-bit word:
//   'F5MS' version
//   groups: count, then per group: pivot x y z, radius   (0 = body, 1-4 = wheels FL FR RL RR)
//   parts:  count, then per part: group firstIndex indexCount
//   vertices: count, then 5 words each: x y z (f32), normal (snorm8 x4), colour (unorm8 r g b role)
//   indices: count, then u32 each
// Wheel vertices are relative to their group's pivot, so the game can spin and steer them.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';

/** Material roles, shared with game/shaders/lit.wgsl. */
const ROLE = { matte: 0, paint: 1, chrome: 2, glass: 3, tail: 4, head: 5, rubber: 6, red: 7, blue: 8, amber: 9, livery: 10 };

const CARS = {
  charger: {
    ratio: 0.14,
    role(mat, x, z, lum) {
      const n = mat.getName();
      if (n === 'Paint') return ROLE.paint;
      if (n === 'Coloured') return ROLE.paint;
      if (n === 'material') return ROLE.chrome;
      if (n === 'GlassMtl') return ROLE.glass;
      if (n === 'GlassRed') return ROLE.tail;
      if (n === 'GlassAmber') return ROLE.amber;
      if (n === 'LightA') return z > 0 ? ROLE.head : ROLE.tail;
      if (n.startsWith('Wheel')) return lum > 0.3 ? ROLE.chrome : ROLE.rubber;
      if (n === 'LicensePlateDefaultA') return -1;
      return ROLE.matte;
    },
  },
  police: {
    ratio: 0.3,
    role(mat, x, z, lum) {
      const n = mat.getName();
      if (n === 'body') return ROLE.livery;
      if (n === 'glass') return ROLE.glass;
      if (n === 'roof_lights') return x > 0 ? ROLE.red : ROLE.blue;
      if (n === 'brake') return z > 0 ? ROLE.head : ROLE.tail;
      if (n === 'wheel') return lum > 0.3 ? ROLE.chrome : ROLE.rubber;
      return ROLE.matte;
    },
  },
};

const GROUPS = ['body', 'wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** Decoded RGBA pixels of a texture, sampled bilinearly with wrap. */
async function decodeTexture(tex) {
  const { data, info } = await sharp(Buffer.from(tex.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  return (u, v) => {
    const fx = (((u % 1) + 1) % 1) * w - 0.5;
    const fy = (((v % 1) + 1) % 1) * h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const at = (x, y, c) => data[(((y + h) % h) * w + ((x + w) % w)) * 4 + c] / 255;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx;
      const b = at(x0, y0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, c) * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  };
}

function mul(m, x, y, z, w) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
}

async function pack(name) {
  const cfg = CARS[name];
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(`public/models/${name}.glb`);
  // Quantized attributes come back as normalized ints; weld and simplify want floats.
  await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: cfg.ratio, error: 0.0015 }));

  const textures = new Map();
  for (const mat of doc.getRoot().listMaterials()) {
    const t = mat.getBaseColorTexture();
    if (t && !textures.has(t)) textures.set(t, await decodeTexture(t));
  }

  const groups = GROUPS.map(() => ({ pivot: [0, 0, 0], radius: 0 }));
  const verts = [];
  const indices = [];
  const parts = [];
  const counts = { tris: 0, roles: {} };

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const g = GROUPS.indexOf(node.getName());
    if (g < 0) throw new Error(`${name}: unexpected node ${node.getName()}`);
    const m = node.getWorldMatrix();
    // Wheels: pivot at the node origin (the wheel centre), vertices relative to it.
    const pivot = g === 0 ? [0, 0, 0] : mul(m, 0, 0, 0, 1);
    groups[g].pivot = pivot;
    let maxR = 0;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const pos = prim.getAttribute('POSITION');
      const nrm = prim.getAttribute('NORMAL');
      const uv = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices();
      const tex = mat?.getBaseColorTexture() ? textures.get(mat.getBaseColorTexture()) : null;
      const factor = mat ? mat.getBaseColorFactor() : [0.8, 0.8, 0.8, 1];
      const base = verts.length;
      const remap = new Int32Array(pos.getCount()).fill(-1);
      const el = [], en = [], et = [];
      for (let i = 0; i < pos.getCount(); i++) {
        const p = mul(m, ...pos.getElement(i, el), 1);
        const n = nrm ? mul(m, ...nrm.getElement(i, en), 0) : [0, 1, 0];
        const nl = Math.hypot(...n) || 1;
        let lin = [factor[0], factor[1], factor[2]];
        if (tex && uv) {
          const [u, v] = uv.getElement(i, et);
          const s = tex(u, v);
          lin = lin.map((c, k) => c * srgbToLinear(s[k]));
        }
        const srgb = lin.map((c) => Math.round(Math.min(1, Math.max(0, linearToSrgb(c))) * 255));
        const lum = (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) ** (1 / 2.2);
        const role = mat ? cfg.role(mat, p[0], p[2], lum) : ROLE.matte;
        if (role < 0) continue;
        remap[i] = verts.length;
        const rel = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
        if (g > 0) maxR = Math.max(maxR, Math.hypot(rel[1], rel[2]));
        verts.push({ p: rel, n: n.map((c) => c / nl), c: [...srgb, role] });
        counts.roles[role] = (counts.roles[role] ?? 0) + 1;
      }
      const first = indices.length;
      const src = idx ? idx.getArray() : Array.from({ length: pos.getCount() }, (_, i) => i);
      for (let i = 0; i + 2 < src.length; i += 3) {
        const a = remap[src[i]], b = remap[src[i + 1]], c = remap[src[i + 2]];
        if (a < 0 || b < 0 || c < 0) continue;
        indices.push(a, b, c);
      }
      if (indices.length > first) parts.push({ group: g, first, count: indices.length - first });
      counts.tris += (indices.length - first) / 3;
      void base;
    }
    if (g > 0) groups[g].radius = maxR;
  }

  const words = [];
  const u32 = (v) => words.push({ u: v >>> 0 });
  const f32 = (v) => words.push({ f: v });
  u32(0x534d3546); // 'F5MS'
  u32(1);
  u32(groups.length);
  for (const g of groups) {
    for (const v of g.pivot) f32(v);
    f32(g.radius);
  }
  u32(parts.length);
  for (const p of parts) {
    u32(p.group);
    u32(p.first);
    u32(p.count);
  }
  u32(verts.length);
  for (const v of verts) {
    for (const c of v.p) f32(c);
    const sn = v.n.map((c) => Math.max(-127, Math.min(127, Math.round(c * 127))) & 0xff);
    u32(sn[0] | (sn[1] << 8) | (sn[2] << 16));
    u32(v.c[0] | (v.c[1] << 8) | (v.c[2] << 16) | (v.c[3] << 24));
  }
  u32(indices.length);
  for (const i of indices) u32(i);

  const buf = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => ('u' in w ? buf.writeUInt32LE(w.u, i * 4) : buf.writeFloatLE(w.f, i * 4)));
  const out = `game/assets/${name}.mesh`;
  await writeFile(out, buf);
  console.log(`${out}: ${buf.length} bytes, ${verts.length} vertices, ${counts.tris} triangles, ${parts.length} parts, roles ${JSON.stringify(counts.roles)}`);
  console.log('  wheels', groups.slice(1).map((g) => g.pivot.map((v) => v.toFixed(2)).join(',') + ' r' + g.radius.toFixed(2)).join(' | '));
}

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CARS)) await pack(name);
