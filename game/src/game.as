// Fast5 in Rive: the game. Owns the world, the physics, the camera and the
// renderer, reads the keyboard and gamepad, runs the story from the crew
// select to the end screens, and drives the screens and HUD (ui.rml) through
// the view model.
import { Layout, Context } from "rive/host";
import { Renderer } from "rive/renderer";
import { KeyboardEvent, GamepadEvent } from "rive/events";
import { Color } from "rive/color";
import { clock } from "rive/os";
import { MapData, MapLoader } from "./map";
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
import { Hud, money, thousands } from "./hud";
import { Minimap } from "./minimap";
import { Roads, Gps } from "./roads";
import { M4, MeshBuilder, VERTEX_BYTES, clamp, ease, fmt } from "./util";

const STEP: f64 = 1.0 / 120.0;

// Key codes (GLFW numbering, as Rive's KeyboardInput uses).
const KEY_W: i32 = 87;
const KEY_A: i32 = 65;
const KEY_S: i32 = 83;
const KEY_D: i32 = 68;
const KEY_R: i32 = 82;
const KEY_SPACE: i32 = 32;
const KEY_ENTER: i32 = 257;
const KEY_KP_ENTER: i32 = 335;
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

/** Where the run is: choosing the crew (the city loads behind it), the intro, driving, the end screen. */
const PHASE_SELECT: i32 = 0;
const PHASE_INTRO: i32 = 1;
const PHASE_DRIVE: i32 = 2;
const PHASE_RESULT: i32 = 3;

/** How long the intro's camera takes to come down from the orbit to the convoy (s). */
const INTRO_SWOOP: f64 = 3.2;
const INTRO_LENGTH: f64 = 4.4;

/** Where the convoy starts: outside the station on Avenida Juan Ponce de León, heading north. */
const START_X: f64 = 200;
const START_Z: f64 = 160;

/** Mia's lines when the player leaves her route (from the original game). */
const REROUTE_LINES: StaticArray<string> = ["Okay, new route.", "That works too. Rerouting.", "Not my way, but fine. Rerouting.", "Change of plan. Recalculating."];

/** What the tuning panel can change. */
const TUNE_NAMES: StaticArray<string> = ["Cable stiffness", "Cable damping", "Break strength", "Winch slips at", "Stringiness", "Tow length", "Vault mass", "Vault friction"];

/** The crew. Dom's Charger is heavy and strong; Brian's Skyline lighter and sharper. */
const CREW_NAMES: StaticArray<string> = ["DOM", "BRIAN"];
const DOM_PAINT: u32 = 0x141518;
const BRIAN_PAINT: u32 = 0x1c4fd8;

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

