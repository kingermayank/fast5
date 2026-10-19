import * as THREE from 'three';

/**
 * The city's own lights, seen from above: street lamps, headlights, tail
 * lights, strobes, the searchlight, sparks. Each frame GroundFx splats them as
 * soft shapes into a top-down light map around the camera, and every lit
 * surface reads that map as one more light shining down on it. So a lamp's
 * pool lights the asphalt's texture instead of glowing on top of it, a
 * cruiser's strobes wash over the cars beside it, the base of a facade picks
 * up the lamps in front of it, and wet ground catches all of it as a sheen.
 */
export const STREET_LIGHT = {
  map: { value: null as THREE.Texture | null },
  /** World x, z of the map's middle. */
  center: { value: new THREE.Vector2() },
  /** Width of the square it covers (m). */
  size: { value: 400 },
  /** Splat brightness to light: a splat of 1 is about a lamp's pool. */
  gain: { value: 1 },
};

export class StreetLight {
  /** What's drawn into the map (GroundFx adds its light layers here). */
  readonly scene = new THREE.Scene();
  private target: THREE.WebGLRenderTarget;
  private camera: THREE.OrthographicCamera;
  private clear = new THREE.Color();

  constructor(
    private size = 400,
    private resolution = 1024,
  ) {
    this.target = new THREE.WebGLRenderTarget(resolution, resolution, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.colorSpace = THREE.NoColorSpace;
    const h = size / 2;
    this.camera = new THREE.OrthographicCamera(-h, h, h, -h, 1, 400);
    // Straight down, with the map's up toward -z: u runs with x, v against z.
    this.camera.up.set(0, 0, -1);
    STREET_LIGHT.map.value = this.target.texture;
    STREET_LIGHT.size.value = size;
  }

  /** Draw the map around `focus`, moved in whole texels so it doesn't crawl. */
  render(renderer: THREE.WebGLRenderer, focus: THREE.Vector3): void {
    const texel = this.size / this.resolution;
    const x = Math.round(focus.x / texel) * texel;
    const z = Math.round(focus.z / texel) * texel;
    this.camera.position.set(x, 200, z);
    this.camera.lookAt(x, 0, z);
    STREET_LIGHT.center.value.set(x, z);
    const before = renderer.getRenderTarget();
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clear);
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(before);
    renderer.setClearColor(this.clear, alpha);
  }
}

/** How many lamps the wet road mirrors at once (the nearest to what the camera looks at). */
export const GLINT_LAMPS = 24;

/** The lamps the wet road mirrors this frame: their heads, how many, and their light. */
export const GLINTS = {
  heads: { value: Array.from({ length: GLINT_LAMPS }, () => new THREE.Vector3()) },
  count: { value: 0 },
  color: { value: new THREE.Color(0xffd09a).multiplyScalar(260) },
};

/**
 * Wet ground that mirrors the street lamps: each nearby lamp as a true point
 * light, specular only (the street light map already lights it), so a puddle
 * shows the lamp's reflection where the eye expects it and damp asphalt a soft
 * sheen round it.
 */
export function mirrorsLamps<T extends THREE.Material>(mat: T): T {
  const before = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer);
    shader.uniforms.glintHeads = GLINTS.heads;
    shader.uniforms.glintCount = GLINTS.count;
    shader.uniforms.glintColor = GLINTS.color;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 glintHeads[ ${GLINT_LAMPS} ];
        uniform int glintCount;
        uniform vec3 glintColor;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `for ( int i = 0; i < ${GLINT_LAMPS}; i ++ ) {
          if ( i >= glintCount ) break;
          vec3 toLamp = glintHeads[ i ] - vStreetPos;
          float d2 = dot( toLamp, toLamp );
          if ( d2 > 2500.0 ) continue;
          vec3 l = normalize( ( viewMatrix * vec4( toLamp, 0.0 ) ).xyz );
          float nl = saturate( dot( geometryNormal, l ) );
          // A lamp head has size, and rain stirs the puddles: no reflection is pin-sharp.
          PhysicalMaterial wet = material;
          wet.roughness = max( wet.roughness, 0.2 );
          reflectedLight.directSpecular += nl * glintColor / max( d2, 9.0 ) * BRDF_GGX( l, geometryViewDir, geometryNormal, wet );
        }
        #include <lights_fragment_end>`,
      );
  };
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|glints`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Every MeshStandardMaterial (and MeshPhysicalMaterial) in the game takes the
 * map as a light from above, tilted toward a wall's face so facades catch the
 * lamps in front of them, and fading out up the walls. It's the default
 * onBeforeCompile, so it reaches every such material however it was made; a
 * material with its own onBeforeCompile gets it by calling the one it
 * replaced (as seeThrough does).
 */
export function installStreetLight(): void {
  THREE.Material.prototype.onBeforeCompile = function streetLit(this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms) {
    if (!(this as THREE.MeshStandardMaterial).isMeshStandardMaterial) return;
    shader.uniforms.streetLightMap = STREET_LIGHT.map;
    shader.uniforms.streetLightCenter = STREET_LIGHT.center;
    shader.uniforms.streetLightSize = STREET_LIGHT.size;
    shader.uniforms.streetLightGain = STREET_LIGHT.gain;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vStreetPos;').replace(
      '#include <worldpos_vertex>',
      `#include <worldpos_vertex>
      vec4 streetPos = vec4( transformed, 1.0 );
      #ifdef USE_BATCHING
        streetPos = batchingMatrix * streetPos;
      #endif
      #ifdef USE_INSTANCING
        streetPos = instanceMatrix * streetPos;
      #endif
      vStreetPos = ( modelMatrix * streetPos ).xyz;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform sampler2D streetLightMap;
        uniform vec2 streetLightCenter;
        uniform float streetLightSize;
        uniform float streetLightGain;
        varying vec3 vStreetPos;`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `{
          vec2 slUV = vec2( vStreetPos.x - streetLightCenter.x, streetLightCenter.y - vStreetPos.z ) / streetLightSize + 0.5;
          vec2 slEdge = abs( slUV - 0.5 );
          // Fades out toward the map's edge, and up the walls (the lamps hang at about 7 m).
          float slFade = ( 1.0 - smoothstep( 0.4, 0.5, max( slEdge.x, slEdge.y ) ) ) * ( 1.0 - smoothstep( 2.0, 11.0, vStreetPos.y ) );
          vec3 slColor = texture2D( streetLightMap, slUV ).rgb * ( streetLightGain * slFade );
          if ( slColor.r + slColor.g + slColor.b > 0.0003 ) {
            vec3 slNormal = inverseTransformDirection( geometryNormal, viewMatrix );
            IncidentLight slLight;
            slLight.direction = normalize( ( viewMatrix * vec4( normalize( vec3( slNormal.x * 0.7, 1.0, slNormal.z * 0.7 ) ), 0.0 ) ).xyz );
            slLight.color = slColor;
            slLight.visible = true;
            RE_Direct( slLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
          }
        }
        #include <lights_fragment_end>`,
      );
  };
}
