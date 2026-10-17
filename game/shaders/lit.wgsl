// Every opaque surface: the city, the cars, the vault and the cables, lit by a
// low golden-hour sun (with shadows), the sky and the ground bounce, then fogged
// and graded. The vertex colour's alpha holds the material role (ROLE_* below);
// game/src/render.as fills the uniforms.

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  camPos: vec4f,      // xyz, w = time (s)
  sunDir: vec4f,      // toward the sun; w = 1 when the shadow map is valid
  sunColor: vec4f,    // rgb, already scaled by intensity
  skyTop: vec4f,
  skyHorizon: vec4f,
  ground: vec4f,      // bounce light from below
  fog: vec4f,         // rgb, w = density (1/m)
  grade: vec4f,       // exposure, saturation, contrast, vignette
  screen: vec4f,      // width, height, 1/width, 1/height
  camRight: vec4f,
  camUp: vec4f,
};

struct Object {
  model: mat4x4f,
  paint: vec4f,       // rgb paint (sRGB), w = gloss 0..1
  params: vec4f,      // x brake lamps, y headlamps, z beacon phase, w strain glow (cables)
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(1) @binding(0) var<uniform> obj: Object;

const ROLE_MATTE = 0u;
const ROLE_PAINT = 1u;
const ROLE_CHROME = 2u;
const ROLE_GLASS = 3u;
const ROLE_TAIL = 4u;
const ROLE_HEAD = 5u;
const ROLE_RUBBER = 6u;
const ROLE_RED = 7u;
const ROLE_BLUE = 8u;
const ROLE_AMBER = 9u;
const ROLE_LIVERY = 10u;
const ROLE_WALL = 16u;
const ROLE_ROOF = 17u;
const ROLE_ASPHALT = 18u;
const ROLE_CONCRETE = 19u;
const ROLE_GRASS = 20u;
const ROLE_STEEL = 21u;
const ROLE_CABLE = 22u;
const ROLE_LINE = 23u;
const ROLE_WATER = 24u;
const ROLE_GROUND = 25u;
const ROLE_SHOP = 26u;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec4f,
  @location(2) col: vec4f,
};

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) nrm: vec3f,
  @location(2) col: vec4f,
  @location(3) shadowPos: vec3f,
};

@vertex
fn vs_main(i: VIn) -> VOut {
  let w = obj.model * vec4f(i.pos, 1.0);
  var o: VOut;
  o.clip = frame.viewProj * w;
  o.world = w.xyz;
  o.nrm = (obj.model * vec4f(i.nrm.xyz, 0.0)).xyz;
  o.col = i.col;
  let l = frame.lightViewProj * w;
  o.shadowPos = vec3f(l.x * 0.5 + 0.5, 0.5 - l.y * 0.5, l.z);
  return o;
}

fn toLinear(c: vec3f) -> vec3f {
  return pow(max(c, vec3f(0.0)), vec3f(2.2));
}

fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(sin(dot(q, vec2f(12.9898, 78.233)) * 43758.5453) + dot(q, q));
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash2(i);
  let b = hash2(i + vec2f(1.0, 0.0));
  let c = hash2(i + vec2f(0.0, 1.0));
  let d = hash2(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2f) -> f32 {
  return noise(p) * 0.55 + noise(p * 2.07 + 13.1) * 0.3 + noise(p * 4.13 + 7.7) * 0.15;
}

fn sky(d: vec3f) -> vec3f {
  let t = d.y;
  var c = mix(frame.skyHorizon.rgb, frame.skyTop.rgb, sqrt(clamp(t, 0.0, 1.0)));
  if (t < 0.0) {
    // Below the horizon a reflection sees street, not the warm bounce light.
    c = mix(frame.skyHorizon.rgb * 0.6, vec3f(0.06, 0.065, 0.075), clamp(-t * 3.0, 0.0, 1.0));
  }
  let s = max(dot(d, frame.sunDir.xyz), 0.0);
  return c + frame.sunColor.rgb * (pow(s, 600.0) * 3.0 + pow(s, 16.0) * 0.08);
}

