import * as THREE from 'three';
import { angleTo, seek } from './ai';
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
import { Hud } from './hud';
import { Input, type ControlState } from './input';
import { PartnerDriver } from './partner';
import { FIXED_DT, initPhysics } from './physics';
import { Police } from './police';
import { Cable, Vault } from './vault';
import { Vehicle, type VehicleSpec } from './vehicle';

type CharacterId = 'rico' | 'cole';

export const CHARACTERS: Record<CharacterId, { name: string; spec: VehicleSpec; side: 1 | -1 }> = {
  rico: {
    name: 'Rico Santos',
    side: 1,
    spec: {
      mass: 2100, accel: 23, topSpeed: 62, turnRate: 2.1, grip: 7.5,
      model: { body: 0x1a1a1c, trim: 0x0b0b0c, rim: 0x7a6440, matte: true },
    },
  },
  cole: {
    name: 'Cole Mercer',
    side: -1,
    spec: {
      mass: 1800, accel: 25, topSpeed: 64, turnRate: 2.5, grip: 7,
      model: { body: 0x1d1f23, trim: 0x0b0b0c, rim: 0xc4c8ce, matte: true },
    },
  },
};

type State = 'select' | 'intro' | 'breach' | 'chase' | 'outro' | 'busted' | 'lost';

const CABLE_TOW_LENGTH = 10;

