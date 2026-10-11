import * as THREE from 'three';
import { BRIDGE_X, PITCH, SEAWALL_Z, STREET_HALF } from './city';
import type { Input } from './input';

export interface HudState {
  speedKmh: number;
  /** Nitrous meter 0..1. */
  nos: number;
  style: number;
  heat: number;
  busted: number;
  damage: number;
  wrecked: number;
  objective: string;
  /** Guidance under the arrow, e.g. "LEFT IN 80 m". */
  distance: string;
  /** Angle to the route ahead (radians, positive = left), or null to hide. */
  arrow: number | null;
  player: THREE.Vector3;
  heading: number;
  vault: THREE.Vector3;
  partner: THREE.Vector3;
  cops: THREE.Vector3[];
  /** The GPS route, next intersection first. */
  route: THREE.Vector3[];
  /** Points of interest on the minimap. */
  blips: { pos: THREE.Vector3; color: string; label: string }[];
}

const $ = (id: string) => document.getElementById(id)!;

const MAP_SCALE = 0.55; // px per meter
const MAP_SIZE = 200;

export class Hud {
  private hud = $('hud');
  private overlay = $('overlay');
  private select = $('select');
  private cards = Array.from(document.querySelectorAll<HTMLElement>('.card'));
  private selected = 0;
  private onSelect?: (id: string) => void;
  private cutsceneEl = $('cutscene');
  private radioEl = $('radio');
  private radioTimer = 0;
  private map = $('minimap') as HTMLCanvasElement;
  private ctx = this.map.getContext('2d')!;

  static money(n: number): string {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  static time(t: number): string {
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  // ------------------------------------------------------------ screens

  showSelect(onSelect: (id: string) => void): void {
    this.onSelect = onSelect;
    this.select.classList.remove('hidden');
    this.cards.forEach((card, i) => {
      card.addEventListener('mouseenter', () => this.highlight(i));
      card.addEventListener('click', () => this.confirm(i));
    });
    this.highlight(0);
  }

  selectInput(input: Input): void {
    if (input.wasPressed('ArrowLeft') || input.wasPressed('KeyA')) this.highlight(0);
    if (input.wasPressed('ArrowRight') || input.wasPressed('KeyD')) this.highlight(1);
    if (input.wasPressed('Enter')) this.confirm(this.selected);
  }

  hideSelect(): void {
    this.select.classList.add('hidden');
  }

  private highlight(i: number): void {
    this.selected = i;
    this.cards.forEach((c, k) => c.classList.toggle('active', k === i));
  }

  private confirm(i: number): void {
    const cb = this.onSelect;
    this.onSelect = undefined;
    cb?.(this.cards[i].dataset.id!);
  }

  showHud(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
  }

  showOverlay(title: string, body: string, prompt: string): void {
    $('overlay-title').textContent = title;
    $('overlay-body').textContent = body;
    $('overlay-prompt').textContent = prompt;
    this.overlay.classList.remove('hidden');
    this.showHud(false);
    this.radioEl.classList.add('hidden');
  }

  /** Letterbox bars for cutscenes; hides the gameplay HUD while on. */
  cinematic(on: boolean): void {
    this.cutsceneEl.classList.toggle('hidden', !on);
    if (on) this.showHud(false);
  }

  subtitle(who: string, text: string): void {
    const el = $('cutscene-text');
    el.innerHTML = '';
    if (!text) return;
    if (who) {
      const b = document.createElement('b');
      b.textContent = who + ': ';
      el.append(b);
    }
    el.append(text);
  }

  titleCard(text: string): void {
    const el = $('title-card');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  radio(who: string, text: string): void {
    this.radioEl.innerHTML = '';
    const b = document.createElement('b');
    b.textContent = who + ': ';
    this.radioEl.append(b, text);
    this.radioEl.classList.remove('hidden');
    this.radioTimer = 5;
  }

  // ------------------------------------------------------------ per frame

  private bannerTimer = 0;

  /** Big animated callout for a moment, e.g. ("BANK JOB", "+$2,500,000"). */
  banner(title: string, sub = '', seconds = 2.6): void {
    const el = $('banner');
    $('banner-title').textContent = title;
    $('banner-sub').textContent = sub;
    // Restart the entrance animation.
    el.classList.add('hidden');
    void el.offsetWidth;
    el.classList.remove('hidden');
    this.bannerTimer = seconds;
  }

  /** Center meter for a moment (null label hides it). */
  meter(label: string | null, value = 0, prompt = ''): void {
    $('moment-meter').classList.toggle('hidden', label === null);
    if (label === null) return;
    $('moment-label').textContent = label;
    ($('moment-fill') as HTMLElement).style.width = `${Math.round(value * 100)}%`;
    $('moment-prompt').textContent = prompt;
  }

  /** One-line gameplay hint under the objective ('' hides it). */
  hint(text: string): void {
    $('hint').textContent = text;
    $('hint').classList.toggle('hidden', !text);
  }

  update(dt: number, s: HudState | null): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) $('banner').classList.add('hidden');
    }
    if (this.radioTimer > 0) {
      this.radioTimer -= dt;
      if (this.radioTimer <= 0) this.radioEl.classList.add('hidden');
    }
    if (!s) return;

    $('speed').textContent = String(Math.round(s.speedKmh));
    ($('nos-fill') as HTMLElement).style.width = `${Math.round(s.nos * 100)}%`;
    $('style').textContent = Math.round(s.style).toLocaleString('en-US');
    $('heat').textContent = '★'.repeat(s.heat) + '☆'.repeat(5 - s.heat);
    $('damage').textContent = Hud.money(s.damage);
    $('wrecked').textContent = String(s.wrecked);
    $('objective').textContent = s.objective;
    $('distance').textContent = s.arrow === null ? '' : s.distance;
    const arrow = $('arrow');
    arrow.classList.toggle('hidden', s.arrow === null);
    if (s.arrow !== null) arrow.style.transform = `rotate(${(-s.arrow * 180) / Math.PI}deg)`;
    const bust = $('busted');
    bust.classList.toggle('hidden', s.busted <= 0.01);
    ($('busted-fill') as HTMLElement).style.width = `${s.busted * 100}%`;
    this.drawMap(s);
  }

