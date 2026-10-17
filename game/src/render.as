// The GPU side: pipelines, uniforms and the frame's passes. A frame is
//   1. the sun's shadow map (depth only, around the camera's focus),
//   2. the lit pass into Rive's own render target (4x MSAA where available):
//      opaque meshes, then smoke and dust, then sparks and glints.
// Everything the game wants drawn is queued with mesh(), particles() and so on
// between begin() and finish(). When the host exposes no render target (the
// CLI's headless capture), the frame goes to a GPU canvas drawn as an image.
import { Context } from "rive/host";
import { Renderer } from "rive/renderer";
import { ImageSampler } from "rive/image";
import { BlendMode } from "rive/paint";
import { Mat2D } from "rive/mat2d";
import {
  GPUBuffer, GPUPipeline, GPUPipelineDesc, GPUColorTargetDesc, GPUVertexBufferLayout,
  GPUVertexAttribute, GPUDepthStencilDesc, GPUBindGroup, GPUBindGroupUBO, GPUBindGroupTexture,
  GPUBindGroupSampler, GPUBindGroupLayout, GPUPassDesc, GPUColorAttachment, GPUTexture,
  GPUTextureDesc, GPUTextureView, GPUTextureViewDesc, GPUTarget, GPUCanvas, GPUSampler,
  GPUBlendState,
} from "rive/gpu";
import {
  BufferUsage, TextureFormat, VertexFormat, CompareFunction, CullMode, LoadOp, StoreOp,
  IndexFormat, Filter, WrapMode, VertexStepMode, BlendFactor, TextureAspect,
} from "rive/gpu_enums";
import { M4, VERTEX_BYTES } from "./util";

export const MAX_OBJECTS: i32 = 192;
const OBJECT_STRIDE: u32 = 256;
const FRAME_BYTES: u32 = 320;
const SHADOW_SIZE: u32 = 2048;
export const MAX_PARTICLES: i32 = 3000;
/** Particle instance: pos.xyz size, vel.xyz stretch, rgba8. */
export const PARTICLE_WORDS: i32 = 9;

/** Vertex and index buffers on the GPU. */
export class GpuMesh {
  vbo: GPUBuffer;
  ibo: GPUBuffer;
  vertexCapacity: u32;
  indexCapacity: u32;
  indexCount: u32 = 0;

  constructor(vertexBytes: u32, indexBytes: u32) {
    this.vertexCapacity = vertexBytes;
    this.indexCapacity = indexBytes;
    this.vbo = new GPUBuffer(BufferUsage.vertex, vertexBytes);
    this.ibo = new GPUBuffer(BufferUsage.index, indexBytes);
  }

  /** A static mesh straight from bytes (a slice of a blob or a builder). */
  static from(vertices: ArrayBuffer, vertexOffset: u32, vertexBytes: u32, indices: ArrayBuffer, indexOffset: u32, indexBytes: u32): GpuMesh {
    let m = new GpuMesh(vertexBytes, indexBytes);
    m.vbo.update(0, vertices, vertexBytes, vertexOffset);
    m.ibo.update(0, indices, indexBytes, indexOffset);
    m.indexCount = indexBytes / 4;
    return m;
  }
}

class Draw {
  mesh: GpuMesh;
  first: u32;
  count: u32;
  slot: u32;
  shadow: bool;
  main: bool;
  constructor(mesh: GpuMesh, first: u32, count: u32, slot: u32, shadow: bool, main: bool) {
    this.mesh = mesh;
    this.first = first;
    this.count = count;
    this.slot = slot;
    this.shadow = shadow;
    this.main = main;
  }
}

/** The lighting and grade for a frame (linear colours). */
export class Look {
  sunX: f64 = -0.596;
  sunY: f64 = 0.407;
  sunZ: f64 = -0.692;
  sun: StaticArray<f64> = [3.0, 2.4, 1.75];
  skyTop: StaticArray<f64> = [0.2, 0.31, 0.5];
  skyHorizon: StaticArray<f64> = [0.95, 0.7, 0.5];
  ground: StaticArray<f64> = [0.26, 0.22, 0.18];
  fog: StaticArray<f64> = [0.8, 0.68, 0.58];
  fogDensity: f64 = 0.0011;
  exposure: f64 = 0.95;
  saturation: f64 = 1.2;
  contrast: f64 = 1.14;
  vignette: f64 = 0.4;
}

