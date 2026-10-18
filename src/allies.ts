import * as THREE from 'three';
import type { MomentContext } from './moments';
import type { Cop } from './police';
import { BANK, inTunnel, onBridge, SPIKES } from './roadmap';
import { CAUGHT_GROUPS, Vehicle, type VehicleSpec } from './vehicle';

/*
 * Han and Roman in two police cars that aren't police cars: halfway through the
 * city they come up behind the convoy, slot into the pack and ram real cruisers
 * off the road from inside it, laughing on the radio, then peel off to get to the
 * tunnel ahead of everyone. They pass straight through the crew and the vault (they
 * know where not to be); green markers and minimap blips say which two they are.
 */

const ALLY_SPEC: VehicleSpec = {
  mass: 1900,
  accel: 26,
  topSpeed: 66,
  turnRate: 2.6,
  grip: 8,
  model: { body: 0xf4f4f4, trim: 0x15181d, rim: 0x9aa0a6, police: true, asset: 'police' },
};

/** How long they ride with you (s), and how many cruisers they take out before they go. */
const RIDE = 34;
const MAX_TAKEDOWNS = 4;

const RAM_LINES = {
  ROMAN: ['Ha! Write me a ticket!', 'Sorry, officer! My foot slipped!', 'Did you see that? Did everybody see that?'],
  HAN: ['Pardon me.', 'That one’s on the city.', 'Two for two.'],
};

interface Ally {
  v: Vehicle;
  name: 'ROMAN' | 'HAN';
  marker: THREE.Mesh;
  takedowns: number;
  /** The cruiser it's going for. */
  target: Cop | null;
}

function say(ctx: MomentContext, who: string, line: string): void {
  ctx.hud.radio(who, line);
  ctx.voice.speak(who, line);
}

export class Allies {
  state: 'waiting' | 'riding' | 'leaving' | 'gone' = 'waiting';
  readonly cars: Ally[] = [];
  private time = 0;
  /** Set by the game: whether they can still come (only on the way to the tunnel, before the swap). */
  allowed: () => boolean = () => true;
  private lastLine = -10;
  private lines = { ROMAN: 0, HAN: 0 };

  constructor(private ctx: MomentContext) {}

  /** Their positions, for the minimap. */
  get blips(): THREE.Vector3[] {
    return this.state === 'riding' || this.state === 'leaving' ? this.cars.map((a) => a.v.position) : [];
  }

  /** Per frame of the chase: when to come in and when to go, their markers, the radio. */
  update(dt: number, chaseTime: number): void {
    const { ctx } = this;
    const { player, police, scene } = ctx;
    if (this.state === 'gone') return;
    if (this.state === 'waiting') {
      // Past the spike strip, the bank still ahead, and cops on their tail (or a while into the chase).
      const past = SPIKES.toLocal(player.position).z > 40;
      const busy = police.cops.filter((c) => !c.wrecked && c.v.position.distanceTo(player.position) < 110).length >= 2;
      const p = player.position;
      const clear = p.distanceTo(BANK.corner) > 260 && !inTunnel(p, 320) && !onBridge(p);
      if (((past && busy) || (chaseTime > 75 && busy)) && clear && this.allowed()) this.arrive();
      // Too late for them: they went straight to the tunnel.
      if (!this.allowed()) this.state = 'gone';
      return;
    }
    this.time += dt;
    for (const a of this.cars) {
      a.v.render(dt);
      a.marker.position.copy(a.v.position).setY(3.6 + Math.sin(this.time * 5 + (a.name === 'HAN' ? 1.5 : 0)) * 0.2);
      a.marker.rotation.y += dt * 2.5;
      const bar = a.v.model.lightBar;
      if (bar) {
        const flash = Math.floor(this.time * 6) % 2 === 0;
        bar.red.emissiveIntensity = flash ? 3 : 0.2;
        bar.blue.emissiveIntensity = flash ? 0.2 : 3;
      }
    }
    const done = this.cars.reduce((n, a) => n + a.takedowns, 0);
    const nearBank = player.position.distanceTo(BANK.corner) < 200 || inTunnel(player.position, 260);
    if (this.state === 'riding' && (this.time > RIDE || done >= MAX_TAKEDOWNS || nearBank)) {
      this.state = 'leaving';
      this.time = 0;
      say(ctx, 'HAN', 'That’s our exit. We’ll see you in the tunnel.');
    }
    if (this.state === 'leaving' && this.time > 6) {
      for (const a of this.cars) {
        a.v.dispose(scene);
        scene.remove(a.marker);
      }
      this.cars.length = 0;
      this.state = 'gone';
    }
  }

