// Fast5 in Rive: the game loop. Owns the world, the physics, the camera and
// the renderer, reads the keyboard and gamepad, and publishes its state to the
// view model for the HUD and the page.
import { Layout, Context } from "rive/host";
import { Renderer } from "rive/renderer";
import { Path } from "rive/path";
import { Paint } from "rive/paint";
import { Vector } from "rive/vector";
import { KeyboardEvent, GamepadEvent } from "rive/events";
import { ViewModel } from "rive/data";
import { Color } from "rive/color";
import { clock } from "rive/os";
import { MapData } from "./map";
import { CityMesh } from "./citymesh";
import { StaticWorld } from "./world";
import { PhysicsWorld } from "./physics";
import { Car, CarSpec, Controls } from "./car";
import { Vault, VaultParams } from "./vault";
import { Cable, CableParams } from "./cable";
import { Partner } from "./partner";
import { Fx } from "./fx";
import { OverheadCamera } from "./camera";
import { Model } from "./models";
import { GameRenderer, GpuMesh, Look } from "./render";
import { M4, MeshBuilder, VERTEX_BYTES, clamp, ease, fmt } from "./util";

const STEP: f64 = 1.0 / 120.0;

// Key codes (GLFW numbering, as Rive's KeyboardInput uses).
const KEY_W: i32 = 87;
const KEY_A: i32 = 65;
const KEY_S: i32 = 83;
const KEY_D: i32 = 68;
const KEY_R: i32 = 82;
const KEY_SPACE: i32 = 32;
const KEY_UP: i32 = 265;
const KEY_DOWN: i32 = 264;
const KEY_LEFT: i32 = 263;
const KEY_RIGHT: i32 = 262;
const KEY_LSHIFT: i32 = 340;
const KEY_RSHIFT: i32 = 344;
const KEY_TAB: i32 = 258;
const KEY_LBRACKET: i32 = 91;
const KEY_RBRACKET: i32 = 93;
const KEY_MINUS: i32 = 45;
const KEY_EQUAL: i32 = 61;

/** What the tuning panel can change. */
const TUNE_NAMES: StaticArray<string> = ["Cable stiffness", "Cable damping", "Break strength", "Winch slips at", "Stringiness", "Tow length", "Vault mass", "Vault friction"];

function domSpec(): CarSpec {
  let s = new CarSpec();
  s.mass = 2100;
  s.power = 460000;
  s.maxDrive = 27000;
  s.topSpeed = 62;
  s.mu = 1.95;
  s.steerMax = 0.6;
  return s;
}

function brianSpec(): CarSpec {
  let s = new CarSpec();
  s.mass = 1800;
  s.power = 430000;
  s.maxDrive = 25000;
  s.topSpeed = 64;
  s.mu = 2.0;
  s.steerMax = 0.66;
  return s;
}

function setNum(vm: ViewModel, name: string, value: f64): void {
  let p = vm.getNumber(name);
  if (p != null) p.value = value;
}

/** Green while easy, amber as it works, red past the breaking point's warning line. */
function strainColor(ratio: f64): Color {
  let r: f64, g: f64, b: f64;
  if (ratio < 0.5) {
    let t = ratio / 0.5;
    r = 91 + (255 - 91) * t; g = 210 + (181 - 210) * t; b = 122 + (71 - 122) * t;
  } else {
    let t = clamp((ratio - 0.5) / 0.3, 0, 1);
    r = 255; g = 181 + (64 - 181) * t; b = 71 + (46 - 71) * t;
  }
  return Color.rgba(<u8>r, <u8>g, <u8>b, 255);
}

export class Game extends Layout {
  context: Context? = null;
  width: f64 = 1280;
  height: f64 = 720;
  scale: f64 = 1;
  time: f64 = 0;
  look: Look = new Look();

  // Loading.
  mapBytes: ArrayBuffer? = null;
  map: MapData? = null;
  city: CityMesh? = null;
  cityGpu: GpuMesh? = null;
  ready: bool = false;
  bar: Path = new Path();
  barPaint: Paint = new Paint();

  // The world.
  world: StaticWorld? = null;
  physics: PhysicsWorld? = null;
  player: Car? = null;
  partnerCar: Car? = null;
  partner: Partner? = null;
  vault: Vault? = null;
  cables: Array<Cable> = [];
  cableParams: CableParams = new CableParams();
  vaultParams: VaultParams = new VaultParams();
  fx: Fx = new Fx();
  camera: OverheadCamera = new OverheadCamera();
  accumulator: f64 = 0;
  nos: f64 = 1;

