import * as THREE from 'three';
import { angleTo, seek } from './ai';
import { Sound } from './audio';
import { BreachScene } from './breach';
import {
  BRIDGE_X,
  CAR_STARTS,
  PITCH,
  City,
  ROUTE,
  SEAWALL_Z,
  STATION_FACADE_X,
  SWAP_ZONE_Z,
  VAULT_START,
  VAULT_START_HEADING,
} from './city';
import { Cutscene } from './cutscene';
import { Effects } from './fx';
import { createGraphics } from './graphics';
import { Hud } from './hud';
import { Input, type ControlState } from './input';
import { PartnerDriver } from './partner';
import { FIXED_DT, initPhysics } from './physics';
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
  const hud = new Hud(ROUTE);
  const police = new Police(world, scene, city);
  police.onWreck = (at) => {
    fx.burst(at.clone().setY(1), 1);
    sound.crash(1);
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
  let heat = 0;
  let busted = 0;
  let waypoint = 0;
  let accumulator = 0;
  let lastCalloutWaypoint = -1;
  let lastPlayerSpeed = 0;

  function setupCrew(id: CharacterId): void {
    character = id;
    const me = CHARACTERS[id];
    const other = CHARACTERS[id === 'dom' ? 'brian' : 'dom'];
    // The car on the left (+x when facing north) has side = 1.
    const startFor = (side: number) => CAR_STARTS[side === 1 ? 1 : 0];
    player = new Vehicle(world, me.spec, startFor(me.side), 0);
    partner = new Vehicle(world, other.spec, startFor(other.side), 0);
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

  /** R: line the crew back up in the middle of the nearest street, facing the next waypoint. */
  function resetConvoy(): void {
    const p = player.position;
    const target = ROUTE[waypoint];
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

  let partnerStuck = 0;
  let partnerTeleports = 0;
  let playerStuck = 0;

  /** Teleport the partner back into formation if it's been wedged for a while. */
  function unstickPartner(dt: number): void {
    const pinned = Math.abs(player.forwardSpeed) > 5 && Math.abs(partner.forwardSpeed) < 1.5;
    partnerStuck = pinned ? partnerStuck + dt : 0;
    if (partnerStuck < 4) return;
    partnerStuck = 0;
    const f = player.forward;
    const slot = player.position.addScaledVector(new THREE.Vector3(f.z, 0, -f.x), -CHARACTERS[character].side * 5.5);
    if (city.isStreet(slot.x, slot.z)) {
      partner.place(slot, player.heading);
      partnerAi.reset(player);
      partnerTeleports++;
    }
  }

  // ----------------------------------------------------------- physics

  function physicsStep(dt: number): void {
    const driving = state === 'breach' || state === 'chase';
    const hold: ControlState = { throttle: 0, brake: 0, steer: 0, handbrake: true };
    player.controls = driving ? (autopilot ? seek(world, player, ROUTE[waypoint], 0.9) : input.controls()) : hold;
    partner.controls = driving ? partnerAi.controls(dt, player, partner, vault.position) : hold;
    player.step(dt);
    partner.step(dt);

    if (state === 'chase' && !noCops) {
      police.step(dt, player, vault, heat, player.position.z > SEAWALL_Z);
    } else if (state === 'outro' || state === 'busted' || state === 'lost') {
      police.step(dt, player, vault, heat, player.position.z > SEAWALL_Z);
    }

    if (state === 'chase' || state === 'outro') for (const c of cables) c.reel(CABLE_TOW_LENGTH, dt);
    world.step();
  }

  // ----------------------------------------------------------- game flow

  function startGameplay(): void {
    cutscene = null;
    enter('breach');
    breach.shooting = true;
    hud.showHud(true);
    hud.radio('MIA', 'Floor it! Pull that vault out of there!');
  }

  function updateGame(dt: number): void {
    stateTime += dt;
    if (state === 'cutscene') {
      if (input.wasPressed('Enter') || input.wasPressed('Escape')) cutscene?.skip();
      return;
    }

    if (state === 'breach' && vault.position.x > STATION_FACADE_X + 3) {
      enter('chase');
      breach.shooting = false;
      heat = 1;
      hud.radio('MIA', 'It’s out! Every cop in Rio is coming. Follow my route.');
    }

    if ((state === 'breach' || state === 'chase') && inWater()) {
      enter('lost');
      hud.showOverlay(
        'VAULT LOST',
        `The vault went over the side and into the bay.\nReyes’s money is at the bottom of Guanabara Bay.\n\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`,
        'Press Enter to try again',
      );
    }

    if (state === 'chase') {
      chaseTime += dt;
      unstickPartner(dt);
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
      heat = Math.min(5, 1 + Math.floor(chaseTime / 50) + Math.floor(damage / 300000) + Math.floor(police.wreckedCount / 10));

      const wp = ROUTE[waypoint];
      if (player.position.distanceTo(wp) < 30 && waypoint < ROUTE.length - 1) waypoint++;
      calloutTurn();

      const pinned = police.closeTo(player.position, 9) >= 2 && Math.abs(player.forwardSpeed) < 4;
      busted = THREE.MathUtils.clamp(busted + (pinned ? dt / 3.5 : -dt / 2), 0, 1);
      if (busted >= 1) {
        enter('busted');
        hud.showOverlay('BUSTED', `They boxed you in.\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`, 'Press Enter to try again');
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
          `Time ${Hud.time(chaseTime)}   Cops wrecked ${police.wreckedCount}   Property damage ${Hud.money(damage)}`,
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

  function calloutTurn(): void {
    if (waypoint === lastCalloutWaypoint || waypoint === 0 || waypoint >= ROUTE.length - 1) return;
    const wp = ROUTE[waypoint];
    if (player.position.distanceTo(wp) > 90) return;
    lastCalloutWaypoint = waypoint;
    const a = wp.clone().sub(ROUTE[waypoint - 1]);
    const b = ROUTE[waypoint + 1].clone().sub(wp);
    const cross = a.x * b.z - a.z * b.x;
    let line: string | null = null;
    if (waypoint === ROUTE.length - 2) line = 'Bridge ahead. Get to the yellow gantry at the far end.';
    // Left of travel is +x when facing +z, which makes a left turn a negative cross product.
    else if (Math.abs(cross) > 1) line = cross < 0 ? 'Next intersection, hang a left!' : 'Next intersection, go right!';
    if (line) {
      hud.radio('MIA', line);
      voice.speak('MIA', line);
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
    if (player && (state === 'breach' || state === 'chase')) {
      const s = Math.abs(player.forwardSpeed);
      if (lastPlayerSpeed - s > 7) {
        sound.crash(Math.min(1, (lastPlayerSpeed - s) / 20));
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

  function updateCamera(dt: number): void {
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let fov = 62;
    let k = 1 - Math.exp(-5 * dt);
    const shot = state === 'cutscene' ? cutscene?.update(dt) : null;
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
      const f = player.forward;
      const speed = Math.min(1, Math.abs(player.forwardSpeed) / 60);
      pos = player.position.addScaledVector(f, -14 - speed * 3).setY(6 + speed);
      look = player.position.addScaledVector(f, 7).setY(1.5);
      fov = 62 + speed * 14;
      // A little high-speed rumble.
      if (speed > 0.5) pos.add(new THREE.Vector3((Math.random() - 0.5) * speed * 0.08, (Math.random() - 0.5) * speed * 0.08, 0));
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
    gfx.follow(state === 'cutscene' || !player ? camLook.clone().setY(0) : player.position);
  }

  window.addEventListener('resize', gfx.resize);
  gfx.resize();

  // ----------------------------------------------------------- start

  function begin(id: CharacterId, skipIntro: boolean): void {
    hud.hideSelect();
    setupCrew(id);
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
  const autopilot = params.has('autopilot');
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
    vault: vault.position.toArray().map(Math.round),
    truck: breach.truckPosition.toArray().map(Math.round),
    cables: cables.map((c) => +c.length.toFixed(1)),
    heat,
    waypoint,
    cops: police.cops.length,
    wrecked: police.wreckedCount,
    damage,
    busted: +busted.toFixed(2),
    fps: Math.round(fps),
  });

  let fps = 60;
  const timer = new THREE.Timer();
  function frame(time: number): void {
    timer.update(time);
    const rawDt = timer.getDelta();
    fps = fps * 0.95 + (rawDt > 0 ? 1 / rawDt : 60) * 0.05;
    const dt = Math.min(rawDt, 0.1);
    breach.update(dt);
    if (state === 'select') {
      hud.selectInput(input);
      sound.quiet();
    } else {
      accumulator += dt;
      while (accumulator >= FIXED_DT) {
        physicsStep(FIXED_DT);
        accumulator -= FIXED_DT;
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
        heat,
        busted,
        damage,
        wrecked: police.wreckedCount,
        objective:
          state === 'breach'
            ? 'Rip the vault out of the station'
            : waypoint >= ROUTE.length - 1
              ? 'Reach the swap point'
              : 'Follow Mia’s route to the bridge',
        distance: player.position.distanceTo(ROUTE[waypoint]),
        arrow: state === 'chase' ? angleTo(player, ROUTE[waypoint]) : null,
        player: player.position,
        heading: player.heading,
        vault: vault.position,
        partner: partner.position,
        cops: police.cops.filter((c) => !c.wrecked).map((c) => c.v.position),
        waypoint,
      });
    } else {
      hud.update(dt, null);
    }

    gfx.render();
    input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start();
