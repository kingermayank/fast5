import * as THREE from 'three';
import type { Hud } from './hud';
import type { Voice } from './voice';

export interface CameraFrame {
  pos: THREE.Vector3;
  look: THREE.Vector3;
  fov?: number;
}

export interface Shot {
  duration: number;
  /** Camera for this moment; `k` runs 0..1 across the shot, `t` is seconds into it. */
  camera(k: number, t: number): CameraFrame;
  /** Big centered title card shown for the whole shot. */
  title?: string;
  /** [secondsIntoShot, SPEAKER, line] */
  lines?: [number, string, string][];
  start?(): void;
  update?(t: number, dt: number): void;
}

/**
 * Plays a list of shots with letterboxing, subtitles and voiceover. If a video
 * file is registered for the scene, it plays that instead. Either way `finish`
 * runs once at the end (or on skip) to leave the world in the scene's end state.
 */
export class Cutscene {
  private index = -1;
  private time = 0;
  private spoken = new Set<string>();
  private video: HTMLVideoElement | null = null;
  done = false;
  shake = 0;

  constructor(
    private shots: Shot[],
    private hud: Hud,
    private voice: Voice,
    private finish: () => void,
    videoUrl?: string,
  ) {
    hud.cinematic(true);
    if (videoUrl) this.playVideo(videoUrl);
    else this.next();
  }

  /** Advance; returns the camera to use this frame (null once finished). */
  update(dt: number): CameraFrame | null {
    if (this.done) return null;
    if (this.video) return null;
    this.time += dt;
    let shot = this.shots[this.index];
    if (this.time >= shot.duration) {
      this.next();
      if (this.done) return null;
      shot = this.shots[this.index];
    }
    shot.update?.(this.time, dt);
    for (const [at, who, text] of shot.lines ?? []) {
      const key = `${this.index}:${at}`;
      if (this.time >= at && !this.spoken.has(key)) {
        this.spoken.add(key);
        this.hud.subtitle(who, text);
        this.voice.speak(who, text);
      }
    }
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const frame = shot.camera(Math.min(1, this.time / shot.duration), this.time);
    if (this.shake > 0) {
      const s = this.shake * 0.4;
      frame.pos = frame.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
    }
    return frame;
  }

  skip(): void {
    if (this.done) return;
    this.end();
  }

  private next(): void {
    this.index++;
    this.time = 0;
    if (this.index >= this.shots.length) {
      this.end();
      return;
    }
    const shot = this.shots[this.index];
    this.hud.titleCard(shot.title ?? '');
    this.hud.subtitle('', '');
    shot.start?.();
  }

  private end(): void {
    this.done = true;
    this.voice.stop();
    this.video?.remove();
    this.video = null;
    this.hud.titleCard('');
    this.hud.subtitle('', '');
    this.hud.cinematic(false);
    this.finish();
  }

  private playVideo(url: string): void {
    const v = document.createElement('video');
    v.src = url;
    v.className = 'cutscene-video';
    v.playsInline = true;
    v.addEventListener('ended', () => this.end());
    v.addEventListener('error', () => {
      // Missing or unplayable file: fall back to the in-engine version.
      v.remove();
      this.video = null;
      this.next();
    });
    document.body.appendChild(v);
    this.video = v;
    void v.play().catch(() => v.dispatchEvent(new Event('error')));
  }
}

/** Smooth 0..1 ease. */
export const ease = (k: number) => k * k * (3 - 2 * k);

export function lerpFrame(a: [number, number, number], b: [number, number, number], la: [number, number, number], lb: [number, number, number], k: number): CameraFrame {
  const e = ease(k);
  return {
    pos: new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), e),
    look: new THREE.Vector3(...la).lerp(new THREE.Vector3(...lb), e),
  };
}
