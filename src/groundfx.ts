import * as THREE from 'three';
import type { Path } from './roads';

/** White in the middle, fading to nothing at the edge (alpha carries the falloff). */
function radialTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** A headlight's throw: narrow and bright at the bottom edge (the car), wide and faint at the top. */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(64, 128);
  for (let y = 0; y < 128; y++) {
    const along = 1 - y / 127; // 0 at the car (bottom row), 1 far ahead
    const half = 0.18 + along * 0.82;
    for (let x = 0; x < 64; x++) {
      const across = Math.abs(x / 63 - 0.5) * 2;
      // Full inside the cone, soft at its sides; brightest near the car, fading out ahead.
      const edge = 1 - THREE.MathUtils.smoothstep(across, half * 0.35, half);
      const a = edge * Math.pow(1 - along, 1.6) * THREE.MathUtils.smoothstep(along, 0, 0.1);
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/**
 * A light's reflection on wet asphalt: a narrow streak that starts at the
 * light's foot and runs toward the viewer, brightest near the light. Texture +y
 * runs from the foot (bottom row) to the far tip.
 */
function streakTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(32, 128);
  for (let y = 0; y < 128; y++) {
    const along = 1 - y / 127; // 0 at the foot (bottom row), 1 at the tip
    for (let x = 0; x < 32; x++) {
      const across = Math.abs(x / 31 - 0.5) * 2;
      // Shimmering: the water's ripples break the streak into bands.
      const ripple = 0.75 + 0.25 * Math.sin(along * 38 + Math.sin(along * 9) * 2);
      const a = Math.pow(1 - across, 1.8) * Math.pow(1 - along, 1.4) * THREE.MathUtils.smoothstep(along, 0, 0.06) * ripple;
      const i = (y * 32 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}

/** A soft chevron pointing up the texture (+y), for the route painted on the road. */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'white';
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.moveTo(13, 46);
  ctx.lineTo(32, 20);
  ctx.lineTo(51, 46);
  ctx.stroke();
  return new THREE.CanvasTexture(c);
}

export type LightBar = { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };

/**
 * Parked cruisers with their lights going (props in set pieces), so their
 * strobes light the road too. A retry reloads the page, so this only grows.
 */
export const BEACONS: { at: THREE.Object3D; bar: LightBar }[] = [];

/** One kind of ground decal: flat quads in one instanced draw, refilled every frame. */
class Layer {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(
    private capacity: number,
    material: THREE.MeshBasicMaterial,
    private y: number,
  ) {
    // The road and its markings are pulled toward the camera with polygon offset (against
    // z-fighting); seen from above at a slant that's more than these few centimetres, so pull harder.
    material.polygonOffset = true;
    material.polygonOffsetFactor = -10;
    material.polygonOffsetUnits = -10;
    // A unit quad lying flat, its +y texture axis pointing along +z.
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateY(Math.PI);
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
  }

  begin(): void {
    this.n = 0;
  }

  /** A quad centred at (x, z), `length` along `heading` (a bearing) and `width` across. */
  add(x: number, z: number, heading: number, length: number, width: number, color: THREE.Color): void {
    if (this.n >= this.capacity) return;
    this.q.setFromAxisAngle(this.up, heading);
    this.mesh.setMatrixAt(this.n, this.m.compose(this.p.set(x, this.y, z), this.q, this.s.set(width, 1, length)));
    this.mesh.setColorAt(this.n, color);
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/**
 * Light and shade painted on the ground, which is how lights read from above:
 * pools under street lamps, headlight throws ahead of cars, red and blue
 * strobes round police cars, and soft contact shadows that sit the cars and the
 * vault on the road. Three instanced draws, refilled every frame.
 */
export class GroundFx {
  readonly group = new THREE.Group();
  private glow: Layer;
  private beams: Layer;
  private shade: Layer;
  private streaks: Layer;
  private marks: Layer;
  private c = new THREE.Color();
  /** Bearing from the scene toward the camera, on the ground: where reflections run. */
  private toViewer = 0;

  constructor() {
    const radial = radialTexture();
    // No fog on added light: fogging an additive quad brightens it toward the haze colour.
    const additive = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff, fog: false });
    this.shade = new Layer(64, new THREE.MeshBasicMaterial({ map: radial, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }), 0.075);
    this.glow = new Layer(256, additive(radial), 0.085);
    this.beams = new Layer(64, additive(beamTexture()), 0.09);
    this.streaks = new Layer(384, additive(streakTexture()), 0.088);
    this.marks = new Layer(40, additive(chevronTexture()), 0.092);
    this.group.add(this.shade.mesh, this.glow.mesh, this.beams.mesh, this.streaks.mesh, this.marks.mesh);
  }

  /**
   * Mia's route painted on the road ahead, as in the open-world games: a
   * chevron every 6 m for the next 120 m, with a pulse running along them
   * toward where you're going.
   */
  route(path: Path, time: number): void {
    const len = Math.min(path.length, 120);
    for (let s = 8; s < len; s += 6) {
      const p = path.at(s);
      const t = path.tangent(s);
      const wave = 0.5 + 0.5 * Math.sin(s * 0.32 - time * 6.5);
      const fade = Math.min(1, (len - s) / 24) * Math.min(1, (s - 6) / 8);
      this.marks.add(p.x, p.z, Math.atan2(t.x, t.z), 1.7, 2.3, this.c.set(0xffb547).multiplyScalar((0.22 + 0.62 * wave * wave) * fade));
    }
  }

  /** Where the camera is, so reflections run toward it (call before painting). */
  viewFrom(camera: THREE.Vector3, look: THREE.Vector3): void {
    this.toViewer = Math.atan2(camera.x - look.x, camera.z - look.z);
  }

  /**
   * A light's reflection in the wet road: a streak from its foot toward the
   * viewer, longer the higher the light hangs.
   */
  reflect(at: THREE.Vector3, height: number, color: THREE.ColorRepresentation, intensity: number, width = 0.9): void {
    if (intensity <= 0.01) return;
    const length = 2 + height * 1.9;
    const h = this.toViewer;
    const x = at.x + Math.sin(h) * length * 0.5;
    const z = at.z + Math.cos(h) * length * 0.5;
    this.streaks.add(x, z, h, length, width, this.c.set(color).multiplyScalar(intensity));
  }

  begin(): void {
    this.shade.begin();
    this.glow.begin();
    this.beams.begin();
    this.streaks.begin();
    this.marks.begin();
  }

  /** A round pool of light, `radius` m, `color` scaled by `intensity` (over 1 blooms). */
  pool(at: THREE.Vector3, radius: number, color: THREE.ColorRepresentation, intensity: number): void {
    if (intensity <= 0.01) return;
    this.glow.add(at.x, at.z, 0, radius * 2, radius * 2, this.c.set(color).multiplyScalar(intensity));
  }

  /**
   * Red and blue pools either side of a cruiser, as bright as its light bar is
   * right now (whatever flashes the bar flashes these). `left` is the car's left on the ground.
   */
  strobes(at: THREE.Vector3, left: THREE.Vector3, bar: LightBar): void {
    // A lit bar half runs at emissive 3, an unlit one at 0.2.
    const k = 0.6;
    this.pool(at.clone().addScaledVector(left, 1.8), 5.5, 0xff2233, bar.red.emissiveIntensity * k);
    this.pool(at.clone().addScaledVector(left, -1.8), 5.5, 0x2a5cff, bar.blue.emissiveIntensity * k);
    this.reflect(at.clone().addScaledVector(left, 0.4), 1.6, 0xff2a3a, bar.red.emissiveIntensity * 0.45, 1.3);
    this.reflect(at.clone().addScaledVector(left, -0.4), 1.6, 0x3a66ff, bar.blue.emissiveIntensity * 0.45, 1.3);
  }

  /** A headlight throw from `from` along `heading` (a bearing). */
  beam(from: THREE.Vector3, heading: number, length: number, width: number, color: THREE.ColorRepresentation, intensity: number): void {
    const x = from.x + Math.sin(heading) * length * 0.5;
    const z = from.z + Math.cos(heading) * length * 0.5;
    this.beams.add(x, z, heading, length, width, this.c.set(color).multiplyScalar(intensity));
  }

  /** A soft dark patch under something, `length` along `heading`. */
  shadow(at: THREE.Vector3, heading: number, length: number, width: number): void {
    this.shade.add(at.x, at.z, heading, length, width, this.c.set(0xffffff));
  }

  end(): void {
    this.shade.end();
    this.glow.end();
    this.beams.end();
    this.streaks.end();
    this.marks.end();
  }
}
