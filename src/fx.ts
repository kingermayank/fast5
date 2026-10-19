import * as THREE from 'three';
import { NIGHT } from './look';
import { STREET_LIGHT } from './streetlight';

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  size: number;
}

function softDot(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** A pool of point sprites with simple ballistic motion. */
class ParticlePool {
  readonly points: THREE.Points;
  private particles: Particle[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;

  constructor(
    private capacity: number,
    private color: THREE.Color,
    private gravity: number,
    private drag: number,
    additive: boolean,
    private grow: number,
    /** HDR multiplier so additive sparks trigger bloom. */
    private brightness = 1,
    private opacity = 1,
    /** Falling particles bounce off this height (the road); -Infinity: they fall on through. */
    private floor = 0.03,
  ) {
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    // Glowing particles (sparks, nitrous, glass glints) are their own light; smoke, dust and spray
    // are lit: by the street light map where they drift through it, and faintly by the night.
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: softDot() },
        lit: { value: additive ? 0 : 1 },
        ambient: { value: NIGHT ? 0.16 : 1 },
        streetLightMap: STREET_LIGHT.map,
        streetLightCenter: STREET_LIGHT.center,
        streetLightSize: STREET_LIGHT.size,
        streetLightGain: STREET_LIGHT.gain,
      },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        uniform float lit;
        uniform float ambient;
        uniform sampler2D streetLightMap;
        uniform vec2 streetLightCenter;
        uniform float streetLightSize;
        uniform float streetLightGain;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          if (lit > 0.5) {
            vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
            vec2 uv = vec2(w.x - streetLightCenter.x, streetLightCenter.y - w.z) / streetLightSize + 0.5;
            vec3 light = texture2D(streetLightMap, uv).rgb * streetLightGain * 0.12;
            vColor = color * (ambient + light);
          }
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 300.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): void {
    if (this.particles.length >= this.capacity) this.particles.shift();
    this.particles.push({ pos: pos.clone(), vel: vel.clone(), life, maxLife: life, size });
  }

  update(dt: number): void {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps.splice(i, 1);
        continue;
      }
      p.vel.y -= this.gravity * dt;
      p.vel.multiplyScalar(1 - this.drag * dt);
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < this.floor && this.gravity > 0) {
        p.pos.y = this.floor;
        p.vel.y *= -0.3;
        p.vel.x *= 0.6;
        p.vel.z *= 0.6;
      }
      p.size += this.grow * dt;
    }
    for (let i = 0; i < this.capacity; i++) {
      const p = ps[i];
      if (!p) {
        this.sizes[i] = 0;
        continue;
      }
      const k = p.life / p.maxLife;
      this.positions.set([p.pos.x, p.pos.y, p.pos.z], i * 3);
      const b = this.brightness;
      this.colors.set([this.color.r * b, this.color.g * b, this.color.b * b], i * 3);
      this.alphas[i] = k * this.opacity;
      this.sizes[i] = p.size;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
  }
}

/** Sparks, dust and muzzle flashes. */
export class Effects {
  readonly group = new THREE.Group();
  private sparks = new ParticlePool(900, new THREE.Color(1.0, 0.55, 0.15), 14, 1.5, true, -0.1, 5);
  private dust = new ParticlePool(300, new THREE.Color(0.42, 0.38, 0.34), -0.6, 1.2, false, 2.2, 1, 0.55);
  private smoke = new ParticlePool(500, new THREE.Color(0.78, 0.78, 0.8), -1.2, 1.8, false, 2.6, 1, 0.38);
  private glass = new ParticlePool(700, new THREE.Color(0.75, 0.9, 1.0), 16, 0.6, true, 0, 3);
  private cash = new ParticlePool(500, new THREE.Color(0.45, 0.75, 0.45), 1.6, 2.5, false, 0, 1, 1);
  private nos = new ParticlePool(300, new THREE.Color(0.35, 0.55, 1.0), -0.5, 3, true, 1.5, 6);
  /** Spray thrown up off the bay (it falls back through the surface). */
  private water = new ParticlePool(500, new THREE.Color(0.86, 0.93, 1.0), 13, 0.45, false, 1.1, 1.25, 0.9, -Infinity);
  readonly skids = new SkidMarks();
  private flashes: { light: THREE.PointLight; life: number }[] = [];