  private arrive(): void {
    const { ctx } = this;
    const { player, scene, partnerDriver } = ctx;
    this.state = 'riding';
    this.time = 0;
    // From back along the road the convoy just drove, out of sight, coming up fast.
    const trail = partnerDriver.playerTrail;
    const back = trail[Math.max(0, trail.length - 1 - 70)] ?? player.position.addScaledVector(player.forward, -80);
    const f = player.forward;
    const left = new THREE.Vector3(f.z, 0, -f.x);
    (['ROMAN', 'HAN'] as const).forEach((name, i) => {
      const at = back.clone().addScaledVector(left, i ? -3 : 3).addScaledVector(f, -i * 9);
      const v = new Vehicle(ctx.world, ALLY_SPEC, at, player.heading);
      // They pass through the crew and the vault, but they hit everything else.
      v.collider.setCollisionGroups(CAUGHT_GROUPS);
      const pv = player.body.linvel();
      v.body.setLinvel({ x: pv.x * 1.2, y: 0, z: pv.z * 1.2 }, true);
      scene.add(v.model.group);
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.45, 0.9, 4).rotateX(Math.PI),
        new THREE.MeshStandardMaterial({ color: 0x0a3a14, emissive: 0x3dff6a, emissiveIntensity: 2.6 }),
      );
      scene.add(marker);
      this.cars.push({ v, name, marker, takedowns: 0, target: null });
    });
    say(ctx, 'MIA', 'Friendlies coming up behind you: two “police” cars. That’s Roman and Han. Don’t hit them.');
    setTimeout(() => say(ctx, 'ROMAN', 'Officer Roman, reporting for duty! Who wants a ticket?'), 3400);
  }

  /** Per physics step: each picks the nearest real cruiser and drives through it. */
  step(dt: number): void {
    if (this.state !== 'riding' && this.state !== 'leaving') return;
    const { ctx } = this;
    const { player, police } = ctx;
    const pv = player.body.linvel();
    const f = player.forward;
    for (const a of this.cars) {
      const pos = a.v.position;
      if (this.state === 'leaving') {
        // Off up the road ahead, flat out.
        const want = f.clone().multiplyScalar(Math.hypot(pv.x, pv.z) + 16);
        a.v.follow(dt, want, Math.atan2(want.x, want.z), 3);
        continue;
      }
      if (a.target && (a.target.wrecked || !police.cops.includes(a.target))) a.target = null;
      if (!a.target) {
        let best: Cop | null = null;
        let bestD = 140;
        for (const c of police.cops) {
          if (c.wrecked || this.cars.some((o) => o !== a && o.target === c)) continue;
          const d = c.v.position.distanceTo(player.position);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        a.target = best;
      }
      let want: THREE.Vector3;
      const t = a.target;
      if (t) {
        // Lead the cruiser a little and come in hard.
        const tv = t.v.body.linvel();
        const aim = t.v.position.add(new THREE.Vector3(tv.x, 0, tv.z).multiplyScalar(0.35));
        const to = aim.sub(pos);
        const speed = Math.max(Math.hypot(tv.x, tv.z) + 12, 26);
        want = to.normalize().multiplyScalar(speed);
        // Rammed: it's wrecked, and it's theirs.
        const cv = a.v.body.linvel();
        const closing = Math.hypot(cv.x - tv.x, cv.z - tv.z);
        if (t.v.position.distanceTo(pos) < 3.6 && closing > 6) this.rammed(a, t);
      } else {
        // Nothing to hit: ride along behind the convoy, off to one side.
        const slot = player.position.addScaledVector(f, -14).addScaledVector(new THREE.Vector3(f.z, 0, -f.x), a.name === 'ROMAN' ? 5 : -5);
        want = new THREE.Vector3(pv.x, 0, pv.z).addScaledVector(slot.sub(pos), 1.2);
      }
      if (want.length() > 44) want.setLength(44);
      a.v.follow(dt, want, want.length() > 2 ? Math.atan2(want.x, want.z) : a.v.heading, 4);
    }
  }

  private rammed(a: Ally, cop: Cop): void {
    const { ctx } = this;
    a.target = null;
    a.takedowns++;
    ctx.police.wreck(cop, a.v.position);
    ctx.reward(200, 0.1);
    ctx.hud.banner(`${a.name === 'ROMAN' ? 'ROMAN' : 'HAN'}’S TAKEDOWN`, '+200', 1.6);
    if (this.time - this.lastLine > 4) {
      this.lastLine = this.time;
      const lines = RAM_LINES[a.name];
      say(ctx, a.name, lines[this.lines[a.name]++ % lines.length]);
    }
  }
}