  // Drawing.
  gfx: GameRenderer? = null;
  charger: Model? = null;
  vaultGpu: GpuMesh? = null;
  cableGpu: GpuMesh? = null;
  cableMesh: MeshBuilder = new MeshBuilder();

  // Input.
  keys: StaticArray<bool> = new StaticArray<bool>(512);
  padSteer: f64 = 0;
  padThrottle: f64 = 0;
  padBrake: f64 = 0;
  padHandbrake: bool = false;
  padNos: bool = false;

  // View model.
  vm: ViewModel? = null;
  autopilot: f64 = 0;
  testTime: f64 = -1;
  tuneOpen: bool = false;
  tuneIndex: i32 = 0;
  banner: string = "";
  bannerTime: f64 = 0;
  // Sound events for the page: counters it watches for changes.
  crashCount: f64 = 0;
  crashPower: f64 = 0;
  snapCount: f64 = 0;
  jerkCount: f64 = 0;
  wasTaut: StaticArray<bool> = [false, false];
  slowest: f64 = 0;
  loadedFrames: i32 = 0;
  drawTime: f64 = 0;
  drawFrames: i32 = 0;
  debugFrames: i32 = 0;

  log(message: string): void {
    let c = this.context;
    if (c != null) c.log(message);
  }

  override init(context: Context): bool {
    this.context = context;
    let bytes = context.blob("map");
    if (bytes == null) {
      context.log("map blob missing");
      return false;
    }
    this.mapBytes = bytes;
    this.city = new CityMesh();
    this.gfx = new GameRenderer(context);
    this.vm = context.viewModel();
    return true;
  }

