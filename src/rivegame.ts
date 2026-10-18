import { Alignment, Fit, Layout, Rive, RuntimeLoader, type ViewModelInstance } from '@rive-app/webgl2';
import wasmUrl from '@rive-app/webgl2/rive.wasm?url';
import { Sound } from './audio';

/**
 * The Rive build of the game (game/, built to public/rive/fast5-game.riv): the
 * whole game runs inside the Rive file, drawn through its GPU canvas. This page
 * only hosts it, and synthesises the sound from the state the game publishes
 * on its view model (the Rive file has no audio of its own yet).
 *
 * Web runtimes only run signed scripts, so the file must come from
 * `rive game --publish` (npm run game:build), not a local build.
 */

const SRC = `${import.meta.env.BASE_URL}rive/fast5-game.riv`;

RuntimeLoader.setWasmUrl(wasmUrl);
RuntimeLoader.setWasmFallbackUrl(null);

function isRiv(b: ArrayBuffer): boolean {
  return new TextDecoder().decode(b.slice(0, 4)) === 'RIVE';
}

/** The file, or its base64 copy in .riv.json for hosts that only serve JSON. */
async function fetchRiv(): Promise<ArrayBuffer | null> {
  const riv = await fetch(SRC)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);
  if (riv && isRiv(riv)) return riv;
  const b64: unknown = await fetch(`${SRC}.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (typeof b64 !== 'string') return null;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return isRiv(bytes.buffer) ? bytes.buffer : null;
}

function status(text: string): void {
  const el = document.getElementById('status');
  if (el) {
    el.textContent = text;
    el.hidden = text === '';
  }
}

/** Turns the game's published state into sound, every frame. */
function playSound(vmi: ViewModelInstance, sound: Sound): void {
  const num = (name: string) => vmi.number(name)?.value ?? 0;
  const seen = { crash: 0, snap: 0, jerk: 0, nos: 0 };
  const tick = () => {
    const speed = num('speed') / 3.6;
    const vault = num('vaultSpeed') / 3.6;
    sound.update(speed, num('throttle'), 1e9, vault * 1.6);
    const nos = num('nosOn');
    sound.tires(num('slip'), nos > 0);
    if (nos > 0 && seen.nos === 0) sound.whoosh();
    seen.nos = nos;
    const crash = num('crashCount');
    if (crash > seen.crash) sound.crash(num('crashPower'));
    seen.crash = crash;
    const snap = num('snapCount');
    if (snap > seen.snap) {
      sound.bang();
      sound.clank();
    }
    seen.snap = snap;
    const jerk = num('jerkCount');
    if (jerk > seen.jerk) sound.clank();
    seen.jerk = jerk;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function main(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  status('Loading…');
  const buffer = await fetchRiv();
  if (!buffer) {
    status('The Rive build is missing: run npm run game:build.');
    return;
  }
  const sound = new Sound();
  const layout = () => new Layout({ fit: Fit.Layout, alignment: Alignment.Center, layoutScaleFactor: Math.min(1.35, Math.max(0.7, window.innerHeight / 720)) });
  const r: Rive = new Rive({
    buffer,
    canvas,
    stateMachine: 'UI',
    autoplay: true,
    autoBind: true,
    enableGPUCanvas: true,
    // The scripted layout holds a focus node: the canvas takes the keyboard.
    tabIndex: 0,
    layout: layout(),
    onLoad: () => {
      status('');
      r.resizeDrawingSurfaceToCanvas();
      canvas.focus();
      const vmi = r.viewModelInstance;
      if (vmi) playSound(vmi, sound);
    },
    onLoadError: (e) => status(`Couldn't load the Rive build: ${String(e)}`),
  });
  window.addEventListener('resize', () => {
    r.layout = layout();
    r.resizeDrawingSurfaceToCanvas();
  });
  // Clicking anywhere gives the game the keyboard back.
  window.addEventListener('pointerdown', () => canvas.focus());
}

void main();
