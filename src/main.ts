import * as THREE from 'three';
import { angleTo, seek } from './ai';
import { Sound } from './audio';
import { BreachScene } from './breach';
import {
  BRIDGE_X,
  BANK,
  CAR_STARTS,
  PITCH,
  City,
  SEAWALL_Z,
  STATION_FACADE_X,
  SWAP_ZONE_Z,
  VAULT_START,
  VAULT_START_HEADING,
} from './city';
import { Cutscene } from './cutscene';
import { Director } from './director';
import { Effects } from './fx';
import { BRIDGE_FOOT_POS, Gps, type Turn } from './gps';
import { createGraphics } from './graphics';
import { Hud } from './hud';
import { Input, type ControlState } from './input';
import { BankJob, type MomentContext, SpikeStrip, ThePull } from './moments';
import { type Obstacle, PartnerDriver } from './partner';
import { exits, lanePath, leftOf, nextIntersection, roadHalfWidth, routeExit, snapDir, streetCenter } from './roads';
import { FIXED_DT, initPhysics, RAPIER } from './physics';
import { Police } from './police';
import { Cable, Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';
import { CUTSCENE_VIDEOS } from './videos';
import { Voice } from './voice';

type CharacterId = 'dom' | 'brian';

export const CHARACTERS: Record<CharacterId, { name: string; spec: VehicleSpec; side: 1 | -1 }> = {
  dom: {
    name: 'Dom Toretto',
    side: 1,
    spec: {
      mass: 2100, accel: 23, topSpeed: 62, turnRate: 2.1, grip: 7.5,
      model: { body: 0x141416, trim: 0x0b0b0c, rim: 0x3a3a3c, matte: true },
    },
  },
  brian: {
    name: 'Brian O’Conner',
    side: -1,
    spec: {
      mass: 1800, accel: 25, topSpeed: 64, turnRate: 2.5, grip: 7,
      model: { body: 0x17181b, trim: 0x0b0b0c, rim: 0x9ea3aa, matte: true },
    },
  },
};

type State = 'select' | 'cutscene' | 'breach' | 'chase' | 'outro' | 'busted' | 'lost';

const CABLE_TOW_LENGTH = 10;

async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const gfx = createGraphics(canvas);
  const { scene, camera } = gfx;

  const world = await initPhysics();
  const city = new City(world);
  scene.add(city.group);
  const fx = new Effects();
  scene.add(fx.group);
  const sound = new Sound();
  const voice = new Voice();

  const vault = new Vault(world, VAULT_START, VAULT_START_HEADING);
  scene.add(vault.mesh);
  const breach = new BreachScene(world, scene, city, fx, sound);

  const input = new Input();
  const hud = new Hud();
  const gps = new Gps();
  const police = new Police(world, scene, city);
  const director = new Director();
  police.visible = (p) => isVisible(p);
  police.onBump = (at, k) => {
    sound.crash(0.25 + k * 0.5);
    input.rumble(0.3 + k * 0.6);
    fx.burst(at.setY(0.9), 0.25 + k * 0.4);
    director.shake = Math.max(director.shake, 0.25 + k * 0.6);
  };
  police.onWreck = (at) => {
    fx.burst(at.clone().setY(1), 1);
    sound.crash(1);
    nos = Math.min(1, nos + 0.15);
    style += 100;
    input.rumble(0.25, 120);
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

  function createMoments(): void {
    const ctx: MomentContext = {
      world,
      scene,
      city,
      fx,
      sound,
      hud,
      voice,
      director,
      player,
      partner,
      vault,
      cables,
      route: () => gps.nodes,
      reward: (points, refill) => {
        style += points;
        nos = Math.min(1, nos + refill);
      },
      addDamage: (amount) => {
        damage += amount;
      },
    };
    pull = new ThePull(ctx);
    spikes = new SpikeStrip(ctx);
    bankJob = new BankJob(ctx);
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
    scene.add(player.model.group, partner.model.group);
    partnerAi = new PartnerDriver(world, city, -me.side);
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

  function enter(next: State): void {
    state = next;
    stateTime = 0;
  }

  // ----------------------------------------------------------- recovery

  /** R: line the crew back up in the middle of the nearest street, facing along the GPS route. */
  function resetConvoy(): void {
    const p = player.position;
    const target = gps.nodes.find((n) => n.distanceTo(p) > 15) ?? gps.nodes[gps.nodes.length - 1] ?? p.clone().setZ(p.z + 50);
    let center: THREE.Vector3;
    let heading: number;
    const gx = Math.round(p.x / PITCH) * PITCH;
    const gz = Math.round(p.z / PITCH) * PITCH;
    if (p.z > SEAWALL_Z) {
      center = new THREE.Vector3(BRIDGE_X, 0, p.z);
      heading = 0;
    } else if (Math.abs(p.x - gx) < Math.abs(p.z - gz)) {
      center = new THREE.Vector3(gx, 0, p.z);
      heading = target.z >= p.z ? 0 : Math.PI;
    } else {
      center = new THREE.Vector3(p.x, 0, gz);
      heading = target.x >= p.x ? Math.PI / 2 : -Math.PI / 2;
    }
    const f = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const side = CHARACTERS[character].side;
    player.place(center.clone().addScaledVector(left, side * 2.75), heading);
    partner.place(center.clone().addScaledVector(left, -side * 2.75), heading);
    vault.place(center.clone().addScaledVector(f, -CABLE_TOW_LENGTH - 2.5), heading);
    partnerAi.reset(player);
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
  function autopilotControls(): ControlState {
    const p = player.position;
    // Spun round: turn back toward the route.
    const next = gps.nodes.find((n) => n.distanceTo(p) > 15);
    if (autopilot !== 'wander' && next && next.clone().sub(p).normalize().dot(player.forward) < -0.3) {
      autoPlan = null;
      return seek(world, player, next, 0.6);
    }
    const d = snapDir(player.forward);
    if (autoPlan && (!autoPlan.exit || p.clone().sub(autoPlan.corner).dot(autoPlan.exit) > 14)) autoPlan = null;
    if (!autoPlan) {
      const corner = nextIntersection(p, d);
      if (corner) {
        const options = exits(corner, d);
        const gpsExit = routeExit(corner, d, gps.nodes);
        // 'detour' deliberately disobeys the GPS at about a third of the intersections.
        const others = options.filter((o) => !gpsExit || o.dot(gpsExit) < 0.9);
        const exit =
          autopilot === 'wander'
            ? options[Math.floor(Math.random() * options.length)]
            : autopilot === 'detour' && others.length && Math.random() < 0.35
              ? others[Math.floor(Math.random() * others.length)]
              : gpsExit;
        autoPlan = { corner, exit: exit ?? null, detour: !!exit && !!gpsExit && exit.dot(gpsExit) < 0.9 };
      }
    }
    // Follow the hints like a player would: aim for the spike-strip gap, handbrake at the bank.
    const gap = spikes?.gapX() ?? null;
    const lane = gap !== null && d.z > 0.9 ? gap - streetCenter(p, d).x : CHARACTERS[character].side * 3;
    const bankSwing = autopilot !== 'wander' && p.distanceTo(new THREE.Vector3(100, 0, 500)) < 20 && player.forward.z > 0.3;
    const path = lanePath(p, d, lane, autoPlan?.corner ?? null, autoPlan?.exit ?? null);
    const s0 = path.project(p);
    const speed = player.forwardSpeed;
    const target = path.at(s0 + 10 + Math.abs(speed) * 0.4);
    const turning = !!autoPlan?.exit && autoPlan.exit.dot(d) < 0.5;
    const toCorner = autoPlan ? autoPlan.corner.clone().sub(p).dot(d) : Infinity;
    const vTarget = turning && toCorner < 45 && toCorner > -10 ? 12 : p.z > SEAWALL_Z ? 45 : 28;
    const err = vTarget - speed;
    return {
      throttle: THREE.MathUtils.clamp(err * 0.3, 0, 1),
      brake: err < -2 ? THREE.MathUtils.clamp(-err * 0.15, 0, 1) : 0,
      steer: THREE.MathUtils.clamp(angleTo(player, target) * 2.4, -1, 1),
      handbrake: bankSwing,
    };
  }
  let playerStuck = 0;

  /** Put the partner back beside the player (only ever done off-screen). */
  function recoverPartner(): void {
    const d = snapDir(player.forward);
    const center = streetCenter(player.position, d);
    const playerOffset = player.position.clone().sub(center).dot(leftOf(d));
    const half = roadHalfWidth(player.position) - 2.3;
    const offset = THREE.MathUtils.clamp(playerOffset - CHARACTERS[character].side * 5, -half, half);
    const slot = center.clone().addScaledVector(leftOf(d), offset);
    if (!city.isStreet(slot.x, slot.z) || Math.abs(offset - playerOffset) < 3) return;
    partner.place(slot, Math.atan2(d.x, d.z));
    partner.body.setLinvel({ x: d.x * player.forwardSpeed, y: 0, z: d.z * player.forwardSpeed }, true);
    partnerAi.reset(player);
    partnerTeleports++;
  }

  const frustum = new THREE.Frustum();
  const isVisible = (p: THREE.Vector3) => camera.position.distanceTo(p) < 160 && frustum.containsPoint(p.clone().setY(1));

  /** Everything the partner should steer around. */
  function partnerObstacles(): Obstacle[] {
    const list: Obstacle[] = [
      { pos: player.position, radius: 1.8, soft: true },
      { pos: vault.position.setY(0), radius: 2.4, soft: true },
    ];
    // Everything is "soft": the partner steers around it when there's a free lane but never
    // brakes for it. It's chained to the vault, and the Chargers plow through in the film.
    for (const c of police.cops) list.push({ pos: c.v.position, radius: 2.6, soft: true });
    if (spikes) list.push(...spikes.obstacles());
    const near = partner.position;
    for (const prop of city.props) {
      if (prop.value < 1500) continue; // bricks: drive through
      const t = prop.body.translation();
      if (Math.abs(t.x - near.x) > 45 || Math.abs(t.z - near.z) > 45) continue;
      list.push({ pos: new THREE.Vector3(t.x, 0, t.z), radius: prop.value >= 15000 ? 2.5 : prop.value >= 6000 ? 2.2 : 0.7, soft: true });
    }
    return list;
  }

  // ----------------------------------------------------------- physics

  function physicsStep(dt: number): void {
    const driving = state === 'breach' || state === 'chase';
    const hold: ControlState = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    const auto = autopilot ? (state === 'chase' ? autopilotControls() : seek(world, player, new THREE.Vector3(200, 0, 300), 0.9)) : null;
    player.controls = driving ? (auto ?? input.controls()) : hold;
    // Keyboard steering eases in; an analog stick is already smooth, so it gets a quick response.
    player.steerRate = input.analog && !auto ? { in: 14, out: 14 } : { in: 5, out: 12 };
    if (driving) {
      const vv = vault.body.linvel();
      partner.controls = partnerAi.controls(dt, {
        player,
        me: partner,
        vault: vault.position,
        vaultVel: new THREE.Vector3(vv.x, 0, vv.z),
        route: state === 'chase' ? gps.nodes : [],
        obstacles: partnerObstacles(),
        visible: isVisible,
      });
      if (partnerAi.wantsRecovery && state === 'chase') recoverPartner();
    } else {
      partner.controls = hold;
    }
    const nosOn = driving && !!player.controls.nos && nos > 0.02;
    player.nosActive = nosOn;
    if (nosOn) nos = Math.max(0, nos - dt * 0.3);
    else if (driving) nos = Math.min(1, nos + dt * 0.012);
    player.step(dt);
    partner.step(dt);

    if (state === 'chase' && !noCops) {
      police.step(dt, player, vault, heat, player.position.z > SEAWALL_Z);
    } else if (state === 'outro' || state === 'busted' || state === 'lost') {
      police.step(dt, player, vault, heat, player.position.z > SEAWALL_Z);
    }

    if (state === 'chase' || state === 'outro') for (const c of cables) c.reel(CABLE_TOW_LENGTH, dt);
    for (const c of cables) c.step(dt);
    if (state === 'chase') bankJob?.step(dt);
    world.step();
    if (state === 'chase') {
      measurePartner(dt);
      measureImpacts(dt);
    }
  }

  // ----------------------------------------------------------- game flow

  function startGameplay(): void {
    cutscene = null;
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
    }

    if (state === 'breach' && vault.position.x > STATION_FACADE_X + 3) {
      enter('chase');
      breach.shooting = false;
      heat = 1;
      say('MIA', 'It’s out! Every cop in Rio is coming. Follow my route, or find your own. I’ll guide you.');
    }

    if ((state === 'breach' || state === 'chase') && inWater()) {
      enter('lost');
      hud.showOverlay(
        'VAULT LOST',
        `The vault went over the side and into the bay.\nReyes’s money is at the bottom of Guanabara Bay.\n\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`,
        'Press Enter to try again',
      );
    }

    if (input.wasPressed('KeyC')) camFar = !camFar;
    if (state === 'chase') {
      chaseTime += dt;
      if (input.wasPressed('KeyR')) resetConvoy();
      if (autopilot) {
        playerStuck = Math.abs(player.forwardSpeed) < 2 ? playerStuck + dt : 0;
        if (playerStuck > 4) {
          playerStuck = 0;
          resetConvoy();
        }
      }
      const newDamage = city.collectDamage();
      if (newDamage > 0) sound.crash(Math.min(1, newDamage / 15000) * 0.6);
      damage += newDamage;
      streetDamage += newDamage;
      heat = Math.min(5, 1 + Math.floor(chaseTime / 50) + Math.floor(streetDamage / 300000) + Math.floor(police.wreckedCount / 10));

      gps.update(dt, player.position, travelDir());
      calloutTurn();

      const pinned = police.closeTo(player.position, 9) >= 2 && Math.abs(player.forwardSpeed) < 4;
      busted = THREE.MathUtils.clamp(busted + (pinned ? dt / 3.5 : -dt / 2), 0, 1);
      if (busted >= 1) {
        enter('busted');
        hud.showOverlay('BUSTED', `They boxed you in.\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}   Style: ${style.toLocaleString('en-US')}`, 'Press Enter to try again');
      }

      if (player.position.z > SWAP_ZONE_Z) {
        enter('outro');
        hud.radio('MIA', 'You made it. Kill the engines.');
      }
    }

    if (state === 'outro' && stateTime > 4 && stateTime - dt <= 4) {
      hud.showOverlay(
        'THE SWAP',
        'While every cop in Rio chased that vault, Roman and Han swapped it for an empty decoy.\n' +
          'Reyes’s money was already gone.\n\n' +
          `Time ${Hud.time(chaseTime)}   Cops wrecked ${police.wreckedCount}   Property damage ${Hud.money(damage)}   Style ${style.toLocaleString('en-US')}`,
        'Press Enter to play again',
      );
    }
    if ((state === 'busted' || state === 'lost' || (state === 'outro' && stateTime > 4)) && input.wasPressed('Enter')) {
      const url = new URL(location.href);
      url.searchParams.set('crew', character);
      location.href = url.toString();
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
      say('MIA', 'Bridge ahead. Get to the yellow gantry at the far end.');
      return;
    }
    const turn = gps.nextTurn(p, travelDir());
    if (!turn || turn.at !== gps.nodes[0] || turn.distance > 100 || turn.distance < 25) return;
    if (turnKey(turn) === calledTurn) return;
    calledTurn = turnKey(turn);
    say('MIA', turn.side === 'left' ? 'Next intersection, hang a left!' : 'Next intersection, go right!');
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

  function nearestCopDistance(): number {
    if (!player) return Infinity;
    let best = Infinity;
    for (const c of police.cops) if (!c.wrecked) best = Math.min(best, c.v.position.distanceTo(player.position));
    return best;
  }

  // ----------------------------------------------------------- camera

  const camPos = new THREE.Vector3(260, 120, 40);
  const camLook = new THREE.Vector3(180, 0, 150);
  /** Chase camera state: smoothed yaw, how far out it may sit (walls pull it in), and far/near framing (C). */
  let camYaw = 0;
  let camPull = 1;
  let camFar = true;
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
    } else if (state === 'select') {
      const t = performance.now() / 1000;
      pos = new THREE.Vector3(186 + Math.cos(t * 0.12) * 60, 26, 150 + Math.sin(t * 0.12) * 60);
      look = new THREE.Vector3(190, 4, 150);
      k = 1;
    } else if (state === 'outro') {
      const t = stateTime * 0.25;
      const c = player.position;
      pos = new THREE.Vector3(c.x + Math.cos(t) * 26, 10, c.z + Math.sin(t) * 26);
      look = c.clone().setY(1.5);
    } else if (player) {
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
    gfx.follow(state === 'cutscene' || !player ? camLook.clone().setY(0) : player.position);
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
  // Debug: ?nocops=1 disables police (for testing the route and ending).
  const noCops = params.has('nocops');
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
    partnerThinks: partnerAi?.thoughts,
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
    heat,
    gpsNext: gps.nodes[0]?.toArray().filter((_, i) => i !== 1),
    reroutes: gps.reroutes,
    autoDetourIn: autoPlan?.detour ? Math.round(autoPlan.corner.distanceTo(player.position)) : null,
    rerouteLog: gps.log,
    cops: police.cops.length,
    wrecked: police.wreckedCount,
    damage,
    busted: +busted.toFixed(2),
    strain: pull ? +pull.strain.toFixed(2) : 0,
    hb: player?.controls.handbrake ?? false,
    vaultSpeed: +Math.hypot(vault.body.linvel().x, vault.body.linvel().z).toFixed(1),
    pulled: pull?.done ?? false,
    style,
    nos: +nos.toFixed(2),
    timeScale: +director.timeScale.toFixed(2),
    blown: [player?.tireBlown ?? 0, partner?.tireBlown ?? 0].map((x) => +x.toFixed(1)),
    fps: Math.round(fps),
  });

  const BANK_BLIP = new THREE.Vector3((BANK.x0 + BANK.x1) / 2, 0, (BANK.z0 + BANK.z1) / 2);

  /** HUD guidance: an arrow toward the route 40 m ahead, and the next turn or the distance left. */
  function navigation(): { arrow: number | null; distance: string } {
    if (state !== 'chase' || !gps.nodes.length) return { arrow: null, distance: '' };
    const p = player.position;
    const path = gps.path(p);
    const turn = gps.nextTurn(p, travelDir());
    return {
      arrow: angleTo(player, path.at(Math.min(path.length, 40))),
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
      player.render(dt);
      partner.render(dt);
      for (const car of [player, partner]) car.model.brake.emissiveIntensity = car.controls.brake > 0 ? 4 : 1.2;
      for (const c of cables) c.render();
      police.render(dt);
    }
    const drag = updateEffects(dt);
    fx.update(dt);
    vault.render();
    city.render();
    city.update(dt);
    updateCamera(dt);

    if (state === 'breach' || state === 'chase') {
      sound.update(player.forwardSpeed, player.controls.throttle, nearestCopDistance(), drag);
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
        objective: state === 'breach' ? 'Rip the vault out of the station' : player.position.z > SEAWALL_Z ? 'Reach the swap point' : 'Drag the vault to the bridge',
        ...navigation(),
        player: player.position,
        heading: player.heading,
        vault: vault.position,
        partner: partner.position,
        cops: police.cops.filter((c) => !c.wrecked).map((c) => c.v.position),
        route: state === 'chase' ? gps.nodes : [],
        blips: bankJob?.pending ? [{ pos: BANK_BLIP, color: '#3ddc84', label: '$' }] : [],
      });
    } else {
      hud.update(dt, null);
    }

    if (++frameCount % renderEvery === 0 && drawThisFrame) gfx.render();
    input.endFrame();
    if (!capture) requestAnimationFrame(frame);
  }
  if (capture) {
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
