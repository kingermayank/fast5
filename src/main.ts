import * as THREE from 'three';
import { Car } from './car';
import { Hud } from './hud';
import { Input } from './input';
import { CURB_WIDTH, ROAD_HALF_WIDTH, Track, WALL_OFFSET } from './track';

const TOTAL_LAPS = 3;
const SECTORS = 4;
const PHYSICS_STEP = 1 / 120;
const CAR_HALF_WIDTH = 1.1;

type State = 'menu' | 'countdown' | 'racing' | 'finished';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const sky = new THREE.Color(0x9cc8f0);
scene.background = sky;
scene.fog = new THREE.Fog(sky, 150, 700);

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 2000);

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x4a6b32, 1.2));
const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -60;
sun.shadow.camera.right = sun.shadow.camera.top = 60;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const track = new Track();
scene.add(track.group);

const car = new Car();
scene.add(car.mesh);

const input = new Input();
const hud = new Hud(track);

let state: State = 'menu';
let trackIndex = 0;
let nextSector = 1;
let lap = 1;
let raceTime = 0;
let lapStart = 0;
let bestLap = Infinity;
let countdown = 0;
let cameraMode = 0;
let accumulator = 0;

function resetToGrid(): void {
  const idx = track.offsetIndex(0, -12);
  const t = track.tangents[idx];
  car.place(track.points[idx], Math.atan2(t.x, t.z));
  trackIndex = idx;
  nextSector = 1;
  lap = 1;
  raceTime = lapStart = 0;
  snapCamera();
}

/** Put the car back on the center line, facing the right way. */
function resetToTrack(): void {
  const loc = track.locate(car.position, trackIndex);
  car.place(loc.point, Math.atan2(loc.tangent.x, loc.tangent.z));
}

function startCountdown(): void {
  resetToGrid();
  state = 'countdown';
  countdown = 3.999;
  hud.showOverlay(false);
  hud.showHud(true);
}

function finishRace(): void {
  state = 'finished';
  hud.showOverlay(
    true,
    `Finished in ${Hud.formatTime(raceTime)}\nBest lap ${Hud.formatTime(bestLap)}`,
  );
  hud.setMessage('');
}

function sectorOf(index: number): number {
  return Math.floor((index / track.sampleCount) * SECTORS);
}

function physicsStep(dt: number): void {
  const controls =
    state === 'racing' || state === 'finished'
      ? input.controls()
      : { throttle: 0, brake: 1, steer: 0, handbrake: false };
  if (state === 'finished') {
    controls.throttle = 0;
    controls.brake = Math.min(1, car.forwardSpeed / 20);
  }

  const before = track.locate(car.position, trackIndex);
  const onRoad = Math.abs(before.lateral) <= ROAD_HALF_WIDTH + CURB_WIDTH;
  car.update(dt, controls, onRoad ? 'road' : 'grass');

  // Barrier collision: clamp to the wall and remove velocity going into it.
  const loc = track.locate(car.position, before.index);
  const limit = WALL_OFFSET - CAR_HALF_WIDTH;
  if (Math.abs(loc.lateral) > limit) {
    const side = Math.sign(loc.lateral);
    car.position.addScaledVector(loc.left, (side * limit - loc.lateral));
    const into = car.velocity.dot(loc.left) * side;
    if (into > 0) car.velocity.addScaledVector(loc.left, -side * into * 1.3);
    car.velocity.multiplyScalar(1 - 2 * dt);
    car.syncMesh(0);
  }

  trackIndex = loc.index;
  if (state !== 'racing') return;

  raceTime += dt;
  const sector = sectorOf(trackIndex);
  if (nextSector < SECTORS && sector === nextSector) {
    nextSector++;
  } else if (nextSector === SECTORS && sector === 0) {
    const lapTime = raceTime - lapStart;
    bestLap = Math.min(bestLap, lapTime);
    lapStart = raceTime;
    nextSector = 1;
    if (lap === TOTAL_LAPS) {
      finishRace();
    } else {
      lap++;
      hud.flash(lap === TOTAL_LAPS ? 'FINAL LAP' : `LAP ${lap}`, 1.5);
    }
  }
}

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();

function cameraTarget(): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const f = car.forward;
  if (cameraMode === 1) {
    // Bumper cam.
    return {
      pos: car.position.clone().addScaledVector(f, 0.6).setY(1.3),
      look: car.position.clone().addScaledVector(f, 20).setY(1.0),
    };
  }
  const speedPull = Math.min(1, Math.abs(car.forwardSpeed) / 70);
  return {
    pos: car.position.clone().addScaledVector(f, -9 - speedPull * 2).setY(3.8 + speedPull * 0.6),
    look: car.position.clone().addScaledVector(f, 4).setY(1.2),
  };
}

function snapCamera(): void {
  const t = cameraTarget();
  camPos.copy(t.pos);
  camLook.copy(t.look);
}

function updateCamera(dt: number): void {
  const t = cameraTarget();
  const k = cameraMode === 1 ? 1 : 1 - Math.exp(-8 * dt);
  camPos.lerp(t.pos, k);
  camLook.lerp(t.look, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  camera.fov = 65 + Math.min(1, Math.abs(car.forwardSpeed) / 70) * 12;
  camera.updateProjectionMatrix();

  sun.position.copy(car.position).add(new THREE.Vector3(60, 120, 40));
  sun.target.position.copy(car.position);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();

function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.1);

  if (input.wasPressed('Enter') && (state === 'menu' || state === 'finished')) startCountdown();
  if (input.wasPressed('KeyC')) {
    cameraMode = (cameraMode + 1) % 2;
    snapCamera();
  }
  if (input.wasPressed('KeyR') && state === 'racing') resetToTrack();

  if (state === 'countdown') {
    countdown -= dt;
    if (countdown <= 1) {
      state = 'racing';
      hud.flash('GO!', 0.8);
    } else {
      hud.setMessage(String(Math.floor(countdown)));
    }
  }

  accumulator += dt;
  while (accumulator >= PHYSICS_STEP) {
    physicsStep(PHYSICS_STEP);
    accumulator -= PHYSICS_STEP;
  }

  updateCamera(dt);

  const wrongWay =
    state === 'racing' && car.forwardSpeed > 5 && car.forward.dot(track.tangents[trackIndex]) < -0.3;
  hud.update(dt, {
    speedKmh: Math.abs(car.forwardSpeed) * 3.6,
    lap: Math.min(lap, TOTAL_LAPS),
    totalLaps: TOTAL_LAPS,
    time: raceTime,
    bestLap,
    wrongWay,
    car: car.position,
    heading: car.heading,
  });

  renderer.render(scene, camera);
  input.endFrame();
  requestAnimationFrame(frame);
}

resetToGrid();
requestAnimationFrame(frame);
