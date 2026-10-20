import * as THREE from 'three';

/**
 * Little people for the set pieces: a crew member in work overalls, built from a
 * few boxes so they read from the chase and cutscene cameras. Original, generic
 * figures (no likenesses). Origin on the ground between the feet, facing +z.
 */
export interface Figure {
  group: THREE.Group;
  /** Shoulder pivots: rotate about x to swing forward, about z to raise sideways (the left arm is on +x). */
  armL: THREE.Group;
  armR: THREE.Group;
  /** Hip pivots. */
  legL: THREE.Group;
  legR: THREE.Group;
  /** Everything above the hips, for leaning. */
  upper: THREE.Group;
}

export interface FigureLook {
  /** Overalls (or shirt) colour. */
  suit: number;
  skin: number;
  /** A hard hat in this colour; none if left out. */
  hat?: number;
  /** Reflective bands round the arms, legs and chest (high-vis overalls). */
  bands?: boolean;
}

const geo = {
  leg: new THREE.BoxGeometry(0.17, 0.86, 0.19).translate(0, -0.43, 0),
  boot: new THREE.BoxGeometry(0.19, 0.12, 0.3).translate(0, -0.86, 0.04),
  torso: new THREE.BoxGeometry(0.46, 0.6, 0.26).translate(0, 0.3, 0),
  arm: new THREE.BoxGeometry(0.12, 0.62, 0.13).translate(0, -0.31, 0),
  hand: new THREE.BoxGeometry(0.1, 0.11, 0.11).translate(0, -0.66, 0),
  head: new THREE.SphereGeometry(0.135, 12, 10).translate(0, 0.78, 0),
  hat: new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.83, 0),
  brim: new THREE.CylinderGeometry(0.2, 0.2, 0.02, 14).translate(0, 0.83, 0.03),
  band: new THREE.BoxGeometry(1, 1, 1),
};

export function buildFigure(look: FigureLook): Figure {
  const suit = new THREE.MeshStandardMaterial({ color: look.suit, roughness: 0.75 });
  const skin = new THREE.MeshStandardMaterial({ color: look.skin, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.8 });
  // Reflective tape catches the light (a little emissive so it shows in the gloom under the overpass).
  const tape = new THREE.MeshStandardMaterial({ color: 0xd8dde0, roughness: 0.3, metalness: 0.5, emissive: 0x6a6e70, emissiveIntensity: 0.6 });
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D) => {
    const x = new THREE.Mesh(g, m);
    x.castShadow = true;
    parent.add(x);
    return x;
  };
  const band = (parent: THREE.Object3D, w: number, d: number, y: number) => {
    const b = mesh(geo.band, tape, parent);
    b.scale.set(w, 0.05, d);
    b.position.y = y;
  };

  const group = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.98;
  group.add(hips);
  const legs: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const leg = new THREE.Group();
    leg.position.x = side * 0.11;
    mesh(geo.leg, suit, leg);
    mesh(geo.boot, dark, leg);
    if (look.bands) band(leg, 0.19, 0.21, -0.62);
    hips.add(leg);
    legs.push(leg);
  }
  const upper = new THREE.Group();
  hips.add(upper);
  mesh(geo.torso, suit, upper);
  if (look.bands) {
    band(upper, 0.48, 0.28, 0.42);
    band(upper, 0.48, 0.28, 0.18);
  }
  const arms: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.3, 0.55, 0);
    mesh(geo.arm, suit, arm);
    mesh(geo.hand, skin, arm);
    if (look.bands) band(arm, 0.14, 0.15, -0.36);
    upper.add(arm);
    arms.push(arm);
  }
  mesh(geo.head, skin, upper);
  if (look.hat !== undefined) {
    const hat = new THREE.MeshStandardMaterial({ color: look.hat, roughness: 0.4 });
    mesh(geo.hat, hat, upper);
    mesh(geo.brim, hat, upper);
  }
  return { group, armL: arms[0], armR: arms[1], legL: legs[0], legR: legs[1], upper };
}

/** Back to standing still, arms down. */
export function stand(f: Figure): void {
  for (const p of [f.armL, f.armR, f.legL, f.legR]) p.rotation.set(0, 0, 0);
  f.upper.rotation.set(0, 0, 0);
  f.group.position.y = 0;
}

/** Waving one arm over the head, `t` seconds in. */
export function wave(f: Figure, t: number, arm: 'L' | 'R' = 'R'): void {
  const a = arm === 'L' ? f.armL : f.armR;
  const s = arm === 'L' ? 1 : -1;
  a.rotation.set(0, 0, s * (2.5 + 0.35 * Math.sin(t * 9)));
}

/** Both arms up, bouncing on the spot (a cheer), `t` seconds in. */
export function cheer(f: Figure, t: number): void {
  const k = Math.abs(Math.sin(t * 7));
  f.armL.rotation.set(0, 0, 2.7 + 0.2 * k);
  f.armR.rotation.set(0, 0, -2.7 - 0.2 * k);
  f.group.position.y = 0.12 * k;
}

/** Beckoning someone on: one arm sweeping forward and back, `t` seconds in. */
export function beckon(f: Figure, t: number): void {
  f.armR.rotation.set(-1.2 - 0.9 * (0.5 + 0.5 * Math.sin(t * 6)), 0, -0.2);
}

/** Bent forward with both hands out low, catching something (`k` 0..1, how far into it). */
export function reach(f: Figure, k: number): void {
  f.upper.rotation.set(0.55 * k, 0, 0);
  f.armL.rotation.set(-1.1 * k, 0, 0.15 * k);
  f.armR.rotation.set(-1.1 * k, 0, -0.15 * k);
  f.group.position.y = -0.08 * k;
}