  constructor() {
    this.group.add(this.sparks.points, this.dust.points, this.smoke.points, this.glass.points, this.cash.points, this.nos.points, this.water.points, this.skids.mesh);
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffb060, 0, 18, 2);
      this.group.add(light);
      this.flashes.push({ light, life: 0 });
    }
  }

  /** Steel dragging on asphalt: a fan of sparks from a point, thrown backward. */
  scrape(at: THREE.Vector3, velocity: THREE.Vector3, intensity: number): void {
    const n = Math.min(6, Math.ceil(intensity * 3));
    for (let i = 0; i < n; i++) {
      const v = velocity.clone().multiplyScalar(-0.25 - Math.random() * 0.3);
      v.x += (Math.random() - 0.5) * 6;
      v.z += (Math.random() - 0.5) * 6;
      v.y = 1.5 + Math.random() * 4;
      this.sparks.emit(at, v, 0.25 + Math.random() * 0.4, 0.12 + Math.random() * 0.1);
    }
  }

  /** Impact: burst of sparks and a puff of dust. */
  burst(at: THREE.Vector3, power = 1): void {
    for (let i = 0; i < 40 * power; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 16, Math.random() * 9, (Math.random() - 0.5) * 16);
      this.sparks.emit(at, v, 0.3 + Math.random() * 0.6, 0.15);
    }
    this.puff(at, 10 * power);
  }

  puff(at: THREE.Vector3, count = 4): void {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 4, 0.5 + Math.random() * 1.5, (Math.random() - 0.5) * 4);
      this.dust.emit(at.clone().add(new THREE.Vector3(0, 0.5, 0)), v, 1.2 + Math.random(), 1.5 + Math.random());
    }
  }

  /** Gunfire flash: a short-lived point light and a few sparks. */
  muzzle(at: THREE.Vector3): void {
    const f = this.flashes.find((x) => x.life <= 0) ?? this.flashes[0];
    f.light.position.copy(at);
    f.life = 0.06;
    for (let i = 0; i < 6; i++) {
      this.sparks.emit(at, new THREE.Vector3((Math.random() - 0.5) * 6, Math.random() * 2, (Math.random() - 0.5) * 6), 0.08, 0.35);
    }
  }

  /** White tire smoke from a spinning or sliding wheel. */
  tireSmoke(at: THREE.Vector3, intensity: number, drift = new THREE.Vector3()): void {
    const n = Math.random() < intensity ? 1 + Math.floor(intensity * 1.5) : 0;
    for (let i = 0; i < n; i++) {
      const v = drift.clone().multiplyScalar(0.2).add(new THREE.Vector3((Math.random() - 0.5) * 2, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 2));
      this.smoke.emit(at.clone().setY(0.35), v, 1.4 + Math.random() * 1.4, 1.2 + Math.random() * 0.8);
    }
  }

  /** A pane of glass exploding into shards. */
  shatter(at: THREE.Vector3, push: THREE.Vector3, count = 50): void {
    for (let i = 0; i < count; i++) {
      const v = push.clone().multiplyScalar(0.4 + Math.random() * 0.5).add(new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8));
      const p = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.5, Math.random() * 4, (Math.random() - 0.5) * 1.5));
      this.glass.emit(p, v, 0.6 + Math.random() * 0.9, 0.06 + Math.random() * 0.08);
    }
  }

  /** Banknotes thrown into the air, fluttering down slowly. */
  money(at: THREE.Vector3, count = 120): void {
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3((Math.random() - 0.5) * 10, 3 + Math.random() * 8, (Math.random() - 0.5) * 10);
      this.cash.emit(at.clone().add(new THREE.Vector3(0, 1.5, 0)), v, 3 + Math.random() * 3, 0.12 + Math.random() * 0.06);
    }
  }

  /** Something heavy hitting the water: a column and a crown of spray, and mist rolling off it. */
  splash(at: THREE.Vector3, power = 1): void {
    for (let i = 0; i < 160 * power; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      const v = new THREE.Vector3(Math.cos(a) * (1 + r * 6), 7 + Math.random() * 11 * (1 - r * 0.6), Math.sin(a) * (1 + r * 6));
      const p = at.clone().add(new THREE.Vector3(Math.cos(a) * r * 2, 0.2, Math.sin(a) * r * 2));
      this.water.emit(p, v, 0.9 + Math.random() * 1.1, 0.22 + Math.random() * 0.35);
    }
    for (let i = 0; i < 14 * power; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(a) * 3, 0.6 + Math.random(), Math.sin(a) * 3);
      this.smoke.emit(at.clone().add(new THREE.Vector3(Math.cos(a) * 2, 0.4, Math.sin(a) * 2)), v, 1.8 + Math.random(), 1.6 + Math.random());
    }
  }

  /** Blue nitrous flame from an exhaust, thrown backwards. */
  nosFlame(at: THREE.Vector3, backward: THREE.Vector3): void {
    for (let i = 0; i < 3; i++) {
      const v = backward.clone().multiplyScalar(8 + Math.random() * 6).add(new THREE.Vector3((Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1));
      this.nos.emit(at, v, 0.08 + Math.random() * 0.08, 0.35 + Math.random() * 0.2);
    }
  }

  update(dt: number): void {
    this.sparks.update(dt);
    this.dust.update(dt);
    this.smoke.update(dt);
    this.glass.update(dt);
    this.cash.update(dt);
    this.nos.update(dt);
    this.water.update(dt);
    for (const f of this.flashes) {
      f.life -= dt;
      f.light.intensity = f.life > 0 ? 60 : 0;
    }
  }
}

/** Dark rubber marks laid on the road by sliding or spinning tires (ring buffer of quads). */
export class SkidMarks {
  readonly mesh: THREE.InstancedMesh;
  private next = 0;
  private last = new Map<string, THREE.Vector3>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();

  constructor(private capacity = 1200) {
    const geo = new THREE.PlaneGeometry(0.32, 1).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0x0b0b0b, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, hidden);
  }

  /** Extend the mark for tire `key` to `p`. Call with null to lift the tire. */
  mark(key: string, p: THREE.Vector3 | null): void {
    if (!p) {
      this.last.delete(key);
      return;
    }
    const prev = this.last.get(key);
    const at = p.clone().setY(0.03);
    if (prev) {
      const d = at.distanceTo(prev);
      if (d < 0.4) return;
      if (d < 4) {
        const mid = prev.clone().add(at).multiplyScalar(0.5);
        this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.atan2(at.x - prev.x, at.z - prev.z));
        this.s.set(1, 1, d);
        this.m.compose(mid, this.q, this.s);
        this.mesh.setMatrixAt(this.next, this.m);
        this.next = (this.next + 1) % this.capacity;
        this.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.last.set(key, at);
  }
}
