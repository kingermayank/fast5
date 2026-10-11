export interface ControlState {
  throttle: number;
  brake: number;
  /** -1 (right) .. 1 (left) */
  steer: number;
  handbrake: boolean;
  /** Nitrous (player only; AI leaves it unset). */
  nos?: boolean;
}

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  private any(...codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** True once per key press; cleared by endFrame(). */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  endFrame(): void {
    this.pressed.clear();
  }

  controls(): ControlState {
    let steer = 0;
    if (this.any('KeyA', 'ArrowLeft')) steer += 1;
    if (this.any('KeyD', 'ArrowRight')) steer -= 1;
    return {
      throttle: this.any('KeyW', 'ArrowUp') ? 1 : 0,
      brake: this.any('KeyS', 'ArrowDown') ? 1 : 0,
      steer,
      handbrake: this.any('Space'),
      nos: this.any('ShiftLeft', 'ShiftRight', 'KeyN'),
    };
  }
}
