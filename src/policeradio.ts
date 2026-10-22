import type { Voice } from './voice';

/**
 * Police radio under the chase, in Portuguese: the dispatcher sending units
 * after the convoy and units calling in. It's background, so it's quieter and
 * scratchier than the crew's radio and has no subtitles; a call waits for a
 * gap in the crew's talk and goes unsaid if none comes. Recordings only.
 */
const CALLS = {
  start: ['CENTRAL', 'Central para todas as viaturas: roubaram o cofre da sede. Dois carros estão rebocando o cofre pela avenida.'],
  pursuit: ['UNIT', 'Unidade doze em perseguição. Eles estão arrastando o cofre pela pista!'],
  chopper: ['CENTRAL', 'Atenção, todas as unidades: o helicóptero tem contato visual. Mantenham a perseguição.'],
  wrecks: ['UNIT', 'Central, temos várias viaturas destruídas. Precisamos de reforço, urgente!'],
  weapon: ['UNIT', 'Eles estão usando o cofre como arma! Mantenham distância!'],
  roadblock: ['CENTRAL', 'Bloqueio montado à frente. Empurrem eles para o bloqueio!'],
  lost: ['UNIT', 'Central, perdemos o cofre debaixo do viaduto! Alguém tem visual?'],
  found: ['UNIT', 'Achei! O cofre está saindo do viaduto, sentido ponte!'],
  accesses: ['CENTRAL', 'Atenção, viaturas: fechem todos os acessos à ponte!'],
  bridge: ['CENTRAL', 'Eles estão na ponte! Todas as viaturas para a ponte, agora!'],
} as const;

export type PoliceCall = keyof typeof CALLS;

/** Calls that fill a quiet stretch of the chase, in this order. */
const FILLERS: PoliceCall[] = ['pursuit', 'chopper', 'weapon', 'accesses'];

/** Seconds of nothing on the radio before a filler call. */
const QUIET = 22;

export class PoliceRadio {
  private made = new Set<PoliceCall>();
  /** Calls waiting: `wait` s until they may go out, `left` s until they're stale. */
  private pending: { name: PoliceCall; wait: number; left: number }[] = [];
  private quiet = 0;

  constructor(private voice: Voice) {}

  /** Make a call (once a run) `delay` s from now, in the first gap in the talk within `within` s after that. */
  call(name: PoliceCall, delay = 0, within = 15): void {
    if (this.made.has(name)) return;
    this.made.add(name);
    this.pending.push({ name, wait: delay, left: delay + within });
  }

  /** Every frame of the chase. */
  update(dt: number): void {
    for (const p of this.pending) {
      p.wait -= dt;
      p.left -= dt;
    }
    this.pending = this.pending.filter((p) => p.left > 0);
    if (this.voice.busy) {
      this.quiet = 0;
      return;
    }
    const due = this.pending.find((p) => p.wait <= 0);
    if (due) {
      this.pending.splice(this.pending.indexOf(due), 1);
      const [who, text] = CALLS[due.name];
      this.voice.speak(who, text, { channel: 'police', recordedOnly: true, maxWait: 1 });
      this.quiet = 0;
      return;
    }
    this.quiet += dt;
    if (this.quiet < QUIET) return;
    this.quiet = 0;
    const next = FILLERS.find((f) => !this.made.has(f));
    if (next) this.call(next);
  }
}