  /**
   * Heading-up map centered on the player (like GTA's radar): the way you're
   * facing is always up, so a turn on the map is the same turn on the road.
   */
  private drawMap(s: HudState): void {
    const ctx = this.ctx;
    const c = MAP_SIZE / 2;
    const sin = Math.sin(s.heading);
    const cos = Math.cos(s.heading);
    const toMap = (p: THREE.Vector3): [number, number] => {
      const dx = p.x - s.player.x;
      const dz = p.z - s.player.z;
      const ahead = dx * sin + dz * cos;
      // Left of the car (+x when facing +z) is drawn to the left.
      const left = dx * cos - dz * sin;
      return [c - left * MAP_SCALE, c - ahead * MAP_SCALE];
    };
    ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(15,20,28,0.75)';
    ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Streets.
    ctx.strokeStyle = 'rgba(200,205,215,0.45)';
    ctx.lineWidth = STREET_HALF * 2 * MAP_SCALE;
    ctx.beginPath();
    const line = (a: THREE.Vector3, b: THREE.Vector3) => {
      ctx.moveTo(...toMap(a));
      ctx.lineTo(...toMap(b));
    };
    for (let i = 0; i <= 5; i++) line(new THREE.Vector3(i * PITCH, 0, -STREET_HALF), new THREE.Vector3(i * PITCH, 0, 7 * PITCH + STREET_HALF));
    for (let j = 0; j <= 7; j++) line(new THREE.Vector3(-STREET_HALF, 0, j * PITCH), new THREE.Vector3(5 * PITCH + STREET_HALF, 0, j * PITCH));
    line(new THREE.Vector3(BRIDGE_X, 0, SEAWALL_Z), new THREE.Vector3(BRIDGE_X, 0, SEAWALL_Z + 1000));
    ctx.stroke();

    // The GPS route.
    if (s.route.length) {
      ctx.strokeStyle = '#ffcc33';
      ctx.lineWidth = 4;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(c, c);
      for (const n of s.route) ctx.lineTo(...toMap(n));
      ctx.stroke();
      const [gx, gy] = toMap(s.route[s.route.length - 1]);
      ctx.fillStyle = '#ffcc33';
      ctx.fillRect(gx - 5, gy - 5, 10, 10);
    }

    for (const b of s.blips) {
      const [x, y] = toMap(b.pos);
      ctx.fillStyle = b.color;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0b0d12';
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(b.label, x, y + 0.5);
    }

    const dot = (p: THREE.Vector3, color: string, r: number) => {
      const [x, y] = toMap(p);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const blink = Math.floor(performance.now() / 250) % 2 === 0;
    for (const cop of s.cops) dot(cop, blink ? '#ff3344' : '#3366ff', 3.5);
    dot(s.vault, '#c0c6cf', 4);
    dot(s.partner, '#7fd1ff', 3.5);

    ctx.translate(c, c);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
