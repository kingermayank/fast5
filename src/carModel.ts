import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const WHEEL_RADIUS = 0.42;

export interface CarModelOptions {
  body: number;
  trim: number;
  rim: number;
  police?: boolean;
  /** Matte paint (the crew's Chargers) vs glossy (cruisers). */
  matte?: boolean;
}

export interface CarModel {
  group: THREE.Group;
  body: THREE.Group;
  spinners: THREE.Object3D[];
  frontPivots: THREE.Object3D[];
  /** Police light bar materials, flashed by the owner. */
  lightBar?: { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  paint: THREE.MeshPhysicalMaterial;
  brake: THREE.MeshStandardMaterial;
}

const WIDTH = 1.9;
const FRONT_AXLE = 1.55;
const REAR_AXLE = -1.5;

/** Side profile (z forward, y up) with wheel arches cut into the sill line. */
function bodyProfile(): THREE.Shape {
  const s = new THREE.Shape();
  const arch = WHEEL_RADIUS + 0.09;
  const sill = 0.36;
  s.moveTo(-2.5, sill);
  // Rear arch, sill, front arch along the bottom (rear to front).
  s.lineTo(REAR_AXLE - arch, sill);
  s.absarc(REAR_AXLE, WHEEL_RADIUS, arch, Math.PI, 0, true);
  s.lineTo(FRONT_AXLE - arch, sill);
  s.absarc(FRONT_AXLE, WHEEL_RADIUS, arch, Math.PI, 0, true);
  s.lineTo(2.48, sill);
  // Nose, hood, cowl.
  s.lineTo(2.56, 0.62);
  s.lineTo(2.5, 0.9);
  s.lineTo(2.2, 0.99);
  s.lineTo(0.95, 1.08);
  // Beltline back to the trunk lid, then the tail.
  s.lineTo(-1.95, 1.1);
  s.lineTo(-2.45, 1.08);
  s.lineTo(-2.56, 0.8);
  s.lineTo(-2.5, sill);
  return s;
}

/** Greenhouse: windshield, roof and fastback rear glass. */
function cabinProfile(): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(0.95, 1.06);
  s.lineTo(0.02, 1.47);
  s.lineTo(-1.12, 1.5);
  s.lineTo(-1.98, 1.08);
  s.lineTo(0.95, 1.06);
  return s;
}

function extrudeX(shape: THREE.Shape, width: number, bevel: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 10,
  });
  // The shape is drawn in (z, y) and extruded along +z; rotate so shape-x becomes
  // world z and the extrusion runs across the car, then center it.
  geo.rotateY(-Math.PI / 2);
  geo.translate((width - bevel * 2) / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

let sharedParts: { body: THREE.BufferGeometry; cabin: THREE.BufferGeometry; roof: THREE.BufferGeometry } | null = null;

function parts() {
  if (!sharedParts) {
    const roofShape = new THREE.Shape();
    roofShape.moveTo(0.05, 1.47);
    roofShape.lineTo(-1.1, 1.5);
    roofShape.lineTo(-1.1, 1.53);
    roofShape.lineTo(0.05, 1.5);
    sharedParts = {
      body: extrudeX(bodyProfile(), WIDTH, 0.08),
      cabin: extrudeX(cabinProfile(), WIDTH - 0.32, 0.06),
      roof: extrudeX(roofShape, WIDTH - 0.3, 0.02),
    };
  }
  return sharedParts;
}

const textCache = new Map<string, THREE.CanvasTexture>();
function doorDecal(text: string): THREE.CanvasTexture {
  let tex = textCache.get(text);
  if (!tex) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#123a8a';
    ctx.fillRect(0, 84, 512, 44);
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, 256, 64);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    textCache.set(text, tex);
  }
  return tex;
}

/**
 * Full-size four-door muscle sedan in the shape of a 2010 Charger: long hood,
 * fast rear glass, full-width "racetrack" tail lamp, crosshair grille.
 * Origin is on the ground at the car's center, facing +z.
 */
