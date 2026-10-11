import * as THREE from 'three';
import { BRIDGE_X, PITCH, SEAWALL_Z, STREET_HALF } from './city';
import type { Input } from './input';

export interface HudState {
  speedKmh: number;
  heat: number;
  busted: number;
  damage: number;
  wrecked: number;
  objective: string;
  distance: number;
  /** Angle to the next waypoint (radians, positive = left), or null to hide. */
  arrow: number | null;
  player: THREE.Vector3;
  heading: number;
  vault: THREE.Vector3;
  partner: THREE.Vector3;
  cops: THREE.Vector3[];
  waypoint: number;
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
  private cutsceneLines: [number, string][] = [];
  private cutsceneTime = 0;
  private radioEl = $('radio');
  private radioTimer = 0;
  private map = $('minimap') as HTMLCanvasElement;
  private ctx = this.map.getContext('2d')!;

  constructor(private route: THREE.Vector3[]) {}

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
  }

  /** Timed title cards: [secondsFromStart, text]. Empty list hides it. */
  cutscene(lines: [number, string][]): void {
    this.cutsceneLines = lines;
    this.cutsceneTime = 0;
    this.cutsceneEl.classList.toggle('hidden', lines.length === 0);
    $('cutscene-text').textContent = '';
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

  update(dt: number, s: HudState | null): void {
    if (this.cutsceneLines.length) {
      this.cutsceneTime += dt;
      const current = this.cutsceneLines.filter(([t]) => t <= this.cutsceneTime).pop();
      $('cutscene-text').textContent = current ? current[1] : '';
      if (this.cutsceneTime > 11) this.cutscene([]);
    }
    if (this.radioTimer > 0) {
      this.radioTimer -= dt;
      if (this.radioTimer <= 0) this.radioEl.classList.add('hidden');
    }
    if (!s) return;

    $('speed').textContent = String(Math.round(s.speedKmh));
    $('heat').textContent = '★'.repeat(s.heat) + '☆'.repeat(5 - s.heat);
    $('damage').textContent = Hud.money(s.damage);
    $('wrecked').textContent = String(s.wrecked);
    $('objective').textContent = s.objective;
    $('distance').textContent = s.arrow === null ? '' : `${Math.round(s.distance)} m`;
    const arrow = $('arrow');
    arrow.classList.toggle('hidden', s.arrow === null);
    if (s.arrow !== null) arrow.style.transform = `rotate(${(-s.arrow * 180) / Math.PI}deg)`;
    const bust = $('busted');
    bust.classList.toggle('hidden', s.busted <= 0.01);
    ($('busted-fill') as HTMLElement).style.width = `${s.busted * 100}%`;
    this.drawMap(s);
  }

  /** North-up map centered on the player. World +x is drawn to the left (top-down view). */
  private drawMap(s: HudState): void {
    const ctx = this.ctx;
    const c = MAP_SIZE / 2;
    const toMap = (p: THREE.Vector3): [number, number] => [c - (p.x - s.player.x) * MAP_SCALE, c - (p.z - s.player.z) * MAP_SCALE];
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
    for (let i = 0; i <= 5; i++) {
      const [x0, y0] = toMap(new THREE.Vector3(i * PITCH, 0, -STREET_HALF));
      const [x1, y1] = toMap(new THREE.Vector3(i * PITCH, 0, 7 * PITCH + STREET_HALF));
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    for (let j = 0; j <= 7; j++) {
      const [x0, y0] = toMap(new THREE.Vector3(-STREET_HALF, 0, j * PITCH));
      const [x1, y1] = toMap(new THREE.Vector3(5 * PITCH + STREET_HALF, 0, j * PITCH));
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
    const [bx0, by0] = toMap(new THREE.Vector3(BRIDGE_X, 0, SEAWALL_Z));
    const [bx1, by1] = toMap(new THREE.Vector3(BRIDGE_X, 0, SEAWALL_Z + 1000));
    ctx.moveTo(bx0, by0);
    ctx.lineTo(bx1, by1);
    ctx.stroke();

    // Remaining route.
    ctx.strokeStyle = '#ffcc33';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(c, c);
    for (let i = s.waypoint; i < this.route.length; i++) ctx.lineTo(...toMap(this.route[i]));
    ctx.stroke();

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
    ctx.rotate(-s.heading);
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
