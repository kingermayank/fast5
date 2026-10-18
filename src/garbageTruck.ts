import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/*
 * The swap truck: a city rear-loader garbage truck in a made-up livery (CIDADE
 * LIMPA, "clean city"). Its packer body is wide and empty enough to swallow the
 * vault; the rear hopper lifts on two rams like a jaw, and a steel ramp drops
 * from the sill to the road. Laid out in the truck's frame: origin on the ground
 * at its middle, facing +z.
 */

/** The packer body: its open back (the sill), front, outer half-width and top. */
export const BODY_BACK = -3.6;
const BODY_FRONT = 2.9;
const BODY_HW = 1.75;
const BODY_TOP = 4.1;
/** The body's floor, where the ramp is hinged (m up). */
export const FLOOR = 1.1;
export const RAMP_LENGTH = 4.6;
/** The ramp's foot on the road (z, truck frame) when it's down. */
export const RAMP_FOOT = BODY_BACK - Math.sqrt(RAMP_LENGTH ** 2 - FLOOR ** 2);
/** Where the vault comes to rest inside (its centre, z). */
export const INSIDE = BODY_BACK + 1.95;
/** The rear riding steps (x, z) the crew stand on; the left one is on +x. */
export const STEP = { x: BODY_HW + 0.25, z: BODY_BACK - 0.25, y: 0.55 };
/** Front bumper (z), for clearances. */
export const FRONT = 5.7;
const WHEEL_R = 0.56;
/** How far the hopper swings up when open (rad). */
const HOPPER_OPEN = 1.45;

function liveryTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 384;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1f6f6a';
  ctx.fillRect(0, 0, 1024, 384);
  // A lime stripe along the bottom and a thin white one above it.
  ctx.fillStyle = '#b5d334';
  ctx.fillRect(0, 300, 1024, 54);
  ctx.fillStyle = '#f2f4f0';
  ctx.fillRect(0, 286, 1024, 8);
  // The badge: a white disc with a two-tone leaf.
  ctx.fillStyle = '#f2f4f0';
  ctx.beginPath();
  ctx.arc(170, 150, 96, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1f6f6a';
  ctx.beginPath();
  ctx.moveTo(118, 206);
  ctx.bezierCurveTo(108, 120, 170, 76, 232, 88);
  ctx.bezierCurveTo(236, 156, 190, 214, 118, 206);
  ctx.fill();
  ctx.strokeStyle = '#b5d334';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(122, 202);
  ctx.quadraticCurveTo(170, 150, 222, 98);
  ctx.stroke();
  ctx.fillStyle = '#f2f4f0';
  ctx.font = 'bold 92px Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('CIDADE', 300, 112);
  ctx.fillText('LIMPA', 300, 206);
  ctx.font = '36px Arial, sans-serif';
  ctx.fillStyle = '#cfe7e3';
  ctx.fillText('coleta urbana  •  turno da noite', 300, 262);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Red and white reflective chevrons for the back of the hopper. */
function chevronTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e8ecef';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#c4161c';
  for (let x = -64; x < 256; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 64);
    ctx.lineTo(x + 32, 0);
    ctx.lineTo(x + 64, 0);
    ctx.lineTo(x + 32, 64);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Static parts, merged per material so the whole truck is a few draw calls. */
class PartList {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z));
    // Merged geometries need the same attributes.
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    const list = this.parts.get(mat) ?? [];
    list.push(g);
    this.parts.set(mat, list);
  }
  build(parent: THREE.Object3D): void {
    for (const [mat, list] of this.parts) {
      const m = new THREE.Mesh(mergeGeometries(list)!, mat);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
    }
  }
}

export class GarbageTruck {
  readonly group = new THREE.Group();
  /** Everything on the springs (cab, body, hopper), pitched for a lurch. */
  private sprung = new THREE.Group();
  private hopper = new THREE.Group();
  private ramp = new THREE.Group();
  private wheels: THREE.Object3D[] = [];
  private rams: { sleeve: THREE.Mesh; rod: THREE.Mesh; base: THREE.Vector3; side: number }[] = [];
  private beacons: THREE.MeshStandardMaterial[] = [];
  private workLight: THREE.MeshStandardMaterial;
  private brakeLamps: THREE.MeshStandardMaterial;
  private time = 0;
  private kick = 0;
  private kickV = 0;
  /** How far open the hopper is (1 up, 0 shut) and the ramp is down (1 on the road, 0 stowed). */
  hopperOpen = 1;
  rampDown = 1;
  /** The amber beacons turn (a working truck, nothing to see). */
  beaconsOn = true;

