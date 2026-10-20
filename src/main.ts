import * as THREE from 'three';
import { angleTo, seek } from './ai';
import { Allies } from './allies';
import { loadModels, model } from './assets';
import { Sound } from './audio';
import { BreachScene } from './breach';
import { NEWS, wreckNews } from './broadcast';
import { Chopper, SPOT_RADIUS } from './chopper';
import { CAR_STARTS, City, LAMP_HEAD, STATION_FACADE_X, VAULT_START, VAULT_START_HEADING } from './city';
import { Cutscene, type Shot } from './cutscene';
import { Finale } from './finale';
import { Coach } from './coach';
import { CUTAWAY } from './cutaway';
import { Director } from './director';
import { Effects } from './fx';
import { BRIDGE_FOOT_POS, Gps, type Turn } from './gps';
import { createGraphics } from './graphics';
import { NIGHT } from './look';
import { GLINT_LAMPS, GLINTS } from './streetlight';
import { BEACONS, GroundFx } from './groundfx';
import { Hud } from './hud';
import { Input, type ControlState } from './input';
import type { Prop } from './city';
import { BankJob, BridgeFinale, type MomentContext, Roadblock, SpikeStrip, SPLIT_AT, ThePull } from './moments';
import { OverheadCamera } from './overhead';
import { PartnerDriver } from './partner';
import { curveSpeed, exits, lanePath, leftOf, nextIntersection, Path, roadDir, routeExit } from './roads';
import { BANK, BRIDGE, GOAL, inTunnel, MAP, onBridge, PLAN, SPIKES, TUNNEL } from './roadmap';
import { FIXED_DT, initPhysics, RAPIER } from './physics';
import { Police } from './police';
import { Reyes } from './reyes';
import { Rig } from './rig';
import { RiveUi } from './riveui';
import { Run } from './run';
import { Traffic } from './traffic';
import { BusCrossing } from './bus';
import { Pedestrians } from './pedestrians';
import { watchForProblems } from './problems';
import { Rain } from './rain';
import { TunnelSwap } from './tunnel';
import { Cable, CABLE_TOW_LENGTH, Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';
import { CUTSCENE_VIDEOS } from './videos';
import { Voice } from './voice';

declare const __BUILD__: string;
document.getElementById('build')!.textContent = `San Juan map · build ${__BUILD__}`;

type CharacterId = 'dom' | 'brian';

export const CHARACTERS: Record<CharacterId, { name: string; spec: VehicleSpec; side: 1 | -1 }> = {
  dom: {
    name: 'Dom Toretto',
    side: 1,
    spec: {
      mass: 2100, accel: 23, topSpeed: 62, turnRate: 2.1, grip: 7.5,
      model: { body: 0x141416, trim: 0x0b0b0c, rim: 0x3a3a3c, matte: true, asset: 'charger' },
    },
  },
  brian: {
    name: 'Brian O’Conner',
    side: -1,
    spec: {
      mass: 1800, accel: 25, topSpeed: 64, turnRate: 2.5, grip: 7,
      model: { body: 0x17181b, trim: 0x0b0b0c, rim: 0x9ea3aa, matte: true, asset: 'skyline' },
    },
  },
};

type State = 'select' | 'cutscene' | 'breach' | 'chase' | 'outro' | 'busted' | 'lost';

/** Swap the procedural Christ the Redeemer for the downloaded model, if it loaded. */
function useStatueModel(statue: THREE.Group): void {
  const src = model('christ');
  if (!src) {
    floodlit(statue);
    return;
  }
  const s = src.clone();
  const size = new THREE.Box3().setFromObject(s).getSize(new THREE.Vector3());
  // Arms across the view from the city (the group already faces it).
  if (size.z > size.x) s.rotation.y = Math.PI / 2;
  // Much larger than life (38 m) so it still reads from the city, 3.5 km away.
  s.scale.setScalar(120 / size.y);
  // The group's origin sits 12 m above the peak; stand the plinth on the summit.
  s.position.y = -14;
  statue.clear();
  statue.add(s);
  floodlit(statue);
}

/** At night the statue is floodlit, as the real one is: a pale glow over the dark hills. */
function floodlit(statue: THREE.Group): void {
  if (!NIGHT) return;
  statue.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const glow = (m: THREE.Material) => {
      const lit = (m as THREE.MeshStandardMaterial).clone();
      if (lit.emissive) {
        lit.emissive.set(0xfff0d8);
        lit.emissiveIntensity = 0.9;
      }
      return lit;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(glow) : glow(mesh.material);
  });
}