fn shadowAt(sp: vec3f, ndl: f32) -> f32 {
  if (frame.sunDir.w < 0.5 || sp.x <= 0.002 || sp.x >= 0.998 || sp.y <= 0.002 || sp.y >= 0.998 || sp.z >= 1.0) {
    return 1.0;
  }
  let texel = 1.0 / 2048.0;
  let bias = 0.0008 + 0.0025 * (1.0 - ndl);
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += textureSampleCompareLevel(shadowMap, shadowSampler, sp.xy + vec2f(f32(x), f32(y)) * texel * 1.5, sp.z - bias);
    }
  }
  return s / 9.0;
}

struct Surface {
  albedo: vec3f,
  rough: f32,
  metal: f32,
  emissive: vec3f,
  clearcoat: f32,
  normal: vec3f,
  ao: f32,
};

// Facades: storeys and window bays from the world position along the wall.
fn facade(base: vec3f, world: vec3f, n: vec3f, fw: vec3f, shop: bool) -> Surface {
  var s: Surface;
  s.albedo = base;
  s.rough = 0.85;
  s.metal = 0.0;
  s.emissive = vec3f(0.0);
  s.clearcoat = 0.0;
  s.normal = n;
  s.ao = 1.0;
  let t = normalize(vec3f(-n.z, 0.0, n.x));
  let u = dot(world, t);
  let storey = 3.3;
  let bay = 3.1;
  let fy = world.y / storey;
  let fx = u / bay;
  let cell = vec2f(floor(fx), floor(fy));
  let g = vec2f(fract(fx), fract(fy));
  // Window pane, slightly soft edged (fw keeps it from shimmering at a distance).
  // Soften by about a pixel, but never so much that panes turn into blobs at grazing angles.
  let soft = min(vec2f(max(fw.x, fw.z) / bay, fw.y / storey) * 1.2, vec2f(0.05)) + 0.008;
  var lo = vec2f(0.22, 0.3);
  var hi = vec2f(0.78, 0.82);
  if (shop && world.y < storey) {
    lo = vec2f(0.06, 0.05);
    hi = vec2f(0.94, 0.78);
  }
  let inside = smoothstep(lo - soft, lo + soft, g) * (1.0 - smoothstep(hi - soft, hi + soft, g));
  let win = inside.x * inside.y;
  // Frame: a lighter band just around the pane.
  let fl = smoothstep(lo - vec2f(0.07, 0.06) - soft, lo - vec2f(0.07, 0.06), g) * (1.0 - smoothstep(hi + vec2f(0.07, 0.06), hi + vec2f(0.07, 0.06) + soft, g));
  let frameMask = clamp(fl.x * fl.y - win, 0.0, 1.0);
  s.albedo = mix(s.albedo, s.albedo * 1.25 + 0.05, frameMask * 0.8);
  // Stain and weathering.
  let grime = fbm(vec2f(u * 0.15, world.y * 0.4));
  s.albedo *= 0.86 + 0.24 * grime;
  // Glass: dark and reflective; one in five lit warm from inside.
  let h = hash2(cell + floor(world.xz * 0.013));
  let lit = select(0.0, 1.0, h > 0.8);
  let glass = mix(vec3f(0.04, 0.05, 0.06), vec3f(0.08, 0.07, 0.06), h);
  s.albedo = mix(s.albedo, glass, win);
  s.rough = mix(s.rough, 0.08, win);
  s.emissive = vec3f(1.0, 0.62, 0.3) * win * lit * (0.6 + 0.4 * hash2(cell + 3.0));
  // Contact shadow at the foot of the wall.
  s.ao = mix(0.55, 1.0, smoothstep(0.0, 2.5, world.y));
  return s;
}