  constructor() {
    const white = new THREE.MeshStandardMaterial({ color: 0xeef0ec, roughness: 0.45, metalness: 0.2 });
    const teal = new THREE.MeshStandardMaterial({ color: 0x1f6f6a, roughness: 0.55, metalness: 0.25 });
    const livery = new THREE.MeshStandardMaterial({ map: liveryTexture(), roughness: 0.5, metalness: 0.2 });
    const chevrons = new THREE.MeshStandardMaterial({ map: chevronTexture(), roughness: 0.35, emissive: 0x2a0a0a, emissiveIntensity: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.85 });
    const grime = new THREE.MeshStandardMaterial({ color: 0x24271f, roughness: 0.95, side: THREE.DoubleSide });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.35 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 1, roughness: 0.15 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0c1218, metalness: 0.9, roughness: 0.1 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 });
    const hub = new THREE.MeshStandardMaterial({ color: 0x6d7276, metalness: 0.7, roughness: 0.4 });
    const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4dd, emissiveIntensity: 2.4 });
    this.brakeLamps = new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2a1a, emissiveIntensity: 1.4 });
    this.workLight = new THREE.MeshStandardMaterial({ color: 0x2a2620, emissive: 0xffd8a0, emissiveIntensity: 2.2 });

    this.group.add(this.sprung);
    const fixed = new PartList();
    const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);

    // Chassis rails, fuel tank and bumpers.
    fixed.add(box(1.1, 0.32, 9.2), dark, 0, 0.78, 0.6);
    fixed.add(new THREE.CylinderGeometry(0.32, 0.32, 1.3, 14), steel, -1.25, 0.82, 1.9, 0, 0, Math.PI / 2);
    fixed.add(box(2.7, 0.32, 0.35), dark, 0, 0.62, FRONT - 0.15);

    // The cab: cab-over, white, with a dark grille and a big windscreen.
    const cabBack = 3.15;
    const cabLen = FRONT - 0.3 - cabBack;
    const cabMid = cabBack + cabLen / 2;
    fixed.add(box(2.62, 1.2, cabLen), white, 0, 1.45, cabMid);
    fixed.add(box(2.6, 1.15, cabLen - 0.25), white, 0, 2.62, cabMid - 0.1);
    fixed.add(box(2.56, 0.12, cabLen - 0.4), white, 0, 3.24, cabMid - 0.15);
    fixed.add(box(2.3, 0.95, 0.05), glass, 0, 2.6, FRONT - 0.42, -0.12);
    for (const s of [-1, 1]) {
      fixed.add(box(0.05, 0.75, 1.2), glass, s * 1.31, 2.62, cabMid + 0.15);
      // Mirror arms and heads.
      fixed.add(box(0.5, 0.05, 0.05), dark, s * 1.5, 2.55, FRONT - 0.55);
      fixed.add(box(0.12, 0.55, 0.25), dark, s * 1.78, 2.35, FRONT - 0.55);
      fixed.add(box(0.42, 0.2, 0.05), head, s * 0.85, 1.25, FRONT - 0.29);
      fixed.add(box(0.06, 0.6, 0.06), chrome, s * 1.05, 1.7, cabBack - 0.05);
    }
    fixed.add(box(1.5, 0.55, 0.06), dark, 0, 1.35, FRONT - 0.29);
    // A teal band round the cab, under the windows.
    fixed.add(box(2.64, 0.16, cabLen + 0.02), teal, 0, 2.02, cabMid);

    // The packer body: an open-backed shell (walls, roof, floor, bulkhead), dark inside.
    const len = BODY_FRONT - BODY_BACK;
    const mid = (BODY_FRONT + BODY_BACK) / 2;
    const tall = BODY_TOP - FLOOR + 0.1;
    for (const s of [-1, 1]) {
      // Outer skin with the livery, an inner grimy face, ribs.
      const side = new THREE.Mesh(new THREE.PlaneGeometry(len, tall), livery);
      side.position.set(s * (BODY_HW + 0.01), FLOOR + tall / 2 - 0.05, mid);
      side.rotation.y = (s * Math.PI) / 2;
      side.castShadow = side.receiveShadow = true;
      this.sprung.add(side);
      fixed.add(box(0.1, tall, len), teal, s * (BODY_HW - 0.05), FLOOR + tall / 2 - 0.05, mid);
      fixed.add(new THREE.PlaneGeometry(len, tall), grime, s * (BODY_HW - 0.11), FLOOR + tall / 2 - 0.05, mid, 0, (-s * Math.PI) / 2, 0);
      for (const z of [-2.6, -1.1, 0.4, 1.9]) fixed.add(box(0.06, tall - 0.2, 0.12), white, s * (BODY_HW + 0.03), FLOOR + tall / 2 - 0.05, z);
    }
    fixed.add(box(BODY_HW * 2, 0.14, len), teal, 0, BODY_TOP, mid);
    fixed.add(new THREE.PlaneGeometry(BODY_HW * 2 - 0.2, len), grime, 0, BODY_TOP - 0.08, mid, Math.PI / 2, 0, 0);
    fixed.add(box(BODY_HW * 2, 0.12, len), steel, 0, FLOOR - 0.06, mid);
    fixed.add(box(BODY_HW * 2, tall, 0.12), teal, 0, FLOOR + tall / 2 - 0.05, BODY_FRONT - 0.06);
    fixed.add(new THREE.PlaneGeometry(BODY_HW * 2 - 0.2, tall - 0.1), grime, 0, FLOOR + tall / 2 - 0.05, BODY_FRONT - 0.13);
    // Under the body: a valance down to the chassis, so you can't see through.
    for (const s of [-1, 1]) fixed.add(box(0.06, 0.45, len - 0.4), dark, s * (BODY_HW - 0.2), FLOOR - 0.3, mid);
    // The work lamp under the roof, lighting the inside.
    const lamp = new THREE.Mesh(box(1.4, 0.05, 0.35), this.workLight);
    lamp.position.set(0, BODY_TOP - 0.12, BODY_BACK + 1.2);
    this.sprung.add(lamp);

    // Rear riding steps and grab handles on the body's back corners.
    for (const s of [-1, 1]) {
      fixed.add(box(0.5, 0.06, 0.45), steel, s * STEP.x, STEP.y, STEP.z);
      fixed.add(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 8), chrome, s * (STEP.x + 0.12), 1.55, STEP.z + 0.2);
      fixed.add(box(0.25, 0.3, 0.05), this.brakeLamps, s * (BODY_HW - 0.2), 0.95, BODY_BACK - 0.02);
    }

    fixed.build(this.sprung);

    // Amber beacons on the cab roof.
    for (const s of [-1, 1]) {
      const m = new THREE.MeshStandardMaterial({ color: 0x5a3200, emissive: 0xffa21a, emissiveIntensity: 3 });
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.22, 12), m);
      b.position.set(s * 0.9, 3.42, cabBack + 0.4);
      this.sprung.add(b);
      this.beacons.push(m);
    }

    // The hopper: hinged along the top of the body's open back, swinging up to open.
    this.hopper.position.set(0, BODY_TOP, BODY_BACK);
    this.sprung.add(this.hopper);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(-1.55, -0.22);
    shape.lineTo(-1.78, -2.2);
    shape.lineTo(-1.35, -2.95);
    shape.lineTo(0, -BODY_TOP + FLOOR);
    shape.lineTo(0, 0);
    const shell = new THREE.ExtrudeGeometry(shape, { depth: BODY_HW * 2, bevelEnabled: false });
    // Drawn in (z, y), extruded along +z: turn so the extrusion runs across the truck.
    shell.rotateY(-Math.PI / 2);
    shell.translate(BODY_HW, 0, 0);
    shell.computeVertexNormals();
    const hop = new PartList();
    hop.add(shell, teal, 0, 0, 0);
    hop.add(box(BODY_HW * 2 - 0.2, 0.5, 0.04), chevrons, 0, -2.05, -1.8, 0.11);
    for (const s of [-1, 1]) hop.add(box(0.28, 0.16, 0.05), this.brakeLamps, s * 1.35, -1.6, -1.76, 0.11);
    // The dark face it shows the street when it's up.
    hop.add(new THREE.PlaneGeometry(BODY_HW * 2 - 0.15, BODY_TOP - FLOOR - 0.15), grime, 0, -(BODY_TOP - FLOOR) / 2, 0.02);
    hop.build(this.hopper);

    // The rams: a sleeve on the body's side, a chrome rod out to the hopper.
    for (const s of [-1, 1]) {
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 10), dark);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8), chrome);
      sleeve.castShadow = rod.castShadow = true;
      this.sprung.add(sleeve, rod);
      this.rams.push({ sleeve, rod, base: new THREE.Vector3(s * (BODY_HW + 0.14), 1.7, BODY_BACK + 0.9), side: s });
    }

    // The ramp: hinged at the sill, a ribbed steel plate with side rails.
    this.ramp.position.set(0, FLOOR, BODY_BACK);
    this.sprung.add(this.ramp);
    const rp = new PartList();
    rp.add(box(3.1, 0.08, RAMP_LENGTH), steel, 0, -0.04, -RAMP_LENGTH / 2);
    for (const s of [-1, 1]) rp.add(box(0.1, 0.14, RAMP_LENGTH), steel, s * 1.5, 0.03, -RAMP_LENGTH / 2);
    for (let z = -0.4; z > -RAMP_LENGTH; z -= 0.45) rp.add(box(2.9, 0.03, 0.06), dark, 0, 0.01, z);
    rp.build(this.ramp);

    // Wheels: steer axle under the cab, a tandem under the body (twin tyres).
    for (const [z, w] of [[4.2, 0.42], [-1.55, 0.72], [-2.85, 0.72]] as const) {
      for (const s of [-1, 1]) {
        const wheel = new THREE.Group();
        wheel.position.set(s * (1.32 - w / 2 + 0.2), WHEEL_R, z);
        const t = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, w, 20).rotateZ(Math.PI / 2), tire);
        const h = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, w + 0.02, 12).rotateZ(Math.PI / 2), hub);
        t.castShadow = true;
        wheel.add(t, h);
        this.group.add(wheel);
        this.wheels.push(wheel);
      }
    }
    this.setHopper(1);
    this.setRamp(1);
  }

  /** Hopper `k` open (1 right up, 0 shut). */
  setHopper(k: number): void {
    this.hopperOpen = k;
    this.hopper.rotation.x = HOPPER_OPEN * k;
    this.hopper.updateMatrix();
    // Each ram runs from its base on the body to a pin partway down the hopper's side.
    for (const r of this.rams) {
      const pin = new THREE.Vector3(r.side * (BODY_HW + 0.14), -1.7, -0.95).applyEuler(this.hopper.rotation).add(this.hopper.position);
      const d = pin.clone().sub(r.base);
      const len = d.length();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      const sleeveLen = 1.25;
      r.sleeve.quaternion.copy(q);
      r.sleeve.scale.set(1, sleeveLen, 1);
      r.sleeve.position.copy(r.base).addScaledVector(d, sleeveLen / 2 / len);
      r.rod.quaternion.copy(q);
      r.rod.scale.set(1, Math.max(0.1, len - sleeveLen + 0.2), 1);
      r.rod.position.copy(r.base).addScaledVector(d, (sleeveLen - 0.2 + len) / 2 / len);
    }
  }

  /** Ramp `k` down (1 on the road, 0 lifted level and slid away under the floor). */
  setRamp(k: number): void {
    this.rampDown = k;
    const down = -Math.asin(FLOOR / RAMP_LENGTH);
    const lift = THREE.MathUtils.smoothstep(1 - k, 0, 0.5);
    const slide = THREE.MathUtils.smoothstep(1 - k, 0.5, 1);
    this.ramp.rotation.x = down * (1 - lift);
    this.ramp.position.set(0, FLOOR - 0.18 * slide, BODY_BACK + RAMP_LENGTH * 0.92 * slide);
    this.ramp.visible = slide < 0.98;
  }

  /** A jolt through the springs (the vault slamming in): the back squats by `amount` (about 1). */
  lurch(amount: number): void {
    this.kickV -= amount * 1.6;
  }

  /** Per frame: beacons, wheels turning at `speed` (m/s), the springs settling. */
  update(dt: number, speed: number): void {
    this.time += dt;
    for (const [i, b] of this.beacons.entries()) {
      const phase = Math.sin(this.time * 9 + i * Math.PI);
      b.emissiveIntensity = this.beaconsOn ? (phase > 0.3 ? 5 : 0.3) : 0.1;
    }
    for (const w of this.wheels) w.rotation.x += (speed / WHEEL_R) * dt;
    // A damped spring on the body's pitch.
    this.kickV += (-this.kick * 60 - this.kickV * 7) * dt;
    this.kick += this.kickV * dt;
    this.sprung.rotation.x = this.kick * 0.35;
  }

  /** Lamps for braking (on the hopper and the body). */
  braking(on: boolean): void {
    this.brakeLamps.emissiveIntensity = on ? 4 : 1.4;
  }

  /** The work lamp in the body. */
  set workLamp(on: boolean) {
    this.workLight.emissiveIntensity = on ? 2.2 : 0;
  }

  /** World position of a point in the truck's frame. */
  toWorld(x: number, y: number, z: number): THREE.Vector3 {
    this.group.updateMatrixWorld();
    return this.group.localToWorld(new THREE.Vector3(x, y, z));
  }
}
