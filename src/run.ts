import type { ResultCard } from './hud';

/**
 * One run's score, its rank, and the player's records across runs. Each run
 * also draws three challenges, favouring ones the player has never done, so
 * there's always a reason to go again. Records live in localStorage.
 */

export interface RunStats {
  /** Reached the swap point. */
  finished: boolean;
  /** Chase time (s). */
  time: number;
  wrecked: number;
  damage: number;
  style: number;
  bank: boolean;
  spikesClean: boolean;
  tireLost: boolean;
  /** Seconds of nitrous burned. */
  nosSeconds: number;
  maxHeat: number;
  topSpeedKmh: number;
  /** Most police cars wrecked within a few seconds of each other. */
  bestStreak: number;
}

export function freshStats(): RunStats {
  return { finished: false, time: 0, wrecked: 0, damage: 0, style: 0, bank: false, spikesClean: false, tireLost: false, nosSeconds: 0, maxHeat: 1, topSpeedKmh: 0, bestStreak: 0 };
}

interface Challenge {
  id: string;
  text: string;
  done(s: RunStats): boolean;
  /** How far along, for one that was missed. */
  progress?(s: RunStats): string;
}

const CHALLENGES: Challenge[] = [
  { id: 'bank', text: 'Swing the vault through the bank', done: (s) => s.bank },
  { id: 'spikes', text: 'Thread the gap in the spike strip', done: (s) => s.spikesClean },
  { id: 'wreck15', text: 'Wreck 15 police cars', done: (s) => s.wrecked >= 15, progress: (s) => `${s.wrecked}/15` },
  { id: 'wreck30', text: 'Wreck 30 police cars', done: (s) => s.wrecked >= 30, progress: (s) => `${s.wrecked}/30` },
  { id: 'fast', text: 'Reach the bridge in under 3:30', done: (s) => s.finished && s.time < 210, progress: (s) => (s.finished ? fmtTime(s.time) : 'not reached') },
  { id: 'damage', text: 'Cause $4,000,000 in damage', done: (s) => s.damage >= 4e6, progress: (s) => `$${(s.damage / 1e6).toFixed(1)}M` },
  { id: 'heat5', text: 'Reach the bridge at heat 5', done: (s) => s.finished && s.maxHeat >= 5, progress: (s) => `heat ${s.maxHeat}` },
  { id: 'tires', text: 'Finish on all four tires', done: (s) => s.finished && !s.tireLost },
  { id: 'nos', text: 'Burn 12 seconds of nitrous', done: (s) => s.nosSeconds >= 12, progress: (s) => `${s.nosSeconds.toFixed(0)} s` },
  { id: 'speed', text: 'Hit 160 km/h with the vault in tow', done: (s) => s.topSpeedKmh >= 160, progress: (s) => `${Math.round(s.topSpeedKmh)} km/h` },
  { id: 'streak', text: 'Wreck 3 police cars in a row', done: (s) => s.bestStreak >= 3, progress: (s) => `best ${s.bestStreak}` },
];

interface Records {
  runs: number;
  finishes: number;
  bestScore: number;
  bestGrade: string;
  bestTime: number | null;
  mostWrecked: number;
  /** Challenge ids ever completed. */
  done: string[];
}

const KEY = 'fast5.records';

function load(): Records {
  const empty: Records = { runs: 0, finishes: 0, bestScore: 0, bestGrade: '', bestTime: null, mostWrecked: 0, done: [] };
  try {
    return { ...empty, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Records>) };
  } catch {
    return empty;
  }
}

function save(r: Records): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // Private windows: the run still works, it just isn't remembered.
  }
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  return `${m}:${Math.floor(t - m * 60).toString().padStart(2, '0')}`;
}

/** A clean, steady run to the bridge is an A; an S takes speed, nitrous and a lot of wrecked cruisers. */
const GRADES = [
  ['S', 58000],
  ['A', 42000],
  ['B', 28000],
  ['C', 0],
] as const;

export class Run {
  readonly stats = freshStats();
  readonly challenges: Challenge[];
  readonly records = load();

  constructor() {
    // Three challenges, never-done ones first, in random order.
    const done = new Set(this.records.done);
    const shuffled = [...CHALLENGES].sort(() => Math.random() - 0.5);
    shuffled.sort((a, b) => Number(done.has(a.id)) - Number(done.has(b.id)));
    this.challenges = shuffled.slice(0, 3);
  }

  /** How many runs came before this one (0 on a first run). */
  get previousRuns(): number {
    return this.records.runs;
  }

  /** A challenge that's just been met this run, once each (for a callout). */
  private announced = new Set<string>();
  newlyDone(): Challenge[] {
    const out = this.challenges.filter((c) => !this.announced.has(c.id) && c.done(this.stats));
    for (const c of out) this.announced.add(c.id);
    return out;
  }

  score(): number {
    const s = this.stats;
    const timeBonus = s.finished ? Math.max(0, 300 - s.time) * 60 : 0;
    const challengeBonus = this.challenges.filter((c) => c.done(s)).length * 2500;
    return Math.round(s.style + s.wrecked * 300 + s.damage / 500 + timeBonus + (s.finished ? 8000 : 0) + challengeBonus);
  }

  grade(score = this.score()): string {
    return GRADES.find(([, min]) => score >= min)![0];
  }

  /** Record the run (once) and make the end screen's card. */
  finish(): ResultCard {
    const s = this.stats;
    const score = this.score();
    const grade = this.grade(score);
    const r = this.records;
    const newBest = score > r.bestScore;
    const prevBest = r.bestScore;
    r.runs++;
    if (s.finished) r.finishes++;
    if (newBest) {
      r.bestScore = score;
      r.bestGrade = grade;
    }
    if (s.finished && (r.bestTime === null || s.time < r.bestTime)) r.bestTime = s.time;
    r.mostWrecked = Math.max(r.mostWrecked, s.wrecked);
    for (const c of this.challenges) if (c.done(s) && !r.done.includes(c.id)) r.done.push(c.id);
    save(r);
    return {
      grade,
      score: score.toLocaleString('en-US'),
      best: newBest && r.runs > 1 ? `NEW BEST  (WAS ${prevBest.toLocaleString('en-US')})` : newBest ? 'FIRST RUN ON RECORD' : `BEST ${r.bestScore.toLocaleString('en-US')}  ·  RANK ${r.bestGrade}`,
      challenges: this.challenges.map((c) => {
        const done = c.done(s);
        return { text: done || !c.progress ? c.text : `${c.text}  (${c.progress(s)})`, done };
      }),
    };
  }

  /** Count a run that ended without reaching the bridge (busted, or the vault lost). */
  fail(): void {
    this.records.runs++;
    this.records.mostWrecked = Math.max(this.records.mostWrecked, this.stats.wrecked);
    for (const c of this.challenges) if (c.done(this.stats) && !this.records.done.includes(c.id)) this.records.done.push(c.id);
    save(this.records);
  }
}