export class GameRenderer {
  context: Context;
  ready: bool = false;
  failed: bool = false;
  samples: u32 = 1;
  format: TextureFormat = TextureFormat.rgba8unorm;

  lit: GPUPipeline? = null;
  shadowPipe: GPUPipeline? = null;
  glow: GPUPipeline? = null;
  smoke: GPUPipeline? = null;

  frameUbo: GPUBuffer? = null;
  objectUbo: GPUBuffer? = null;
  litFrame: GPUBindGroup? = null;
  shadowFrame: GPUBindGroup? = null;
  fxFrame: GPUBindGroup? = null;
  objects: GPUBindGroup? = null;

  shadowTex: GPUTexture? = null;
  shadowTarget: GPUTextureView? = null;
  shadowSample: GPUTextureView? = null;

  depth: GPUTexture? = null;
  depthView: GPUTextureView? = null;
  msaa: GPUTexture? = null;
  msaaView: GPUTextureView? = null;
  targetW: u32 = 0;
  targetH: u32 = 0;
  canvas: GPUCanvas? = null;

  quad: GPUBuffer? = null;
  particleBuf: GPUBuffer? = null;
  particleData: Float32Array = new Float32Array(MAX_PARTICLES * PARTICLE_WORDS);
  particleWords: Uint32Array = Uint32Array.wrap(this.particleData.buffer);
  smokeCount: i32 = 0;
  glowCount: i32 = 0;

  frameData: Float32Array = new Float32Array(<i32>FRAME_BYTES / 4);
  objectData: Float32Array = new Float32Array(MAX_OBJECTS * <i32>OBJECT_STRIDE / 4);
  objectCount: i32 = 0;
  draws: Array<Draw> = [];
  offsets: Array<u32> = [0];

  // The frame's camera, for culling.
  focusX: f64 = 0;
  focusZ: f64 = 0;
  viewRadius: f64 = 300;
  shadowRadius: f64 = 120;

  constructor(context: Context) {
    this.context = context;
  }

  log(message: string): void {
    this.context.log(message);
  }

