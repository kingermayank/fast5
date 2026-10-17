import * as THREE from 'three';

/**
 * See-through buildings: from the overhead camera a tower between the camera
 * and the car would hide it, so building surfaces nearer the camera than the
 * player, inside a circle around the player on screen, are dissolved (with a
 * dithered edge). Shadows are unaffected: they're drawn with depth materials.
 */
export const CUTAWAY = {
  /** The player on screen, in drawing-buffer pixels. */
  screen: { value: new THREE.Vector2() },
  /** Circle radius in pixels; 0 turns the cut off. */
  radius: { value: 0 },
  /** The player's distance in front of the camera (m). */
  depth: { value: 0 },
};

const patched = new WeakSet<THREE.Material>();

/** Make `mat` dissolve where it would hide the player. Safe to call more than once. */
export function seeThrough<T extends THREE.Material>(mat: T): T {
  if (patched.has(mat)) return mat;
  patched.add(mat);
  const before = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    before.call(mat, shader, renderer);
    shader.uniforms.cutScreen = CUTAWAY.screen;
    shader.uniforms.cutRadius = CUTAWAY.radius;
    shader.uniforms.cutDepth = CUTAWAY.depth;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCutHeight;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCutHeight = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec2 cutScreen;
        uniform float cutRadius;
        uniform float cutDepth;
        varying float vCutHeight;
        const float CUT_BAYER[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);`,
      )
      .replace(
        'void main() {',
        `void main() {
        // Only what's above head height and in front of the player can hide it.
        if (cutRadius > 0.0 && vCutHeight > 2.5 && vViewPosition.z < cutDepth - 3.0) {
          float k = length(gl_FragCoord.xy - cutScreen) / cutRadius;
          ivec2 b = ivec2(mod(gl_FragCoord.xy, 4.0));
          if (k < 1.0 && (CUT_BAYER[b.x + b.y * 4] + 0.5) / 16.0 > smoothstep(0.65, 1.0, k)) discard;
        }`,
      );
  };
  // Patched and unpatched copies of a material must not share a compiled program.
  const key = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${key()}|cutaway`;
  mat.needsUpdate = true;
  return mat;
}