  override resize(width: f64, height: f64, scale: f64): void {
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  // ------------------------------------------------------------ loading

  /** Parse the map, then build the city a slice per frame. True once it's all there. */
  load(): bool {
    let city = this.city!;
    if (city.done && this.loadedFrames++ > 0) return true;
    if (city.done) return false;
    let map = this.map;
    if (map == null) {
      let parsed = MapData.parse(this.mapBytes!);
      if (parsed == null) {
        this.log("map blob unreadable");
        return false;
      }
      this.map = parsed;
      return false;
    }
    if (city.step(map, 0.04)) {
      this.log("city: " + city.mesh.vertexCount.toString() + " vertices, " + city.indexCount.toString() + " indices, " + map.buildings.length.toString() + " buildings");
    }
    // Even on the frame it finishes: the setup gets a frame of its own.
    return false;
  }

  /** The crew outside the station: the vault on the pavement, both Chargers in the street, cables on. */
  setup(): void {
    let map = this.map!;
    let world = new StaticWorld(map);
    this.world = world;
    let physics = new PhysicsWorld(world);
    this.physics = physics;

    let vault = new Vault(this.vaultParams);
    physics.add(vault.body);
    this.vault = vault;
    let player = new Car(domSpec());
    let mate = new Car(brianSpec());
    physics.add(player.body);
    physics.add(mate.body);
    // The crew's cars ghost through each other (they'd only tangle); everything else collides.
    player.body.group = 2;
    player.body.mask = 0xffff & ~2;
    mate.body.group = 2;
    mate.body.mask = 0xffff & ~2;
    this.player = player;
    this.partnerCar = mate;

    // Physics order: tyres first, then the cables' pull, then the vault's friction.
    physics.solvers.push(player);
    physics.solvers.push(mate);
    let left = new Cable(player, vault, 1, world, physics.bodies, this.cableParams, 11);
    let right = new Cable(mate, vault, -1, world, physics.bodies, this.cableParams, 23);
    this.cables.push(left);
    this.cables.push(right);
    physics.solvers.push(left);
    physics.solvers.push(right);
    physics.solvers.push(vault);
    this.partner = new Partner(mate, player, right, world, -1);

    this.place(true);
    this.ready = true;
  }

  /** Lines the convoy up at (x, z) heading a: cars side by side, the vault a tow length behind. */
  placeAt(x: f64, z: f64, a: f64): void {
    let fx = Math.sin(a), fz = Math.cos(a), lx = Math.cos(a), lz = -Math.sin(a);
    this.player!.body.place(x + lx * 3, z + lz * 3, a);
    this.partnerCar!.body.place(x - lx * 3, z - lz * 3, a);
    let back = this.cableParams.length + 5;
    this.vault!.body.place(x - fx * back, z - fz * back, a);
    for (let i = 0; i < this.cables.length; i++) this.cables[i].hook(0.6);
    this.camera.reset(x, z);
  }

  /** Puts the convoy back together: at the start, or lined up where the player is. */
  place(start: bool): void {
    let player = this.player!;
    let mate = this.partnerCar!;
    let vault = this.vault!;
    if (start) {
      vault.body.place(177, 150, 1.5708);
      player.body.place(202.5, 158, 0);
      mate.body.place(196.5, 158, 0);
    } else {
      let b = player.body;
      let fx = b.fwdX(), fz = b.fwdZ(), lx = b.leftX(), lz = b.leftZ();
      let cx = b.x - lx * 3, cz = b.z - lz * 3;
      let a = b.a;
      player.body.place(cx + lx * 3, cz + lz * 3, a);
      mate.body.place(cx - lx * 3, cz - lz * 3, a);
      vault.body.place(cx - fx * (this.cableParams.length + 5), cz - fz * (this.cableParams.length + 5), a);
    }
    for (let i = 0; i < this.cables.length; i++) this.cables[i].hook(0.6);
    this.camera.reset(player.body.x, player.body.z);
  }

  // ------------------------------------------------------------ input

  override keyboardEvent(event: KeyboardEvent): bool {
    let key = <i32>event.key;
    if (key < 0 || key >= 512) return false;
    let down = event.phase != "up";
    let was = this.keys[key];
    this.keys[key] = down;
    if (down && !was && key == KEY_R && this.ready) this.place(false);
    if (down && !was && key == KEY_TAB) this.tuneOpen = !this.tuneOpen;
    if (down && this.tuneOpen) {
      if (key == KEY_LBRACKET) this.tuneIndex = (this.tuneIndex + TUNE_NAMES.length - 1) % TUNE_NAMES.length;
      if (key == KEY_RBRACKET) this.tuneIndex = (this.tuneIndex + 1) % TUNE_NAMES.length;
      if (key == KEY_MINUS) this.tune(this.tuneIndex, -1);
      if (key == KEY_EQUAL) this.tune(this.tuneIndex, 1);
    }
    return true;
  }

  /** Nudges a tunable up or down a notch. */
  tune(i: i32, dir: f64): void {
    let c = this.cableParams;
    let v = this.vaultParams;
    if (i == 0) c.stiffness = clamp(c.stiffness * (dir > 0 ? 1.25 : 0.8), 15000, 300000);
    else if (i == 1) c.damping = clamp(c.damping * (dir > 0 ? 1.25 : 0.8), 500, 60000);
    else if (i == 2) c.breakForce = clamp(c.breakForce * (dir > 0 ? 1.15 : 1 / 1.15), 40000, 600000);
    else if (i == 3) c.slipForce = clamp(c.slipForce * (dir > 0 ? 1.15 : 1 / 1.15), 20000, 600000);
    else if (i == 4) c.stringiness = clamp(c.stringiness + dir * 0.1, 0, 1);
    else if (i == 5) c.length = clamp(c.length + dir, 4, 30);
    else if (i == 6) {
      v.mass = clamp(v.mass + dir * 500, 1000, 12000);
      let b = this.vault!.body;
      b.setMass(v.mass, b.hx, b.hz);
    } else if (i == 7) v.muKinetic = clamp(v.muKinetic + dir * 0.04, 0.08, 0.9);
  }

  /** The value of tunable i, with its unit. */
  tuneValue(i: i32): string {
    let c = this.cableParams;
    let v = this.vaultParams;
    if (i == 0) return fmt(c.stiffness / 1000, 0) + " kN/m";
    if (i == 1) return fmt(c.damping / 1000, 1) + " kN·s/m";
    if (i == 2) return fmt(c.breakForce / 1000, 0) + " kN";
    if (i == 3) return fmt(c.slipForce / 1000, 0) + " kN";
    if (i == 4) return fmt(c.stringiness, 1);
    if (i == 5) return fmt(c.length, 0) + " m";
    if (i == 6) return fmt(v.mass / 1000, 1) + " t";
    return fmt(v.muKinetic, 2);
  }

  override gamepadEvent(event: GamepadEvent): bool {
    this.padSteer = -<f64>event.leftX;
    this.padThrottle = <f64>event.rightTrigger;
    this.padBrake = <f64>event.leftTrigger;
    this.padHandbrake = event.south;
    this.padNos = event.east || event.rightShoulder;
    if (event.north && this.ready) this.place(false);
    return true;
  }

  private key(k: i32): bool {
    return this.keys[k];
  }

  private readControls(dt: f64): void {
    let c = this.player!.controls;
    let kSteer: f64 = 0;
    if (this.key(KEY_A) || this.key(KEY_LEFT)) kSteer += 1;
    if (this.key(KEY_D) || this.key(KEY_RIGHT)) kSteer -= 1;
    // Keyboard steering eases in so taps don't twitch.
    let target = Math.abs(this.padSteer) > 0.08 ? this.padSteer : kSteer;
    c.steer = ease(c.steer, target, Math.abs(target) > Math.abs(c.steer) ? 7 : 12, dt);
    c.throttle = this.key(KEY_W) || this.key(KEY_UP) ? 1 : this.padThrottle;
    c.brake = this.key(KEY_S) || this.key(KEY_DOWN) ? 1 : this.padBrake;
    c.handbrake = this.key(KEY_SPACE) || this.padHandbrake;
    c.nos = this.key(KEY_LSHIFT) || this.key(KEY_RSHIFT) || this.padNos;
    if (this.autopilot == 1) this.drive(c, this.time);
    if (this.autopilot == 2) this.yankTest(c, dt);
  }

  /**
   * The yank test (view model `autopilot` = 2), on the long straight of the
   * Expreso Piñero: hard acceleration, a hard stop so the vault slides into the
   * slack, a short reverse, then a nitrous launch that snatches the cables.
   */
  private yankTest(c: Controls, dt: f64): void {
    if (this.testTime < 0) {
      // Edge 161: (1172.4, 1629.3) to (274.1, 1452.4).
      let dx = 274.1 - 1172.4, dz = 1452.4 - 1629.3;
      this.placeAt(1150, 1625, Math.atan2(dx, dz));
      this.testTime = 0;
    }
    this.testTime += dt;
    let t = this.testTime;
    // Hold the lane: steer for the road's line a little ahead.
    let b = this.player!.body;
    let ax = 1172.4, az = 1629.3, dx = 274.1 - 1172.4, dz = 1452.4 - 1629.3;
    let len = Math.sqrt(dx * dx + dz * dz);
    dx /= len;
    dz /= len;
    let along = (b.x - ax) * dx + (b.z - az) * dz;
    let tx = ax + dx * (along + 25) - dz * 5, tz = az + dz * (along + 25) + dx * 5;
    let want = Math.atan2(tx - b.x, tz - b.z);
    let err = want - b.a;
    while (err > 3.14159) err -= 6.28318;
    while (err < -3.14159) err += 6.28318;
    c.steer = clamp(err * 2, -1, 1);
    c.throttle = 0;
    c.brake = 0;
    c.nos = false;
    c.handbrake = false;
    if (t < 1) {
    } else if (t < 9) {
      c.throttle = 1;
    } else if (t < 12.5) {
      c.brake = 1;
      c.steer = 0;
    } else if (t < 15.5) {
      // Stopped: back up into the vault to leave plenty of slack.
      c.brake = 1;
      c.steer = 0;
    } else if (t < 16) {
    } else {
      c.throttle = 1;
      c.nos = true;
    }
  }

  /** Scripted laps for headless tests (view model `autopilot` = 1). */
  private drive(c: Controls, t: f64): void {
    c.throttle = 1;
    c.brake = 0;
    c.handbrake = false;
    c.nos = false;
    c.steer = 0;
    let s = t - 4;
    if (s < 0) {
      c.throttle = 0;
    } else if (s < 5) {
      c.steer = 0;
    } else if (s < 7) {
      c.steer = 0.7;
    } else if (s < 10) {
      c.steer = 0;
    } else if (s < 12) {
      c.steer = -0.8;
      c.handbrake = s > 11;
    } else if (s < 14) {
      c.throttle = 0;
      c.brake = 1;
    } else if (s < 15) {
      c.throttle = 0;
    } else {
      c.nos = true;
    }
  }

  // ------------------------------------------------------------ the loop

  override advance(seconds: f64): bool {
    let started = clock();
    let result = this.tick(seconds);
    let took = clock() - started;
    if (took > this.slowest) {
      this.slowest = took;
      if (took > 0.05) this.log("slowest frame so far: " + fmt(took * 1000, 1) + " ms (" + (this.ready ? "playing" : "loading") + ")");
    }
    return result;
  }

  tick(seconds: f64): bool {
    let dt = Math.min(seconds, 0.05);
    this.time += dt;
    if (!this.load()) return true;
    if (!this.ready) {
      let t0 = clock();
      this.setup();
      this.log("setup: " + fmt((clock() - t0) * 1000, 1) + " ms");
      return true;
    }
    let vm = this.vm;
    if (vm != null) {
      let ap = vm.getNumber("autopilot");
      if (ap != null) this.autopilot = ap.value;
    }

    let player = this.player!;
    let mate = this.partnerCar!;
    let vault = this.vault!;
    let physics = this.physics!;
    this.readControls(dt);
    // Nitrous: a tank that drains while it burns and refills slowly.
    let burning = player.controls.nos && this.nos > 0.02 && player.controls.throttle > 0;
    player.nosActive = burning;
    this.nos = clamp(this.nos + (burning ? -0.22 : 0.06) * dt, 0, 1);
    this.partner!.update(dt);

    this.accumulator = Math.min(this.accumulator + dt, STEP * 6);
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      player.update(STEP);
      mate.update(STEP);
      physics.fixedStep(STEP);
      player.settle(STEP);
      mate.settle(STEP);
      vault.settle(STEP);
      for (let i = 0; i < this.cables.length; i++) {
        let c = this.cables[i];
        let strain = c.strain();
        if (strain > 0.6 && !c.broken && this.autopilot > 0) this.log("cable " + i.toString() + " peak " + fmt(strain * c.params.breakForce / 1000, 0) + " kN, damage " + fmt(c.damage, 2));
        c.settle(STEP);
        if (c.snapped) {
          // Crack: a flash and a shower of sparks where it parted, and a jolt.
          this.fx.flash(c.snapX, c.snapY + 0.3, c.snapZ, 1.6);
          this.fx.sparks(c.snapX, c.snapY, c.snapZ, 0, 0, 14, 40);
          this.camera.shake(1.4);
          this.snapCount++;
          let both = this.cables[0].broken && this.cables[1].broken;
          this.banner = both ? "THE VAULT'S LOOSE" : i == 0 ? "YOUR CABLE SNAPPED" : "BRIAN'S CABLE SNAPPED";
          this.bannerTime = 0;
          this.log("cable " + i.toString() + " snapped at " + fmt(strain * c.params.breakForce / 1000, 0) + " kN");
        }
      }
    }
    this.effects(dt);
    this.fx.update(dt);
    this.bannerTime += dt;
    if (this.bannerTime > 2.4) this.banner = "";
    this.debugFrames++;
    if (this.autopilot > 0 && this.debugFrames % 30 == 0) {
      let cA = this.cables[0], cB = this.cables[1];
      this.log("t " + fmt(this.time, 1) + " player v " + fmt(player.forwardSpeed, 2) + " lat " + fmt(player.lateralSpeed, 2) + " w " + fmt(player.body.w, 2) +
        " slipR " + fmt(player.slipRear, 3) + " spin " + fmt(player.wheelspin, 2) + " | mate v " + fmt(mate.forwardSpeed, 2) + " slipR " + fmt(mate.slipRear, 3) +
        " | vault v " + fmt(vault.sliding, 2) + " | cables " + fmt(cA.tension / 1000, 1) + "/" + fmt(cB.tension / 1000, 1) + " kN len " + fmt(cA.length, 1) + "/" + fmt(cB.length, 1) +
        " | fx " + this.fx.count.toString() + " | pos " + fmt(player.body.x, 1) + "," + fmt(player.body.z, 1));
    }

    let b = player.body;
    let vb = vault.body;
    let spread = Math.sqrt((vb.x - b.x) * (vb.x - b.x) + (vb.z - b.z) * (vb.z - b.z));
    // Frame the convoy: mostly the player, some of the vault.
    this.camera.update(dt, b.x * 0.72 + vb.x * 0.28, b.z * 0.72 + vb.z * 0.28, b.vx, b.vz, spread, player.nosActive);
    this.publish();
    return true;
  }