export function buildCarModel(o: CarModelOptions): CarModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const p = parts();

  const paint = new THREE.MeshPhysicalMaterial({
    color: o.body,
    metalness: o.matte ? 0.3 : 0.6,
    roughness: o.matte ? 0.55 : 0.25,
    clearcoat: o.matte ? 0.05 : 0.9,
    clearcoatRoughness: 0.2,
  });
  const trim = new THREE.MeshStandardMaterial({ color: o.trim, metalness: 0.4, roughness: 0.6 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0c1218, metalness: 0.9, roughness: 0.05, clearcoat: 1 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 1, roughness: 0.15 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    body.add(m);
    return m;
  };

  add(p.body, paint);
  add(p.cabin, glass);
  add(p.roof, paint);

  // Crosshair grille and lower intake.
  const grille = new THREE.MeshStandardMaterial({ color: 0x050505, metalness: 0.5, roughness: 0.4 });
  add(new THREE.BoxGeometry(1.25, 0.3, 0.06), grille, 0, 0.74, 2.55);
  add(new THREE.BoxGeometry(1.25, 0.04, 0.07), o.police ? chrome : trim, 0, 0.74, 2.56);
  add(new THREE.BoxGeometry(0.04, 0.3, 0.07), o.police ? chrome : trim, 0, 0.74, 2.56);
  add(new THREE.BoxGeometry(1.5, 0.14, 0.06), grille, 0, 0.45, 2.52);
  // Splitter and rear diffuser.
  add(new THREE.BoxGeometry(WIDTH - 0.1, 0.05, 0.25), trim, 0, 0.33, 2.42);
  add(new THREE.BoxGeometry(WIDTH - 0.2, 0.12, 0.2), trim, 0, 0.4, -2.47);
  // Mirrors and door handles.
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.22, 0.12, 0.2), o.police ? paint : trim, side * 1.02, 1.12, 0.75);
    add(new THREE.BoxGeometry(0.03, 0.04, 0.2), chrome, side * 0.96, 0.95, 0.15);
    add(new THREE.BoxGeometry(0.03, 0.04, 0.2), chrome, side * 0.96, 0.95, -0.95);
    // Exhaust tips.
    add(new THREE.CylinderGeometry(0.06, 0.06, 0.15, 10).rotateX(Math.PI / 2), chrome, side * 0.55, 0.4, -2.56);
  }

  // Lights. Emissive intensity above 1 so bloom picks them up.
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 3 });
  const brake = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff1010, emissiveIntensity: 1.2 });
  for (const x of [-0.72, 0.72]) add(new THREE.BoxGeometry(0.42, 0.1, 0.05), head, x, 0.86, 2.53);
  add(new THREE.BoxGeometry(WIDTH - 0.25, 0.12, 0.05), brake, 0, 0.95, -2.54);

  let lightBar: CarModel['lightBar'];
  if (o.police) {
    const decal = new THREE.MeshStandardMaterial({ map: doorDecal('POLÍCIA'), roughness: 0.4 });
    for (const side of [-1, 1]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.5), decal);
      plane.position.set(side * 0.965, 0.72, -0.2);
      plane.rotation.y = (side * Math.PI) / 2;
      body.add(plane);
    }
    const red = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 4 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x000a55, emissive: 0x1a3cff, emissiveIntensity: 4 });
    add(new THREE.BoxGeometry(1.3, 0.06, 0.32), trim, 0, 1.55, -0.55);
    add(new THREE.BoxGeometry(0.6, 0.14, 0.28), red, -0.33, 1.63, -0.55);
    add(new THREE.BoxGeometry(0.6, 0.14, 0.28), blue, 0.33, 1.63, -0.55);
    lightBar = { red, blue };
  } else {
    // Rear winch on a tube frame: the tow point for the vault cable.
    add(new THREE.BoxGeometry(1.3, 0.08, 0.08), chrome, 0, 0.42, -2.62);
    add(new THREE.CylinderGeometry(0.16, 0.16, 0.42, 14).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.9, roughness: 0.3 }), 0, 0.42, -2.74);
  }
  group.add(body);

  // Wheels: tire, five-spoke rim, brake disc.
  const tire = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 });
  const rim = new THREE.MeshStandardMaterial({ color: o.rim, metalness: 0.85, roughness: 0.3 });
  const disc = new THREE.MeshStandardMaterial({ color: 0x55585c, metalness: 0.8, roughness: 0.5 });
  const spinners: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  for (const [x, z, front] of [
    [-0.86, FRONT_AXLE, true],
    [0.86, FRONT_AXLE, true],
    [-0.86, REAR_AXLE, false],
    [0.86, REAR_AXLE, false],
  ] as const) {
    // The crew's cars run fatter drag radials on the rear.
    const width = !front && !o.police ? 0.42 : 0.32;
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_RADIUS, z);
    const spinner = new THREE.Group();
    const t = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, width, 24).rotateZ(Math.PI / 2), tire);
    t.castShadow = true;
    spinner.add(t);
    const out = Math.sign(x) * (width / 2 + 0.005);
    const rimGeo = mergeGeometries(
      [0, 1, 2, 3, 4].map((k): THREE.BufferGeometry =>
        new THREE.BoxGeometry(0.03, 0.27, 0.07).translate(0, 0.13, 0).rotateX((k / 5) * Math.PI * 2).translate(out, 0, 0),
      ).concat([new THREE.CylinderGeometry(0.28, 0.28, 0.03, 20).rotateZ(Math.PI / 2).translate(out * 0.9, 0, 0)]),
    )!;
    spinner.add(new THREE.Mesh(rimGeo, rim));
    spinner.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.04, 16).rotateZ(Math.PI / 2).translate(out * 0.6, 0, 0), disc));
    pivot.add(spinner);
    group.add(pivot);
    spinners.push(spinner);
    if (front) frontPivots.push(pivot);
  }

  return { group, body, spinners, frontPivots, lightBar, paint, brake };
}