  private setup(target: GPUTarget): bool {
    let context = this.context;
    let litModule = context.shader("shaders/lit");
    let shadowModule = context.shader("shaders/shadow");
    let fxModule = context.shader("shaders/fx");
    if (litModule == null || shadowModule == null || fxModule == null) {
      this.log("renderer: shaders missing");
      this.failed = true;
      return false;
    }
    let features = context.features();
    this.samples = features.maxSamples >= 4 ? 4 : 1;
    this.format = <TextureFormat>target.format;

    let frameLayout = GPUBindGroupLayout.fromShader(litModule, 0);
    let objectLayout = GPUBindGroupLayout.fromShader(litModule, 1, [0]);
    let shadowFrameLayout = GPUBindGroupLayout.fromShader(shadowModule, 0);
    let fxFrameLayout = GPUBindGroupLayout.fromShader(fxModule, 0);
    if (frameLayout == null || objectLayout == null || shadowFrameLayout == null || fxFrameLayout == null) {
      this.log("renderer: bind group layouts failed");
      this.failed = true;
      return false;
    }

    let layout = new GPUVertexBufferLayout();
    layout.stride = VERTEX_BYTES;
    layout.attributes = [
      new GPUVertexAttribute(VertexFormat.float3, 0, 0),
      new GPUVertexAttribute(VertexFormat.snorm8x4, 1, 12),
      new GPUVertexAttribute(VertexFormat.unorm8x4, 2, 16),
    ];

    // Lit opaque.
    let color = new GPUColorTargetDesc();
    color.format = this.format;
    let depthState = new GPUDepthStencilDesc();
    depthState.format = TextureFormat.depth32float;
    depthState.compare = CompareFunction.lessEqual;
    depthState.write = true;
    let lit = new GPUPipelineDesc();
    lit.vertexModule = litModule;
    lit.fragmentModule = litModule;
    lit.vertexEntryPoint = "vs_main";
    lit.fragmentEntryPoint = "fs_main";
    lit.colorTargets = [color];
    lit.vertexBuffers = [layout];
    lit.bindGroupLayouts = [frameLayout, objectLayout];
    lit.depthStencil = depthState;
    lit.cullMode = CullMode.back;
    lit.sampleCount = this.samples;
    this.lit = new GPUPipeline(lit);

    // Shadow: depth only, a little slope bias against acne.
    let shadowDepth = new GPUDepthStencilDesc();
    shadowDepth.format = TextureFormat.depth32float;
    shadowDepth.compare = CompareFunction.lessEqual;
    shadowDepth.write = true;
    shadowDepth.depthBias = 2;
    shadowDepth.depthBiasSlopeScale = 2.5;
    let sh = new GPUPipelineDesc();
    sh.vertexModule = shadowModule;
    sh.vertexEntryPoint = "vs_main";
    sh.vertexBuffers = [layout];
    sh.bindGroupLayouts = [shadowFrameLayout, objectLayout];
    sh.depthStencil = shadowDepth;
    sh.cullMode = CullMode.none;
    this.shadowPipe = new GPUPipeline(sh);

    // Particles: a unit quad per vertex, one instance per particle.
    let corner = new GPUVertexBufferLayout();
    corner.stride = 8;
    corner.attributes = [new GPUVertexAttribute(VertexFormat.float2, 0, 0)];
    let inst = new GPUVertexBufferLayout();
    inst.stride = <u32>(PARTICLE_WORDS * 4);
    inst.stepMode = VertexStepMode.instance;
    inst.attributes = [
      new GPUVertexAttribute(VertexFormat.float4, 1, 0),
      new GPUVertexAttribute(VertexFormat.float4, 2, 16),
      new GPUVertexAttribute(VertexFormat.unorm8x4, 3, 32),
    ];
    let fxDepth = new GPUDepthStencilDesc();
    fxDepth.format = TextureFormat.depth32float;
    fxDepth.compare = CompareFunction.lessEqual;
    fxDepth.write = false;
    for (let k = 0; k < 2; k++) {
      let blend = new GPUBlendState();
      if (k == 0) {
        // Smoke: premultiplied alpha over.
        blend.dstColor = BlendFactor.oneMinusSrcAlpha;
        blend.dstAlpha = BlendFactor.oneMinusSrcAlpha;
      } else {
        // Glow: add light.
        blend.dstColor = BlendFactor.one;
        blend.srcAlpha = BlendFactor.zero;
        blend.dstAlpha = BlendFactor.one;
      }
      let c = new GPUColorTargetDesc();
      c.format = this.format;
      c.blend = blend;
      let d = new GPUPipelineDesc();
      d.vertexModule = fxModule;
      d.fragmentModule = fxModule;
      d.vertexEntryPoint = "vs_main";
      d.fragmentEntryPoint = k == 0 ? "fs_smoke" : "fs_glow";
      d.colorTargets = [c];
      d.vertexBuffers = [corner, inst];
      d.bindGroupLayouts = [fxFrameLayout];
      d.depthStencil = fxDepth;
      d.sampleCount = this.samples;
      if (k == 0) this.smoke = new GPUPipeline(d);
      else this.glow = new GPUPipeline(d);
    }

    // Uniforms.
    let frameUbo = new GPUBuffer(BufferUsage.uniform, FRAME_BYTES);
    let objectUbo = new GPUBuffer(BufferUsage.uniform, <u32>MAX_OBJECTS * OBJECT_STRIDE);
    this.frameUbo = frameUbo;
    this.objectUbo = objectUbo;

    // Shadow map, sampled through a comparison sampler (hardware PCF).
    let sd = new GPUTextureDesc();
    sd.width = SHADOW_SIZE;
    sd.height = SHADOW_SIZE;
    sd.format = TextureFormat.depth32float;
    sd.renderTarget = true;
    let shadowTex = new GPUTexture(sd);
    this.shadowTex = shadowTex;
    this.shadowTarget = shadowTex.view();
    let sampleDesc = new GPUTextureViewDesc();
    sampleDesc.aspect = TextureAspect.depthOnly;
    let shadowSample = shadowTex.view(sampleDesc);
    this.shadowSample = shadowSample;
    let cmp = new GPUSampler(Filter.linear, Filter.linear, Filter.nearest, WrapMode.clampToEdge, WrapMode.clampToEdge, CompareFunction.lessEqual);

    this.litFrame = new GPUBindGroup(frameLayout, [new GPUBindGroupUBO(0, frameUbo, 0, FRAME_BYTES)], [new GPUBindGroupTexture(1, shadowSample)], [new GPUBindGroupSampler(2, cmp)]);
    this.shadowFrame = new GPUBindGroup(shadowFrameLayout, [new GPUBindGroupUBO(0, frameUbo, 0, FRAME_BYTES)]);
    this.fxFrame = new GPUBindGroup(fxFrameLayout, [new GPUBindGroupUBO(0, frameUbo, 0, FRAME_BYTES)]);
    this.objects = new GPUBindGroup(objectLayout, [new GPUBindGroupUBO(0, objectUbo, 0, OBJECT_STRIDE)]);

    let corners = new Float32Array(12);
    let cs: StaticArray<f32> = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
    for (let i = 0; i < 12; i++) corners[i] = cs[i];
    this.quad = new GPUBuffer(BufferUsage.vertex, 48, corners.buffer, true);
    this.particleBuf = new GPUBuffer(BufferUsage.vertex, <u32>(MAX_PARTICLES * PARTICLE_WORDS * 4));

    this.ready = true;
    this.log("renderer ready: " + this.samples.toString() + "x MSAA, format " + (<u32>this.format).toString());
    return true;
  }

