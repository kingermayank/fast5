import type { Hud } from './hud';

/**
 * Coaching in the hint slot under the objective (a moment's own hint always
 * wins): the controls that matter, in the order they matter, on the first runs;
 * this run's challenges on every run; and a nudge whenever the player is boxed
 * in or stuck.
 */
export class Coach {
  private queue: [string, number][] = [];
  private left = 0;
  private nudging = false;

  constructor(private hud: Hud) {}

  /** At the start of the chase. */
  start(firstRuns: boolean, challenges: string[]): void {
    this.queue = [];
    if (firstRuns) {
      this.queue.push(
        ['FOLLOW THE GOLD ARROWS ON THE ROAD TO THE BRIDGE', 6],
        ['SPACE: HANDBRAKE  —  SWING THE VAULT INTO THE COPS', 5],
        ['SHIFT: NITROUS  —  EVERY WRECKED COP REFILLS IT', 5],
      );
    }
    challenges.forEach((c, i) => this.queue.push([`CHALLENGE ${i + 1}/${challenges.length}:  ${c.toUpperCase()}`, 3.6]));
    this.left = 1.5;
  }

  update(dt: number, now: { boxedIn: boolean; stuck: boolean }): void {
    const nudge = now.boxedIn ? 'BOXED IN!  REVERSE (S) OR HIT NITROUS (SHIFT) TO BREAK OUT' : now.stuck ? 'STUCK?  HOLD GAS AND STEER TO SPIN OUT  —  OR PRESS R' : '';
    if (nudge) {
      this.hud.tip(nudge);
      this.nudging = true;
      return;
    }
    if (this.nudging) {
      this.nudging = false;
      this.showing = false;
      this.hud.tip('');
      this.left = 1;
    }
    this.left -= dt;
    if (this.left > 0) return;
    if (this.showing) {
      // A beat of nothing between tips, so each new one catches the eye.
      this.showing = false;
      this.hud.tip('');
      this.left = this.queue.length ? 0.5 : Infinity;
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.hud.tip(next[0]);
    this.showing = true;
    this.left = next[1];
  }

  private showing = false;

  stop(): void {
    this.queue = [];
    this.left = Infinity;
    this.hud.tip('');
  }
}
