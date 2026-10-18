import * as THREE from 'three';
import type { Input } from './input';
import { MAP, points, RAW } from './roadmap';
import type { RiveUi } from './riveui';

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
  /** The bearing drawn as up on the minimap: the car's heading, or the camera's from overhead. */
  up: number;
  vault: THREE.Vector3;
  partner: THREE.Vector3;
  cops: THREE.Vector3[];
  /** The GPS route ahead, as a polyline along the streets. */
  route: THREE.Vector3[];
  /** Points of interest on the minimap. */
  blips: { pos: THREE.Vector3; color: string; label: string }[];
}

/** A news break: [tag, headline, crawl]. */
export type NewsBreak = readonly [string, string, string];

/** How long a news break stays up, and how long before another may replace it (s). */
const NEWS_SECONDS = 8;
const NEWS_MIN_SECONDS = 4.5;

/** What the end screen shows of a finished run (see run.ts). */
export interface ResultCard {
  grade: string;
  score: string;
  /** "NEW BEST" or the best so far. */
  best: string;
  challenges: { text: string; done: boolean }[];
}

const $ = (id: string) => document.getElementById(id)!;

const MAP_SCALE = 0.55; // px per meter
const MAP_SIZE = 200;

/** The whole street map drawn once (north-up in game coordinates); the radar rotates it. */
const BASE = (() => {
  const box = new THREE.Box3().setFromPoints(MAP.nodes.map((n) => n.pos)).expandByScalar(200);
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((box.max.x - box.min.x) * MAP_SCALE);
  canvas.height = Math.ceil((box.max.z - box.min.z) * MAP_SCALE);
  const ctx = canvas.getContext('2d')!;
  const X = (x: number) => (x - box.min.x) * MAP_SCALE;
  const Z = (z: number) => (z - box.min.z) * MAP_SCALE;
  // Water, then land, then streets.
  ctx.fillStyle = 'rgba(20,48,70,0.9)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(15,20,28,0.95)';
  for (const poly of RAW.land) {
    ctx.beginPath();
    for (const ring of poly) {
      points(ring).forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
  ctx.fillStyle = 'rgba(70,80,96,0.55)';
  for (const b of RAW.buildings) {
    ctx.beginPath();
    points(b.p).forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(200,205,215,0.5)';
  ctx.lineCap = ctx.lineJoin = 'round';
  for (const e of [...MAP.edges].sort((a, b) => b.hw - a.hw)) {
    ctx.lineWidth = Math.max(2, e.hw * 2 * MAP_SCALE);
    ctx.strokeStyle = e.rank <= 2 ? 'rgba(225,215,185,0.6)' : 'rgba(200,205,215,0.45)';
    ctx.beginPath();
    e.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Z(p.z)) : ctx.moveTo(X(p.x), Z(p.z))));
    ctx.stroke();
  }
  return { canvas, origin: box.min };
})();

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
  /** The Rive UI, once loaded: it draws everything but the minimap. */
  private ui: RiveUi | null = null;
  private screens = { select: false, hud: false, cinematic: false, overlay: false };
  /** The last few banners, news breaks and radio lines, for play-tests. */
  readonly log: string[] = [];

  private note(line: string): void {
    this.log.push(`${(performance.now() / 1000).toFixed(1)} ${line}`);
    if (this.log.length > 16) this.log.shift();
  }

  static money(n: number): string {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  static time(t: number): string {
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  // ------------------------------------------------------------ screens

  /** Hand the screens over to the Rive UI (see ui/CONTRACT.md). */
  attachRive(ui: RiveUi): void {
    this.ui = ui;
    document.body.classList.add('rive-ui');
    // Each part of the HTML UI steps aside only if the file draws it (it has that part's properties).
    const parts = { hud: 'speed', meter: 'meterLabel', hint: 'hint', radio: 'radioText', banner: 'bannerTitle', cutscene: 'subtitleText', select: 'crew', result: 'resultTitle' };
    for (const [part, prop] of Object.entries(parts)) document.body.classList.toggle(`rive-${part}`, ui.has(prop));
    ui.on('crew', (v) => typeof v === 'number' && this.highlight(Math.round(v)));
    ui.on('confirm', () => this.onSelect && this.confirm(this.selected));
    ui.set('crew', this.selected);
    this.syncScreen();
  }

  /** Which screen the Rive UI shows: the topmost of what's on. */
  private syncScreen(): void {
    if (!this.ui) return;
    const s = this.screens;
    const screen = s.overlay ? 'result' : s.cinematic ? 'cinematic' : s.select ? 'select' : s.hud ? 'drive' : 'off';
    this.ui.set('screen', screen);
    this.ui.interactive(screen === 'select' && this.ui.has('crew'));
  }

  showSelect(onSelect: (id: string) => void): void {
    this.onSelect = onSelect;
    this.screens.select = true;
    this.syncScreen();
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
    this.screens.select = false;
    this.syncScreen();
  }

  private highlight(i: number): void {
    this.selected = i;
    this.cards.forEach((c, k) => c.classList.toggle('active', k === i));
    this.ui?.set('crew', i);
  }

  private confirm(i: number): void {
    const cb = this.onSelect;
    this.onSelect = undefined;
    cb?.(this.cards[i].dataset.id!);
  }

  showHud(visible: boolean): void {
    this.hud.classList.toggle('hidden', !visible);
    this.screens.hud = visible;
    this.syncScreen();
  }

  showOverlay(title: string, body: string, prompt: string): void {
    $('overlay-title').textContent = title;
    $('overlay-body').textContent = body;
    $('overlay-prompt').textContent = prompt;
    this.overlay.classList.remove('hidden');
    this.ui?.set('resultTitle', title);
    this.ui?.set('resultBody', body);
    this.ui?.set('resultPrompt', prompt);
    this.screens.overlay = true;
    this.showHud(false);
    this.radioEl.classList.add('hidden');
    this.ui?.set('radioOn', false);
    this.newsQueue.length = 0;
    this.newsTimer = 0;
    this.ui?.set('newsOn', false);
  }

  /** Letterbox bars for cutscenes; hides the gameplay HUD while on. */
  cinematic(on: boolean): void {
    this.cutsceneEl.classList.toggle('hidden', !on);
    this.screens.cinematic = on;
    if (on) {
      this.showHud(false);
      // A scene starts clean: no gameplay banner or radio box left over on top of it.
      this.bannerTimer = Math.min(this.bannerTimer, 1e-3);
      this.radioTimer = Math.min(this.radioTimer, 1e-3);
    } else this.syncScreen();
  }

  subtitle(who: string, text: string): void {
    this.ui?.set('subtitleWho', who);
    this.ui?.set('subtitleText', text);
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
    this.ui?.set('titleCard', text);
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
    this.note(`radio ${who}: ${text}`);
    this.ui?.set('radioWho', who);
    this.ui?.set('radioText', text);
    this.ui?.set('radioOn', true);
    this.ui?.fire('radio');
  }

  // ------------------------------------------------------------ per frame

  private bannerTimer = 0;

  /** A banner is on screen (another would cut it short). */
  get bannerBusy(): boolean {
    return this.bannerTimer > 0;
  }

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
    this.note(`banner ${title} / ${sub}`);
    this.ui?.set('bannerTitle', title);
    this.ui?.set('bannerSub', sub);
    this.ui?.set('bannerOn', true);
    this.ui?.fire('banner');
  }

  /** The nitrous switches on the dash for the solo pull: `step` switches on (0..3), 4 lights the button; -1 hides it. */
  nosArm(step: number): void {
    const el = $('nos-arm');
    el.classList.toggle('hidden', step < 0);
    el.querySelectorAll('.sw').forEach((sw, i) => sw.classList.toggle('on', step > i));
    el.querySelector('.btn')!.classList.toggle('lit', step >= 4);
  }

  /** Center meter for a moment (null label hides it). */
  meter(label: string | null, value = 0, prompt = ''): void {
    $('moment-meter').classList.toggle('hidden', label === null);
    this.ui?.set('meterOn', label !== null);
    if (label === null) return;
    this.ui?.set('meterLabel', label);
    this.ui?.set('meterValue', value);
    this.ui?.set('meterPrompt', prompt);
    $('moment-label').textContent = label;
    ($('moment-fill') as HTMLElement).style.width = `${Math.round(value * 100)}%`;
    $('moment-prompt').textContent = prompt;
  }

  private momentHint = '';
  private tipText = '';

  /** One-line gameplay hint under the objective ('' hides it). Moments use it; it outranks tips. */
  hint(text: string): void {
    this.momentHint = text;
    this.showHint();
  }

  /** A coaching tip in the same slot, shown only while no moment needs it ('' clears it). */
  tip(text: string): void {
    this.tipText = text;
    this.showHint();
  }

  private showHint(): void {
    const text = this.momentHint || this.tipText;
    this.ui?.set('hint', text);
    $('hint').textContent = text;
    $('hint').classList.toggle('hidden', !text);
  }

  // ------------------------------------------------------------ TV news

  private newsTimer = 0;
  private newsQueue: NewsBreak[] = [];

  /**
   * A TV news break in the top corner (drawn by the Rive UI only): the channel's
   * tag, a headline and a crawl. One that comes in while another is still fresh
   * waits its turn; only the latest two wait.
   */
  news(item: NewsBreak): void {
    if (this.newsTimer > NEWS_SECONDS - NEWS_MIN_SECONDS) {
      this.newsQueue.push(item);
      if (this.newsQueue.length > 2) this.newsQueue.shift();
    } else {
      this.showNews(item);
    }
  }

  private showNews([tag, headline, ticker]: NewsBreak): void {
    this.newsTimer = NEWS_SECONDS;
    this.note(`news ${tag}: ${headline}`);
    this.ui?.set('newsTag', tag);
    this.ui?.set('newsHeadline', headline);
    this.ui?.set('newsTicker', ticker);
    this.ui?.set('newsOn', true);
    this.ui?.fire('news');
  }

  private updateNews(dt: number): void {
    if (this.newsTimer <= 0) return;
    this.newsTimer -= dt;
    if (this.newsQueue.length && this.newsTimer < NEWS_SECONDS - NEWS_MIN_SECONDS) this.showNews(this.newsQueue.shift()!);
    else if (this.newsTimer <= 0) this.ui?.set('newsOn', false);
  }

  /** The end screen's rank, score and challenges (null hides them: busted, or the vault lost). */
  result(r: ResultCard | null): void {
    if (!this.ui) {
      // The HTML end screen gets the same, as text.
      if (r) $('overlay-body').textContent += `\n\nRANK ${r.grade}   SCORE ${r.score}   ${r.best}\n` + r.challenges.map((c) => `${c.done ? 'DONE' : 'MISSED'}  ${c.text}`).join('\n');
      return;
    }
    this.ui.set('resultRanked', !!r);
    if (!r) return;
    this.ui.set('resultGrade', r.grade);
    this.ui.set('resultScore', r.score);
    this.ui.set('resultBest', r.best);
    r.challenges.forEach((c, i) => {
      this.ui!.set(`ch${i + 1}Done`, c.done ? 'DONE   ' : '');
      this.ui!.set(`ch${i + 1}Miss`, c.done ? '' : 'MISSED   ');
      this.ui!.set(`ch${i + 1}Text`, c.text + (i < r.challenges.length - 1 ? '\n' : ''));
    });
  }

  update(dt: number, s: HudState | null): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) {
        $('banner').classList.add('hidden');
        this.ui?.set('bannerOn', false);
      }
    }
    if (this.radioTimer > 0) {
      this.radioTimer -= dt;
      if (this.radioTimer <= 0) {
        this.radioEl.classList.add('hidden');
        this.ui?.set('radioOn', false);
      }
    }
    this.updateNews(dt);
    if (!s) return;
    if (this.ui) this.updateRive(this.ui, s);

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

  private updateRive(ui: RiveUi, s: HudState): void {
    ui.set('speed', Math.round(s.speedKmh));
    ui.set('speedText', String(Math.round(s.speedKmh)));
    ui.set('nos', Math.round(s.nos * 100) / 100);
    ui.set('heat', s.heat);
    ui.set('busted', Math.round(s.busted * 100) / 100);
    ui.set('style', Math.round(s.style).toLocaleString('en-US'));
    ui.set('damage', Hud.money(s.damage));
    ui.set('wrecked', String(s.wrecked));
    ui.set('objective', s.objective);
    ui.set('guidance', s.arrow === null ? '' : s.distance);
    ui.set('arrowOn', s.arrow !== null);
    // Radians, clockwise on screen (the arrow's +left is counter-clockwise); a degree's precision is plenty.
    if (s.arrow !== null) ui.set('arrowAngle', Math.round(-s.arrow * 57.3) / 57.3);
  }

  /**
   * Map centered on the player (like GTA's radar), turned so `up` is up: behind
   * the car that's the way you're facing, so a turn on the map is the same turn
   * on the road; from overhead it's the camera's up, so the map matches the screen.
   */
  private drawMap(s: HudState): void {
    const ctx = this.ctx;
    const c = MAP_SIZE / 2;
    const sin = Math.sin(s.up);
    const cos = Math.cos(s.up);
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

    // The map, turned so `up` is up.
    const px = (s.player.x - BASE.origin.x) * MAP_SCALE;
    const pz = (s.player.z - BASE.origin.z) * MAP_SCALE;
    ctx.save();
    // Screen = center + R * (map - player), with R taking +up to up and its left to the left.
    const a = -cos;
    const b = -sin;
    const cc = sin;
    const d = -cos;
    ctx.setTransform(a, b, cc, d, c - (a * px + cc * pz), c - (b * px + d * pz));
    ctx.drawImage(BASE.canvas, 0, 0);
    ctx.restore();

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
    // The player's arrow points the way the car faces.
    ctx.rotate(s.up - s.heading);
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
