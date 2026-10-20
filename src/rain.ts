import * as THREE from 'three';
import { STREET_LIGHT } from './streetlight';

/** Rain falls through a box this big (m) kept round what the camera looks at, ground to top. */
const BOX = new THREE.Vector3(170, 45, 170);
/** Falling speed (m/s) and the wind's push. */
const FALL = new THREE.Vector3(1.6, -11, 0.9);

const uniforms = {
  time: { value: 0 },
  origin: { value: new THREE.Vector3() },
  box: { value: BOX },
  fall: { value: FALL },
  /** 0 with the rain off (under the overpass), 1 in the open. */
  amount: { value: 1 },
  streetLightMap: STREET_LIGHT.map,
  streetLightCenter: STREET_LIGHT.center,
  streetLightSize: STREET_LIGHT.size,
  streetLightGain: STREET_LIGHT.gain,
};

const lightAt = /* glsl */ `
  uniform sampler2D streetLightMap;
  uniform vec2 streetLightCenter;
  uniform float streetLightSize;
  uniform float streetLightGain;
  vec3 streetLightAt(vec3 w) {
    vec2 uv = vec2(w.x - streetLightCenter.x, streetLightCenter.y - w.z) / streetLightSize + 0.5;
    return texture2D(streetLightMap, uv).rgb * streetLightGain;
  }`;

/**
 * Rain at night, as the overhead reference has it: streaks falling through a
 * box round the camera's view and splashes on the ground, all moved by the GPU
 * from the time alone. Both are faint in the dark and catch whatever light they
 * pass through (they read the street light map), so the rain shows in the lamp
 * pools and the headlight throws.
 */
export class Rain {
  readonly group = new THREE.Group();

  constructor(streaks = 14000, splashes = 2200) {
    this.group.add(this.streaks(streaks), this.splashes(splashes));
  }

  /** Keep the rain round `focus`; `inside` (under the overpass) turns it off. */
  update(dt: number, focus: THREE.Vector3, inside: boolean): void {
    uniforms.time.value += dt;
    uniforms.origin.value.copy(focus);
    uniforms.amount.value += ((inside ? 0 : 1) - uniforms.amount.value) * Math.min(1, dt * 3);
    this.group.visible = uniforms.amount.value > 0.01;
  }

  private streaks(count: number): THREE.Mesh {
    // One quad per drop: corner.x across (-0.5..0.5), corner.y from the head (0) back along its fall (1).
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(randoms(count, 4), 4));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 corner;
        attribute vec4 seed;
        uniform float time;
        uniform vec3 origin;
        uniform vec3 box;
        uniform vec3 fall;
        ${lightAt}
        varying float vAlong;
        varying vec3 vLight;
        void main() {
          float speed = 0.8 + seed.w * 0.45;
          vec3 drift = fall * speed * time;
          // Wrapped into the box round the origin, across; ground to top, down.
          vec2 across = mod(seed.xz * box.xz + drift.xz - origin.xz + box.xz * 0.5, box.xz) - box.xz * 0.5 + origin.xz;
          float y = mod(seed.y * box.y + drift.y, box.y);
          vec3 head = vec3(across.x, y, across.y);
          vec3 dir = normalize(fall);
          vec3 p = head - dir * corner.y * 1.3;
          // Wide enough to cover a pixel or so however far off.
          vec3 toCamera = cameraPosition - p;
          float width = max(0.03, length(toCamera) * 0.0008);
          vec3 side = cross(dir, toCamera);
          p += side / max(length(side), 1e-4) * corner.x * width;
          vAlong = corner.y;
          vLight = 0.02 + streetLightAt(head) * 0.08;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float amount;
        varying float vAlong;
        varying vec3 vLight;
        void main() {
          gl_FragColor = vec4(vLight * (1.0 - vAlong) * amount, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }

  private splashes(count: number): THREE.Mesh {
    // A ring on the ground that opens and fades in a quarter of a second, then comes again somewhere else.
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2));
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Array(12).fill(0), 3));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.setAttribute('seed', new THREE.InstancedBufferAttribute(randoms(count, 3), 3));
    geo.instanceCount = count;
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        attribute vec2 corner;
        attribute vec3 seed;
        uniform float time;
        uniform vec3 origin;
        uniform vec3 box;
        ${lightAt}
        varying vec2 vCorner;
        varying float vAge;
        varying vec3 vLight;
        float hash(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float t = time * 4.0 + seed.z;
          float cycle = floor(t);
          vAge = fract(t);
          vec2 at = vec2(hash(cycle * 12.9898 + seed.x * 78.233), hash(cycle * 39.346 + seed.y * 11.135));
          vec2 xz = origin.xz + (at - 0.5) * box.xz * 0.8;
          float r = 0.05 + vAge * 0.22;
          vec3 p = vec3(xz.x + corner.x * r, 0.09, xz.y + corner.y * r);
          vCorner = corner;
          vLight = 0.02 + streetLightAt(p) * 0.06;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float amount;
        varying vec2 vCorner;
        varying float vAge;
        varying vec3 vLight;
        void main() {
          float d = length(vCorner);
          float ring = smoothstep(0.55, 0.8, d) * (1.0 - smoothstep(0.8, 1.0, d));
          gl_FragColor = vec4(vLight * ring * (1.0 - vAge) * amount, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    return mesh;
  }
}

function randoms(count: number, size: number): Float32Array {
  let s = 4242;
  const out = new Float32Array(count * size);
  for (let i = 0; i < out.length; i++) out[i] = (s = (s * 16807) % 2147483647) / 2147483647;
  return out;
}