  /** Sparks and dust off the vault, tyre smoke, scrapes and knocks. */
  private effects(dt: f64): void {
    let vault = this.vault!;
    let vb = vault.body;
    let fx = this.fx;
    let r = fx.rng;
    let slide = vault.sliding;
    if (slide > 1.5) {
      // From the trailing edge of the plinth, flying back along the slide.
      let tx = -vb.vx / slide, tz = -vb.vz / slide;
      let rate = clamp(vault.grind / 60000, 0, 1) * 160 * dt;
      let n = <i32>rate + (r.next() < rate - Math.floor(rate) ? 1 : 0);
      for (let k = 0; k < n; k++) {
        let along = r.range(-1.5, 1.5);
        let ex = vb.x + tx * 1.55 - tz * along;
        let ez = vb.z + tz * 1.55 + tx * along;
        fx.sparks(ex, 0.08, ez, tx, tz, 4 + slide * 0.5, 1);
      }
      if (r.next() < clamp(slide / 10, 0, 1) * dt * 22) fx.dust(vb.x + tx * 1.6, 0.25, vb.z + tz * 1.6, vb.vx, vb.vz, clamp(slide / 12, 0, 1));
    }
    for (let i = 0; i < 2; i++) {
      let car = i == 0 ? this.player! : this.partnerCar!;
      let b = car.body;
      let sliding = Math.abs(car.lateralSpeed) > 2.5 && b.speed() > 4 ? clamp((Math.abs(car.slipRear) - 0.12) * 4, 0, 1) : 0;
      let slipping = Math.max(car.wheelspin > 0.35 ? car.wheelspin : 0, sliding);
      if (slipping > 0.2 && r.next() < slipping * dt * 30) {
        for (let side = -1; side <= 1; side += 2) {
          let wx = b.worldX(<f64>side * 0.8, -1.4), wz = b.worldZ(<f64>side * 0.8, -1.4);
          fx.smoke(wx, 0.3, wz, b.vx, b.vz, slipping);
        }
      }
      let sp = b.speed() + 0.01;
      if (b.scrape > 3 && r.next() < dt * 40) fx.sparks(b.scrapeX, 0.5, b.scrapeZ, -b.vx / sp, -b.vz / sp, 5, 3);
      if (b.impact > 6) {
        this.crashCount++;
        this.crashPower = clamp(b.impact / 18, 0.3, 1);
        fx.sparks(b.impactX, 0.6, b.impactZ, 0, 0, 6, <i32>clamp(b.impact, 4, 24));
        this.camera.shake(clamp(b.impact * 0.06, 0.2, 1.2));
      }
    }
    if (vb.impact > 4) {
      this.crashCount++;
      this.crashPower = clamp(vb.impact / 10, 0.4, 1);
      fx.sparks(vb.impactX, 0.8, vb.impactZ, 0, 0, 7, <i32>clamp(vb.impact * 2, 6, 40));
      this.camera.shake(clamp(vb.impact * 0.1, 0.3, 1.5));
    }
  }