  /** Starts a frame: clears the queues. */
  begin(): void {
    this.objectCount = 0;
    this.draws.length = 0;
    this.smokeCount = 0;
    this.glowCount = 0;
  }

  /** Per-object uniforms; returns the slot to draw with. */
  object(model: M4, paintRgb: u32, gloss: f64, p0: f64, p1: f64, p2: f64, p3: f64): u32 {
    if (this.objectCount >= MAX_OBJECTS) return <u32>(MAX_OBJECTS - 1);
    let slot = this.objectCount++;
    let o = slot * <i32>OBJECT_STRIDE / 4;
    model.write(this.objectData, o);
    this.objectData[o + 16] = <f32>(<f64>((paintRgb >> 16) & 0xff) / 255);
    this.objectData[o + 17] = <f32>(<f64>((paintRgb >> 8) & 0xff) / 255);
    this.objectData[o + 18] = <f32>(<f64>(paintRgb & 0xff) / 255);
    this.objectData[o + 19] = <f32>gloss;
    this.objectData[o + 20] = <f32>p0;
    this.objectData[o + 21] = <f32>p1;
    this.objectData[o + 22] = <f32>p2;
    this.objectData[o + 23] = <f32>p3;
    return <u32>slot;
  }

  mesh(mesh: GpuMesh, first: u32, count: u32, slot: u32, shadow: bool): void {
    if (count == 0) return;
    this.draws.push(new Draw(mesh, first, count, slot, shadow, true));
  }

  /** Only into the shadow map (a caster the camera can't see but whose shadow it can). */
  shadowOnly(mesh: GpuMesh, first: u32, count: u32, slot: u32): void {
    if (count == 0) return;
    this.draws.push(new Draw(mesh, first, count, slot, true, false));
  }

  /** Adds a particle; glowing ones add light, the rest blend as smoke. */
  particle(glow: bool, x: f64, y: f64, z: f64, size: f64, vx: f64, vy: f64, vz: f64, stretch: f64, r: u32, g: u32, b: u32, a: u32): void {
    // Smoke fills from the front of the buffer, glow from the back.
    let index: i32;
    if (glow) {
      if (this.smokeCount + this.glowCount >= MAX_PARTICLES) return;
      index = MAX_PARTICLES - 1 - this.glowCount;
      this.glowCount++;
    } else {
      if (this.smokeCount + this.glowCount >= MAX_PARTICLES) return;
      index = this.smokeCount;
      this.smokeCount++;
    }
    let o = index * PARTICLE_WORDS;
    let f = this.particleData;
    f[o] = <f32>x;
    f[o + 1] = <f32>y;
    f[o + 2] = <f32>z;
    f[o + 3] = <f32>size;
    f[o + 4] = <f32>vx;
    f[o + 5] = <f32>vy;
    f[o + 6] = <f32>vz;
    f[o + 7] = <f32>stretch;
    this.particleWords[o + 8] = (r & 0xff) | ((g & 0xff) << 8) | ((b & 0xff) << 16) | ((a & 0xff) << 24);
  }

