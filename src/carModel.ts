import * as THREE from 'three';

export const WHEEL_RADIUS = 0.42;

export interface CarModelOptions {
  body: number;
  trim: number;
  rim: number;
  police?: boolean;
  /** Matte paint (hero cars) vs glossy (cruisers). */
  matte?: boolean;
}

export interface CarModel {
  group: THREE.Group;
  body: THREE.Group;
  spinners: THREE.Object3D[];
  frontPivots: THREE.Object3D[];
  /** Police light bar materials, flashed by the owner. */
  lightBar?: { red: THREE.MeshStandardMaterial; blue: THREE.MeshStandardMaterial };
  paint: THREE.MeshStandardMaterial;
}

/**
 * Full-size four-door muscle sedan. Origin is on the ground at the car's center,
 * facing +z. Roughly 2.0 m wide, 5.0 m long.
 */
export function buildCarModel(o: CarModelOptions): CarModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
    color: o.body,
    metalness: o.matte ? 0.15 : 0.55,
    roughness: o.matte ? 0.85 : 0.3,
  });
  const trim = new THREE.MeshStandardMaterial({ color: o.trim, metalness: 0.3, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x10161d, metalness: 0.9, roughness: 0.15 });

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    body.add(m);
    return m;
  };

  // Lower body, hood, trunk, cabin.
  add(new THREE.BoxGeometry(2.0, 0.62, 5.0), paint, 0, 0.7, 0);
  add(new THREE.BoxGeometry(1.94, 0.18, 1.7), paint, 0, 1.06, 1.55).rotation.x = 0.06;
  add(new THREE.BoxGeometry(1.94, 0.16, 1.0), paint, 0, 1.06, -2.0);
  add(new THREE.BoxGeometry(1.7, 0.55, 2.2), glass, 0, 1.3, -0.35);
  add(new THREE.BoxGeometry(1.6, 0.06, 1.7), o.police ? paint : trim, 0, 1.6, -0.45);
  // Bumpers and grille.
  add(new THREE.BoxGeometry(2.05, 0.3, 0.2), trim, 0, 0.5, 2.5);
  add(new THREE.BoxGeometry(2.05, 0.3, 0.2), trim, 0, 0.5, -2.5);
  add(new THREE.BoxGeometry(1.3, 0.25, 0.05), new THREE.MeshStandardMaterial({ color: 0x050505 }), 0, 0.85, 2.51);
  if (o.police) {
    // Two-tone: dark doors.
    add(new THREE.BoxGeometry(2.02, 0.5, 2.0), trim, 0, 0.72, -0.2);
  } else {
    // Rear winch frame: the tow point for the vault cable.
    add(new THREE.BoxGeometry(1.4, 0.12, 0.3), trim, 0, 0.45, -2.62);
    add(new THREE.BoxGeometry(0.4, 0.3, 0.35), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.8, roughness: 0.3 }), 0, 0.45, -2.75);
  }

  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2cc, emissiveIntensity: 1.4 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff0000, emissiveIntensity: 1.1 });
  for (const x of [-0.72, 0.72]) {
    add(new THREE.BoxGeometry(0.42, 0.12, 0.05), head, x, 0.86, 2.51);
  }
  add(new THREE.BoxGeometry(1.8, 0.1, 0.05), tail, 0, 0.9, -2.51);

  let lightBar: CarModel['lightBar'];
  if (o.police) {
    const red = new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff0000, emissiveIntensity: 2 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x2244ff, emissive: 0x0033ff, emissiveIntensity: 2 });
    add(new THREE.BoxGeometry(0.6, 0.16, 0.3), red, -0.35, 1.71, -0.2);
    add(new THREE.BoxGeometry(0.6, 0.16, 0.3), blue, 0.35, 1.71, -0.2);
    lightBar = { red, blue };
  }
  group.add(body);

  const tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: o.rim, metalness: 0.8, roughness: 0.35 });
  const tireGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.4, 18).rotateZ(Math.PI / 2);
  const rimGeo = new THREE.BoxGeometry(0.42, 0.55, 0.14);
  const spinners: THREE.Object3D[] = [];
  const frontPivots: THREE.Object3D[] = [];
  for (const [x, z, front] of [
    [-1.0, 1.6, true],
    [1.0, 1.6, true],
    [-1.0, -1.6, false],
    [1.0, -1.6, false],
  ] as const) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_RADIUS, z);
    const spinner = new THREE.Group();
    const t = new THREE.Mesh(tireGeo, tire);
    t.castShadow = true;
    spinner.add(t, new THREE.Mesh(rimGeo, rim));
    pivot.add(spinner);
    group.add(pivot);
    spinners.push(spinner);
    if (front) frontPivots.push(pivot);
  }

  return { group, body, spinners, frontPivots, lightBar, paint };
}