/** Hobbs's armored assault truck: tall, angular, slit windows. Origin on the ground, facing +z. */
export function buildArmoredTruck(): THREE.Group {
  const g = new THREE.Group();
  const armor = new THREE.MeshStandardMaterial({ color: 0x2c2f2b, metalness: 0.55, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111312, metalness: 0.3, roughness: 0.7 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x0a0f12, metalness: 0.9, roughness: 0.05 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  };
  const profile = new THREE.Shape();
  profile.moveTo(-3.1, 0.7);
  profile.lineTo(3.1, 0.7);
  profile.lineTo(3.25, 1.5);
  profile.lineTo(2.2, 1.9);
  profile.lineTo(1.4, 2.9);
  profile.lineTo(-3.0, 2.95);
  profile.lineTo(-3.15, 1.5);
  profile.lineTo(-3.1, 0.7);
  add(extrudeX(profile, 2.5, 0.1), armor, 0, 0, 0);
  // Slit windows and windshield.
  add(new THREE.BoxGeometry(2.0, 0.35, 0.05), glass, 0, 2.45, 1.92).rotation.x = -0.9;
  for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.05, 0.3, 1.6), glass, side * 1.26, 2.45, -0.2);
  // Ram bar, roof rack, spare.
  add(new THREE.BoxGeometry(2.6, 0.35, 0.3), dark, 0, 0.9, 3.3);
  add(new THREE.BoxGeometry(2.0, 0.08, 3.0), dark, 0, 3.05, -0.8);
  add(new THREE.CylinderGeometry(0.55, 0.55, 0.35, 20).rotateX(Math.PI / 2), dark, 0, 1.6, -3.3);
  const tire = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
  for (const [x, z] of [[-1.15, 2.0], [1.15, 2.0], [-1.15, -2.0], [1.15, -2.0]]) {
    add(new THREE.CylinderGeometry(0.62, 0.62, 0.5, 22).rotateZ(Math.PI / 2), tire, x, 0.62, z);
  }
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 3 });
  for (const x of [-0.85, 0.85]) add(new THREE.BoxGeometry(0.35, 0.18, 0.05), head, x, 1.45, 3.22);
  return g;
}