  /** Game state for the HUD and the page. */
  private publish(): void {
    let vm = this.vm;
    if (vm == null) return;
    let player = this.player!;
    let kmh = Math.abs(player.forwardSpeed) * 3.6;
    let speed = vm.getNumber("speed");
    if (speed != null) speed.value = kmh;
    let speedText = vm.getString("speedText");
    if (speedText != null) speedText.value = fmt(kmh, 0);
    for (let i = 0; i < this.cables.length; i++) {
      let c = this.cables[i];
      let pre = i == 0 ? "cableA" : "cableB";
      let t = vm.getNumber(pre + "Strain");
      if (t != null) t.value = c.broken ? 0 : clamp(c.tension / c.params.breakForce, 0, 1.2);
      let hp = vm.getNumber(pre + "Health");
      if (hp != null) hp.value = c.broken ? 0 : 1 - clamp(c.damage, 0, 1);
      let txt = vm.getString(pre + "Text");
      if (txt != null) txt.value = c.broken ? "SNAPPED" : fmt(c.tension / 1000, 0) + " kN";
      let len = vm.getNumber(pre + "Length");
      if (len != null) len.value = c.length;
    }
    let nos = vm.getNumber("nos");
    if (nos != null) nos.value = this.nos;
    let vs = vm.getNumber("vaultSpeed");
    if (vs != null) vs.value = this.vault!.sliding * 3.6;
    let grind = vm.getNumber("vaultGrind");
    if (grind != null) grind.value = this.vault!.grind;

    // The cable panel: pull against strength, coloured as it nears breaking.
    for (let i = 0; i < this.cables.length; i++) {
      let c = this.cables[i];
      let pre = i == 0 ? "cableA" : "cableB";
      let ratio = c.broken ? 0 : c.tension / c.params.breakForce;
      let bar = vm.getNumber(pre + "Bar");
      if (bar != null) bar.value = 220 * clamp(ratio / 1.25, 0, 1);
      let hp = vm.getNumber(pre + "Hp");
      if (hp != null) hp.value = 220 * (c.broken ? 0 : 1 - clamp(c.damage, 0, 1));
      let col = vm.getColor(pre + "Color");
      if (col != null) col.value = strainColor(ratio);
    }
    let vt = vm.getString("vaultText");
    if (vt != null) vt.value = "VAULT  " + fmt(this.vault!.sliding * 3.6, 0) + " km/h";
    let nb = vm.getNumber("nosBar");
    if (nb != null) nb.value = 180 * this.nos;

    // Sound: the page synthesises it from these.
    let pc = player.controls;
    setNum(vm, "throttle", pc.throttle);
    setNum(vm, "slip", Math.max(player.wheelspin, clamp((Math.abs(player.slipRear) - 0.1) * 3, 0, 1)));
    setNum(vm, "nosOn", player.nosActive ? 1 : 0);
    setNum(vm, "crashCount", this.crashCount);
    setNum(vm, "crashPower", this.crashPower);
    setNum(vm, "snapCount", this.snapCount);
    // A cable going taut with a jolt: the clank.
    for (let i = 0; i < this.cables.length; i++) {
      let c = this.cables[i];
      let taut = !c.broken && c.tension > c.params.breakForce * 0.3;
      if (taut && !this.wasTaut[i]) this.jerkCount++;
      this.wasTaut[i] = taut;
    }
    setNum(vm, "jerkCount", this.jerkCount);

    // Banner: a few seconds, then fades.
    let bt = vm.getString("bannerText");
    let ba = vm.getNumber("bannerAlpha");
    if (bt != null) bt.value = this.banner;
    if (ba != null) ba.value = this.banner.length > 0 ? clamp(1 - (this.bannerTime - 1.8) / 0.6, 0, 1) * clamp(this.bannerTime * 8, 0, 1) : 0;

    // Hint: what the cables need from you right now.
    let hint = vm.getString("hint");
    if (hint != null) {
      let a = this.cables[0], b = this.cables[1];
      let msg = "";
      if (a.broken && b.broken) msg = "Both cables are gone. Press R to hook the vault up again.";
      else if (!a.broken && a.tension > a.params.breakForce * 0.6) msg = "Ease off! Your cable is about to go.";
      else if (!a.broken && a.damage > 0.5) msg = "Your cable is fraying. Smooth inputs, no yanks.";
      else if (a.broken) msg = "Brian's still towing. Keep the vault out of the walls.";
      hint.value = msg;
    }

    // Tuning panel.
    let ta = vm.getNumber("tuneAlpha");
    if (ta != null) ta.value = this.tuneOpen ? 1 : 0;
    let tt = vm.getString("tuneText");
    if (tt != null && this.tuneOpen) {
      let lines = "";
      for (let i = 0; i < TUNE_NAMES.length; i++) {
        lines += (i == this.tuneIndex ? "▸ " : "   ") + TUNE_NAMES[i] + "   " + this.tuneValue(i) + (i < TUNE_NAMES.length - 1 ? "\n" : "");
      }
      tt.value = lines;
    }
  }

