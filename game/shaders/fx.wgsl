// Particles: sparks, dust and tyre smoke. One camera-facing quad per particle,
// stretched along its velocity (so sparks streak). fs_glow adds light (sparks,
// glints); fs_smoke blends (dust, smoke) and takes the sun's colour.

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  camPos: vec4f,
  sunDir: vec4f,
  sunColor: vec4f,
  skyTop: vec4f,
  skyHorizon: vec4f,
  ground: vec4f,
  fog: vec4f,
  grade: vec4f,
  screen: vec4f,
  camRight: vec4f,
  camUp: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;

struct PIn {
  @location(0) corner: vec2f,
  @location(1) pos: vec4f,    // xyz, size (m)
  @location(2) vel: vec4f,    // xyz (m/s), stretch (s)
  @location(3) col: vec4f,    // rgba (unorm8)
};

struct POut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
  @location(2) dist: f32,
};

@vertex
fn vs_main(i: PIn) -> POut {
  let right = frame.camRight.xyz;
  let up = frame.camUp.xyz;
  // The velocity as seen on screen, and how long the streak is.
  let vs = vec2f(dot(i.vel.xyz, right), dot(i.vel.xyz, up));
  let speed = length(vs);
  var major = vec2f(1.0, 0.0);
  if (speed > 0.001) {
    major = vs / speed;
  }
  let minor = vec2f(-major.y, major.x);
  let size = i.pos.w;
  let len = size + speed * i.vel.w;
  let off = major * (i.corner.x * len) + minor * (i.corner.y * size);
  let world = i.pos.xyz + right * off.x + up * off.y - i.vel.xyz * i.vel.w * 0.5 * step(0.0, i.vel.w);
  var o: POut;
  o.clip = frame.viewProj * vec4f(world, 1.0);
  o.uv = i.corner;
  o.col = i.col;
  o.dist = length(frame.camPos.xyz - world);
  return o;
}

fn grade(c: vec3f) -> vec3f {
  var color = c * frame.grade.x;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  return pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}

@fragment
fn fs_glow(i: POut) -> @location(0) vec4f {
  let r = length(i.uv);
  let a = clamp(1.0 - r, 0.0, 1.0);
  let k = a * a * i.col.a;
  // Hot core: brighter than its colour, so it reads as light.
  let c = pow(max(i.col.rgb, vec3f(0.0)), vec3f(2.2)) * (1.0 + 3.0 * a);
  return vec4f(grade(c) * k, 0.0);
}

@fragment
fn fs_smoke(i: POut) -> @location(0) vec4f {
  let r = length(i.uv);
  let a = smoothstep(1.0, 0.0, r) * smoothstep(1.0, 0.0, r) * i.col.a;
  let lit = pow(max(i.col.rgb, vec3f(0.0)), vec3f(2.2)) * (frame.sunColor.rgb * 0.16 + frame.skyTop.rgb * 0.35 + frame.ground.rgb * 0.2);
  let fogAmt = 1.0 - exp(-i.dist * frame.fog.w);
  let c = mix(lit, frame.fog.rgb, fogAmt);
  return vec4f(grade(c) * a, a);
}
