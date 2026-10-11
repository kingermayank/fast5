import * as THREE from 'three';

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
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: softDot() } },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
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
      if (p.pos.y < 0.03 && this.gravity > 0) {
        p.pos.y = 0.03;
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
  private flashes: { light: THREE.PointLight; life: number }[] = [];

  constructor() {
    this.group.add(this.sparks.points, this.dust.points);
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

  update(dt: number): void {
    this.sparks.update(dt);
    this.dust.update(dt);
    for (const f of this.flashes) {
      f.life -= dt;
      f.light.intensity = f.life > 0 ? 60 : 0;
    }
  }
}
