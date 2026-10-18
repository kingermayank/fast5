import * as THREE from 'three';

/**
 * The RIO 24H news helicopter. It finds the chase once the vault is out, circles
 * the convoy a little ahead of it and holds a searchlight on the vault: from the
 * overhead camera that's a bright pool sweeping the street with the beam slanting
 * down through the haze. The news breaks in the corner (broadcast.ts) are its
 * "live pictures".
 */

/**
 * It holds station beyond the convoy as seen from the camera, sweeping from side
 * to side (never between the camera and the cars): how far out and how high (m),
 * how wide the sweep is (rad either side) and how fast it goes (rad/s).
 */
const STATION_RANGE = 42;
const STATION_HEIGHT = 32;
const SWEEP = 1.1;
const SWEEP_RATE = 0.16;
/** Where the light lands on the ground: radius (m). */
export const SPOT_RADIUS = 7.5;

const white = new THREE.MeshStandardMaterial({ color: 0xf1f0ea, roughness: 0.35, metalness: 0.25 });
const stripe = new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.4, metalness: 0.2 });
const dark = new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.6, metalness: 0.4 });
const glass = new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 0.08, metalness: 0.7, envMapIntensity: 1.6 });

/** Blurred blades: what a spinning rotor looks like from above. */
function rotorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(30,30,34,0.5)');
  g.addColorStop(0.75, 'rgba(30,30,34,0.22)');
  g.addColorStop(1, 'rgba(30,30,34,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  // Four soft blade smears.
  ctx.translate(64, 64);
  for (let k = 0; k < 4; k++) {
    ctx.rotate(Math.PI / 2);
    const b = ctx.createLinearGradient(0, -10, 0, 10);
    b.addColorStop(0, 'rgba(20,20,24,0)');
    b.addColorStop(0.5, 'rgba(20,20,24,0.45)');
    b.addColorStop(1, 'rgba(20,20,24,0)');
    ctx.fillStyle = b;
    ctx.fillRect(4, -9, 58, 18);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A cone of light in hazy air: soft at its edges, brightest near the lamp. */
function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0xdfe8ff) }, intensity: { value: 0 } },
    vertexShader: /* glsl */ `
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vAlong = -position.y;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      uniform float intensity;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float soft = facing * facing;
        float fade = (1.0 - vAlong * 0.6) * smoothstep(0.0, 0.06, vAlong);
        gl_FragColor = vec4(color * intensity * soft * fade, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export class Chopper {
  readonly group = new THREE.Group();
  /** Where the searchlight lands; it lags its target a little, like someone aiming it. */
  readonly spot = new THREE.Vector3();
  /**
   * A real light for the cars and the vault under the beam (the ground pool is painted
   * by GroundFx). Add it and its target to the scene once, at load; it's dark (0) until
   * the helicopter arrives.
   */
  readonly light = new THREE.SpotLight(0xe6eeff, 0, 0, 0.2, 0.7, 2);
  /** 0 before it arrives, then 1. */
  on = 0;
  private active = false;
  private readonly craft = new THREE.Group();
  private readonly rotor: THREE.Mesh;
  private readonly tailRotor: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly beacon: THREE.MeshStandardMaterial;
  private readonly lamp: THREE.MeshStandardMaterial;
  private readonly pos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private orbit = 0;
  private time = 0;
  private yaw = 0;

  constructor() {
    const craft = this.craft;
    // Body along +z (the nose), skids below, rotor mast on top.
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.05, 2.3, 6, 14).rotateX(Math.PI / 2).scale(1, 0.95, 1), white);
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10).scale(0.95, 0.78, 1.05).translate(0, 0.1, 1.35), glass);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.36, 5.2, 10).rotateX(Math.PI / 2).translate(0, 0.35, -3.9), white);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.5, 0.8).translate(0, 0.95, -6.3), stripe);
    const stab = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.5).translate(0, 0.42, -5.6), white);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(1.08, 1.08, 0.38, 18, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.55), stripe);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.55, 8).translate(0, 1.2, 0.1), dark);
    const engine = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.45, 1.6).translate(0, 0.95, -0.6), white);
    const parts = [body, canopy, tail, fin, stab, band, mast, engine];
    for (const x of [-0.95, 0.95]) {
      parts.push(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 3.4).translate(x, -1.35, 0.1), dark));
      for (const z of [-0.6, 0.9]) parts.push(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08).translate(x * 0.85, -1.05, z), dark));
    }
    for (const p of parts) {
      p.castShadow = true;
      craft.add(p);
    }
    // Searchlight under the nose, and the red beacon on top.
    this.lamp = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xeef4ff, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.4, 12).translate(0, -1.0, 1.55), this.lamp);
    this.beacon = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2a2a, emissiveIntensity: 0 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6).translate(0, 1.25, -0.9), this.beacon);
    craft.add(lamp, beacon);

    const rotorMat = new THREE.MeshBasicMaterial({ map: rotorTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.rotor = new THREE.Mesh(new THREE.CircleGeometry(5.4, 40).rotateX(-Math.PI / 2), rotorMat);
    this.rotor.position.set(0, 1.5, 0.1);
    this.tailRotor = new THREE.Mesh(new THREE.CircleGeometry(0.8, 20).rotateY(Math.PI / 2), rotorMat);
    this.tailRotor.position.set(0.2, 0.95, -6.3);
    craft.add(this.rotor, this.tailRotor);

    // The beam: a unit cone hanging down from the lamp, scaled to reach the spot each frame.
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 1, 1, 28, 1, true).translate(0, -0.5, 0), beamMaterial());
    this.beam.frustumCulled = false;
    this.beam.renderOrder = 2;

    // The light goes straight in the scene (see `light`), never in the hidden group: a light
    // appearing or disappearing makes three.js recompile every material, a hitch mid-chase.
    this.group.add(craft, this.beam);
    this.group.visible = false;
  }

  /** Fly in toward `target` from `from` (off-screen). */
  launch(from: THREE.Vector3, target: THREE.Vector3): void {
    if (this.active) return;
    this.active = true;
    this.group.visible = true;
    this.pos.copy(from);
    this.vel.set(0, 0, 0);
    this.spot.copy(target).setY(0);
    this.orbit = 0;
  }

  /** Leave: the light goes out (the end of the chase). */
  stop(): void {
    this.active = false;
    this.group.visible = false;
    this.light.intensity = 0;
    this.on = 0;
  }

  get flying(): boolean {
    return this.active;
  }

  /** Where it is now. */
  get position(): THREE.Vector3 {
    return this.pos;
  }

  /** `away` is the camera's view direction along the ground: the helicopter stays out that way. */
  update(dt: number, target: THREE.Vector3, targetVel: THREE.Vector3, away: THREE.Vector3): void {
    if (!this.active || dt <= 0) return;
    this.time += dt;
    // Station a little ahead of the convoy and beyond it, sweeping slowly from side to side.
    this.orbit += dt * SWEEP_RATE;
    const bearing = Math.atan2(away.x, away.z) + Math.sin(this.orbit) * SWEEP;
    const lead = targetVel.clone().setY(0).multiplyScalar(1.2);
    const want = target.clone().add(lead);
    want.x += Math.sin(bearing) * STATION_RANGE;
    want.z += Math.cos(bearing) * STATION_RANGE;
    want.y = STATION_HEIGHT + Math.sin(this.time * 0.7) * 1.5;
    // A stiff, damped spring toward it (and no faster than a real helicopter can go).
    const acc = want.sub(this.pos).multiplyScalar(1.6).addScaledVector(this.vel, -1.9);
    this.vel.addScaledVector(acc, dt);
    if (this.vel.length() > 85) this.vel.setLength(85);
    this.pos.addScaledVector(this.vel, dt);
    this.on = Math.min(1, this.on + dt * 0.5);

    // Nose into the wind of its own motion, banked into turns and dipped when it speeds up.
    const ground = Math.hypot(this.vel.x, this.vel.z);
    const toTarget = Math.atan2(target.x - this.pos.x, target.z - this.pos.z);
    const yawWant = ground > 6 ? Math.atan2(this.vel.x, this.vel.z) : toTarget;
    const dy = Math.atan2(Math.sin(yawWant - this.yaw), Math.cos(yawWant - this.yaw));
    this.yaw += dy * Math.min(1, dt * 1.8);
    this.craft.position.copy(this.pos);
    this.craft.rotation.set(Math.min(0.3, ground / 160), this.yaw, THREE.MathUtils.clamp(-dy * 0.9, -0.45, 0.45), 'YXZ');
    this.rotor.rotation.y += dt * 38;
    this.tailRotor.rotation.x += dt * 60;
    this.beacon.emissiveIntensity = (this.time % 1.2) < 0.12 ? 6 : 0.3;

    // The searchlight: aim at the target with a little lag and hand-held wobble.
    const aim = target.clone().setY(0);
    aim.x += Math.sin(this.time * 1.3) * 1.2;
    aim.z += Math.cos(this.time * 1.1) * 1.2;
    this.spot.lerp(aim, 1 - Math.exp(-dt * 3));
    const lampAt = new THREE.Vector3(0, -1.1, 1.55).applyEuler(this.craft.rotation).add(this.pos);
    const toSpot = this.spot.clone().sub(lampAt);
    const length = toSpot.length();
    this.beam.position.copy(lampAt);
    this.beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), toSpot.clone().divideScalar(length));
    this.beam.scale.set(SPOT_RADIUS * 0.9, length, SPOT_RADIUS * 0.9);
    (this.beam.material as THREE.ShaderMaterial).uniforms.intensity.value = 0.18 * this.on;
    this.lamp.emissiveIntensity = 8 * this.on;
    this.light.position.copy(lampAt);
    this.light.target.position.copy(this.spot);
    this.light.distance = length * 2;
    this.light.angle = Math.atan(SPOT_RADIUS / length);
    this.light.intensity = 2600 * this.on;
  }
}
