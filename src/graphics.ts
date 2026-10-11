import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Low golden-hour sun from the west-southwest. */
export const SUN_DIR = new THREE.Vector3(-0.62, 0.3, -0.72).normalize();
const HAZE = 0xd8b08c;

/** Warm grade + vignette, applied after tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.35 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Lift shadows toward teal, push highlights warm.
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += mix(vec3(-0.01, 0.01, 0.025), vec3(0.03, 0.012, -0.02), smoothstep(0.2, 0.8, l));
      c.rgb = mix(vec3(l), c.rgb, 1.08);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= 1.0 - vignette * smoothstep(0.35, 0.85, d);
      gl_FragColor = c;
    }`,
};

export interface Graphics {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  render(): void;
  resize(): void;
  /** Keep the shadow frustum centered on what the camera is looking at. */
  follow(focus: THREE.Vector3): void;
}

export function createGraphics(canvas: HTMLCanvasElement): Graphics {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.75;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HAZE, 0.00065);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.2, 6000);

  // Physical sky, also baked into an environment map for reflections.
  const sky = new Sky();
  sky.scale.setScalar(5000);
  const u = sky.material.uniforms;
  u.turbidity.value = 7;
  u.rayleigh.value = 2.2;
  u.mieCoefficient.value = 0.006;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(SUN_DIR);
  scene.add(sky);

  // Reflections come from a calibrated gradient sky (the physical sky shader's raw
  // radiance is far too bright to light the scene with), plus a sun hotspot.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(gradientSkyScene(), 0.02).texture;
  scene.environmentIntensity = 0.55;

  scene.add(new THREE.HemisphereLight(0xffd9b8, 0x3b3530, 0.35));
  const sun = new THREE.DirectionalLight(0xffc89a, 2.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 75;
  sun.shadow.camera.left = sun.shadow.camera.bottom = -S;
  sun.shadow.camera.right = sun.shadow.camera.top = S;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 500;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  addMountains(scene);

  // Post: MSAA render target, bloom on bright emissives, tone map, grade.
  const size = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 2.2);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  composer.addPass(new ShaderPass(GradeShader));

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    renderer.getDrawingBufferSize(size);
    bloom.resolution.set(size.x / 2, size.y / 2);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    renderer,
    scene,
    camera,
    sun,
    resize,
    render: () => composer.render(),
    follow(focus) {
      sun.position.copy(focus).addScaledVector(SUN_DIR, 250);
      sun.target.position.copy(focus);
    },
  };
}

/** Dome with a warm horizon, blue zenith, dark ground and a bright sun spot. */
function gradientSkyScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const colors: number[] = [];
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const horizon = new THREE.Color(1.0, 0.78, 0.58);
  const zenith = new THREE.Color(0.32, 0.5, 0.85);
  const ground = new THREE.Color(0.16, 0.14, 0.13);
  const c = new THREE.Color();
  const dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    if (dir.y < 0) c.copy(ground).lerp(horizon, Math.max(0, 1 + dir.y * 8) * 0.4);
    else c.copy(horizon).lerp(zenith, Math.pow(dir.y, 0.6));
    // Brighten toward the sun.
    const sunGlow = Math.pow(Math.max(0, dir.dot(SUN_DIR)), 12);
    c.addScalar(sunGlow * 0.8);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sunSpot = new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(30, 24, 18) }));
  sunSpot.position.copy(SUN_DIR).multiplyScalar(90);
  scene.add(sunSpot);
  return scene;
}

/**
 * Rio's skyline: steep green granite peaks around the city, with a sugarloaf
 * dome and a tall peak carrying a statue silhouette. Far enough to sit in haze.
 */
function addMountains(scene: THREE.Scene): void {
  const mat = new THREE.MeshStandardMaterial({ color: 0x4f6b45, roughness: 1, flatShading: true });
  const rock = new THREE.MeshStandardMaterial({ color: 0x7c7468, roughness: 1, flatShading: true });
  const rand = (() => {
    let s = 11;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  const peak = (x: number, z: number, r: number, h: number, m: THREE.Material, squash = 1) => {
    const geo = new THREE.ConeGeometry(r, h, 14, 6);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const k = 1 + (rand() - 0.5) * 0.25 * (1 - Math.abs(y) / h);
      pos.setXYZ(i, pos.getX(i) * k * squash, y, pos.getZ(i) * k);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, h / 2 - 10, z);
    scene.add(mesh);
    return mesh;
  };
  // Ring of hills behind the city (south, east, west).
  for (let a = 0; a < 26; a++) {
    const ang = Math.PI * 0.55 + (a / 26) * Math.PI * 1.9;
    const d = 950 + rand() * 500;
    peak(250 + Math.cos(ang) * d, 350 + Math.sin(ang) * d, 180 + rand() * 160, 160 + rand() * 260, mat);
  }
  // Sugarloaf-style dome out in the bay, east of the bridge.
  const loaf = new THREE.Mesh(new THREE.SphereGeometry(110, 20, 14), rock);
  loaf.scale.set(0.8, 1.6, 0.9);
  loaf.position.set(1100, 20, 1500);
  scene.add(loaf);
  // Tall peak with the statue on top, southwest.
  const tall = peak(-650, -800, 260, 620, mat, 0.8);
  const statue = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(6, 26, 5), stone);
  const arms = new THREE.Mesh(new THREE.BoxGeometry(30, 4, 4), stone);
  arms.position.y = 8;
  statue.add(torso, arms);
  statue.position.set(tall.position.x, tall.position.y + 310 + 12, tall.position.z);
  statue.lookAt(250, statue.position.y, 350);
  scene.add(statue);
}