async function start(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xf0b98a);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 120, 520);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 3000);

  // Late-afternoon light, low warm sun.
  scene.add(new THREE.HemisphereLight(0xffe2c4, 0x4a4036, 1.3));
  const sun = new THREE.DirectionalLight(0xffd6a8, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -70;
  sun.shadow.camera.right = sun.shadow.camera.top = 70;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const world = await initPhysics();
  const city = new City(world);
  scene.add(city.group);

  const vault = new Vault(world, VAULT_START, VAULT_START_HEADING);
  scene.add(vault.mesh);

  const input = new Input();
  const hud = new Hud(ROUTE);
  const police = new Police(world, scene, city);

  let state: State = 'select';
  let character: CharacterId = 'rico';
  let player!: Vehicle;
  let partner!: Vehicle;
  let partnerAi!: PartnerDriver;
  let cables: Cable[] = [];
  let stateTime = 0;
  let chaseTime = 0;
  let damage = 0;
  let heat = 0;
  let busted = 0;
  let waypoint = 0;
  let accumulator = 0;
  let lastCalloutWaypoint = -1;

  function setupCrew(id: CharacterId): void {
    character = id;
    const me = CHARACTERS[id];
    const other = CHARACTERS[id === 'rico' ? 'cole' : 'rico'];
    // Left car (+x when facing north) is the one with side = 1.
    const startFor = (side: number) => CAR_STARTS[side === 1 ? 1 : 0];
    player = new Vehicle(world, me.spec, startFor(me.side), 0);
    partner = new Vehicle(world, other.spec, startFor(other.side), 0);
    scene.add(player.model.group, partner.model.group);
    partnerAi = new PartnerDriver(world, city, -me.side);
    partnerAi.reset(player);
    for (const [car, side] of [[player, me.side], [partner, other.side]] as const) {
      const len = car.towPoint().distanceTo(vault.anchorWorld(side)) + 0.6;
      cables.push(new Cable(world, scene, car, vault, side, len));
    }
  }

  function enter(next: State): void {
    state = next;
    stateTime = 0;
  }

  // ----------------------------------------------------------- partner AI

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
    partner.controls = driving ? partnerAi.controls(dt, player, partner, vault.position) : player.controls;
    player.step(dt);
    partner.step(dt);

    if (state === 'chase' && !noCops) {
      const onBridge = player.position.z > SEAWALL_Z;
      police.step(dt, player, vault, heat, onBridge);
    } else if (state === 'outro' || state === 'busted' || state === 'lost') {
      police.step(dt, player, vault, heat, player.position.z > SEAWALL_Z);
    }

    if (state !== 'breach' && state !== 'intro') for (const c of cables) c.reel(CABLE_TOW_LENGTH, dt);
    world.step();
  }

  function updateGame(dt: number): void {
    stateTime += dt;
    if (state === 'intro') {
      if (input.wasPressed('Enter') || stateTime > 11) {
        enter('breach');
        hud.showHud(true);
        hud.radio('LENA', 'Wall’s down. Floor it — pull that vault out of there!');
      }
      return;
    }

    if (state === 'breach' && vault.position.x > STATION_FACADE_X + 3) {
      enter('chase');
      heat = 1;
      hud.radio('LENA', 'It’s out! Every cop in Porto Sol is coming. Follow my route.');
    }

    if ((state === 'breach' || state === 'chase') && inWater()) {
      enter('lost');
      hud.showOverlay(
        'VAULT LOST',
        `The vault went over the side and into the lagoon.\nSalazar’s money is at the bottom of the bay.\n\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`,
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
      damage += city.collectDamage();
      heat = Math.min(5, 1 + Math.floor(chaseTime / 50) + Math.floor(damage / 300000) + Math.floor(police.wreckedCount / 10));

      // Route progress.
      const wp = ROUTE[waypoint];
      if (player.position.distanceTo(wp) < 30 && waypoint < ROUTE.length - 1) waypoint++;
      calloutTurn();

      // Busted: boxed in by cops and stopped.
      const pinned = police.closeTo(player.position, 9) >= 2 && Math.abs(player.forwardSpeed) < 4;
      busted = THREE.MathUtils.clamp(busted + (pinned ? dt / 3.5 : -dt / 2), 0, 1);
      if (busted >= 1) {
        enter('busted');
        hud.showOverlay('BUSTED', `They boxed you in.\nCops wrecked: ${police.wreckedCount}   Damage: ${Hud.money(damage)}`, 'Press Enter to try again');
      }

      if (player.position.z > SWAP_ZONE_Z) {
        enter('outro');
        hud.radio('LENA', 'You made it. Kill the engines.');
      }
    }

    if (state === 'outro' && stateTime > 4 && stateTime - dt <= 4) {
      hud.showOverlay(
        'THE SWAP',
        'While every cop in Porto Sol chased that vault, Deuce and Kong swapped it for an empty decoy.\n' +
          'Salazar’s money was already gone.\n\n' +
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
    if (waypoint === ROUTE.length - 2) {
      hud.radio('LENA', 'Bridge ahead. Get to the yellow gantry at the far end.');
    } else if (Math.abs(cross) > 1) {
      // Left of travel is +x when facing +z, which makes a left turn a negative cross product.
      hud.radio('LENA', cross < 0 ? 'Next intersection — hang a left!' : 'Next intersection — go right!');
    }
  }

  // ----------------------------------------------------------- camera

  const camPos = new THREE.Vector3(260, 120, 40);
  const camLook = new THREE.Vector3(180, 0, 150);

  function updateCamera(dt: number): void {
    let pos: THREE.Vector3;
    let look: THREE.Vector3;
    let k = 1 - Math.exp(-5 * dt);
    if (state === 'select') {
      const t = performance.now() / 1000;
      pos = new THREE.Vector3(180 + Math.cos(t * 0.15) * 70, 30, 150 + Math.sin(t * 0.15) * 70);
      look = new THREE.Vector3(185, 4, 150);
      k = 1;
    } else if (state === 'intro') {
      // Sweep down from above the city to the crew at the station.
      const t = Math.min(1, stateTime / 10);
      const e = t * t * (3 - 2 * t);
      pos = new THREE.Vector3().lerpVectors(new THREE.Vector3(320, 140, -60), new THREE.Vector3(214, 9, 132), e);
      look = new THREE.Vector3().lerpVectors(new THREE.Vector3(200, 0, 200), new THREE.Vector3(186, 2, 152), e);
      k = 1;
    } else if (state === 'outro') {
      const t = stateTime * 0.25;
      const c = player.position;
      pos = new THREE.Vector3(c.x + Math.cos(t) * 26, 10, c.z + Math.sin(t) * 26);
      look = c.clone().setY(1.5);
    } else {
      const f = player.forward;
      const speed = Math.min(1, Math.abs(player.forwardSpeed) / 60);
      pos = player.position.addScaledVector(f, -15 - speed * 3).setY(7 + speed);
      look = player.position.addScaledVector(f, 6).setY(1.5);
    }
    camPos.lerp(pos, k);
    camLook.lerp(look, k);
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    const focus = player ? player.position : camLook;
    sun.position.copy(focus).add(new THREE.Vector3(-80, 110, -50));
    sun.target.position.copy(focus);
  }

  function resize(): void {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // ----------------------------------------------------------- start

  function begin(id: CharacterId): void {
    hud.hideSelect();
    setupCrew(id);
    enter('intro');
    hud.cutscene([
      [0, 'PORTO SOL — 6:42 PM'],
      [2.5, 'Victor Salazar keeps $100 million in a vault inside police headquarters.'],
      [5.5, 'Half the cops in this city are on his payroll, guarding it.'],
      [8.5, 'Agent Holloway’s truck just opened the wall. Now pull.'],
    ]);
  }

  const params = new URL(location.href).searchParams;
  // Debug: ?autopilot=1 drives the player along Lena's route (used by play-tests).
  const autopilot = params.has('autopilot');
  // Debug: ?nocops=1 disables police (for testing the route and ending).
  const noCops = params.has('nocops');
  const preset = params.get('crew');
  if (preset === 'rico' || preset === 'cole') {
    begin(preset);
    enter('breach');
    hud.cutscene([]);
    hud.showHud(true);
    hud.radio('LENA', 'Wall’s down. Floor it — pull that vault out of there!');
  } else {
    hud.showSelect((id) => begin(id as CharacterId));
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
    cables: cables.map((c) => +c.length.toFixed(1)),
    heat,
    waypoint,
    cops: police.cops.length,
    wrecked: police.wreckedCount,
    damage,
    busted: +busted.toFixed(2),
  });

  const timer = new THREE.Timer();
  function frame(time: number): void {
    timer.update(time);
    const dt = Math.min(timer.getDelta(), 0.1);
    if (state === 'select') {
      hud.selectInput(input);
    } else {
      accumulator += dt;
      while (accumulator >= FIXED_DT) {
        physicsStep(FIXED_DT);
        accumulator -= FIXED_DT;
      }
      updateGame(dt);
      player.render(dt);
      partner.render(dt);
      for (const c of cables) c.render();
      police.render(dt);
    }
    vault.render();
    city.render();
    updateCamera(dt);

    if (player && state !== 'intro') {
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
              : 'Follow Lena’s route to the bridge',
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

    renderer.render(scene, camera);
    input.endFrame();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start();