  /** Camera, sun and grade for this frame. */
  camera(eyeX: f64, eyeY: f64, eyeZ: f64, tx: f64, ty: f64, tz: f64, fovY: f64, width: f64, height: f64, time: f64, look: Look): void {
    let view = M4.lookAt(eyeX, eyeY, eyeZ, tx, ty, tz, 0, 1, 0);
    let proj = M4.perspective(fovY, width / Math.max(1, height), 1.0, 2500);
    let viewProj = proj.mul(view);
    this.focusX = tx;
    this.focusZ = tz;

    // Sun: an orthographic box around the focus, snapped to whole texels so
    // shadows don't crawl as the camera moves.
    let r = this.shadowRadius;
    let lx = look.sunX, ly = look.sunY, lz = look.sunZ;
    let lightView = M4.lookAt(tx + lx * 600, ty + ly * 600, tz + lz * 600, tx, ty, tz, 0, 1, 0);
    let texel = (2 * r) / <f64>SHADOW_SIZE;
    // Focus in light space, snapped.
    let fx = lightView.m[0] * tx + lightView.m[4] * ty + lightView.m[8] * tz + lightView.m[12];
    let fy = lightView.m[1] * tx + lightView.m[5] * ty + lightView.m[9] * tz + lightView.m[13];
    let sx = Math.round(fx / texel) * texel - fx;
    let sy = Math.round(fy / texel) * texel - fy;
    let lightProj = M4.ortho(-r + sx + fx, r + sx + fx, -r + sy + fy, r + sy + fy, 1, 1400);
    let lightViewProj = lightProj.mul(lightView);

    let f = this.frameData;
    viewProj.write(f, 0);
    lightViewProj.write(f, 16);
    f[32] = <f32>eyeX; f[33] = <f32>eyeY; f[34] = <f32>eyeZ; f[35] = <f32>time;
    f[36] = <f32>lx; f[37] = <f32>ly; f[38] = <f32>lz; f[39] = 1;
    for (let k = 0; k < 3; k++) {
      f[40 + k] = <f32>look.sun[k];
      f[44 + k] = <f32>look.skyTop[k];
      f[48 + k] = <f32>look.skyHorizon[k];
      f[52 + k] = <f32>look.ground[k];
      f[56 + k] = <f32>look.fog[k];
    }
    f[59] = <f32>look.fogDensity;
    f[60] = <f32>look.exposure;
    f[61] = <f32>look.saturation;
    f[62] = <f32>look.contrast;
    f[63] = <f32>look.vignette;
    f[64] = <f32>width; f[65] = <f32>height; f[66] = <f32>(1 / Math.max(1, width)); f[67] = <f32>(1 / Math.max(1, height));
    // Camera right and up in world space: rows of the view matrix.
    f[68] = <f32>view.m[0]; f[69] = <f32>view.m[4]; f[70] = <f32>view.m[8]; f[71] = 0;
    f[72] = <f32>view.m[1]; f[73] = <f32>view.m[5]; f[74] = <f32>view.m[9]; f[75] = 0;
  }

  private ensureTargets(t: GPUTarget): void {
    if (this.depth != null && this.targetW == t.width && this.targetH == t.height) return;
    let dd = new GPUTextureDesc();
    dd.width = t.width;
    dd.height = t.height;
    dd.format = TextureFormat.depth32float;
    dd.renderTarget = true;
    dd.sampleCount = this.samples;
    let depth = new GPUTexture(dd);
    this.depth = depth;
    this.depthView = depth.view();
    if (this.samples > 1) {
      let md = new GPUTextureDesc();
      md.width = t.width;
      md.height = t.height;
      md.format = this.format;
      md.renderTarget = true;
      md.sampleCount = this.samples;
      let msaa = new GPUTexture(md);
      this.msaa = msaa;
      this.msaaView = msaa.view();
    }
    this.targetW = t.width;
    this.targetH = t.height;
  }

