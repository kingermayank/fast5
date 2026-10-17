import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * Golden hour: a low sun from the west-southwest, about 24 degrees up. Any
 * lower and, seen from above, nearly every street sits in shadow.
 */
export const SUN_DIR = new THREE.Vector3(-0.596, 0.407, -0.692).normalize();
const HAZE = 0xd9a47c;
/** Haze for the chase camera, and thicker for the overhead view, whose distances are short. */
const FOG_CHASE = 0.0003;
const FOG_OVERHEAD = 0.0018;

/**
 * Tilt-shift: a blur that grows toward the top and bottom of the screen around
 * a sharp band, so the city reads as a miniature (as in the overhead reference).
 * Run twice, across then down; `amount` is the widest blur radius in pixels.
 */
const TiltShiftShader = {
  uniforms: { tDiffuse: { value: null }, delta: { value: new THREE.Vector2() }, focus: { value: 0.5 }, amount: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 delta;
    uniform float focus;
    uniform float amount;
    varying vec2 vUv;
    void main() {
      // Sharp within 0.12 of the focus line, blurred all the way 0.5 from it.
      float r = amount * smoothstep(0.12, 0.5, abs(vUv.y - focus));
      if (r < 0.1) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (int i = -6; i <= 6; i++) {
        float t = float(i) / 6.0;
        float w = exp(-3.0 * t * t);
        sum += texture2D(tDiffuse, vUv + delta * (t * r)) * w;
        total += w;
      }
      gl_FragColor = sum / total;
    }`,
};

/** Warm grade + vignette, applied after tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, vignette: { value: 0.35 }, saturation: { value: 1.12 }, contrast: { value: 1.06 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float vignette;
    uniform float saturation;
    uniform float contrast;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      // Golden-hour grade: shadows toward teal, highlights toward amber, a touch more contrast.
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += mix(vec3(-0.015, 0.012, 0.035), vec3(0.045, 0.015, -0.03), smoothstep(0.15, 0.85, l));
      c.rgb = mix(vec3(l), c.rgb, saturation);
      c.rgb = (c.rgb - 0.5) * contrast + 0.5;
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
  /** The statue on the tall peak (procedural until the model loads). */
  statue: THREE.Group;
  render(): void;
  resize(): void;
  /** Keep the shadow frustum centered on what the camera is looking at. */
  follow(focus: THREE.Vector3): void;
  /**
   * The overhead presentation: tilt-shift sharp around screen height `focus`
   * (0 bottom, 1 top), thicker haze, deeper vignette. Off for the chase camera and cutscenes.
   */
  overhead(on: boolean, focus?: number): void;
}

export function createGraphics(canvas: HTMLCanvasElement): Graphics {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  // Count draw calls and triangles across all post passes (see render()).
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(HAZE, FOG_CHASE);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 9000);

  // Physical sky, also baked into an environment map for reflections.
  const sky = new Sky();
  sky.scale.setScalar(8000);
  const u = sky.material.uniforms;
  u.turbidity.value = 9;
  u.rayleigh.value = 2.6;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(SUN_DIR);
  // The sun disc is ~60000x brighter than the sky, which overflows the half-float render target;
  // bloom then smears infinity over the whole screen whenever you face the sun. Cap it.
  sky.material.fragmentShader = sky.material.fragmentShader.replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( min( texColor, vec3( 1.8 ) ), 1.0 );');
  scene.add(sky);

  // Reflections come from a calibrated gradient sky (the physical sky shader's raw
  // radiance is far too bright to light the scene with), plus a sun hotspot.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(gradientSkyScene(), 0.02).texture;
  scene.environmentIntensity = 0.55;

  // Warm key, cool fill: shadows pick up the blue of the sky, as at golden hour.
  scene.add(new THREE.HemisphereLight(0xa9c2e6, 0x4a3b2e, 0.45));
  const sun = new THREE.DirectionalLight(0xffb27a, 2.5);
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

  const statue = addMountains(scene);

  // Post: MSAA render target, bloom on bright emissives, tone map, grade.
  const size = new THREE.Vector2();
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 2.2);
  composer.addPass(bloom);
  const tiltX = new ShaderPass(TiltShiftShader);
  const tiltY = new ShaderPass(TiltShiftShader);
  tiltX.enabled = tiltY.enabled = false;
  composer.addPass(tiltX);
  composer.addPass(tiltY);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  function resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    renderer.getDrawingBufferSize(size);
    bloom.resolution.set(size.x / 2, size.y / 2);
    tiltX.uniforms.delta.value.set(1 / size.x, 0);
    tiltY.uniforms.delta.value.set(0, 1 / size.y);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    renderer,
    scene,
    camera,
    sun,
    statue,
    resize,
    render: () => {
      renderer.info.reset();
      composer.render();
    },
    follow(focus) {
      sun.position.copy(focus).addScaledVector(SUN_DIR, 250);
      sun.target.position.copy(focus);
    },
    overhead(on, focus = 0.5) {
      for (const pass of [tiltX, tiltY]) {
        pass.enabled = on;
        pass.uniforms.focus.value = focus;
        // About 9 px at 1080p, scaled with the drawing buffer.
        pass.uniforms.amount.value = (9 * size.y) / 1080;
      }
      fog.density = on ? FOG_OVERHEAD : FOG_CHASE;
      // From above there's no bright sky in shot, so open the exposure up and push the colour.
      renderer.toneMappingExposure = on ? 0.98 : 0.8;
      grade.uniforms.vignette.value = on ? 0.45 : 0.35;
      grade.uniforms.saturation.value = on ? 1.28 : 1.12;
      grade.uniforms.contrast.value = on ? 1.1 : 1.06;
    },
  };
}

/** Dome with a warm horizon, blue zenith, dark ground and a bright sun spot. */
function gradientSkyScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 48, 24);
  const colors: number[] = [];
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const horizon = new THREE.Color(1.0, 0.7, 0.48);
  const zenith = new THREE.Color(0.27, 0.44, 0.8);
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
function addMountains(scene: THREE.Scene): THREE.Group {
  // Half the city's fog: at 3 km full haze would turn them flat tan; this way they read as
  // Rio's forested hills seen through warm air.
  const halfFog = (m: THREE.Material) => {
    m.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', '#include <fog_fragment>\n').replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          float fogFactor = 0.55 * (1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`,
      );
    };
    return m;
  };
  const mat = halfFog(new THREE.MeshStandardMaterial({ color: 0x24502a, roughness: 1 }));
  const rock = halfFog(new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.9 }));
  const rand = (() => {
    let s = 11;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  })();
  /**
   * A Rio morro: a steep-sided dome, lumpy, its foot buried in the city. `spire`
   * pinches the top (Corcovado) instead of rounding it (Sugarloaf).
   */
  const peak = (x: number, z: number, r: number, h: number, m: THREE.Material, squash = 1, spire = 0) => {
    const geo = new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const phase = rand() * 10;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      // Steep sides: push the profile out toward a cylinder, then pinch the top for a spire.
      const side = Math.pow(Math.max(0, 1 - py * py), 0.32) / Math.max(1e-3, Math.hypot(px, pz));
      const pinch = 1 - spire * Math.pow(py, 1.5);
      const k = (py < 0.999 ? side : 0) * pinch * (1 + 0.12 * Math.sin(Math.atan2(pz, px) * 3 + phase) * (1 - py));
      pos.setXYZ(i, px * k * r * squash, py * h, pz * k * r);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, -h * 0.12, z);
    scene.add(mesh);
    return mesh;
  };
  // Ring of hills rising out of the far city, all round except the bay to the north-east
  // (the map's middle is about (1000, 600); the bridge runs out into the bay).
  const CX = 1000;
  const CZ = 600;
  for (let a = 0; a < 30; a++) {
    const ang = Math.PI * 0.62 + (a / 30) * Math.PI * 1.55;
    const d = 2900 + rand() * 700;
    const r = 260 + rand() * 260;
    peak(CX + Math.cos(ang) * d, CZ + Math.sin(ang) * d, r, r * (0.7 + rand() * 0.9), mat, 0.8 + rand() * 0.5, rand() * 0.3);
  }
  // Sugarloaf and its smaller twin (Urca) out in the bay, dead ahead as you drive the bridge:
  // bare granite with a cap of forest.
  peak(3500, -2150, 150, 400, rock, 0.75, 0.1);
  peak(3230, -1880, 150, 210, mat, 1.2);
  // Corcovado with the statue on top, south: ahead as you drive down Ponce de León.
  const tall = peak(450, 3500, 420, 820, mat, 0.7, 0.55);
  const statue = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.8 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(6, 26, 5), stone);
  const arms = new THREE.Mesh(new THREE.BoxGeometry(30, 4, 4), stone);
  arms.position.y = 8;
  statue.add(torso, arms);
  statue.position.set(tall.position.x, tall.position.y + 820 + 12, tall.position.z);
  statue.lookAt(CX, statue.position.y, CZ);
  scene.add(statue);
  return statue;
}
