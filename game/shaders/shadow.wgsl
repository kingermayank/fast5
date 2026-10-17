// Sun shadow map: depth only, from the sun's orthographic view. Same uniforms
// and vertex layout as lit.wgsl (only lightViewProj and the model are read).

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

struct Object {
  model: mat4x4f,
  paint: vec4f,
  params: vec4f,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(1) @binding(0) var<uniform> obj: Object;

struct VIn {
  @location(0) pos: vec3f,
  @location(1) nrm: vec4f,
  @location(2) col: vec4f,
};

@vertex
fn vs_main(i: VIn) -> @builtin(position) vec4f {
  return frame.lightViewProj * obj.model * vec4f(i.pos, 1.0);
}