function smooth(t: f64): f64 {
  let x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
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
  loader: MapLoader? = null;
  map: MapData? = null;
  city: CityMesh? = null;
  cityGpu: GpuMesh? = null;
  ready: bool = false;
  loadedFrames: i32 = 0;
  uploaded: bool = false;

  // The story.
  phase: i32 = PHASE_SELECT;
  phaseTime: f64 = 0;
  /** 0 Dom, 1 Brian: who you drive. */
  crew: i32 = 0;
  startWanted: bool = false;
  /** The title orbit's camera when the intro began, which it swoops down from. */
  fromEyeX: f64 = 0;
  fromEyeY: f64 = 0;
  fromEyeZ: f64 = 0;
  fromTargetX: f64 = 0;
  fromTargetZ: f64 = 0;
  // The run's score.
  runTime: f64 = 0;
  style: f64 = 0;
  damage: f64 = 0;
  wrecked: i32 = 0;
  heat: f64 = 0;
  busted: f64 = 0;

  // The streets and the route.
  roads: Roads? = null;
  gps: Gps? = null;
  /** The turn Mia last called (its intersection), when she last rerouted, and the bridge call. */
  calledTurn: i32 = -1;
  lastReroute: f64 = -10;
  bridgeCalled: bool = false;

  // The world.
  world: StaticWorld? = null;
  physics: PhysicsWorld? = null;
  dom: Car? = null;
  brian: Car? = null;
  domCable: Cable? = null;
  brianCable: Cable? = null;
  player: Car? = null;
  partnerCar: Car? = null;
  partner: Partner? = null;
  vault: Vault? = null;
  /** The player's cable, then the partner's. */
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
  skyline: Model? = null;
  vaultGpu: GpuMesh? = null;
  cableGpu: GpuMesh? = null;
  cableMesh: MeshBuilder = new MeshBuilder();
  minimap: Minimap? = null;

  // Input.
  keys: StaticArray<bool> = new StaticArray<bool>(512);
  padSteer: f64 = 0;
  padThrottle: f64 = 0;
  padBrake: f64 = 0;
  padHandbrake: bool = false;
  padNos: bool = false;

  // The screens and HUD, and the test switches.
  hud: Hud? = null;
  autopilot: f64 = 0;
  /** Set by headless test runs (view model `headless` = 1): the CLI's data dump has no GPU to upload to. */
  headless: bool = false;
  testTime: f64 = -1;
  tuneOpen: bool = false;
  tuneIndex: i32 = 0;
  // Sound events for the page: counters it watches for changes.
  crashCount: f64 = 0;
  crashPower: f64 = 0;
  snapCount: f64 = 0;
  jerkCount: f64 = 0;
  wasTaut: StaticArray<bool> = [false, false];
  slowest: f64 = 0;
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
    let vm = context.viewModel();
    if (vm != null) this.hud = new Hud(vm);
    return true;
  }

  override resize(width: f64, height: f64, scale: f64): void {
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  // ------------------------------------------------------------ loading

  /** Read the map, then build the city, a slice per frame. True once it's all there. */
  load(): bool {
    let city = this.city!;
    if (city.done && this.loadedFrames++ > 0) return true;
    if (city.done) return false;
    let map = this.map;
    if (map == null) {
      if (this.loader == null) this.loader = new MapLoader(this.mapBytes!);
      let loader = this.loader!;
      if (loader.failed || !loader.step(0.03)) return false;
      if (loader.failed) {
        this.log("map blob unreadable");
        return false;
      }
      this.map = loader.map;
      this.loader = null;
      this.mapBytes = null;
      return false;
    }
    if (city.step(map, 0.04)) {
      this.log("city: " + city.mesh.vertexCount.toString() + " vertices, " + city.indexCount.toString() + " indices, " + map.buildings.length.toString() + " buildings");
    }
    // Even on the frame it finishes: the setup gets a frame of its own.
    return false;
  }

  /** 0..1: reading the map, building the city (most of it), putting it on the GPU. */
  loadProgress(): f64 {
    let map = this.map;
    let loader = this.loader;
    if (this.ready) return 0.85 + 0.15 * this.city!.uploadProgress();
    if (map != null) return 0.1 + this.city!.progress(map) * 0.75;
    return loader != null ? loader.progress() * 0.1 : 0;
  }

  /** The crew outside the station: both cars in the street, the vault behind them, cables on. */
  setup(): void {
    let map = this.map!;
    let world = new StaticWorld(map);
    this.world = world;
    let physics = new PhysicsWorld(world);
    this.physics = physics;
    this.minimap = new Minimap(map);
    let roads = new Roads(map);
    this.roads = roads;
    this.gps = new Gps(roads, map);

    let vault = new Vault(this.vaultParams);
    physics.add(vault.body);
    this.vault = vault;
    let dom = new Car(domSpec());
    let brian = new Car(brianSpec());
    physics.add(dom.body);
    physics.add(brian.body);
    // The crew's cars ghost through each other (they'd only tangle); everything else collides.
    dom.body.group = 2;
    dom.body.mask = 0xffff & ~2;
    brian.body.group = 2;
    brian.body.mask = 0xffff & ~2;
    this.dom = dom;
    this.brian = brian;

    // Physics order: tyres first, then the cables' pull, then the vault's friction.
    // Dom tows from the vault's left eye and Brian from its right, whoever's driving.
    physics.solvers.push(dom);
    physics.solvers.push(brian);
    let domCable = new Cable(dom, vault, 1, world, physics.bodies, this.cableParams, 11);
    let brianCable = new Cable(brian, vault, -1, world, physics.bodies, this.cableParams, 23);
    this.domCable = domCable;
    this.brianCable = brianCable;
    physics.solvers.push(domCable);
    physics.solvers.push(brianCable);
    physics.solvers.push(vault);

    this.chooseCrew(0);
    this.place(true);
    this.ready = true;
  }

  /** Who you drive: the other car is your partner, holding the slot beside you. */
  chooseCrew(crew: i32): void {
    this.crew = crew;
    let me = crew == 0 ? this.dom! : this.brian!;
    let mate = crew == 0 ? this.brian! : this.dom!;
    let myCable = crew == 0 ? this.domCable! : this.brianCable!;
    let mateCable = crew == 0 ? this.brianCable! : this.domCable!;
    this.player = me;
    this.partnerCar = mate;
    this.cables = [myCable, mateCable];
    // Brian keeps Dom's right; Dom keeps Brian's left.
    this.partner = new Partner(mate, me, mateCable, myCable, this.world!, crew == 0 ? -1 : 1);
    for (let i = 0; i < 2; i++) {
      let c = (i == 0 ? me : mate).controls;
      c.throttle = 0;
      c.brake = 0;
      c.steer = 0;
      c.handbrake = false;
      c.nos = false;
    }
  }

  /** Lines the convoy up at (x, z) heading a: Dom on the left, Brian on the right, the vault a tow length behind. */
  placeAt(x: f64, z: f64, a: f64): void {
    let fx = Math.sin(a), fz = Math.cos(a), lx = Math.cos(a), lz = -Math.sin(a);
    this.dom!.body.place(x + lx * 3, z + lz * 3, a);
    this.brian!.body.place(x - lx * 3, z - lz * 3, a);
    let back = this.cableParams.length + 5;
    this.vault!.body.place(x - fx * back, z - fz * back, a);
    for (let i = 0; i < this.cables.length; i++) this.cables[i].hook(0.6);
    let partner = this.partner;
    if (partner != null) partner.lead = 0;
    this.camera.reset(x, z);
  }

  /**
   * Puts the convoy back together: at the start, or lined up where the player is.
   * The start is outside the station on Avenida Juan Ponce de León, heading north
   * up its long straight with the vault in line behind (a side-on first pull
   * would swing the cars' tails round before they got going).
   */
  place(start: bool): void {
    if (start) {
      this.placeAt(START_X, START_Z, 0);
      return;
    }
    let b = this.player!.body;
    let side: f64 = this.crew == 0 ? 3 : -3;
    this.placeAt(b.x - b.leftX() * side, b.z - b.leftZ() * side, b.a);
  }

  // ------------------------------------------------------------ input

  override keyboardEvent(event: KeyboardEvent): bool {
    let key = <i32>event.key;
    if (key < 0 || key >= 512) return false;
    let down = event.phase != "up";
    let was = this.keys[key];
    this.keys[key] = down;
    let pressed = down && !was;
    let confirm = pressed && (key == KEY_ENTER || key == KEY_KP_ENTER || key == KEY_SPACE);
    if (this.phase == PHASE_SELECT) {
      if (pressed && (key == KEY_LEFT || key == KEY_A)) this.highlight(0);
      if (pressed && (key == KEY_RIGHT || key == KEY_D)) this.highlight(1);
      if (confirm) this.startWanted = true;
      return true;
    }
    if (this.phase == PHASE_INTRO) {
      if (pressed && (key == KEY_ENTER || key == KEY_KP_ENTER)) this.startDriving();
      return true;
    }
    if (pressed && key == KEY_R && this.phase == PHASE_DRIVE) this.place(false);
    if (pressed && key == KEY_TAB) this.tuneOpen = !this.tuneOpen;
    if (down && this.tuneOpen) {
      if (key == KEY_LBRACKET) this.tuneIndex = (this.tuneIndex + TUNE_NAMES.length - 1) % TUNE_NAMES.length;
      if (key == KEY_RBRACKET) this.tuneIndex = (this.tuneIndex + 1) % TUNE_NAMES.length;
      if (key == KEY_MINUS) this.tune(this.tuneIndex, -1);
      if (key == KEY_EQUAL) this.tune(this.tuneIndex, 1);
    }
    return true;
  }

  /** The crew card under the keyboard's cursor (the mouse sets it in the UI too). */
  private highlight(crew: i32): void {
    let hud = this.hud;
    if (hud != null) hud.crew.force(<f64>crew);
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
    if (this.phase == PHASE_SELECT) {
      if (event.leftX < -0.5) this.highlight(0);
      if (event.leftX > 0.5) this.highlight(1);
      if (event.south) this.startWanted = true;
    }
    if (event.north && this.phase == PHASE_DRIVE) this.place(false);
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
    if (this.autopilot == 1) this.drive(c, this.phaseTime);
    if (this.autopilot == 2) this.yankTest(c, dt);
    if (this.autopilot == 3) this.followRoute(c);
  }

  /**
   * Drives Mia's route for tests (view model `autopilot` = 3): its own lane,
   * steering for the route a little ahead, slowing for the turns.
   */
  private followRoute(c: Controls): void {
    let gps = this.gps!;
    let p = this.player!;
    let b = p.body;
    c.handbrake = false;
    c.nos = false;
    if (gps.pathLength < 1) {
      c.throttle = 0;
      c.brake = 1;
      return;
    }
    let speed = p.forwardSpeed;
    let look = 10 + Math.abs(speed) * 0.4;
    gps.pointAlong(Math.min(gps.pathLength, look));
    let ax = gps.atX, az = gps.atZ;
    gps.pointAlong(Math.min(gps.pathLength, look + 2));
    let tx = gps.atX - ax, tz = gps.atZ - az;
    let tl = Math.sqrt(tx * tx + tz * tz) + 1e-9;
    // Keep to our side of the road: Dom left of the line, Brian right.
    let lane: f64 = this.crew == 0 ? 2.8 : -2.8;
    let gx = ax + (tz / tl) * lane, gz = az + (-tx / tl) * lane;
    let want = Math.atan2(gx - b.x, gz - b.z);
    let err = want - b.a;
    while (err > 3.14159) err -= 6.28318;
    while (err < -3.14159) err += 6.28318;
    c.steer = clamp(err * 2.4, -1, 1);
    // Slow for the bend ahead: how far the route turns over the next 60 m.
    gps.pointAlong(Math.min(gps.pathLength, 12));
    let h0x = gps.atX - b.x, h0z = gps.atZ - b.z;
    gps.pointAlong(Math.min(gps.pathLength, 60));
    let h1x = gps.atX - b.x, h1z = gps.atZ - b.z;
    let cosTurn = (h0x * h1x + h0z * h1z) / (Math.sqrt(h0x * h0x + h0z * h0z) * Math.sqrt(h1x * h1x + h1z * h1z) + 1e-9);
    let target = cosTurn > 0.97 ? 26 : cosTurn > 0.85 ? 16 : 10;
    let e = target - speed;
    c.throttle = clamp(e * 0.3, 0, 1);
    c.brake = e < -2 ? clamp(-e * 0.07, 0, 1) : 0;
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

  /**
   * Scripted run for headless tests (view model `autopilot` = 1), from the start
   * up Avenida Juan Ponce de León: pull away, swerve across the lanes so the
   * vault swings, a firm stop so it slides up on the cars, then pull away again.
   */
  private drive(c: Controls, t: f64): void {
    let b = this.player!.body;
    let s = t - 1;
    // Hold a line up the avenue (north), shifted a lane each way to swerve.
    let lane: f64 = this.crew == 0 ? 203 : 197;
    if (s > 3 && s < 7) lane += 3.5 * Math.sin((s - 3) * 1.5708);
    let want = Math.atan2(lane - b.x, 14 + Math.abs(this.player!.forwardSpeed) * 0.6);
    let err = want - b.a;
    while (err > 3.14159) err -= 6.28318;
    while (err < -3.14159) err += 6.28318;
    c.steer = clamp(err * 2, -1, 1);
    c.throttle = 0;
    c.brake = 0;
    c.handbrake = false;
    c.nos = false;
    if (s < 0) {
    } else if (s < 7) {
      c.throttle = 1;
    } else if (s < 9.5) {
      c.brake = 0.5;
    } else if (s >= 10.5) {
      c.throttle = 1;
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
    this.phaseTime += dt;
    let hud = this.hud;
    if (hud != null) {
      this.autopilot = hud.autopilot.read();
      this.headless = hud.headless.read() > 0;
      hud.update(dt);
    }

    // Loading carries on behind the crew select: the map, the city, then its GPU buffers.
    if (this.load()) {
      if (!this.ready) {
        let t0 = clock();
        this.setup();
        this.log("setup: " + fmt((clock() - t0) * 1000, 1) + " ms");
      } else if (!this.uploaded && !this.headless) {
        let t1 = clock();
        this.uploaded = this.uploadStep(this.context!);
        let took = clock() - t1;
        if (took > 0.05) this.log("upload slice: " + fmt(took * 1000, 1) + " ms");
      }
    }
    let live = this.ready && (this.uploaded || this.headless);

    if (this.phase == PHASE_SELECT) {
      this.selecting(dt, live);
      return true;
    }
    if (this.phase == PHASE_INTRO && this.phaseTime >= INTRO_LENGTH) this.startDriving();
    this.simulate(dt);
    this.effects(dt);
    this.fx.update(dt);
    this.follow(dt);
    if (this.phase == PHASE_DRIVE) this.navigate(dt);
    this.publish();
    return true;
  }

  /** Where the player is actually going: their velocity when driving forward, else where they point. */
  private travelX(): f64 {
    let p = this.player!;
    let b = p.body;
    let v = b.speed();
    return v > 4 && p.forwardSpeed > 2 ? b.vx / v : b.fwdX();
  }

  private travelZ(): f64 {
    let p = this.player!;
    let b = p.body;
    let v = b.speed();
    return v > 4 && p.forwardSpeed > 2 ? b.vz / v : b.fwdZ();
  }

  /**
   * The route to the bridge: keeps the GPS up to date, points the HUD's arrow
   * 40 m down it, and has Mia call the turns (and grumble when you leave it).
   */
  private navigate(dt: f64): void {
    let gps = this.gps!;
    let hud = this.hud;
    let b = this.player!.body;
    let rerouted = gps.update(dt, b.x, b.z, this.travelX(), this.travelZ());
    if (hud == null) return;
    // The arrow, turned the way the screen is.
    gps.pointAlong(Math.min(gps.pathLength, 40));
    let dx = gps.atX - b.x, dz = gps.atZ - b.z;
    let yaw = this.camera.bearing();
    let c = Math.cos(yaw), sn = Math.sin(yaw);
    hud.arrowAngle.set(Math.atan2(-dx * c + dz * sn, dx * sn + dz * c));
    hud.arrowOn.set(gps.pathLength > 1);
    hud.guidance.set(gps.turnSide != 0 ? (gps.turnSide < 0 ? "LEFT" : "RIGHT") + " IN " + fmt(gps.turnDistance, 0) + " m" : fmt(gps.pathLength, 0) + " m TO GO");
    hud.objective.set(this.roads!.onBridge(b.x, b.z) ? "Reach the swap point" : "Drag the vault to the bridge");

    // Mia, on the radio.
    let r = this.roads!;
    if (!this.bridgeCalled && gps.nextIsGoal()) {
      let fx = r.nx[gps.foot] - b.x, fz = r.nz[gps.foot] - b.z;
      if (Math.sqrt(fx * fx + fz * fz) < 110) {
        this.bridgeCalled = true;
        hud.radio("MIA", "Bridge ahead. Get to the yellow gantry at the far end.");
        return;
      }
    }
    if (rerouted && this.runTime - this.lastReroute >= 8) {
      this.lastReroute = this.runTime;
      if (gps.turnSide != 0 && gps.turnDistance <= 130) this.calledTurn = gps.turnNode;
      let next = gps.turnSide == 0 ? "Straight on to the bridge." : gps.turnDistance > 130 ? "Stay on this street for now." : gps.turnSide < 0 ? "Hang a left at the next corner!" : "Go right at the next corner!";
      hud.radio("MIA", REROUTE_LINES[gps.reroutes % REROUTE_LINES.length] + " " + next);
      return;
    }
    if (gps.turnSide != 0 && gps.turnNode == gps.ids[0] && gps.turnDistance <= 100 && gps.turnDistance >= 25 && gps.turnNode != this.calledTurn) {
      this.calledTurn = gps.turnNode;
      hud.radio("MIA", gps.turnSide < 0 ? "Next intersection, hang a left!" : "Next intersection, go right!");
    }
  }

  /** The crew select: pick with the keys or the mouse, start once the city's ready. */
  private selecting(dt: f64, live: bool): void {
    let hud = this.hud;
    if (hud != null) {
      hud.screen("select");
      if (hud.takeConfirm()) this.startWanted = true;
      hud.selectPrompt.set(live ? "PRESS ENTER TO START" : "LOADING THE CITY   " + fmt(this.loadProgress() * 100, 0) + "%");
    }
    // Test runs go straight in, as whoever the view model's `crew` says.
    if (this.autopilot > 0) this.startWanted = true;
    if (!live) return;
    // A slow orbit high over the convoy while you choose.
    let t = this.time * 0.06;
    let cx = START_X, cz = START_Z - 8;
    this.camera.frame(cx + Math.cos(t) * 80, 84, cz + Math.sin(t) * 80, cx, cz);
    if (this.startWanted) {
      let crew = hud != null ? <i32>Math.round(hud.crew.read()) : 0;
      this.beginRun(crew == 1 ? 1 : 0);
    }
  }

  /** The crew's chosen: the intro, the camera coming down out of the orbit onto the convoy. */
  private beginRun(crew: i32): void {
    this.chooseCrew(crew);
    this.place(true);
    this.phase = PHASE_INTRO;
    this.phaseTime = 0;
    this.runTime = 0;
    this.style = 0;
    this.damage = 0;
    this.wrecked = 0;
    this.heat = 0;
    this.busted = 0;
    this.nos = 1;
    this.gps!.reset();
    this.calledTurn = -1;
    this.lastReroute = -10;
    this.bridgeCalled = false;
    let cam = this.camera;
    this.fromEyeX = cam.eyeX;
    this.fromEyeY = cam.eyeY;
    this.fromEyeZ = cam.eyeZ;
    this.fromTargetX = cam.targetX;
    this.fromTargetZ = cam.targetZ;
    let hud = this.hud;
    if (hud != null) {
      hud.screen("cinematic");
      hud.titleCard.set("RIO DE JANEIRO");
      hud.subtitleWho.set("");
      hud.subtitleText.set("");
    }
    if (this.autopilot > 0) this.startDriving();
  }

  /** Hands over: the HUD comes up and the radio crackles. */
  private startDriving(): void {
    this.phase = PHASE_DRIVE;
    this.phaseTime = 0;
    let hud = this.hud;
    if (hud == null) return;
    hud.screen("drive");
    hud.titleCard.set("");
    hud.subtitleWho.set("");
    hud.subtitleText.set("");
    hud.objective.set("Drag the vault to the bridge");
    hud.radio("MIA", "You’re out and rolling. Keep the cables tight and get that box to the bridge.");
  }

  /** The intro's lines over the title card. */
  private introLines(): void {
    let hud = this.hud;
    if (hud == null) return;
    let t = this.phaseTime;
    hud.titleCard.set(t < 2.6 ? "RIO DE JANEIRO" : "");
    let who = "", line = "";
    if (t > 1.2) {
      who = this.crew == 0 ? "DOM" : "BRIAN";
      line = this.crew == 0 ? "Every dirty cop in this city is about to come for that vault. Stay with me." : "Four tons of steel behind us, Dom. Let’s see what these cables can take.";
    }
    hud.subtitleWho.set(who);
    hud.subtitleText.set(line);
  }

  /** One frame of the world: controls, the partner, the physics, the cables' winches and snaps. */
  private simulate(dt: f64): void {
    let player = this.player!;
    let mate = this.partnerCar!;
    let vault = this.vault!;
    let physics = this.physics!;
    let driving = this.phase == PHASE_DRIVE;
    if (driving) {
      this.runTime += dt;
      this.readControls(dt);
      this.partner!.update(dt);
    } else {
      // Waiting on the intro: engines running, brakes on.
      for (let i = 0; i < 2; i++) {
        let c = (i == 0 ? player : mate).controls;
        c.throttle = 0;
        c.brake = 0;
        c.steer = 0;
        c.handbrake = true;
        c.nos = false;
      }
    }
    // Nitrous: a tank that drains while it burns and refills slowly.
    let burning = driving && player.controls.nos && this.nos > 0.02 && player.controls.throttle > 0;
    player.nosActive = burning;
    this.nos = clamp(this.nos + (burning ? -0.22 : 0.06) * dt, 0, 1);

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
          let hud = this.hud;
          if (hud != null) {
            let both = this.cables[0].broken && this.cables[1].broken;
            hud.banner(both ? "THE VAULT’S LOOSE" : "CABLE SNAPPED", both ? "BOTH CABLES GONE" : i == 0 ? "YOUR CABLE" : CREW_NAMES[1 - this.crew] + "’S CABLE");
          }
          this.log("cable " + i.toString() + " snapped at " + fmt(strain * c.params.breakForce / 1000, 0) + " kN");
        }
      }
    }
    this.debugFrames++;
    if (this.autopilot > 0 && this.debugFrames % 30 == 0) {
      let cA = this.cables[0], cB = this.cables[1];
      this.log("t " + fmt(this.phaseTime, 1) + " player v " + fmt(player.forwardSpeed, 2) + " lat " + fmt(player.lateralSpeed, 2) + " w " + fmt(player.body.w, 2) +
        " slipR " + fmt(player.slipRear, 3) + " spin " + fmt(player.wheelspin, 2) + " | mate v " + fmt(mate.forwardSpeed, 2) + " slipR " + fmt(mate.slipRear, 3) + " @ " + fmt(mate.body.x, 1) + "," + fmt(mate.body.z, 1) +
        " | vault v " + fmt(vault.sliding, 2) + " @ " + fmt(vault.body.x, 1) + "," + fmt(vault.body.z, 1) + " | cables " + fmt(cA.tension / 1000, 1) + "/" + fmt(cB.tension / 1000, 1) + " kN len " + fmt(cA.length, 1) + "/" + fmt(cB.length, 1) +
        " | fx " + this.fx.count.toString() + " | pos " + fmt(player.body.x, 1) + "," + fmt(player.body.z, 1));
    }
  }

  /** The camera: following the convoy, or coming down to it out of the title orbit. */
  private follow(dt: f64): void {
    let b = this.player!.body;
    let vb = this.vault!.body;
    let spread = Math.sqrt((vb.x - b.x) * (vb.x - b.x) + (vb.z - b.z) * (vb.z - b.z));
    // Frame the convoy: mostly the player, some of the vault.
    let cam = this.camera;
    cam.update(dt, b.x * 0.72 + vb.x * 0.28, b.z * 0.72 + vb.z * 0.28, b.vx, b.vz, spread, this.player!.nosActive);
    if (this.phase == PHASE_INTRO) {
      this.introLines();
      let k = smooth(this.phaseTime / INTRO_SWOOP);
      cam.frame(this.fromEyeX + (cam.eyeX - this.fromEyeX) * k, this.fromEyeY + (cam.eyeY - this.fromEyeY) * k, this.fromEyeZ + (cam.eyeZ - this.fromEyeZ) * k,
        this.fromTargetX + (cam.targetX - this.fromTargetX) * k, this.fromTargetZ + (cam.targetZ - this.fromTargetZ) * k);
    }
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

  /** The run's state, for the HUD and for the page's sound. */
  private publish(): void {
    let hud = this.hud;
    if (hud == null) return;
    let player = this.player!;
    let kmh = Math.abs(player.forwardSpeed) * 3.6;
    hud.speed.set(Math.round(kmh));
    hud.speedText.set(fmt(kmh, 0));
    hud.nos.set(this.nos);
    hud.heat.set(this.heat);
    hud.busted.set(this.busted);
    hud.style.set(thousands(this.style));
    hud.damage.set(money(this.damage));
    hud.wrecked.set(this.wrecked.toString());
    if (this.phase != PHASE_DRIVE) hud.arrowOn.set(false);
    hud.meterOn.set(false);

    // The cables: pull against strength, coloured as it nears breaking, and what's left of them.
    let driving = this.phase == PHASE_DRIVE;
    hud.cablesAlpha.set(driving ? 1 : 0);
    for (let i = 0; i < this.cables.length; i++) {
      let c = this.cables[i];
      let ratio = c.broken ? 0 : c.tension / c.params.breakForce;
      hud.cableName[i].set(CREW_NAMES[i == 0 ? this.crew : 1 - this.crew]);
      hud.cableBar[i].set(Math.round(150 * clamp(ratio / 1.25, 0, 1)));
      hud.cableHp[i].set(Math.round(150 * (c.broken ? 0 : 1 - clamp(c.damage, 0, 1))));
      hud.cableColor[i].set(strainColor(ratio));
      hud.cableText[i].set(c.broken ? "SNAPPED" : fmt(c.tension / 1000, 0) + " kN");
    }

    // Hint: what the cables need from you right now.
    let a = this.cables[0], b = this.cables[1];
    let mateName = this.crew == 0 ? "Brian" : "Dom";
    let msg = "";
    if (driving) {
      if (a.broken && b.broken) msg = "BOTH CABLES GONE · R TO HOOK UP AGAIN";
      else if (!a.broken && a.tension > a.params.breakForce * 0.6) msg = "EASE OFF · YOUR CABLE’S ABOUT TO GO";
      else if (!a.broken && a.damage > 0.5) msg = "YOUR CABLE’S FRAYING · NO YANKS";
      else if (a.broken) msg = mateName.toUpperCase() + "’S STILL TOWING · KEEP IT OFF THE WALLS";
    }
    hud.hint.set(msg);

    // Sound: the page synthesises it from these.
    let pc = player.controls;
    hud.throttle.set(pc.throttle);
    hud.slip.set(Math.max(player.wheelspin, clamp((Math.abs(player.slipRear) - 0.1) * 3, 0, 1)));
    hud.nosOn.set(player.nosActive ? 1 : 0);
    hud.crashCount.set(this.crashCount);
    hud.crashPower.set(this.crashPower);
    hud.snapCount.set(this.snapCount);
    hud.vaultSpeed.set(this.vault!.sliding * 3.6);
    hud.vaultGrind.set(this.vault!.grind);
    // A cable going taut with a jolt: the clank.
    for (let i = 0; i < this.cables.length; i++) {
      let c = this.cables[i];
      let taut = !c.broken && c.tension > c.params.breakForce * 0.3;
      if (taut && !this.wasTaut[i]) this.jerkCount++;
      this.wasTaut[i] = taut;
    }
    hud.jerkCount.set(this.jerkCount);

    // Tuning panel.
    hud.tuneAlpha.set(this.tuneOpen ? 1 : 0);
    if (this.tuneOpen) {
      let lines = "";
      for (let i = 0; i < TUNE_NAMES.length; i++) {
        lines += (i == this.tuneIndex ? "▸ " : "   ") + TUNE_NAMES[i] + "   " + this.tuneValue(i) + (i < TUNE_NAMES.length - 1 ? "\n" : "");
      }
      hud.tuneText.set(lines);
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
    if (this.skyline == null) {
      let blob = context.blob("skyline");
      if (blob != null) this.skyline = Model.parse(blob);
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
    // Nothing to draw until the city's on the GPU: the crew select covers the screen meanwhile.
    if (!this.ready || !this.uploaded) return;
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

    // The cars: Dom's black Charger, Brian's blue Skyline.
    for (let i = 0; i < 2; i++) {
      let car = i == 0 ? this.dom! : this.brian!;
      let model = i == 0 ? this.charger : this.skyline;
      if (model == null) model = this.charger;
      if (model == null) continue;
      let b = car.body;
      model.draw(gfx, b.x, b.z, b.a, car.pitch, car.roll, car.steer, car.spinFront, car.spinRear, i == 0 ? DOM_PAINT : BRIAN_PAINT, i == 0 ? 0.35 : 0.85, car.braking ? 1.0 : 0.0, 0.0, 0.0);
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
    if (this.phase == PHASE_DRIVE) this.drawMinimap(renderer);
  }

  /** The minimap, in the HUD's bezel: 200 points round, 20 from the bottom-left corner. */
  private drawMinimap(renderer: Renderer): void {
    let mm = this.minimap;
    if (mm == null) return;
    let p = this.player!.body;
    let cx: f64 = 120, cy = this.height - 120;
    // The route ahead, as far as the bezel reaches.
    let route = mm.routePts;
    route.length = 0;
    let gps = this.gps!;
    for (let i = 0; i < gps.pathCum.length && (i < 2 || gps.pathCum[i - 1] < 700); i++) {
      route.push(gps.path[i * 2]);
      route.push(gps.path[i * 2 + 1]);
    }
    mm.begin(renderer, cx, cy, 100, p.x, p.z, this.camera.bearing());
    let v = this.vault!.body;
    mm.box(renderer, v.x, v.z, 4, v.a, 0xffffb547, 0xff0a0e16);
    let mate = this.partnerCar!.body;
    mm.arrow(renderer, mate.x, mate.z, mate.a, 6, this.crew == 0 ? 0xff6f95ff : 0xffbfc4cc, 0xff0a0e16);
    mm.arrow(renderer, p.x, p.z, p.a, 8, 0xfffff4e3, 0xff0a0e16);
    mm.end(renderer);
  }
}
