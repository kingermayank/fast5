import * as THREE from 'three';
import type { CameraFrame } from './cutscene';

export interface DirectorShot {
  /** Real-time seconds the shot holds. */
  duration: number;
  /** Camera for this moment; `k` runs 0..1 across the shot. */
  frame(k: number): CameraFrame;
}

/**
 * Drives the big-moment presentation: slow motion (a global time scale that
 * ramps smoothly in and out) and short cinematic camera shots that take over
 * from the chase camera, then hand back. Runs on real time, so a slow-motion
 * shot lasts as long on screen as it says.
 */
export class Director {
  /** Multiply simulation dt by this. */
  timeScale = 1;
  /** Extra camera shake, decays by itself. */
  shake = 0;
  private slowTarget = 1;
  private slowLeft = 0;
  private shot: DirectorShot | null = null;
  private shotTime = 0;

  /** Slow time to `scale` for `seconds` of real time. */
  slowmo(scale: number, seconds: number): void {
    this.slowTarget = Math.min(this.slowTarget, scale);
    this.slowLeft = Math.max(this.slowLeft, seconds);
  }

  play(shot: DirectorShot): void {
    this.shot = shot;
    this.shotTime = 0;
  }

  get busy(): boolean {
    return !!this.shot;
  }

  /** Advance with real (unscaled) dt. */
  update(realDt: number): void {
    if (this.slowLeft > 0) {
      this.slowLeft -= realDt;
      if (this.slowLeft <= 0) this.slowTarget = 1;
    }
    // Ease in fast, ease out a little slower so it reads as a "whoosh" back to speed.
    const rate = this.slowTarget < this.timeScale ? 10 : 3;
    this.timeScale += (this.slowTarget - this.timeScale) * Math.min(1, realDt * rate);
    if (Math.abs(this.timeScale - this.slowTarget) < 0.01) this.timeScale = this.slowTarget;
    this.shake = Math.max(0, this.shake - realDt * 2);
    if (this.shot) {
      this.shotTime += realDt;
      if (this.shotTime >= this.shot.duration) this.shot = null;
    }
  }

  /** The cinematic camera this frame, if a shot is running. */
  frame(): CameraFrame | null {
    if (!this.shot) return null;
    const f = this.shot.frame(Math.min(1, this.shotTime / this.shot.duration));
    if (this.shake > 0) {
      const s = this.shake * 0.35;
      f.pos = f.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    return f;
  }

  /** Shake offset for the regular chase camera. */
  shakeOffset(): THREE.Vector3 {
    const s = this.shake * 0.3;
    return new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
  }
}