async function start(): Promise<void> {
  watchForProblems();
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const gfx = createGraphics(canvas);
  const { scene, camera } = gfx;

  const [world] = await Promise.all([initPhysics(), loadModels()]);
  useStatueModel(gfx.statue);
  const city = new City(world);
  scene.add(city.group);
  // People on the corners of the route's crossings, who scatter as the convoy comes through.
  const pedestrians = new Pedestrians((p) => city.indoors(p.x, p.z, 0.3));
  scene.add(pedestrians.group);
  const fx = new Effects();
  scene.add(fx.group);
  const groundFx = new GroundFx(gfx.lights);
  scene.add(groundFx.group);
  // It rains at night.
  const rain = NIGHT ? new Rain() : null;
  if (rain) scene.add(rain.group);
  const sound = new Sound();
  const voice = new Voice();

  const vault = new Vault(world, VAULT_START, VAULT_START_HEADING);
  scene.add(vault.mesh);
  const breach = new BreachScene(world, scene, city, fx, sound);

  const input = new Input();
  const hud = new Hud();
  void RiveUi.load().then((ui) => ui && hud.attachRive(ui));
  const gps = new Gps();
  const police = new Police(world, scene, city);
  const director = new Director();
  const reyes = new Reyes(world, scene, fx, sound, director);
  // A city bus pulling across a crossing on the route just as the convoy gets there.
  const bus = new BusCrossing(world, scene);
  const chopper = new Chopper();
  scene.add(chopper.group, chopper.light, chopper.light.target);
  const run = new Run();
  const coach = new Coach(hud);
  const traffic = new Traffic(world, scene);
  const rig = new Rig(world);
  traffic.visible = (p) => isVisible(p);
  traffic.onWreck = (at) => {
    fx.burst(at.setY(0.8), 0.6);
    sound.crash(0.6);
  };
  police.visible = (p) => isVisible(p);
  police.onBump = (at, k) => {
    sound.crash(0.25 + k * 0.5);
    input.rumble(0.3 + k * 0.6);
    fx.burst(at.setY(0.9), 0.25 + k * 0.4);
    director.shake = Math.max(director.shake, 0.25 + k * 0.6);
  };
  police.onWreck = (at, car, byVault) => {
    fx.burst(at.clone().setY(1), 1);
    sound.crash(1);
    nos = Math.min(1, nos + 0.15);
    style += 100;
    input.rumble(0.25, 120);
    takedown(at, car, byVault);
    // In the fight on the bridge, one hit near the rail goes over into the bay.
    bridge?.wrecked(car, byVault);
  };
  police.onSplash = (at) => bridge?.splash(at);
  police.onBikes = () => say('MIA', 'Bikes! Two of them, coming up either side of you. They can’t take a hit. Give them the vault.');
  bus.visible = (p) => isVisible(p);
  // Bikes ride up the road the convoy took, rather than cutting through buildings to it.
  police.trail = () => (partnerAi ? partnerAi.playerTrail : []);
  police.heroes = () => (player ? (partnerAi?.released ? [player.position] : [player.position, partner.position]) : []);
  bus.onPullOut = () => say('MIA', 'Bus! It’s pulling across right in front of you! Go round its tail!');
  bus.onNearMiss = (at) => {
    style += 150;
    hud.banner('NEAR MISS', 'THREADED THE BUS  +150', 1.4);
    if (!director.busy && isVisible(at)) director.slowmo(0.4, 0.8);
  };
  bus.onKnock = (at) => {
    sound.crash(0.9);
    fx.burst(at.clone().setY(1.2), 0.8);
    director.shake = Math.max(director.shake, 0.6);
    damage += 4000;
  };
  // A thrown rider coming down: a thump and a puff of dust (they sit up a moment later).
  police.onRiderDown = (at) => {
    if (!isVisible(at)) return;
    fx.puff(at, 4);
    sound.crash(0.25);
  };
  // A bus shelter's glass going: a shower of it, and the sound.
  city.onShatter = (at, v) => {
    if (!isVisible(at)) return;
    fx.shatter(at, v.multiplyScalar(0.6), 70);
    sound.shatter();
  };
  police.onShoot = (from, to) => {
    if (!isVisible(from) && !isVisible(to)) return;
    fx.muzzle(from);
    fx.scrape(to, to.clone().sub(from).normalize().multiplyScalar(-4), 0.4);
    sound.gunshot();
    if (Math.random() < 0.3) sound.ping(2400 + Math.random() * 1600, 0.05, 0.12);
  };
  reyes.onSplash = (at) => bridge?.splash(at);
  reyes.onWreck = (at) => {
    style += 600;
    nos = Math.min(1, nos + 0.3);
    input.rumble(0.8, 300);
    director.shake = 1.1;
    hud.banner('REYES’S MEN', 'ONE SUV DOWN  +600', 2);
    if (isVisible(at)) director.hitStop(0.12);
  };
  reyes.onBossHit = (at, forced) => bridge?.lastSwing(at, forced);
  reyes.onBossDamaged = (at, left) => {
    style += 800;
    nos = Math.min(1, nos + 0.35);
    input.rumble(0.9, 300);
    hud.banner('REYES IS HIT', left > 1 ? `TWO MORE  +800` : `ONE MORE  +800`, 1.8);
    say('MIA', left > 1 ? 'You hurt him! He’s still coming. Again!' : 'He’s smoking! One more swing!');
    if (isVisible(at)) director.hitStop(0.14);
  };

  let state: State = 'select';
  let character: CharacterId = 'dom';
  let player!: Vehicle;
  let partner!: Vehicle;
  let partnerAi!: PartnerDriver;
  let cutscene: Cutscene | null = null;
  const cables: Cable[] = [];
  let stateTime = 0;
  let chaseTime = 0;
  let damage = 0;
  /** Street damage only (props), which drives heat; set-piece damage counts for score, not heat. */
  let streetDamage = 0;
  let heat = 0;
  let busted = 0;
  let accumulator = 0;
  /** Turn Mia last called out ("x,z" of its intersection), when she last rerouted, and the bridge call. */
  let calledTurn = '';
  let lastReroute = -10;
  let bridgeCalled = false;
  let lastPlayerSpeed = 0;
  /** Nitrous meter 0..1 and style score. */
  let nos = 0.5;
  let style = 0;
  let nosWasOn = false;
  let pull: ThePull | null = null;
  let spikes: SpikeStrip | null = null;
  let bankJob: BankJob | null = null;
  let bridge: BridgeFinale | null = null;
  let roadblock: Roadblock | null = null;
  let swap: TunnelSwap | null = null;
  let allies: Allies | null = null;
  let momentCtx: MomentContext | null = null;
  /** A set piece has the police off the road (the tunnel swap, the split on the bridge). */
  let policeHeld = false;

  function createMoments(): void {
    const ctx: MomentContext = (momentCtx = {
      world,
      scene,
      city,
      fx,
      sound,
      hud,
      voice,
      director,
      police,
      reyes,
      player,
      partner,
      partnerDriver: partnerAi,
      vault,
      cables,
      crew: { player: character === 'dom' ? 'DOM' : 'BRIAN', partner: character === 'dom' ? 'BRIAN' : 'DOM', side: CHARACTERS[character].side },
      route: () => gps.nodes,
      reward: (points, refill) => {
        style += points;
        nos = Math.min(1, nos + refill);
      },
      addDamage: (amount) => {
        damage += amount;
      },
      cutscene: playScene,
      placeConvoy,
      hook: hookCables,
      unhook: unhookCables,
      holdPolice: (hold) => {
        policeHeld = hold;
        if (hold) police.dismiss();
      },
      clearStreets: (where) => {
        police.dismiss(where);
        traffic.remove(where ?? (() => true));
      },
    });
    pull = new ThePull(ctx);
    spikes = new SpikeStrip(ctx);
    bankJob = new BankJob(ctx);
    swap = new TunnelSwap(ctx);
    allies = new Allies(ctx);
    allies.allowed = () => !!swap?.pending && swap.state !== 'lineup';
    bridge = new BridgeFinale(ctx, cutLoose, (at, cars) => blockadeBust(at, cars, true));
    bridge.onLast = (at, forced) => startFinale(at, forced);
    roadblock = new Roadblock(ctx, (at, cars) => blockadeBust(at, cars, false));
  }

  function setupCrew(id: CharacterId): void {
    character = id;
    const me = CHARACTERS[id];
    const other = CHARACTERS[id === 'dom' ? 'brian' : 'dom'];
    // The car on the left (+x when facing north) has side = 1.
    const startFor = (side: number) => CAR_STARTS[side === 1 ? 1 : 0];
    player = new Vehicle(world, me.spec, startFor(me.side), 0);
    partner = new Vehicle(world, other.spec, startFor(other.side), 0);
    player.makeHero();
    partner.makeHero();
    player.pivot = 0.9;
    scene.add(player.model.group, partner.model.group);
    partnerAi = new PartnerDriver(world, -me.side);
    partnerAi.reset(player);
  }

  /** Winch cables from both cars to the vault door. */
  function hookCables(): void {
    const me = CHARACTERS[character];
    for (const [car, side] of [[player, me.side], [partner, -me.side]] as const) {
      const len = car.towPoint().distanceTo(vault.anchorWorld(side)) + 0.6;
      cables.push(new Cable(world, scene, car, vault, side, len));
    }
  }

  /** Every cable off the vault. */
  function unhookCables(): void {
    for (const c of cables) c.dispose(scene);
    cables.length = 0;
  }

  /**
   * A cutscene in the middle of the chase (the tunnel swap, the split on the bridge):
   * the chase clock, the cops and the HUD wait, and the scene's `finish` leaves the
   * world as it ends, skipped or not; then the chase picks up again.
   */
  function playScene(shots: Shot[], finish: () => void): void {
    director.cut();
    hud.hint('');
    hud.meter(null);
    enter('cutscene');
    cutscene = new Cutscene(shots, hud, voice, () => {
      cutscene = null;
      finish();
      enter('chase');
      hud.showHud(true);
    });
  }

  /**
   * The last scene on the bridge (finale.ts): from the last swing to payday. When it
   * ends (or is skipped) the run is over and the end screen comes straight up.
   */
  let finale: Finale | null = null;
  function startFinale(at: THREE.Vector3, forced: boolean): void {
    if (finale || !momentCtx) return;
    finale = new Finale(momentCtx, BRIDGE_PATH, !!swap?.done, at);
    run.stats.finished = true;
    coach.stop();
    style += forced ? 1500 : 3000;
    director.cut();
    hud.hint('');
    hud.meter(null);
    enter('cutscene');
    cutscene = new Cutscene(finale.shots(), hud, voice, () => {
      cutscene = null;
      finale?.finish();
      if (bridge) bridge.state = 'done';
      enter('outro');
    });
  }

  function enter(next: State): void {
    state = next;
    stateTime = 0;
  }

  // ----------------------------------------------------------- recovery

  /** R: line the crew back up in the middle of the nearest street, facing along the GPS route. */
  let convoyResets = 0;
  function resetConvoy(): void {
    convoyResets++;
    const p = player.position;
    // The nearest street, even from the middle of a parking lot.
    const fix = MAP.locate(p, undefined, 400);
    if (!fix) return;
    // Along the street, whichever way the route goes; the vault behind the cars on the
    // street itself (it may curve), with the cars moved up if it's too short behind them.
    const street = new Path(fix.edge.pts);
    const ahead = gps.path(p).at(30).sub(fix.point);
    const sign = fix.tangent.dot(ahead) >= 0 ? 1 : -1;
    const tow = CABLE_TOW_LENGTH + 2.5;
    const s = THREE.MathUtils.clamp(fix.s, sign > 0 ? Math.min(tow, street.length) : 0, sign > 0 ? street.length : Math.max(0, street.length - tow));
    const f = street.tangent(s).multiplyScalar(sign);
    placeConvoy(street.at(s), f, street.at(THREE.MathUtils.clamp(s - sign * tow, 0, street.length)));
  }

  /** Line the crew up side by side at `center`, facing `f`, with the vault behind them (at `vaultAt`, if given). */
  function placeConvoy(center: THREE.Vector3, f: THREE.Vector3, vaultAt = center.clone().addScaledVector(f, -CABLE_TOW_LENGTH - 2.5)): void {
    const heading = Math.atan2(f.x, f.z);
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const side = CHARACTERS[character].side;
    player.place(center.clone().addScaledVector(left, side * 2.75), heading);
    partner.place(center.clone().addScaledVector(left, -side * 2.75), heading);
    vault.place(vaultAt, heading);
    for (const c of cables) c.fit(CABLE_TOW_LENGTH);
    partnerAi.reset(player);
    overhead.reset(heading);
  }

  /** The vault wedged for good (vault.ts): back on the road behind the cars, in a cloud of dust. */
  let vaultRescues = 0;
  function rescueVault(): void {
    const from = vault.position.setY(0);
    const at = vault.rescue(partnerAi.playerTrail, CABLE_TOW_LENGTH + 2.5);
    vault.wantsRescue = false;
    if (!at) return;
    vaultRescues++;
    for (const c of cables) c.fit(CABLE_TOW_LENGTH);
    fx.puff(from, 12);
    fx.puff(at, 12);
    sound.clank();
  }

  /** Past the swap point on the bridge. */
  const BRIDGE_PATH = new Path(BRIDGE.pts);
  function atSwapPoint(p: THREE.Vector3): boolean {
    return onBridge(p) && BRIDGE_PATH.project(p) >= BRIDGE.goalAlong;
  }

  let partnerTeleports = 0;
  /** Partner quality, accumulated over the chase (seconds). */
  const pq = { time: 0, formation: 0, wrongWay: 0, stuck: 0, gapSum: 0, behindSum: 0, sideSum: 0, behind8: 0, tooWide: 0 };

  /**
   * Hard hits on the player's car for play-tests: a velocity jolt over 4 m/s in one
   * physics step (~25 g), blamed on whatever was closest.
   */
  const impacts = { total: 0, cop: 0, partner: 0, vault: 0, other: 0, perMin: 0 };
  let impactVel = new THREE.Vector3();
  let impactCooldown = 0;
  function measureImpacts(dt: number): void {
    const v = player.body.linvel();
    const now = new THREE.Vector3(v.x, 0, v.z);
    const jolt = now.distanceTo(impactVel);
    impactVel = now;
    impactCooldown -= dt;
    if (jolt < 4 || impactCooldown > 0) return;
    impactCooldown = 0.3;
    const p = player.position;
    const near = (q: THREE.Vector3, r: number) => q.distanceTo(p) < r;
    const cause = police.cops.some((c) => near(c.v.position, 6.5))
      ? 'cop'
      : near(partner.position, 5.5)
        ? 'partner'
        : near(vault.position.setY(0), 7)
          ? 'vault'
          : 'other';
    impacts[cause]++;
    impacts.total++;
    impacts.perMin = +(impacts.total / Math.max(1, chaseTime / 60)).toFixed(1);
  }

  /**
   * Getting stuck, for play-tests (seconds): the player pushing but not moving, the
   * vault not moving while the cars pull on it, and the partner far from its place
   * beside the player (plus its average distance from that place).
   */
  const stuck = { time: 0, player: 0, vault: 0, partnerFar: 0, partnerDist: 0 };
  function measureStuck(dt: number): void {
    stuck.time += dt;
    const pushing = player.controls.throttle > 0.5;
    if (pushing && Math.abs(player.forwardSpeed) < 1.5) stuck.player += dt;
    if (pushing && vault.speed < 0.8 && cables.some((c) => c.tension > 20000)) stuck.vault += dt;
    const f = player.forward;
    const slot = player.position.addScaledVector(new THREE.Vector3(f.z, 0, -f.x), -CHARACTERS[character].side * 4.6);
    const d = partner.position.distanceTo(slot);
    stuck.partnerDist += d * dt;
    if (d > 8) stuck.partnerFar += dt;
  }

  function measurePartner(dt: number): void {
    const pf = player.forward;
    const v = partner.body.linvel();
    const gap = player.position.distanceTo(partner.position);
    const moving = Math.abs(player.forwardSpeed) > 5;
    pq.time += dt;
    pq.gapSum += gap * dt;
    const rel = player.position.sub(partner.position);
    const behind = rel.dot(pf);
    const side = Math.abs(rel.dot(new THREE.Vector3(pf.z, 0, -pf.x)));
    pq.behindSum += behind * dt;
    pq.sideSum += side * dt;
    if (behind > 8) pq.behind8 += dt;
    if (side > 9) pq.tooWide += dt;
    if (gap > 2.5 && gap < 11 && pf.dot(partner.forward) > 0.7) pq.formation += dt;
    if (moving && v.x * pf.x + v.z * pf.z < -2) pq.wrongWay += dt;
    if (moving && Math.hypot(v.x, v.z) < 1) pq.stuck += dt;
  }

  /**
   * Debug autopilot used by play-tests: drives its lane like a person would,
   * slowing for corners. 'route' follows the GPS, 'detour' ignores it at
   * random intersections (to test rerouting), 'wander' turns at random.
   */
  let autoPlan: { corner: THREE.Vector3; exit: THREE.Vector3 | null; detour: boolean } | null = null;
  function autopilotControls(dt: number): ControlState {
    if (bridge?.pulling) return { throttle: 1, brake: 0, steer: 0, handbrake: false, nos: true };
    if (bridge?.fighting) {
      // Down the middle of the bridge, swinging the vault at anything that comes near it.
      const s = BRIDGE_PATH.project(player.position);
      const target = BRIDGE_PATH.at(Math.min(BRIDGE_PATH.length - 30, s + 25));
      const vp = vault.position.setY(0);
      const near = police.cops.some((c) => !c.wrecked && c.v.position.distanceTo(vp) < 14) || reyes.suvs.some((x) => !x.wrecked && x.v.position.distanceTo(vp) < 14);
      // A press held for a moment (the flail looks for the press once a frame), now and then.
      autoSwing -= dt;
      if (near && autoSwing < -0.6 && Math.random() < dt * 2.5) autoSwing = 0.2;
      const c = seek(world, player, target, 0.75);
      return { ...c, handbrake: autoSwing > 0 };
    }
    const p = player.position;
    const d = roadDir(p, player.forward);
    const side = CHARACTERS[character].side;
    let path: Path;
    if (autopilot === 'route') {
      // Follow the GPS line along the streets, in our lane.
      path = gps.path(p);
      const ahead = path.at(15);
      if (ahead.clone().sub(p).setY(0).normalize().dot(player.forward) < -0.3) return seek(world, player, ahead, 0.6);
    } else {
      // 'detour' disobeys the GPS at about a third of the intersections; 'wander' turns at random.
      if (autoPlan && (!autoPlan.exit || p.clone().sub(autoPlan.corner).dot(autoPlan.exit) > 14)) autoPlan = null;
      if (!autoPlan) {
        const corner = nextIntersection(p, d);
        if (corner) {
          const options = exits(corner, d);
          const gpsExit = routeExit(corner, d, gps.nodes);
          const others = options.filter((o) => !gpsExit || o.dot(gpsExit) < 0.9);
          const exit =
            autopilot === 'wander'
              ? options[Math.floor(Math.random() * options.length)]
              : others.length && Math.random() < 0.35
                ? others[Math.floor(Math.random() * others.length)]
                : gpsExit;
          autoPlan = { corner, exit: exit ?? null, detour: !!exit && !!gpsExit && exit.dot(gpsExit) < 0.9 };
        }
      }
      path = lanePath(p, d, 0, autoPlan?.corner ?? null, autoPlan?.exit ?? null);
    }
    // Follow the hints like a player would: aim for the spike-strip gap, handbrake at the bank.
    // Otherwise keep to our side of the street, nearer the middle where it's narrow.
    const street = MAP.locate(p, d)?.edge;
    const gap = spikes?.gapOffset() ?? null;
    const lineup = swap?.lineupOffset() ?? null;
    const want = gap !== null && d.dot(SPIKES.z) > 0.9 ? gap : lineup !== null && inTunnel(p, 60) ? lineup : side * THREE.MathUtils.clamp((street?.hw ?? 5) - 2.4, 0, 3);
    // Change lanes gradually, as a driver would with four tons behind them.
    autoLane += THREE.MathUtils.clamp(want - autoLane, -2.5 * dt, 2.5 * dt);
    const lane = autoLane;
    const bankSwing = autopilot !== 'wander' && p.distanceTo(BANK.corner) < 24 && player.forward.dot(BANK.frame.z) > 0.3;
    const s0 = path.project(p);
    const speed = player.forwardSpeed;
    const look = s0 + 10 + Math.abs(speed) * 0.4;
    const target = path.at(look).addScaledVector(leftOf(path.tangent(look)), lane);
    const fast = onBridge(p) ? 45 : (street?.rank ?? 5) <= 1 ? 38 : 28;
    // Slow for bends and turns ahead, as a driver would (real streets curve).
    const vTarget = Math.min(fast, Math.max(9, curveSpeed(path, s0, 80, 5.5)));
    const err = vTarget - speed;
    const steer = THREE.MathUtils.clamp(angleTo(player, target) * 2.4, -1, 1);
    // Nosed into something: back up with the wheel the other way, as a person would, then go again.
    if (autoReverse > 0) {
      autoReverse -= dt;
      return { throttle: 0, brake: 1, steer: -autoReverseSteer, handbrake: false };
    }
    autoBlocked = Math.abs(speed) < 1 && err > 3 ? autoBlocked + dt : 0;
    if (autoBlocked > 1.2) {
      autoBlocked = 0;
      autoReverse = 1.1;
      autoReverseSteer = steer >= 0 ? 1 : -1;
    }
    return {
      throttle: THREE.MathUtils.clamp(err * 0.3, 0, 1),
      // Progressive braking: stamping on the brakes lets the vault slide into you.
      brake: err < -2 ? THREE.MathUtils.clamp(-err * (err < -8 ? 0.15 : 0.07), 0, 1) : 0,
      steer,
      handbrake: bankSwing,
    };
  }
  let autoSwing = 0;
  let autoBlocked = 0;
  let autoReverse = 0;
  let autoReverseSteer = 1;
  let autoLane = 0;

  /** Put the partner back in its place beside the player, in a puff of dust if it's on screen. */
  function recoverPartner(): void {
    const spot = partnerAi.recoveryPoint(player);
    if (!spot) return;
    if (isVisible(partner.position)) fx.puff(partner.position, 8);
    partner.place(spot.pos, spot.heading);
    const v = player.body.linvel();
    partner.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
    if (isVisible(spot.pos)) fx.puff(spot.pos, 8);
    partnerTeleports++;
  }

  /**
   * A car caught inside the rig, between the hero cars or between them and the vault,
   * would stop the convoy dead (rig.ts): it's wrecked and thrown out of the side. So
   * is a parked car shoved in there (lighter props just get plowed aside).
   */
  /**
   * Cops and traffic can't knock the hero cars about: a hero car that touched one in
   * the physics step keeps only part of the velocity the contact gave it, as if it were
   * several times heavier (the other car takes the full hit). A ram is a shove you drive
   * through. `before` is each hero's velocity going into the step.
   */
  const SHOVE_KEPT = 0.3;
  function steadyHeroes(before: { car: Vehicle; v: RAPIER.Vector; w: RAPIER.Vector }[]): void {
    if (!before.length) return;
    const rammers = new Set<number>();
    for (const c of police.cops) rammers.add(c.v.collider.handle);
    for (const c of traffic.cars) rammers.add(c.v.collider.handle);
    for (const s of reyes.suvs) rammers.add(s.v.collider.handle);
    for (const { car, v, w } of before) {
      let hit = false;
      world.contactPairsWith(car.collider, (other) => {
        if (hit || !rammers.has(other.handle)) return;
        world.contactPair(car.collider, other, (m) => {
          if (m.numContacts() > 0) hit = true;
        });
      });
      if (!hit) continue;
      const nv = car.body.linvel();
      const nw = car.body.angvel();
      car.body.setLinvel({ x: v.x + (nv.x - v.x) * SHOVE_KEPT, y: nv.y, z: v.z + (nv.z - v.z) * SHOVE_KEPT }, true);
      car.body.setAngvel({ x: nw.x, y: w.y + (nw.y - w.y) * SHOVE_KEPT, z: nw.z }, true);
    }
  }

  let heavyProps: Prop[] | null = null;
  function clearRig(): void {
    if (!rig.frame(partnerAi.released ? [player] : [player, partner], vault)) return;
    const v = player.body.linvel();
    const convoy = new THREE.Vector3(v.x, 0, v.z);
    for (const c of police.cops) {
      const out = rig.inside(c.v.position);
      if (!out || rig.isThrown(c.v.collider)) continue;
      if (!c.wrecked) police.wreck(c, null);
      rig.throwOut(c.v.body, c.v.collider, out, convoy);
    }
    for (const c of traffic.cars) {
      const out = rig.inside(c.v.position);
      if (!out || rig.isThrown(c.v.collider)) continue;
      if (!c.loose) traffic.wreck(c, null);
      rig.throwOut(c.v.body, c.v.collider, out, convoy);
    }
    heavyProps ??= city.props.filter((p) => p.heavy);
    for (const p of heavyProps) {
      if (p.body.isSleeping()) continue;
      const t = p.body.translation();
      const out = rig.inside(new THREE.Vector3(t.x, 0, t.z));
      const collider = p.body.collider(0);
      if (!out || rig.isThrown(collider)) continue;
      rig.throwOut(p.body, collider, out, convoy);
    }
    rig.step();
  }

  const frustum = new THREE.Frustum();
  const isVisible = (p: THREE.Vector3) => camera.position.distanceTo(p) < 160 && frustum.containsPoint(p.clone().setY(1));

  // ----------------------------------------------------------- physics

  function physicsStep(dt: number): void {
    const driving = state === 'breach' || state === 'chase';
    const hold: ControlState = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    const auto = autopilot ? (state === 'chase' ? autopilotControls(dt) : seek(world, player, new THREE.Vector3(200, 0, 300), 0.9)) : null;
    player.controls = driving ? (auto ?? input.controls()) : hold;
    // Keyboard steering eases in; an analog stick is already smooth, so it gets a quick response.
    player.steerRate = input.analog && !auto ? { in: 14, out: 14 } : { in: 5, out: 12 };
    if (state === 'chase' && player.controls.handbrake) lastSwingAt = chaseTime;
    const nosOn = driving && !!player.controls.nos && nos > 0.02;
    player.nosActive = nosOn;
    if (nosOn) nos = Math.max(0, nos - dt * 0.3);
    else if (driving) nos = Math.min(1, nos + dt * 0.012);
    player.step(dt);
    if (state === 'chase') {
      // The partner flies in formation beside the player (partner.ts).
      partnerAi.drive(dt, { player, me: partner, hazards: spikes?.obstacles() ?? [] });
      if (partnerAi.wantsRecovery) recoverPartner();
    } else {
      // Ripping the vault out of the station, the partner floors it with the player.
      partner.controls = state === 'breach' ? { ...player.controls, nos: false } : hold;
      partner.step(dt);
    }

    if (state === 'chase') {
      reyes.step(dt, player, vault, (p) => bridge?.railOf(p) ?? null);
      bridge?.step(dt);
      allies?.step(dt);
      bus.step(dt, player, [partner, vault]);
    }
    if (state === 'chase' && !noCops && !policeHeld) {
      police.step(dt, player, vault, heat, onBridge(player.position));
    } else if (state === 'outro' || state === 'busted' || state === 'lost') {
      police.step(dt, player, vault, heat, onBridge(player.position));
    }

    if (state === 'chase' || state === 'outro' || state === 'busted' || state === 'lost') {
      const vv = vault.body.linvel();
      const blockers = [player.position, partner.position, ...police.cops.map((c) => c.v.position)];
      traffic.step(dt, player.position, player.forward, blockers, { pos: vault.position.setY(0), vel: new THREE.Vector3(vv.x, 0, vv.z) }, state === 'chase');
    }
    if (state === 'chase') clearRig();

    // Swung on purpose (the handbrake, the throw at the bank): leave the vault be.
    const swinging = player.controls.handbrake || !!bankJob?.flinging || !!bridge?.flinging;
    if ((state === 'chase' || state === 'outro') && !swinging) vault.overrun(dt, partnerAi.released ? [player] : [player, partner]);
    if (state === 'chase') {
      // The vault follows the road the cars drove (unless the player swings it), and never stays wedged.
      const pulled = cables.some((c) => c.tension > 30000);
      vault.followTrail(dt, partnerAi.playerTrail, partnerAi.released ? 0 : partnerAi.thoughts.beside * 0.5 * -CHARACTERS[character].side, swinging, pulled);
      if (vault.wantsRescue) rescueVault();
    }
    if (state === 'chase' || state === 'outro') for (const c of cables) c.reel(CABLE_TOW_LENGTH, dt);
    for (const c of cables) c.step(dt);
    if (state === 'chase') bankJob?.step(dt);
    const heroes = state === 'chase' ? [player, partner].map((car) => ({ car, v: car.body.linvel(), w: car.body.angvel() })) : [];
    world.step();
    steadyHeroes(heroes);
    if (state === 'chase') {
      measurePartner(dt);
      measureImpacts(dt);
      measureStuck(dt);
    }
  }

  // ----------------------------------------------------------- game flow

  function startGameplay(): void {
    cutscene = null;
    overhead.reset(player.heading);
    enter('breach');
    breach.shooting = true;
    hud.showHud(true);
    hud.radio('MIA', 'Floor it! Pull that vault out of there!');
    pull?.start();
  }

  function updateGame(dt: number): void {
    stateTime += dt;
    if (state === 'cutscene') {
      if (input.wasPressed('Enter') || input.wasPressed('Escape')) cutscene?.skip();
      return;
    }

    if (state === 'breach') pull?.update(dt);
    if (state === 'chase') {
      spikes?.update(dt);
      bankJob?.update(dt);
      swap?.update(dt);
      allies?.update(dt, chaseTime);
      bridge?.update(dt);
      roadblock?.update(dt);
      placeRoadblock();
    }

    if (state === 'breach' && vault.position.x > STATION_FACADE_X + 3) {
      enter('chase');
      breach.shooting = false;
      breach.covering = false;
      heat = 1;
      say('MIA', 'It’s out! Every cop in Rio is coming. Follow my route, or find your own. I’ll guide you.');
      startChase();
      // Debug: ?at=bridge skips to the foot of the bridge (for testing the finale), ?at=split to 60 m
      // short of where the crew splits up on it, ?at=tunnel to 130 m short of the tunnel, ?at=bank to
      // the avenue 150 m short of the bank's corner. Past the tunnel, the swap has happened.
      const at = params.get('at');
      if (at === 'bridge' || at === 'split') {
        const s = at === 'bridge' ? 25 : SPLIT_AT - 60;
        placeConvoy(BRIDGE_PATH.at(s), BRIDGE_PATH.tangent(s));
        swap?.skipAhead();
      }
      if (at === 'fight' || at === 'finale') {
        placeConvoy(BRIDGE_PATH.at(SPLIT_AT + 5), BRIDGE_PATH.tangent(SPLIT_AT + 5));
        swap?.skipAhead();
        bridge?.debugCharge();
        // ?at=finale: Reyes up close at once, and the last swing lands a moment later.
        if (at === 'finale') bridge?.debugLast();
      }
      if (at === 'tunnel') {
        const road = new Path(TUNNEL.road);
        const s = road.project(TUNNEL.frame.origin) - 130;
        placeConvoy(road.at(s), road.tangent(s));
      }
      if (at === 'bank' || at === 'bus') {
        // ?at=bus: 150 m short of the crossing where the bus pulls out.
        const mark = at === 'bus' ? bus.at : BANK.corner;
        const k = mark ? PLAN.findIndex((n) => n.pos.distanceTo(mark) < 5) : -1;
        const edge = k > 0 ? MAP.between(PLAN[k - 1], PLAN[k]) : null;
        if (edge) {
          const avenue = new Path(MAP.from(edge, PLAN[k - 1]));
          const s = Math.max(20, avenue.length - 150);
          placeConvoy(avenue.at(s), avenue.tangent(s));
        }
      }
    }

    if ((state === 'breach' || state === 'chase') && inWater()) {
      enter('lost');
      coach.stop();
      run.fail();
      hud.showOverlay(
        'VAULT LOST',
        `The vault went over the side and into the bay.\nReyes’s money is at the bottom of Guanabara Bay.\n\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`,
        'Press Enter to try again',
      );
      hud.result(null);
    }

    if (input.wasPressed('KeyC')) view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
    if (state === 'chase') {
      chaseTime += dt;
      trackRun(dt);
      if (input.wasPressed('KeyR')) resetConvoy();
      const newDamage = city.collectDamage() + traffic.collectDamage();
      if (newDamage > 0) sound.crash(Math.min(1, newDamage / 15000) * 0.6);
      damage += newDamage;
      streetDamage += newDamage;
      heat = Math.min(5, 1 + Math.floor(chaseTime / 50) + Math.floor(streetDamage / 300000) + Math.floor(police.wreckedCount / 10));

      gps.update(dt, player.position, travelDir());
      calloutTurn();

      // No getting boxed in during the fight on the bridge: it's head-on, and it's the finale.
      const pinned = !bridge?.fighting && police.closeTo(player.position, 9) >= 2 && Math.abs(player.forwardSpeed) < 4;
      busted = THREE.MathUtils.clamp(busted + (pinned ? dt / 3.5 : -dt / 2), 0, 1);
      if (busted >= 1) {
        enter('busted');
        coach.stop();
        run.fail();
        hud.showOverlay('BUSTED', `They boxed you in.\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}   Style: ${style.toLocaleString('en-US')}`, 'Press Enter to try again');
        hud.result(null);
      }

      if (atSwapPoint(player.position) && !bridge?.fighting && bridge?.state !== 'done') {
        enter('outro');
        run.stats.finished = true;
        coach.stop();
        director.slowmo(0.35, 1.6);
        hud.radio('MIA', swap?.done ? 'That’s far enough. Leave it for them. It’s empty anyway.' : 'You made it. Kill the engines.');
        setTimeout(() => hud.news(swap?.done ? NEWS.empty : NEWS.finish), 1400);
      }
    }

    // After the last scene the end screen comes straight up; reaching the gantry, after a look round.
    const endsAt = finale ? 0.3 : 4;
    if (state === 'outro' && stateTime > endsAt && stateTime - dt <= endsAt) {
      const stats = `Time ${Hud.time(chaseTime)}   Cops wrecked ${police.wreckedCount}   Property damage ${Hud.money(damage)}   Style ${style.toLocaleString('en-US')}`;
      if (finale?.decoy) {
        hud.showOverlay(
          'PAYDAY',
          'Reyes went down on the bridge, and the safe the police opened there was empty.\n' +
            'The real one came home in a garbage truck. Hobbs gave you a day’s head start: use it.\n\n' +
            stats,
          'Press Enter to play again',
        );
      } else if (finale) {
        hud.showOverlay('SO CLOSE', 'Reyes went down on the bridge, but the safe was the real one, and Hobbs has it now.\nNext time, make the swap in the tunnel.\n\n' + stats, 'Press Enter to play again');
      } else if (swap?.done) {
        hud.showOverlay(
          'THE DECOY',
          'Every cop in Rio chased that vault across the bridge, and it was empty.\n' +
            'Han and Roman had the real one in their truck, back in the tunnel, while the whole city watched the chase.\n\n' +
            stats,
          'Press Enter to play again',
        );
      } else {
        hud.showOverlay(
          'THE SWAP',
          'While every cop in Rio chased that vault, Roman and Han swapped it for an empty decoy.\nReyes’s money was already gone.\n\n' + stats,
          'Press Enter to play again',
        );
      }
      hud.result(run.finish());
    }
    if ((state === 'busted' || state === 'lost' || (state === 'outro' && stateTime > endsAt)) && input.wasPressed('Enter')) {
      const url = new URL(location.href);
      url.searchParams.set('crew', character);
      location.href = url.toString();
    }
  }

  /** The vault is out of the station: the news picks it up and its helicopter comes. */
  function startChase(): void {
    hud.news(NEWS.breakout);
    // In from the top of the screen, high up, so it arrives during the pull-out.
    const up = camLook.clone().sub(camPos).setY(0).normalize();
    chopper.launch(player.position.addScaledVector(up, 240).setY(75), vault.position);
    establishPending = true;
    coach.start(run.previousRuns < 2, run.challenges.map((c) => c.text));
  }

  let lastHeat = 1;
  let reachedBridge = false;
  let establishPending = false;
  /**
   * Getting nowhere: seconds with a pedal down without leaving a circle this big (m)
   * around `stuckAt` (wide enough that rocking back and forth against a wall counts).
   */
  const STUCK_RADIUS = 8;
  const stuckAt = new THREE.Vector3();
  let stuckFor = 0;
  const challengeCallouts: string[] = [];

  /** Per frame of the chase: the run's stats, challenge callouts, news, the bridge shot and coaching. */
  function trackRun(dt: number): void {
    const s = run.stats;
    s.time = chaseTime;
    s.wrecked = police.wreckedCount;
    s.damage = damage;
    s.style = style;
    if (player.nosActive) s.nosSeconds += dt;
    s.topSpeedKmh = Math.max(s.topSpeedKmh, Math.abs(player.forwardSpeed) * 3.6);
    s.maxHeat = Math.max(s.maxHeat, heat);
    s.bank = !!bankJob?.smashed;
    s.spikesClean = !!spikes?.clean;
    s.tireLost ||= !!spikes?.playerBlown;
    for (const c of run.newlyDone()) challengeCallouts.push(c.text);
    if (challengeCallouts.length && !hud.bannerBusy) {
      hud.banner('CHALLENGE COMPLETE', challengeCallouts.shift()!.toUpperCase(), 2);
      sound.ping(1568, 0.14, 0.5);
    }
    if (heat > lastHeat) {
      lastHeat = heat;
      const item = NEWS.heat[heat];
      // On the bridge the story is the bridge.
      if (item && !onBridge(player.position)) hud.news(item);
    }
    // The pull-out once the breakout's own slow-motion shot is over.
    if (establishPending && !director.busy && chaseTime > 0.6) {
      establishPending = false;
      establishingShot(3.4, 2.4, camera.fov + 4);
    }
    if (!reachedBridge && onBridge(player.position)) {
      reachedBridge = true;
      if (!director.busy) bridgeShot();
      hud.news(NEWS.bridge);
    }
    // Stuck: pedal down, but still within a few meters of where the clock started.
    const p = player.position;
    if (p.distanceTo(stuckAt) > STUCK_RADIUS) {
      stuckAt.copy(p);
      stuckFor = 0;
    } else if ((player.controls.throttle > 0.3 || player.controls.brake > 0.3) && !bridge?.pulling) {
      stuckFor += dt;
    }
    const boxedIn = busted > 0.2;
    coach.update(dt, { boxedIn, stuck: !boxedIn && stuckFor > 3 });
    // Still wedged after the tip: put the crew back on the road rather than leave the player stuck.
    if (stuckFor > 6 && !boxedIn) {
      stuckFor = 0;
      fx.puff(p, 10);
      resetConvoy();
      fx.puff(player.position, 10);
    }
  }

  /** The vault or either car has fallen off the bridge or the seawall. */
  function inWater(): boolean {
    return [vault.body, player.body, partner.body].some((b) => b.translation().y < -1.5);
  }

  function say(who: string, line: string): void {
    hud.radio(who, line);
    voice.speak(who, line);
  }

  /** Direction the player is really going: their velocity when driving forward, else where they point. */
  function travelDir(): THREE.Vector3 {
    const v = player.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    return speed > 4 && player.forwardSpeed > 2 ? new THREE.Vector3(v.x / speed, 0, v.z / speed) : player.forward;
  }

  const turnKey = (t: Turn) => `${t.at.x},${t.at.z}`;
  function turnLine(turn: Turn | null): string {
    if (!turn) return 'Straight on to the bridge.';
    if (turn.distance > 130) return 'Stay on this street for now.';
    return turn.side === 'left' ? 'Hang a left at the next corner!' : 'Go right at the next corner!';
  }

  const REROUTE_LINES = ['Okay, new route.', 'That works too. Rerouting.', 'Not my way, but fine. Rerouting.', 'Change of plan. Recalculating.'];
  gps.onReroute = () => {
    if (state !== 'chase' || chaseTime - lastReroute < 8) return;
    lastReroute = chaseTime;
    const turn = gps.nextTurn(player.position, travelDir());
    if (turn && turn.distance <= 130) calledTurn = turnKey(turn);
    say('MIA', `${REROUTE_LINES[gps.reroutes % REROUTE_LINES.length]} ${turnLine(turn)}`);
  };

  /** Mia calls the next turn on the GPS route as the player approaches it. */
  function calloutTurn(): void {
    const p = player.position;
    if (!bridgeCalled && gps.nodes[0] === BRIDGE_FOOT_POS && p.distanceTo(BRIDGE_FOOT_POS) < 110) {
      bridgeCalled = true;
      say('MIA', swap?.done ? 'Bridge ahead. Drag that decoy across, and make it look good.' : 'Bridge ahead. Get to the yellow gantry at the far end.');
      return;
    }
    const turn = gps.nextTurn(p, travelDir());
    if (!turn || turn.at !== gps.nodes[0] || turn.distance > 100 || turn.distance < 25) return;
    if (turnKey(turn) === calledTurn) return;
    calledTurn = turnKey(turn);
    say('MIA', turn.side === 'left' ? 'Next intersection, hang a left!' : 'Next intersection, go right!');
  }

  // ----------------------------------------------------------- big moments

  /**
   * The camera pulls up and out from the overhead view and back down again over
   * `seconds`, still following the player: the whole street, the cops closing in
   * and the helicopter arriving, without taking the wheel away.
   */
  function establishingShot(seconds: number, scale: number, fovTo: number): void {
    const offset = camPos.clone().sub(camLook);
    const lead = camLook.clone().sub(player.position).setY(0);
    const fov0 = camera.fov;
    director.play({
      duration: seconds,
      frame: (k) => {
        // Out, hold, then back in: 0 -> 1 -> 0, eased at both ends.
        const out = k < 0.4 ? Math.sin((k / 0.4) * Math.PI * 0.5) : k < 0.65 ? 1 : Math.cos(((k - 0.65) / 0.35) * Math.PI * 0.5);
        const look = player.position.setY(0).add(lead);
        const pos = look.clone().addScaledVector(offset, 1 + (scale - 1) * out * out);
        return { pos, look, fov: fov0 + (fovTo - fov0) * out };
      },
    });
  }

  /** A slow-motion look at a cruiser as it's wrecked, from the street beside it. */
  function wreckShot(car: Vehicle): void {
    const at = car.position.setY(1);
    // From the side the overhead camera is on (so the shot reads), wherever the street is clear.
    const toCam = camPos.clone().sub(at).setY(0).normalize();
    let best = toCam;
    let bestClear = -1;
    for (const a of [0, 0.7, -0.7, 1.4, -1.4]) {
      const d = toCam.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      const c = clearance(at, at.clone().addScaledVector(d, 11).setY(2));
      if (c > bestClear + 0.05) {
        best = d;
        bestClear = c;
      }
    }
    const dist = Math.max(5, 11 * bestClear);
    const from = at.clone().addScaledVector(best, dist).setY(2.6);
    const to = at.clone().addScaledVector(best, dist * 0.75).setY(3.6);
    director.slowmo(0.28, 1.25);
    director.play({ duration: 1.25, frame: (k) => ({ pos: from.clone().lerp(to, k), look: car.position.setY(0.9), fov: 50 }) });
  }

  /** Side-on from over the water as the convoy hits the bridge, in slow motion. */
  function bridgeShot(): void {
    const p = player.position;
    const s = BRIDGE_PATH.project(p);
    const t = BRIDGE_PATH.tangent(s);
    const side = new THREE.Vector3(t.z, 0, -t.x);
    // Whichever side the overhead camera is already on.
    if (side.dot(camPos.clone().sub(p)) < 0) side.negate();
    const from = p.clone().addScaledVector(side, 34).addScaledVector(t, 30).setY(5);
    const to = p.clone().addScaledVector(side, 30).addScaledVector(t, 48).setY(7);
    director.slowmo(0.45, 2.4);
    director.play({ duration: 2.6, frame: (k) => ({ pos: from.clone().lerp(to, k), look: player.position.add(vault.position).multiplyScalar(0.5).setY(1.5), fov: 42 }) });
  }

  /** On the bridge: the partner's cable comes off and they peel away; the player tows the vault alone. */
  function cutLoose(): void {
    const i = cables.findIndex((c) => c.car === partner);
    if (i < 0) return;
    fx.burst(partner.towPoint(), 0.8);
    sound.clank();
    cables[i].dispose(scene);
    cables.splice(i, 1);
    partnerAi.released = true;
    // One car on four tons now: enough extra power to keep the pace.
    player.assist = 1.3;
  }

  /**
   * A roadblock broken (mid-chase, or the wall on the bridge): slow motion, low at the
   * impact as the cruisers go flying, then high over the wreckage; the vault, if it's
   * what hit them, bounds over the top. Every cruiser in it counts as a takedown.
   */
  function blockadeBust(at: THREE.Vector3, cars: Prop[], finale: boolean): void {
    const dir = player.forward;
    const side = leftOf(dir);
    const low = at.clone().addScaledVector(side, 11).addScaledVector(dir, 8).setY(1.6);
    const high = at.clone().addScaledVector(dir, -16).addScaledVector(side, -9).setY(21);
    director.slowmo(0.22, 2.7);
    director.shake = 1.3;
    director.playAll([
      { duration: 1.2, frame: (k) => ({ pos: low.clone().addScaledVector(dir, -k * 2.5), look: at.clone().setY(1.1), fov: 44 }) },
      { duration: 1.6, frame: (k) => ({ pos: high.clone().addScaledVector(dir, k * 7), look: at.clone().addScaledVector(dir, 5).setY(0.5), fov: 40 }) },
    ]);
    // The cruisers near the impact go flying, thrown on along the way the convoy was going.
    for (const c of cars) {
      const t = c.body.translation();
      const away = new THREE.Vector3(t.x - at.x, 0, t.z - at.z);
      const k = 1 - Math.min(1, away.length() / 14);
      if (k <= 0) continue;
      away.normalize();
      const m = c.body.mass();
      c.body.wakeUp();
      c.body.applyImpulse({ x: (away.x * 6 + dir.x * 7) * m * k, y: m * (2.5 + 4.5 * k), z: (away.z * 6 + dir.z * 7) * m * k }, true);
      c.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * m * 7 * k, y: (Math.random() - 0.5) * m * 3, z: (Math.random() - 0.5) * m * 7 * k }, true);
    }
    sound.crash(1.5);
    sound.bang();
    fx.burst(at.clone().setY(1), 1.8);
    fx.puff(at, 14);
    if (vault.position.setY(0).distanceTo(at) < 9) {
      const v = vault.body.linvel();
      vault.body.setLinvel({ x: v.x, y: 4.5, z: v.z }, true);
    }
    police.wreckedCount += cars.length;
    if (!finale) roadblockDone = chaseTime;
    const bonus = finale ? 2500 : 1500;
    style += bonus + cars.length * 100;
    nos = Math.min(1, nos + 0.5);
    input.rumble(1, 400);
    hud.banner(finale ? 'BLOCKADE BUSTED' : 'ROADBLOCK BUSTED', `${cars.length} CRUISERS  +${bonus + cars.length * 100}`, 2.4);
    setTimeout(() => hud.news(finale ? NEWS.blockade : NEWS.roadblock), 2200);
    if (finale) setTimeout(() => say('MIA', 'You’re through! The gantry’s dead ahead!'), 3000);
  }

  /**
   * Once the heat is up: a roadblock across Mia's route, set up out of sight at the
   * end of a long straight (never near the spike strip, the bank or the bridge), and
   * another a while after each one is busted or left behind.
   */
  const ROADBLOCK_EVERY = 70;
  let roadblockDone = -Infinity;
  let roadblockHinted = false;
  function placeRoadblock(): void {
    if (!roadblock || !momentCtx) return;
    if (roadblock.state === 'set') {
      const ahead = roadblock.ahead(player.position);
      // Gone round it, or left it far behind: take it down, and set up another one later.
      if (ahead < -60 || roadblock.at.distanceTo(player.position) > 400) {
        roadblock.clear();
        roadblockDone = chaseTime;
        if (roadblockHinted) hud.hint('');
        roadblockHinted = false;
        return;
      }
      // Only on a change, so other set pieces' hints aren't wiped every frame.
      const near = ahead > 0 && ahead < 200;
      if (near !== roadblockHinted) hud.hint(near ? 'RAM THE ROADBLOCK  —  OR SWING THE VAULT INTO IT (SPACE)' : '');
      roadblockHinted = near;
      return;
    }
    if (chaseTime - roadblockDone < ROADBLOCK_EVERY || policeHeld) return;
    // The last one's wreckage stays where it is; the next is a new one.
    if (roadblock.state === 'busted') roadblock = new Roadblock(momentCtx, (at, cars) => blockadeBust(at, cars, false));
    // Debug: ?roadblock sets one up as soon as there's a straight for it.
    if ((heat < 2 || chaseTime < 50) && !params.has('roadblock')) return;
    const p = player.position;
    if (onBridge(p)) return;
    const path = gps.path(p);
    const s = 170;
    const turn = gps.nextTurn(p, travelDir());
    if (path.length < s + 120 || (turn && turn.distance < s + 30)) return;
    const at = path.at(s);
    const dir = path.tangent(s);
    if (isVisible(at) || at.distanceTo(BANK.corner) < 160 || at.distanceTo(SPIKES.origin) < 160 || onBridge(at) || inTunnel(at, 150)) return;
    const fix = MAP.locate(at, dir);
    if (!fix || fix.edge.bridge) return;
    const width = Math.max(8, fix.edge.hw * 2 - 1.5);
    roadblock.set(fix.point, dir, width, THREE.MathUtils.clamp(Math.round(width / 3.6), 3, 6));
    say('MIA', 'Roadblock dead ahead! Don’t stop, smash right through it!');
  }

  /**
   * Takedowns: a banner for the first and for streaks (wrecks within a few seconds of
   * each other), slow motion for the big ones, the news at milestones.
   */
  const WRECK_MILESTONES = [10, 25, 50, 75, 100];
  const STREAK_WINDOW = 3;
  const STREAK_CALLOUTS: Record<number, string> = { 2: 'DOUBLE TAKEDOWN', 3: 'TRIPLE TAKEDOWN', 5: 'RAMPAGE' };
  /** A cruiser wrecked by a deliberate swing (the vault hit it within this long of the handbrake, s) is worth more. */
  const SWING_WINDOW = 2;
  const SWING_BONUS = 150;
  const BIKE_BONUS = 50;
  let lastWreckAt = -10;
  let streak = 0;
  let lastWreckShot = -100;
  let lastSwingAt = -10;
  function takedown(at: THREE.Vector3, car: Vehicle, byVault: boolean): void {
    if (state !== 'chase') return;
    streak = chaseTime - lastWreckAt < STREAK_WINDOW ? streak + 1 : 1;
    lastWreckAt = chaseTime;
    run.stats.bestStreak = Math.max(run.stats.bestStreak, streak);
    const n = police.wreckedCount;
    // Each wreck in a streak is worth a little more, up to a cap.
    const bonus = Math.min(4, streak - 1) * 75;
    style += bonus;
    // Swung into it on purpose: the move the whole game is built around.
    const swung = byVault && chaseTime - lastSwingAt < SWING_WINDOW;
    if (swung) style += SWING_BONUS;
    // A bike's worth a little more: they're quick and hard to catch.
    const bike = police.isBike(car);
    if (bike) style += BIKE_BONUS;
    if (STREAK_CALLOUTS[streak]) {
      hud.banner(STREAK_CALLOUTS[streak], `+${bonus + (swung ? SWING_BONUS : 0)}`, 1.3);
    } else if (bike && !hud.bannerBusy && isVisible(at)) {
      hud.banner('BIKE DOWN', `+${100 + BIKE_BONUS + (swung ? SWING_BONUS : 0)}`, 1.2);
    } else if (n === 1) {
      hud.banner('TAKEDOWN', 'WRECKED COPS REFILL YOUR NITROUS  +100', 1.8);
    } else if (swung && !hud.bannerBusy) {
      hud.banner('VAULT SWING', `+${SWING_BONUS + 100}`, 1.1);
    }
    if (WRECK_MILESTONES.includes(n)) hud.news(wreckNews(n));
    // The first wreck, a swing or a triple now and then, and otherwise one every minute or so: slow motion is a treat.
    const since = chaseTime - lastWreckShot;
    const due = n === 1 || (swung && since > 25) || (streak === 3 && since > 30) || since > 75;
    if (due && !director.busy && isVisible(at)) {
      lastWreckShot = chaseTime;
      wreckShot(car);
    } else if (!director.busy && isVisible(at) && at.distanceTo(player.position) < 35) {
      // Hit-stop: the world all but freezes for a beat as it connects (only for the ones you see).
      director.hitStop(0.07);
    }
  }

  // ----------------------------------------------------------- per-frame effects

  /** Sparks and screech while the vault drags on the asphalt; crunch on hard player impacts. */
  function updateEffects(dt: number): number {
    const v = vault.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    const grounded = vault.body.translation().y < 1.6;
    const drag = grounded && cables.length ? speed : 0;
    if (drag > 2) {
      const q = vault.body.rotation();
      const rot = new THREE.Quaternion(q.x, q.y, q.z, q.w);
      const base = vault.position;
      for (const corner of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) {
        if (Math.random() > Math.min(1, drag / 20)) continue;
        const p = new THREE.Vector3(corner[0], -1.2, corner[1]).applyQuaternion(rot).add(base);
        fx.scrape(p.setY(0.08), new THREE.Vector3(v.x, 0, v.z), drag / 15);
      }
      if (Math.random() < dt * 2) fx.puff(base.clone().setY(0), 1);
    }
    if (player && (state === 'breach' || state === 'chase' || state === 'outro')) {
      let playerSlip = 0;
      for (const [k, car] of [player, partner].entries()) {
        const speed = Math.abs(car.forwardSpeed);
        const slide = THREE.MathUtils.clamp((Math.abs(car.lateralSpeed) - 3) / 6, 0, 1);
        const handbrake = car.controls.handbrake && speed > 6 ? 0.7 : 0;
        const slip = Math.max(slide, handbrake, car.wheelspin * 0.9);
        if (k === 0) playerSlip = slip;
        car.rearWheels().forEach((w, i) => {
          if (slip > 0.15) {
            fx.tireSmoke(w, slip, new THREE.Vector3(car.body.linvel().x, 0, car.body.linvel().z));
            if (speed > 2) fx.skids.mark(`${k}-${i}`, w);
          } else {
            fx.skids.mark(`${k}-${i}`, null);
          }
          // Blown tire: the rim grinds on the asphalt.
          if (car.tireBlown > 0 && speed > 3 && i === 0 && Math.random() < 0.6) fx.scrape(w.setY(0.1), new THREE.Vector3(car.body.linvel().x, 0, car.body.linvel().z), 0.6);
        });
      }
      if (player.nosActive) for (const e of player.exhausts()) fx.nosFlame(e, player.forward.negate());
      if (player.nosActive && !nosWasOn) sound.whoosh();
      nosWasOn = player.nosActive;
      sound.tires(playerSlip, player.nosActive);
      const s = Math.abs(player.forwardSpeed);
      if (lastPlayerSpeed - s > 7) {
        sound.crash(Math.min(1, (lastPlayerSpeed - s) / 20));
        input.rumble(Math.min(1, (lastPlayerSpeed - s) / 20));
        fx.burst(player.position.addScaledVector(player.forward, 2.5).setY(0.8), 0.5);
      }
      lastPlayerSpeed = s;
    }
    return drag;
  }

  /**
   * Light and shade on the road (groundfx.ts): lamp pools, headlights, brake
   * lights, police strobes, nitrous and vault sparks, and contact shadows.
   */
  function paintGround(drag: number): void {
    groundFx.begin();
    groundFx.viewFrom(camera.position, camLook);
    // Mia's route, painted on the road ahead.
    // Lining up for the swap, the line to drive instead.
    const guide = state === 'chase' ? swap?.guide() : null;
    if (guide) groundFx.route(guide, performance.now() / 1000);
    else if (player && state === 'chase' && gps.nodes.length) groundFx.route(gps.path(player.position), performance.now() / 1000);
    if (player && state !== 'select') {
      // Everything within reach of the street light map (see streetlight.ts).
      const near = (p: THREE.Vector3) => Math.abs(p.x - camLook.x) < 200 && Math.abs(p.z - camLook.z) < 200;
      const lit: THREE.Vector3[] = [];
      for (const lamp of city.lamps) {
        if (!near(lamp.position)) continue;
        const head = LAMP_HEAD.clone().applyQuaternion(lamp.quaternion).add(lamp.position);
        // Knocked over, it's out.
        if (head.y > 5) {
          groundFx.lamp(head, NIGHT ? 12 : 6.5, 0xffd09a, NIGHT ? 0.75 : 0.5);
          if (NIGHT) lit.push(head);
          else groundFx.reflect(head, head.y, 0xffc27a, 0.55, 1.1);
        }
      }
      // At night the wet road mirrors the lamps nearest the middle of the view (see mirrorsLamps).
      lit.sort((a, b) => a.distanceToSquared(camLook) - b.distanceToSquared(camLook));
      GLINTS.count.value = Math.min(lit.length, GLINT_LAMPS);
      for (let i = 0; i < GLINTS.count.value; i++) GLINTS.heads.value[i].copy(lit[i]);
      // The tunnel's sodium lamps.
      for (const p of city.tunnelLamps) {
        if (near(p)) groundFx.pool(p, 6, 0xff9440, 0.4);
      }
      // The work lamps in the hideout yard, at payday.
      for (const p of finale?.yardLights ?? []) if (near(p)) groundFx.lamp(p, 13, 0xffd9a0, NIGHT ? 1.1 : 0.4);
      for (const c of police.cops) {
        const p = c.v.position;
        const f = c.v.forward;
        groundFx.shadow(p, c.v.heading, 5.6, 2.9);
        if (c.wrecked) continue;
        groundFx.beam(p.clone().addScaledVector(f, 2.3), c.v.heading, NIGHT ? 24 : 15, NIGHT ? 9 : 7, 0xfff0d0, NIGHT ? 1.6 : 0.3);
        groundFx.reflect(p.clone().addScaledVector(f, 2.4), 0.7, 0xfff0d0, 0.35, 1.4);
        // The bar's red half is on the car's left (+x when it faces +z).
        if (c.v.model.lightBar) groundFx.strobes(p, new THREE.Vector3(f.z, 0, -f.x), c.v.model.lightBar);
      }
      for (const t of traffic.cars) {
        const p = t.v.position;
        const f = t.v.forward;
        groundFx.shadow(p, t.v.heading, 5, 2.6);
        if (t.loose) continue;
        groundFx.beam(p.clone().addScaledVector(f, 2.2), t.v.heading, NIGHT ? 22 : 13, NIGHT ? 8 : 6, 0xfff0d0, NIGHT ? 1.5 : 0.25);
        groundFx.reflect(p.clone().addScaledVector(f, 2.2), 0.7, 0xfff0d0, 0.3, 1.3);
      }
      for (const b of BEACONS) {
        const p = b.at.getWorldPosition(new THREE.Vector3());
        if (!near(p)) continue;
        const left = new THREE.Vector3(1, 0, 0).applyQuaternion(b.at.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
        groundFx.strobes(p, left, b.bar);
      }
      for (const car of [player, partner]) {
        const p = car.position;
        const f = car.forward;
        groundFx.shadow(p, car.heading, 5.6, 2.9);
        groundFx.beam(p.clone().addScaledVector(f, 2.3), car.heading, NIGHT ? 28 : 17, NIGHT ? 10 : 7.5, 0xfff0d0, NIGHT ? 1.9 : 0.35);
        // Headlights and tail lights in the wet road.
        groundFx.reflect(p.clone().addScaledVector(f, 2.4), 0.7, 0xfff0d0, 0.4, 1.5);
        const braking = car.controls.brake > 0;
        groundFx.reflect(p.clone().addScaledVector(f, -2.4), 0.8, 0xff2a1a, braking ? 0.9 : 0.25, 1.3);
        if (braking) groundFx.pool(p.clone().addScaledVector(f, -2.7), 2.4, 0xff2a1a, 0.75);
      }
      if (player.nosActive) {
        const at = player.position.addScaledVector(player.forward, -3.2);
        groundFx.pool(at, 3.6, 0x3d6bff, 1.2 + Math.random() * 0.5);
        groundFx.reflect(at, 0.6, 0x5a86ff, 0.8, 1.6);
      }
      // The helicopter's searchlight: a hot spot in a soft halo (its SpotLight lights the cars).
      if (chopper.on > 0) {
        groundFx.pool(chopper.spot, SPOT_RADIUS * 1.3, 0xd8e4ff, 0.35 * chopper.on);
        groundFx.pool(chopper.spot, SPOT_RADIUS * 0.6, 0xffffff, 0.3 * chopper.on);
      }
      const v = vault.position;
      groundFx.shadow(v, 0, 4.6, 4.6);
      if (drag > 4) {
        const k = Math.min(1.4, drag / 12) * (0.6 + Math.random() * 0.4);
        groundFx.pool(v, 3.8, 0xff8a2a, k);
        groundFx.reflect(v, 0.5, 0xff9a3a, k * 0.7, 2.2);
      }
    }
    groundFx.end();
  }

  function nearestCopDistance(): number {
    if (!player) return Infinity;
    let best = Infinity;
    for (const c of police.cops) if (!c.wrecked) best = Math.min(best, c.v.position.distanceTo(player.position));
    return best;
  }

  // ----------------------------------------------------------- camera

  const camPos = new THREE.Vector3(260, 120, 40);
  const camLook = new THREE.Vector3(180, 0, 150);
  /**
   * Gameplay views, cycled with C: the bird's-eye view, then the chase camera behind the
   * vault (far) or tight on the car (near). ?view=chase starts behind the car.
   */
  const VIEWS = ['overhead', 'far', 'near'] as const;
  let view: (typeof VIEWS)[number] = new URL(location.href).searchParams.get('view') === 'chase' ? 'far' : 'overhead';
  const overhead = new OverheadCamera();
  /** Chase camera state: smoothed yaw and how far out it may sit (walls pull it in). */
  let camYaw = 0;
  let camPull = 1;
  const camRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

  /** Fraction of the way from `from` to `to` that's clear of buildings and walls. */
  function clearance(from: THREE.Vector3, to: THREE.Vector3): number {
    const d = to.clone().sub(from);
    const len = d.length();
    camRay.origin = from;
    camRay.dir = d.divideScalar(len);
    const hit = world.castRay(camRay, len, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return hit ? THREE.MathUtils.clamp((hit.timeOfImpact - 1.2) / len, 0.15, 1) : 1;
  }

  function updateCamera(dt: number): void {
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let fov = 62;
    let k = 1 - Math.exp(-5 * dt);
    const shot = state === 'cutscene' ? cutscene?.update(dt) : director.frame();
    if (player && (shot || state !== 'chase' && state !== 'breach')) camYaw = player.heading;
    if (shot) {
      pos = shot.pos;
      look = shot.look;
      fov = shot.fov ?? 50;
      k = 1;
    } else if (state === 'select' && debugCam) {
      pos = new THREE.Vector3(debugCam[0], debugCam[1], debugCam[2]);
      look = new THREE.Vector3(debugCam[3], debugCam[4], debugCam[5]);
      k = 1;
    } else if (state === 'select') {
      // A slow orbit high over the station: the city as you'll play it, from above.
      const t = performance.now() / 1000;
      pos = new THREE.Vector3(186 + Math.cos(t * 0.06) * 75, 78, 150 + Math.sin(t * 0.06) * 75);
      look = new THREE.Vector3(195, 0, 158);
      fov = 40;
      k = 1;
    } else if (state === 'outro' && finale) {
      // After the last scene the camera stays where it ended: on the money, or on the open vault.
      ({ pos, look } = finale.outroCamera(stateTime));
      fov = 46;
      k = 1;
    } else if (state === 'outro') {
      const t = stateTime * 0.25;
      const c = player.position;
      pos = new THREE.Vector3(c.x + Math.cos(t) * 26, 10, c.z + Math.sin(t) * 26);
      look = c.clone().setY(1.5);
    } else if (player && view === 'overhead') {
      const v = player.body.linvel();
      const f = overhead.update(dt, player.position, new THREE.Vector3(v.x, 0, v.z), player.nosActive, player.heading, player.forwardSpeed);
      // Shake has to be bigger from up here to read.
      pos = f.pos.add(director.shakeOffset().multiplyScalar(4));
      look = f.look;
      fov = f.fov;
      k = 1 - Math.exp(-10 * dt);
    } else if (player) {
      const camFar = view === 'far';
      // Swing round toward where the car is going (its velocity) as much as where it points,
      // smoothed, so slides and vault yanks don't whip the view around.
      const v = player.body.linvel();
      let target = player.heading;
      if (Math.hypot(v.x, v.z) > 6 && player.forwardSpeed > 3) target += angleDiff(target, Math.atan2(v.x, v.z)) * 0.5;
      camYaw += angleDiff(camYaw, target) * Math.min(1, dt * 3.5);
      const dir = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
      const speed = Math.min(1, Math.abs(player.forwardSpeed) / 50);
      // Far (default): high and behind the vault, like a truck-and-trailer cam, so you can see
      // the vault swing and the cops around it. Near: tight on the car.
      const back = (camFar ? 24 : 12) + speed * 4;
      const height = (camFar ? 8.5 : 4.8) + speed * 1.5;
      const pivot = player.position.setY(2.2);
      const ideal = pivot.clone().addScaledVector(dir, -back).setY(height);
      // Keep a clear view: pull in at once when a building gets in the way, ease back out.
      const clear = clearance(pivot, ideal);
      camPull = clear < camPull ? clear : Math.min(clear, camPull + dt * 0.8);
      pos = pivot.clone().lerp(ideal, camPull);
      pos.y += (1 - camPull) * 3;
      look = player.position.addScaledVector(dir, camFar ? 12 : 8).setY(1.2);
      fov = (camFar ? 58 : 62) + speed * 12 + (player.nosActive ? 8 : 0);
      pos.add(director.shakeOffset());
      // A little high-speed rumble.
      if (speed > 0.5) pos.add(new THREE.Vector3((Math.random() - 0.5) * speed * 0.08, (Math.random() - 0.5) * speed * 0.08, 0));
      k = 1 - Math.exp(-12 * dt);
    } else {
      pos = camPos.clone();
      look = camLook.clone();
    }
    camPos.lerp(pos, k);
    camLook.lerp(look, k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    // Shadows around what's on screen: the overhead view looks well ahead of the car.
    gfx.follow(state === 'cutscene' || state === 'outro' || !player || view === 'overhead' ? camLook.clone().setY(0) : player.position);
    city.follow(camera.position);

    // From overhead: see through buildings around the player, and keep the tilt-shift band on them.
    const above = view === 'overhead' && !!player && !shot && state !== 'select' && state !== 'cutscene' && state !== 'outro';
    CUTAWAY.radius.value = 0;
    if (above) {
      // Lining up in the tunnel, the window through the roof is centred between the car and the truck ahead.
      const focus = swap?.focus();
      const at = (focus ? player.position.lerp(focus, 0.5) : player.position).setY(1);
      const eye = at.clone().applyMatrix4(camera.matrixWorldInverse);
      const ndc = at.clone().project(camera);
      const buf = gfx.renderer.getDrawingBufferSize(new THREE.Vector2());
      CUTAWAY.screen.value.set((ndc.x * 0.5 + 0.5) * buf.x, (ndc.y * 0.5 + 0.5) * buf.y);
      // Lining up in the tunnel, a wider window through its roof, so the truck ahead shows.
      CUTAWAY.radius.value = buf.y * (swap?.state === 'lineup' ? 0.42 : 0.24);
      // ...and reaches back past the truck, so its roof is cut too.
      CUTAWAY.depth.value = focus ? Math.max(-eye.z, 5 - focus.clone().setY(1).applyMatrix4(camera.matrixWorldInverse).z) : -eye.z;
      gfx.overhead(true, ndc.y * 0.5 + 0.5);
    } else {
      // The title screen's orbit gets the same look.
      gfx.overhead(state === 'select' && !debugCam);
    }
  }

  window.addEventListener('resize', gfx.resize);
  gfx.resize();

  // ----------------------------------------------------------- start

  function begin(id: CharacterId, skipIntro: boolean): void {
    hud.hideSelect();
    setupCrew(id);
    createMoments();
    const me = CHARACTERS[id];
    const cast = {
      left: me.side === 1 ? player : partner,
      right: me.side === 1 ? partner : player,
      hook: hookCables,
    };
    enter('cutscene');
    cutscene = new Cutscene(
      breach.shots(cast, (amount) => {
        if (cutscene) cutscene.shake = amount;
      }),
      hud,
      voice,
      () => {
        breach.finishInstantly(cast);
        startGameplay();
      },
      CUTSCENE_VIDEOS.breach,
    );
    if (skipIntro) cutscene.skip();
  }

  const params = new URL(location.href).searchParams;
  // Debug: ?cam=x,y,z,lookX,lookY,lookZ holds the title-screen camera there (for looking round the map).
  const debugCam = params.get('cam')?.split(',').map(Number) ?? null;
  // Debug: ?autopilot=1 drives the player along Mia's route (used by play-tests).
  const autopilot = params.has('autopilot') ? params.get('autopilot') || 'route' : null;
  // Debug: ?timescale=4 runs the simulation faster than real time; ?renderEvery=4 draws every 4th frame.
  const timescale = Number(params.get('timescale') ?? 1);
  const renderEvery = Number(params.get('renderEvery') ?? 1);
  // Debug: ?capture stops the real-time loop; window.fast5Frame(n, render) then advances exactly n
  // frames of 1/30 s each, so a headless browser can record smooth video one frame at a time.
  const capture = params.has('capture');
  let drawThisFrame = true;
  let frameCount = 0;
  // Debug: ?nocops=1 disables police (for testing the route and ending); ?at=bridge starts the chase on the bridge.
  const noCops = params.has('nocops');
  // ?bikes: the first police to come are a pair of motorbikes, whatever the heat.
  police.forceBikes = params.has('bikes');
  const preset = params.get('crew');
  if (preset === 'dom' || preset === 'brian') {
    begin(preset, !params.has('intro'));
  } else {
    hud.showSelect((id) => begin(id as CharacterId, false));
  }

  // Read-only snapshot for debugging and automated play-tests.
  (window as unknown as { fast5: () => object }).fast5 = () => ({
    state,
    player: player?.position.toArray().map(Math.round),
    speedKmh: player ? Math.round(player.forwardSpeed * 3.6) : 0,
    partner: partner?.position.toArray().map(Math.round),
    partnerGap: player ? +player.position.distanceTo(partner.position).toFixed(1) : 0,
    partnerTeleports,
    impacts,
    stuck: {
      seconds: Math.round(stuck.time),
      player: +stuck.player.toFixed(1),
      vault: +stuck.vault.toFixed(1),
      partnerFar: +stuck.partnerFar.toFixed(1),
      partnerAvg: +(stuck.partnerDist / Math.max(1, stuck.time)).toFixed(1),
    },
    partnerThinks: partnerAi?.thoughts,
    rigThrows: rig.throws,
    resets: convoyResets,
    vaultRescues,
    bank: bankJob ? (bankJob.smashed ? 'smashed' : !bankJob.pending ? 'missed' : bankJob.flinging ? 'flinging' : 'pending') : null,
    swap: swap?.state ?? null,
    lineup: swap ? +swap.quality.toFixed(2) : 0,
    finale: bridge ? { state: bridge.state, strain: +bridge.strain.toFixed(2), overboards: bridge.overboards } : null,
    reyes: reyes.active ? { suvs: reyes.suvs.map((s) => (s.boss ? 'R' : 'G') + (s.wrecked ? 'x' : s.plunge ? 'w' : '')), escort: +reyes.escortTime.toFixed(1), hit: reyes.bossHit, gap: player ? Math.round(reyes.suvs[0].v.position.distanceTo(player.position)) : 0 } : null,
    lastScene: finale ? (finale.decoy ? 'decoy' : 'real') : null,
    cafes: { tables: city.cafes.length, knocked: city.props.filter((p) => p.instance && p.hit).length, first: city.cafes[0]?.toArray().map(Math.round) },
    bikes: player
      ? police.cops.filter((c) => c.bike).map((c) => `${c.wrecked ? 'x' : 'b'}${Math.round(c.v.position.distanceTo(player.position))}@${Math.round(c.v.forwardSpeed)}#${c.v.position.x.toFixed(0)},${c.v.position.z.toFixed(0)}`)
      : [],
    people: { n: pedestrians.count, scattered: pedestrians.scattered },
    bus: { state: bus.state, at: bus.at?.toArray().map(Math.round), gap: player && bus.position ? Math.round(bus.position.distanceTo(player.position)) : null },
    allies: allies ? `${allies.state}:${allies.cars.map((a) => a.name[0] + a.takedowns).join(',')}` : null,
    policeHeld,
    roadblock: roadblock && player ? { state: roadblock.state, at: roadblock.at.toArray().map(Math.round), ahead: Math.round(roadblock.ahead(player.position)), fastest: +roadblock.fastest.toFixed(1) } : null,
    partnerQuality: {
      seconds: Math.round(pq.time),
      formationPct: Math.round((pq.formation / Math.max(1, pq.time)) * 100),
      wrongWaySec: +pq.wrongWay.toFixed(1),
      stuckSec: +pq.stuck.toFixed(1),
      avgGap: +(pq.gapSum / Math.max(1, pq.time)).toFixed(1),
      avgBehind: +(pq.behindSum / Math.max(1, pq.time)).toFixed(1),
      avgSide: +(pq.sideSum / Math.max(1, pq.time)).toFixed(1),
      behind8Pct: Math.round((pq.behind8 / Math.max(1, pq.time)) * 100),
      tooWidePct: Math.round((pq.tooWide / Math.max(1, pq.time)) * 100),
    },
    vault: vault.position.toArray().map(Math.round),
    truck: breach.truckPosition.toArray().map(Math.round),
    cables: cables.map((c) => +c.length.toFixed(1)),
    tension: cables.map((c) => Math.round(c.tension / 1000)),
    copsNear: player ? police.closeTo(player.position, 9) : 0,
    bodies: player
      ? {
          player: [player.body.translation(), player.body.linvel()].map((v) => [v.x, v.y, v.z].map((n) => +n.toFixed(1))),
          vault: [vault.body.translation(), vault.body.linvel(), vault.body.angvel()].map((v) => [v.x, v.y, v.z].map((n) => +n.toFixed(1))),
          partner: [partner.body.translation()].map((v) => [v.x, v.y, v.z].map((n) => +n.toFixed(1))),
        }
      : null,
    controls: player ? player.controls : null,
    heat,
    gpsNext: gps.nodes[0]?.toArray().filter((_, i) => i !== 1),
    reroutes: gps.reroutes,
    autoDetourIn: autoPlan?.detour ? Math.round(autoPlan.corner.distanceTo(player.position)) : null,
    rerouteLog: gps.log,
    cops: police.cops.length,
    traffic: player ? traffic.cars.map((c) => Math.round(c.v.position.distanceTo(player.position)) * (c.loose ? -1 : 1)) : [],
    wrecked: police.wreckedCount,
    damage,
    busted: +busted.toFixed(2),
    strain: pull ? +pull.strain.toFixed(2) : 0,
    hb: player?.controls.handbrake ?? false,
    vaultSpeed: +Math.hypot(vault.body.linvel().x, vault.body.linvel().z).toFixed(1),
    pulled: pull?.done ?? false,
    style,
    score: run.score(),
    grade: run.grade(),
    challenges: run.challenges.map((c) => `${c.id}:${c.done(run.stats) ? 'done' : '-'}`),
    chopper: chopper.flying ? chopper.position.toArray().map(Math.round) : null,
    log: hud.log,
    nos: +nos.toFixed(2),
    timeScale: +director.timeScale.toFixed(2),
    blown: [player?.tireBlown ?? 0, partner?.tireBlown ?? 0].map((x) => +x.toFixed(1)),
    fps: Math.round(fps),
    render: { calls: gfx.renderer.info.render.calls, triangles: gfx.renderer.info.render.triangles },
  });

  const BANK_BLIP = BANK.frame.toWorld(BANK.w / 2, BANK.d / 2);

  /** A column of light over a set piece, so you can see where the story goes next from blocks away. */
  function beaconColumn(color: number): THREE.Mesh {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 128;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 128, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.6, 80, 24, 1, true).translate(0, 40, 0), mat);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }
  const bankBeacon = beaconColumn(0x3ddc84);
  bankBeacon.position.copy(BANK_BLIP).setY(0);
  const TUNNEL_BLIP = TUNNEL.frame.toWorld(0, 0);
  const tunnelBeacon = beaconColumn(0xff9440);
  tunnelBeacon.position.copy(TUNNEL_BLIP);
  const goalBeacon = beaconColumn(0xffc23a);
  goalBeacon.position.copy(GOAL.pos).setY(0);

  /** The beacons pulse gently; the bank's goes out once it's been hit (or missed). */
  function updateBeacons(time: number): void {
    const pulse = 0.7 + 0.3 * Math.sin(time * 2.6);
    bankBeacon.visible = state === 'chase' && !!bankJob?.pending;
    tunnelBeacon.visible = state === 'chase' && !!swap?.pending && swap.state !== 'lineup';
    // Not in the fight on the bridge: then it's Reyes you're after, not the gantry.
    goalBeacon.visible = (state === 'chase' || state === 'outro') && !bridge?.fighting && !finale;
    (bankBeacon.material as THREE.MeshBasicMaterial).opacity = pulse;
    (tunnelBeacon.material as THREE.MeshBasicMaterial).opacity = pulse;
    (goalBeacon.material as THREE.MeshBasicMaterial).opacity = pulse;
  }

  /** What the HUD says to do now. */
  function objective(): string {
    if (state === 'breach') return 'Rip the vault out of the station';
    if (bridge?.pulling) return 'Get the vault rolling on your own';
    if (bridge?.state === 'charge') return reyes.boss ? 'Swing the vault into Reyes’s SUV' : 'Smash through the cruisers coming at you';
    if (swap?.state === 'lineup') return 'Line the vault up with the truck’s ramp';
    const decoy = !!swap?.done;
    if (onBridge(player.position)) return decoy ? 'Drag the decoy across the bridge' : 'Reach the swap point';
    return decoy ? 'Drag the decoy to the bridge' : 'Get the vault to the tunnel';
  }

  /** HUD guidance: an arrow toward the route 40 m ahead, and the next turn or the distance left. */
  function navigation(): { arrow: number | null; distance: string } {
    if (state !== 'chase' || !gps.nodes.length) return { arrow: null, distance: '' };
    const p = player.position;
    const path = gps.path(p);
    const turn = gps.nextTurn(p, travelDir());
    const ahead = path.at(Math.min(path.length, 40));
    return {
      // Relative to the screen from above; relative to the car's nose behind it.
      arrow: view === 'overhead' ? overhead.screenAngle(p, ahead) : angleTo(player, ahead),
      distance: turn ? `${turn.side === 'left' ? 'LEFT' : 'RIGHT'} IN ${Math.round(turn.distance)} m` : `${Math.round(path.length)} m TO GO`,
    };
  }

  let fps = 60;
  const timer = new THREE.Timer();
  function frame(time: number): void {
    timer.update(time);
    input.poll();
    const rawDt = capture ? 1 / 30 : timer.getDelta();
    fps = fps * 0.95 + (rawDt > 0 ? 1 / rawDt : 60) * 0.05;
    const realDt = Math.min(rawDt, 0.1) * timescale;
    director.update(realDt);
    const dt = realDt * director.timeScale;
    breach.update(dt);
    if (state === 'select') {
      hud.selectInput(input);
      sound.quiet();
    } else {
      if (director.timeScale < 0.99) {
        // Slow motion: one smaller step per frame keeps motion smooth.
        world.timestep = Math.max(dt, 1 / 1000);
        physicsStep(world.timestep);
        accumulator = 0;
      } else {
        world.timestep = FIXED_DT;
        accumulator += dt;
        while (accumulator >= FIXED_DT) {
          physicsStep(FIXED_DT);
          accumulator -= FIXED_DT;
        }
      }
      updateGame(dt);
      if (chopper.flying) {
        const vv = vault.body.linvel();
        chopper.update(dt, vault.position, new THREE.Vector3(vv.x, 0, vv.z), camLook.clone().sub(camPos).setY(0).normalize(), inTunnel(vault.position, 3));
      }
      player.render(dt);
      partner.render(dt);
      reyes.update(dt, player, state === 'chase');
      pedestrians.update(dt, camera.position, player.position, Math.abs(player.forwardSpeed), vault.position);
      bus.render(dt, player.position);
      for (const car of [player, partner]) car.model.brake.emissiveIntensity = car.controls.brake > 0 ? 4 : 1.2;
      for (const c of cables) c.render();
      police.render(dt);
      traffic.render(dt);
    }
    const drag = updateEffects(dt);
    fx.update(dt);
    vault.render();
    city.render(camera);
    city.update(dt);
    updateCamera(dt);
    paintGround(drag);
    rain?.update(dt, camLook, inTunnel(camera.position, 4));
    updateBeacons(performance.now() / 1000);

    if (state === 'breach' || state === 'chase') {
      sound.update(player.forwardSpeed, player.controls.throttle, nearestCopDistance(), drag);
      sound.rotor(chopper.flying ? chopper.position.distanceTo(player.position) : Infinity);
    } else if (state === 'cutscene') {
      sound.update(0, 0, Infinity, drag);
    } else {
      sound.quiet();
    }

    if (player && state !== 'cutscene') {
      hud.update(dt, {
        speedKmh: Math.abs(player.forwardSpeed) * 3.6,
        nos,
        style,
        heat,
        busted,
        damage,
        wrecked: police.wreckedCount,
        objective: objective(),
        ...navigation(),
        player: player.position,
        heading: player.heading,
        up: view === 'overhead' ? overhead.yaw : player.heading,
        vault: vault.position,
        partner: partner.position,
        cops: police.cops.filter((c) => !c.wrecked).map((c) => c.v.position),
        route: state === 'chase' ? gps.nodes : [],
        blips: [
          ...(bankJob?.pending ? [{ pos: BANK_BLIP, color: '#3ddc84', label: '$' }] : []),
          ...(swap?.pending ? [{ pos: TUNNEL_BLIP, color: '#ff9440', label: 'T' }] : []),
          ...(reyes.boss && !reyes.bossHit ? [{ pos: reyes.boss.v.position, color: '#ff3b3b', label: 'R' }] : []),
          ...(allies?.blips ?? []).map((pos) => ({ pos, color: '#3dff6a', label: 'A' })),
        ],
      });
    } else {
      hud.update(dt, null);
    }

    if (++frameCount % renderEvery === 0 && drawThisFrame) gfx.render();
    input.endFrame();
    if (!capture) requestAnimationFrame(frame);
  }
  if (capture) {
    // Debug (capture mode only): what's solid within r m of (x, z)?
    (window as unknown as { fast5Colliders: (x: number, z: number, r?: number) => object[] }).fast5Colliders = (x, z, r = 3) => {
      const hits: object[] = [];
      world.intersectionsWithShape({ x, y: 1, z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(r), (c) => {
        const b = c.parent();
        const t = c.translation();
        hits.push({ shape: c.shapeType(), fixed: b?.isFixed(), mass: +(b?.mass() ?? 0).toFixed(0), at: [t.x, t.y, t.z].map((v) => +v.toFixed(1)) });
        return true;
      });
      return hits;
    };
    // Debug (capture mode only): what the vault and the hero cars are touching, and how hard.
    (window as unknown as { fast5Contacts: () => object }).fast5Contacts = () => {
      const names = new Map<number, string>([
        [player.body.handle, 'player'],
        [partner.body.handle, 'partner'],
        [vault.body.handle, 'vault'],
      ]);
      for (const c of police.cops) names.set(c.v.body.handle, c.wrecked ? 'cop-wreck' : 'cop');
      for (const c of traffic.cars) names.set(c.v.body.handle, c.loose ? 'civ-wreck' : 'civ');
      const out: Record<string, object[]> = {};
      for (const [name, col] of [['vault', vault.collider], ['player', player.collider], ['partner', partner.collider]] as const) {
        const list: object[] = [];
        world.contactPairsWith(col, (other) => {
          world.contactPair(col, other, (m) => {
            if (!m.numContacts()) return;
            let impulse = 0;
            for (let i = 0; i < m.numContacts(); i++) impulse += m.contactImpulse(i);
            const b = other.parent();
            const n = m.normal();
            const t = b?.translation();
            list.push({
              with: (b && names.get(b.handle)) ?? (b?.isFixed() ? 'fixed' : `body m${b?.mass().toFixed(0)}`),
              impulse: Math.round(impulse),
              normal: [n.x, n.y, n.z].map((v) => +v.toFixed(2)),
              at: t ? [t.x, t.y, t.z].map((v) => +v.toFixed(1)) : null,
            });
          });
        });
        out[name] = list;
      }
      return out;
    };
    (window as unknown as { fast5Frame: (n?: number, render?: boolean) => void }).fast5Frame = (n = 1, render = true) => {
      for (let i = 0; i < n; i++) {
        drawThisFrame = render && i === n - 1;
        frame(performance.now());
      }
    };
  } else {
    requestAnimationFrame(frame);
  }
}

start();
