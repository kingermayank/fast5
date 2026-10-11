export interface ControlState {
  throttle: number;
  brake: number;
  /** -1 (right) .. 1 (left) */
  steer: number;
  handbrake: boolean;
  /** Nitrous (player only; AI leaves it unset). */
  nos?: boolean;
}

/** Stick dead zone, and the response curve exponent (>1 = finer control near center). */
const DEAD_ZONE = 0.12;
const STEER_CURVE = 1.5;

/**
 * Gamepad buttons (standard mapping) that act like key presses, so menus,
 * retry, reset and the camera toggle work from the pad.
 */
const PAD_KEYS: [button: number, code: string][] = [
  [9, 'Enter'], // Start / Menu
  [0, 'Enter'], // A (also handbrake while driving)
  [8, 'KeyR'], // Back / View: reset the convoy
  [3, 'KeyC'], // Y: camera
  [14, 'ArrowLeft'], // D-pad
  [15, 'ArrowRight'],
];

/** Keyboard, plus any standard gamepad (analog steering and triggers, rumble). */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private pad: Gamepad | null = null;
  private padWas: boolean[] = [];
  /** True while the last steering input came from an analog stick. */
  analog = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (['KeyA', 'KeyD', 'ArrowLeft', 'ArrowRight'].includes(e.code)) this.analog = false;
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  private any(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Read the gamepad. Call once at the start of each frame. */
  poll(): void {
    this.pad = Array.from(navigator.getGamepads?.() ?? []).find((p): p is Gamepad => !!p && p.connected) ?? null;
    if (!this.pad) return;
    PAD_KEYS.forEach(([b, code], i) => {
      const on = !!this.pad!.buttons[b]?.pressed;
      if (on && !this.padWas[i]) this.pressed.add(code);
      this.padWas[i] = on;
    });
  }

  /** True once per key press; cleared by endFrame(). */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }

  /** Rumble the gamepad, if it has motors (strength 0..1). */
  rumble(strength: number, ms = 180): void {
    const act = (this.pad as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strength), weakMagnitude: Math.min(1, strength * 0.6) })?.catch(() => {});
  }

  controls(): ControlState {
    let steer = 0;
    if (this.any('KeyA', 'ArrowLeft')) steer += 1;
    if (this.any('KeyD', 'ArrowRight')) steer -= 1;
    let throttle = this.any('KeyW', 'ArrowUp') ? 1 : 0;
    let brake = this.any('KeyS', 'ArrowDown') ? 1 : 0;
    let handbrake = this.any('Space');
    let nos = this.any('ShiftLeft', 'ShiftRight', 'KeyN');
    const p = this.pad;
    if (p) {
      const x = p.axes[0] ?? 0;
      const mag = Math.max(0, (Math.abs(x) - DEAD_ZONE) / (1 - DEAD_ZONE));
      if (steer === 0 && mag > 0) {
        steer = -Math.sign(x) * mag ** STEER_CURVE;
        this.analog = true;
      }
      const button = (i: number) => p.buttons[i]?.value ?? 0;
      throttle = Math.max(throttle, button(7)); // right trigger
      brake = Math.max(brake, button(6)); // left trigger
      handbrake ||= button(0) > 0.5 || button(5) > 0.5; // A or right bumper
      nos ||= button(1) > 0.5 || button(2) > 0.5 || button(4) > 0.5; // B, X or left bumper
    }
    return { throttle, brake, steer, handbrake, nos };
  }
}