  /** Runs the passes and puts the image on screen. */
  finish(renderer: Renderer, width: f64, height: f64, scale: f64): void {
    let context = this.context;
    let target: GPUTarget? = context.gpuTarget();
    let direct = target != null && target.view != null;
    if (!direct) {
      let w = <u32>Math.max(1, Math.round(width * scale));
      let h = <u32>Math.max(1, Math.round(height * scale));
      let canvas = this.canvas;
      if (canvas == null || canvas.width != w || canvas.height != h) {
        canvas = context.gpuCanvas(w, h);
        this.canvas = canvas;
      }
      target = canvas;
    }
    if (target == null) return;
    let t = target!;
    if (!this.ready && !this.failed && !this.setup(t)) return;
    if (!this.ready) return;
    this.ensureTargets(t);

    this.frameUbo!.update(0, this.frameData.buffer, FRAME_BYTES);
    if (this.objectCount > 0) this.objectUbo!.update(0, this.objectData.buffer, <u32>this.objectCount * OBJECT_STRIDE);

    // 1. Shadow map.
    let sp = new GPUPassDesc();
    sp.depthView = this.shadowTarget;
    sp.depthLoadOp = LoadOp.clear;
    sp.depthStoreOp = StoreOp.store;
    sp.label = "shadow";
    let shadowPass = t.beginRenderPass(sp);
    shadowPass.setPipeline(this.shadowPipe!);
    shadowPass.setBindGroup(0, this.shadowFrame!);
    for (let i = 0; i < this.draws.length; i++) {
      let d = this.draws[i];
      if (!d.shadow) continue;
      this.offsets[0] = d.slot * OBJECT_STRIDE;
      shadowPass.setBindGroup(1, this.objects!, this.offsets);
      shadowPass.setVertexBuffer(0, d.mesh.vbo);
      shadowPass.setIndexBuffer(d.mesh.ibo, <u32>IndexFormat.uint32);
      shadowPass.drawIndexed(d.count, 1, d.first);
    }
    shadowPass.finish();

    // 2. Lit pass.
    let ca = new GPUColorAttachment();
    ca.loadOp = LoadOp.clear;
    ca.clearR = 0.8; ca.clearG = 0.66; ca.clearB = 0.52; ca.clearA = 1;
    if (this.samples > 1) {
      ca.view = this.msaaView;
      ca.resolveTarget = t.view;
      ca.storeOp = StoreOp.discard;
    } else {
      ca.storeOp = StoreOp.store;
    }
    let mp = new GPUPassDesc();
    mp.color = [ca];
    mp.depthView = this.depthView;
    mp.depthLoadOp = LoadOp.clear;
    mp.label = "lit";
    let pass = t.beginRenderPass(mp);
    pass.setPipeline(this.lit!);
    pass.setBindGroup(0, this.litFrame!);
    for (let i = 0; i < this.draws.length; i++) {
      let d = this.draws[i];
      if (!d.main) continue;
      this.offsets[0] = d.slot * OBJECT_STRIDE;
      pass.setBindGroup(1, this.objects!, this.offsets);
      pass.setVertexBuffer(0, d.mesh.vbo);
      pass.setIndexBuffer(d.mesh.ibo, <u32>IndexFormat.uint32);
      pass.drawIndexed(d.count, 1, d.first);
    }

    // 3. Particles.
    let total = this.smokeCount + this.glowCount;
    if (total > 0) {
      let buf = this.particleBuf!;
      let bytesPer = <u32>(PARTICLE_WORDS * 4);
      if (this.smokeCount > 0) buf.update(0, this.particleData.buffer, <u32>this.smokeCount * bytesPer, 0);
      if (this.glowCount > 0) {
        let start = <u32>(MAX_PARTICLES - this.glowCount) * bytesPer;
        buf.update(start, this.particleData.buffer, <u32>this.glowCount * bytesPer, start);
      }
      if (this.smokeCount > 0) {
        pass.setPipeline(this.smoke!);
        pass.setBindGroup(0, this.fxFrame!);
        pass.setVertexBuffer(0, this.quad!);
        pass.setVertexBuffer(1, buf, 0);
        pass.draw(6, <u32>this.smokeCount);
      }
      if (this.glowCount > 0) {
        pass.setPipeline(this.glow!);
        pass.setBindGroup(0, this.fxFrame!);
        pass.setVertexBuffer(0, this.quad!);
        pass.setVertexBuffer(1, buf, <u32>(MAX_PARTICLES - this.glowCount) * bytesPer);
        pass.draw(6, <u32>this.glowCount);
      }
    }
    pass.finish();

    let canvas = this.canvas;
    if (!direct && canvas != null) {
      renderer.save();
      let k = <f32>(1 / scale);
      renderer.transform(Mat2D.withScale(k, k));
      renderer.drawImage(canvas.image, ImageSampler(), BlendMode.srcOver, 1);
      renderer.restore();
    }
  }
}