  // ------------------------------------------------------------ drawing

  /** Puts the next slice of the GPU resources in place; true once they all are. */
  uploadStep(context: Context): bool {
    let city = this.city!;
    if (!city.upload(0.03)) return false;
    if (this.cityGpu == null) {
      this.cityGpu = city.gpu;
      return false;
    }
    if (this.charger == null) {
      let blob = context.blob("charger");
      if (blob != null) this.charger = Model.parse(blob);
      return false;
    }
    if (this.vaultGpu == null) {
      let vm = new MeshBuilder();
      Vault.mesh(vm);
      this.vaultGpu = GpuMesh.from(vm.words.buffer, 0, <u32>vm.vertexCount * VERTEX_BYTES, vm.indices.buffer, 0, <u32>vm.indexCount * 4);
      this.cableGpu = new GpuMesh(64 * 1024, 64 * 1024);
      return false;
    }
    return true;
  }

  drawLoading(renderer: Renderer): void {
    let map = this.map;
    // Building the city is most of the bar, putting it on the GPU the rest.
    let p = map != null ? this.city!.progress(map) * 0.85 : 0;
    if (this.ready) p = 0.85 + 0.15 * this.city!.uploadProgress();
    let w = this.width, h = this.height;
    let bw = Math.min(420, w * 0.5);
    let x = (w - bw) / 2, y = h * 0.62;
    this.barPaint.color = Color.rgba(255, 181, 71, 255);
    let bar = this.bar;
    bar.reset();
    bar.moveTo(Vector.xy(<f32>x, <f32>y));
    bar.lineTo(Vector.xy(<f32>(x + bw * p), <f32>y));
    bar.lineTo(Vector.xy(<f32>(x + bw * p), <f32>(y + 4)));
    bar.lineTo(Vector.xy(<f32>x, <f32>(y + 4)));
    bar.close();
    renderer.drawPath(bar, this.barPaint);
  }