@fragment
fn fs_main(i: VOut) -> @location(0) vec4f {
  // Derivatives first: they need uniform control flow.
  let fw = fwidth(i.world);
  let role = u32(round(i.col.a * 255.0));
  let base = toLinear(i.col.rgb);
  let n0 = normalize(i.nrm);

  var s: Surface;
  s.albedo = base;
  s.rough = 0.8;
  s.metal = 0.0;
  s.emissive = vec3f(0.0);
  s.clearcoat = 0.0;
  s.normal = n0;
  s.ao = 1.0;

  let time = frame.camPos.w;
  switch role {
    case ROLE_PAINT: {
      s.albedo = toLinear(obj.paint.rgb);
      s.rough = mix(0.65, 0.12, obj.paint.w);
      s.clearcoat = obj.paint.w;
    }
    case ROLE_LIVERY: {
      s.rough = 0.25;
      s.clearcoat = 0.8;
    }
    case ROLE_CHROME: {
      s.metal = 1.0;
      s.rough = 0.18;
      s.albedo = max(base, vec3f(0.55));
    }
    case ROLE_GLASS: {
      s.albedo = vec3f(0.02, 0.025, 0.03);
      s.rough = 0.04;
      s.clearcoat = 1.0;
    }
    case ROLE_TAIL: {
      s.albedo = vec3f(0.25, 0.02, 0.02);
      s.rough = 0.2;
      s.emissive = vec3f(1.0, 0.05, 0.03) * (0.6 + obj.params.x * 5.0);
    }
    case ROLE_HEAD: {
      s.albedo = vec3f(0.6, 0.6, 0.55);
      s.rough = 0.15;
      s.emissive = vec3f(1.0, 0.9, 0.7) * obj.params.y * 3.0;
    }
    case ROLE_AMBER: {
      s.albedo = vec3f(0.5, 0.2, 0.0);
      s.rough = 0.2;
    }
    case ROLE_RED: {
      let on = step(0.5, fract(obj.params.z));
      s.albedo = vec3f(0.3, 0.02, 0.02);
      s.emissive = vec3f(1.0, 0.04, 0.02) * on * 6.0 * step(0.001, obj.params.z);
    }
    case ROLE_BLUE: {
      let on = 1.0 - step(0.5, fract(obj.params.z));
      s.albedo = vec3f(0.02, 0.05, 0.3);
      s.emissive = vec3f(0.05, 0.25, 1.0) * on * 6.0 * step(0.001, obj.params.z);
    }
    case ROLE_RUBBER: {
      s.albedo = vec3f(0.025);
      s.rough = 0.95;
    }
    case ROLE_WALL: {
      s = facade(base, i.world, n0, fw, false);
    }
    case ROLE_SHOP: {
      s = facade(base, i.world, n0, fw, true);
    }
    case ROLE_ROOF: {
      let g = fbm(i.world.xz * 0.35);
      s.albedo = base * (0.8 + 0.35 * g);
      s.rough = 0.9;
    }
    case ROLE_ASPHALT: {
      let g = fbm(i.world.xz * 0.6);
      let patches = smoothstep(0.55, 0.75, fbm(i.world.xz * 0.045 + 31.0));
      s.albedo = base * (0.82 + 0.3 * g) * (1.0 - 0.12 * patches);
      s.rough = 0.92;
    }
    case ROLE_CONCRETE: {
      let tile = fract(i.world.xz / 1.5);
      let joint = min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y));
      let jw = max(fw.x, fw.z) * 0.7 + 0.015;
      s.albedo = base * (0.9 + 0.18 * noise(i.world.xz * 2.3)) * mix(0.8, 1.0, smoothstep(0.0, jw, joint));
      s.rough = 0.85;
    }
    case ROLE_GRASS: {
      let g = fbm(i.world.xz * 0.25);
      s.albedo = base * (0.7 + 0.5 * g) + vec3f(0.02, 0.015, 0.0) * noise(i.world.xz * 3.0);
      s.rough = 0.95;
    }
    case ROLE_GROUND: {
      let g = fbm(i.world.xz * 0.08);
      s.albedo = base * (0.8 + 0.35 * g);
      s.rough = 0.95;
    }
    case ROLE_STEEL: {
      let brush = noise(vec2f(dot(i.world.xz, vec2f(0.7, 0.7)) * 40.0, i.world.y * 2.0));
      s.metal = 0.85;
      s.rough = 0.32 + 0.12 * brush;
      s.albedo = base * (0.9 + 0.15 * brush);
    }
    case ROLE_CABLE: {
      s.metal = 0.9;
      s.rough = 0.35;
      let strain = obj.params.w;
      let pulse = 0.65 + 0.35 * sin(time * 28.0);
      s.emissive = vec3f(1.0, 0.25, 0.05) * smoothstep(0.55, 1.0, strain) * pulse * 2.5;
    }
    case ROLE_LINE: {
      s.rough = 0.7;
      s.albedo = base * (0.85 + 0.2 * noise(i.world.xz * 4.0));
    }
    case ROLE_WATER: {
      let ripple = vec2f(noise(i.world.xz * 0.35 + time * 0.3) - 0.5, noise(i.world.xz * 0.35 - time * 0.27 + 9.0) - 0.5);
      s.normal = normalize(vec3f(ripple.x * 0.12, 1.0, ripple.y * 0.12));
      s.albedo = base;
      s.rough = 0.06;
      s.clearcoat = 1.0;
    }
    default: {}
  }

  let n = s.normal;
  let v = normalize(frame.camPos.xyz - i.world);
  let l = frame.sunDir.xyz;
  let h = normalize(l + v);
  let ndl = max(dot(n, l), 0.0);
  let ndv = max(dot(n, v), 0.001);
  let ndh = max(dot(n, h), 0.0);
  let shadow = shadowAt(i.shadowPos, ndl);

  // Diffuse: sun, sky dome and ground bounce.
  let hemi = mix(frame.ground.rgb, frame.skyTop.rgb + frame.skyHorizon.rgb * 0.15, n.y * 0.5 + 0.5);
  let diffuse = s.albedo * (1.0 - s.metal) * (frame.sunColor.rgb * ndl * shadow + hemi * 0.75) * s.ao;

  // Specular: GGX highlight from the sun plus the sky in reflection.
  let a = max(s.rough * s.rough, 0.002);
  let a2 = a * a;
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let D = a2 / (3.14159 * dd * dd);
  let f0 = mix(vec3f(0.04), s.albedo, s.metal);
  let F = f0 + (vec3f(1.0) - f0) * pow(1.0 - max(dot(h, v), 0.0), 5.0);
  let spec = D * F * 0.25 * ndl * shadow * frame.sunColor.rgb;
  let r = reflect(-v, n);
  let fv = f0 + (vec3f(1.0) - f0) * pow(1.0 - ndv, 5.0) * (1.0 - s.rough);
  let env = sky(r) * fv * (1.0 - s.rough * 0.85) * mix(0.55, 1.0, shadow) * s.ao;
  // Clear coat on paint and glass: a sharp second reflection.
  let cf = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let coat = sky(r) * cf * s.clearcoat * mix(0.6, 1.0, shadow);

  var color = diffuse + spec + env + coat + s.emissive;

  // Haze.
  let dist = length(frame.camPos.xyz - i.world);
  let fogAmt = 1.0 - exp(-dist * frame.fog.w);
  color = mix(color, frame.fog.rgb, fogAmt);

  // Grade: exposure, filmic curve, saturation, contrast, vignette.
  color *= frame.grade.x;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
  color = mix(vec3f(luma), color, frame.grade.y);
  color = (color - 0.5) * frame.grade.z + 0.5;
  let uv = i.clip.xy * frame.screen.zw - 0.5;
  color *= 1.0 - frame.grade.w * dot(uv, uv) * 1.6;
  color = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
  return vec4f(color, 1.0);
}
