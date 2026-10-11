import * as THREE from 'three';
import type { Track } from './track';

export interface HudState {
  speedKmh: number;
  lap: number;
  totalLaps: number;
  time: number;
  bestLap: number;
  wrongWay: boolean;
  car: THREE.Vector3;
  heading: number;
}

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private hud = $('hud');
  private overlay = $('overlay');
  private overlaySub = $('overlay-sub');
  private message = $('center-message');
  private speed = $('speed');
  private lap = $('lap');
  private time = $('time');
  private best = $('best');
  private wrongWay = $('wrong-way');
  private minimap = $('minimap') as HTMLCanvasElement;
  private mapCtx = this.minimap.getContext('2d')!;
  private mapPath = new Path2D();
  private mapScale = 1;
  private mapOffset = new THREE.Vector2();
  private flashTimer = 0;

  constructor(track: Track) {
    // Fit the track into the minimap. World +x is drawn to the left so the map
    // matches the driver's view (left of travel = +x when heading along +z).
    const box = new THREE.Box3().setFromPoints(track.points);
    const size = this.minimap.width - 24;
    this.mapScale = size / Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    this.mapOffset.set(box.max.x, box.max.z);
    track.points.forEach((p, i) => {
      const [x, y] = this.toMap(p.x, p.z);
      if (i === 0) this.mapPath.moveTo(x, y);
      else this.mapPath.lineTo(x, y);
    });
    this.mapPath.closePath();
  }

  static formatTime(t: number): string {
    if (!isFinite(t)) return '--';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  }

  private toMap(x: number, z: number): [number, number] {
    return [12 + (this.mapOffset.x - x) * this.mapScale, 12 + (this.mapOffset.y - z) * this.mapScale];
  }

  showOverlay(visible: boolean, text?: string): void {
    this.overlay.classList.toggle('hidden', !visible);
    if (text) this.overlaySub.textContent = text;
  }

  showHud(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
  }

  setMessage(text: string): void {
    if (this.flashTimer > 0) return;
    this.message.textContent = text;
    this.message.classList.toggle('hidden', !text);
  }

  flash(text: string, seconds: number): void {
    this.flashTimer = 0;
    this.setMessage(text);
    this.flashTimer = seconds;
  }

  update(dt: number, s: HudState): void {
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.setMessage('');
    }
    this.speed.textContent = String(Math.round(s.speedKmh));
    this.lap.textContent = `${s.lap}/${s.totalLaps}`;
    this.time.textContent = Hud.formatTime(s.time);
    this.best.textContent = Hud.formatTime(s.bestLap);
    this.wrongWay.classList.toggle('hidden', !s.wrongWay);
    this.drawMinimap(s.car, s.heading);
  }

  private drawMinimap(car: THREE.Vector3, heading: number): void {
    const ctx = this.mapCtx;
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 5;
    ctx.stroke(this.mapPath);
    const [x, y] = this.toMap(car.x, car.z);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-heading);
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