  override draw(renderer: Renderer): void {
    let started = clock();
    this.render(renderer);
    // Script-side cost of a frame (building the draw lists), averaged for tests.
    if (this.autopilot > 0 && this.ready) {
      this.drawTime += clock() - started;
      this.drawFrames++;
      if (this.drawFrames % 120 == 0) {
        this.log("draw (script side): " + fmt((this.drawTime / <f64>this.drawFrames) * 1000, 2) + " ms a frame");
      }
    }
  }

  render(renderer: Renderer): void {
    let gfx = this.gfx;
    let city = this.city;
    let context = this.context;
    if (gfx == null || city == null || context == null) return;
    if (!this.ready) {
      this.drawLoading(renderer);
      return;
    }
    // GPU resources, a budgeted slice per frame (the city's buffers are big).
    if (!this.uploadStep(context)) {
      this.drawLoading(renderer);
      return;
    }
    let cam = this.camera;
    gfx.begin();
    gfx.camera(cam.eyeX, cam.eyeY, cam.eyeZ, cam.targetX, 0, cam.targetZ, cam.fov, this.width * this.scale, this.height * this.scale, this.time, this.look);

    // The city: chunks near the camera, and further out toward the sun for shadows.
    let identity = gfx.object(M4.identity(), 0, 0, 0, 0, 0, 0);
    let cityGpu = this.cityGpu!;
    let tx = cam.targetX, tz = cam.targetZ;
    for (let i = 0; i < city.chunks.length; i++) {
      let c = city.chunks[i];
      if (c.count == 0) continue;
      let r: f64 = 260;
      let near = c.always || (c.maxX > tx - r && c.minX < tx + r && c.maxZ > tz - r && c.minZ < tz + r);
      if (near) {
        gfx.mesh(cityGpu, <u32>c.first, <u32>c.count, identity, true);
      } else {
        // Toward the sun: tall buildings out there still shade the street.
        let sx = tx + this.look.sunX * 250, sz = tz + this.look.sunZ * 250;
        let rs: f64 = 200;
        if (c.maxX > sx - rs && c.minX < sx + rs && c.maxZ > sz - rs && c.minZ < sz + rs) gfx.shadowOnly(cityGpu, <u32>c.first, <u32>c.count, identity);
      }
    }

    // The cars.
    let charger = this.charger;
    if (charger != null) {
      for (let i = 0; i < 2; i++) {
        let car = i == 0 ? this.player! : this.partnerCar!;
        let b = car.body;
        let paint: u32 = i == 0 ? 0x141518 : 0x24272c;
        charger.draw(gfx, b.x, b.z, b.a, car.pitch, car.roll, car.steer, car.spinFront, car.spinRear, paint, 0.35, car.braking ? 1.0 : 0.0, 0.0, 0.0);
      }
    }

    // The vault, rocking on its base.
    let vault = this.vault!;
    let vb = vault.body;
    let vslot = gfx.object(M4.pose(vb.x, vault.lift, vb.z, vb.a, vault.pitch, vault.roll, 1), 0, 0, 0, 0, 0, 0);
    let vg = this.vaultGpu!;
    gfx.mesh(vg, 0, vg.indexCount, vslot, true);

    // The cables, glowing as they near breaking.
    let cm = this.cableMesh;
    cm.vertexCount = 0;
    cm.indexCount = 0;
    let firsts: StaticArray<i32> = [0, 0, 0];
    for (let i = 0; i < this.cables.length; i++) {
      firsts[i] = cm.indexCount;
      this.cables[i].tube(cm, 0x2b2d31);
    }
    firsts[this.cables.length] = cm.indexCount;
    let cg = this.cableGpu!;
    if (cm.indexCount > 0) {
      cg.vbo.update(0, cm.words.buffer, <u32>cm.vertexCount * VERTEX_BYTES, 0);
      cg.ibo.update(0, cm.indices.buffer, <u32>cm.indexCount * 4, 0);
      for (let i = 0; i < this.cables.length; i++) {
        let c = this.cables[i];
        let slot = gfx.object(M4.identity(), 0, 0, 0, 0, 0, c.glow());
        gfx.mesh(cg, <u32>firsts[i], <u32>(firsts[i + 1] - firsts[i]), slot, true);
      }
    }

    this.fx.draw(gfx);
    gfx.finish(renderer, this.width, this.height, this.scale);
  }
}
