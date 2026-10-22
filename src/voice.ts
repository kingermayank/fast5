import type { Sound } from './audio';

/**
 * Voiceover. Every line is a recording: original voices designed for each
 * character with ElevenLabs (tools/voice/script.json lists the lines;
 * public/voice/lines.json maps each to its file). They play through Web
 * Audio, clean for people on screen and over a radio for calls (a telephone
 * band, a little overdrive, a hiss under the voice, a squelch either side).
 * A line with no recording falls back to the browser's speech synthesis, and
 * its text always shows, so the game works without either. Lines queue
 * instead of talking over each other; one that has waited too long is
 * dropped, though its text still shows.
 */

/** How a line is heard: in person, over the crew's radio, or on the police band. */
export type Channel = 'clean' | 'radio' | 'police';

export interface SpeakOptions {
  channel?: Channel;
  /** Called as the line starts, or as it's dropped: show its text then. */
  onStart?: () => void;
  /** How long it may wait behind other lines before it's dropped (s). */
  maxWait?: number;
  /** Only a recording will do (the Portuguese police chatter): no speech synthesis. */
  recordedOnly?: boolean;
}

interface Profile {
  pitch: number;
  rate: number;
  female: boolean;
}

/** Speech synthesis, for a line with no recording: a pitch and pace per character. */
const PROFILES: Record<string, Profile> = {
  DOM: { pitch: 0.45, rate: 0.85, female: false },
  BRIAN: { pitch: 1.0, rate: 1.05, female: false },
  HOBBS: { pitch: 0.6, rate: 0.95, female: false },
  MIA: { pitch: 1.1, rate: 1.05, female: true },
  ELENA: { pitch: 1.0, rate: 1.0, female: true },
  HAN: { pitch: 0.85, rate: 0.95, female: false },
  ROMAN: { pitch: 0.75, rate: 1.12, female: false },
  GISELE: { pitch: 1.05, rate: 0.98, female: true },
  TEJ: { pitch: 0.8, rate: 1.05, female: false },
};

const FEMALE_HINTS = /female|samantha|victoria|karen|zira|susan|moira|tessa|fiona|serena|allison|ava|joanna|salli|kimberly/i;

/** The radio's overdrive. */
const DRIVE = (() => {
  const c = new Float32Array(512);
  for (let i = 0; i < c.length; i++) c[i] = Math.tanh(2.4 * ((i / (c.length - 1)) * 2 - 1));
  return c;
})();

interface Line {
  who: string;
  text: string;
  opts: SpeakOptions;
  /** performance.now() after which it's too late to say. */
  until: number;
}

interface Playing {
  stop(): void;
}

/** Where a line's audio goes in, and how to close that path when it's over (or cut). */
interface Path {
  node: AudioNode;
  /** Seconds before the voice starts (room for the squelch). */
  lead: number;
  end(cut: boolean): void;
}

export class Voice {
  /** "WHO|text" → file under voice/. */
  private files: Record<string, string> = {};
  private bytes = new Map<string, Promise<ArrayBuffer | null>>();
  /** The last few decoded clips (decoded audio is big; the compressed bytes are all kept). */
  private decoded = new Map<string, AudioBuffer>();
  private queue: Line[] = [];
  private playing: Playing | null = null;
  private token = 0;
  private noise: AudioBuffer | null = null;
  private synth = 'speechSynthesis' in window;
  private voices: SpeechSynthesisVoice[] = [];

  constructor(private sound: Sound) {
    fetch('voice/lines.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((m: Record<string, string>) => {
        this.files = m;
        // Fetch them all in the background, once the game itself has loaded.
        setTimeout(() => this.prefetch(), 4000);
      })
      .catch(() => {});
    if (this.synth) {
      const load = () => {
        this.voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      };
      load();
      speechSynthesis.addEventListener?.('voiceschanged', load);
    }
  }

  /** Something is being said, or waiting to be. */
  get busy(): boolean {
    return !!this.playing || this.queue.length > 0;
  }

  speak(who: string, text: string, opts: SpeakOptions = {}): void {
    this.queue.push({ who, text, opts, until: performance.now() + (opts.maxWait ?? 3) * 1000 });
    if (!this.playing) this.next();
  }

  /** Forget what's waiting, but let the line being said finish (a cutscene that has played out). */
  settle(): void {
    this.queue = [];
  }

  /** Cut whatever is being said and forget what's waiting. */
  stop(): void {
    this.token++;
    this.queue = [];
    this.playing?.stop();
    this.playing = null;
    this.sound.duck(false);
  }

  private next(): void {
    let line: Line | undefined;
    // Lines that waited too long go unsaid, but their text still shows.
    while ((line = this.queue.shift()) && performance.now() > line.until) line.opts.onStart?.();
    if (!line) {
      this.sound.duck(false);
      return;
    }
    line.opts.onStart?.();
    const token = ++this.token;
    const done = () => {
      if (token !== this.token) return;
      this.playing = null;
      this.next();
    };
    this.playing = this.playRecording(line, done) ?? (line.opts.recordedOnly ? null : this.synthesize(line, done));
    if (!this.playing) done();
  }

  /** The files for a line: its own recording, or recordings of its sentences in turn (Mia's reroutes are two lines run together). */
  private recordings(who: string, text: string): string[] | null {
    const whole = this.files[`${who}|${text}`];
    if (whole) return [whole];
    const parts = text.match(/[^.!?…]+[.!?…]+[”’"]?/g)?.map((s) => s.trim()) ?? [];
    const out: string[] = [];
    for (let i = 0; i < parts.length; ) {
      let j = parts.length;
      for (; j > i; j--) {
        const file = this.files[`${who}|${parts.slice(i, j).join(' ')}`];
        if (file) {
          out.push(file);
          break;
        }
      }
      if (j === i) return null;
      i = j;
    }
    return out.length ? out : null;
  }

  private playRecording(line: Line, done: () => void): Playing | null {
    const files = this.recordings(line.who, line.text);
    const out = this.sound.voiceOut();
    if (!files || !out) return null;
    const { ctx, bus } = out;
    const channel = line.opts.channel ?? 'clean';
    const path = channel === 'clean' ? this.clean(ctx, bus) : this.radio(ctx, bus, channel === 'police');
    // The police band is background: the mix stays up under it.
    if (channel !== 'police') this.sound.duck(true);
    let source: AudioBufferSourceNode | null = null;
    let over = false;
    const finish = (cut: boolean) => {
      if (over) return;
      over = true;
      path.end(cut);
      if (!cut) done();
    };
    const play = async (i: number) => {
      if (over) return;
      if (i >= files.length) return finish(false);
      const buffer = await this.buffer(ctx, files[i]);
      if (over) return;
      if (!buffer) return finish(false);
      const s = (source = ctx.createBufferSource());
      s.buffer = buffer;
      s.connect(path.node);
      s.onended = () => {
        if (source === s) source = null;
        void play(i + 1);
      };
      s.start(ctx.currentTime + (i === 0 ? path.lead : 0.06));
    };
    void play(0);
    return {
      stop: () => {
        try {
          source?.stop();
        } catch {
          // Not started yet.
        }
        finish(true);
      },
    };
  }

  private clean(ctx: AudioContext, bus: AudioNode): Path {
    const g = ctx.createGain();
    g.connect(bus);
    return { node: g, lead: 0, end: () => setTimeout(() => g.disconnect(), 200) };
  }

  /** Over the radio: a telephone band, a little overdrive, a hiss under the voice and a squelch either side. */
  private radio(ctx: AudioContext, bus: AudioNode, police: boolean): Path {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = police ? 450 : 300;
    const drive = ctx.createWaveShaper();
    drive.curve = DRIVE;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = police ? 2700 : 3400;
    const level = ctx.createGain();
    level.gain.value = police ? 0.32 : 0.95;
    hp.connect(drive).connect(lp).connect(level).connect(bus);
    const noise = this.noiseBuffer(ctx);
    const hiss = ctx.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    const hissLevel = ctx.createGain();
    hissLevel.gain.value = police ? 0.035 : 0.015;
    hiss.connect(hissLevel).connect(hp);
    const t = ctx.currentTime;
    hiss.start(t, Math.random());
    this.squelch(ctx, hp, t);
    return {
      node: hp,
      lead: 0.09,
      end: (cut) => {
        const now = ctx.currentTime;
        if (!cut) this.squelch(ctx, hp, now);
        const at = now + (cut ? 0 : 0.1);
        hiss.stop(at);
        setTimeout(() => level.disconnect(), (at - now) * 1000 + 100);
      },
    };
  }

  /** The burst of noise as a radio keys up or drops. */
  private squelch(ctx: AudioContext, into: AudioNode, at: number): void {
    const s = ctx.createBufferSource();
    s.buffer = this.noiseBuffer(ctx);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.07);
    s.connect(g).connect(into);
    s.start(at, Math.random());
    s.stop(at + 0.08);
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return this.noise;
  }

  private fetchBytes(file: string): Promise<ArrayBuffer | null> {
    let p = this.bytes.get(file);
    if (!p) {
      p = fetch('voice/' + file)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.bytes.set(file, p);
    }
    return p;
  }

  private async buffer(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
    const hit = this.decoded.get(file);
    if (hit) return hit;
    const bytes = await this.fetchBytes(file);
    if (!bytes) return null;
    try {
      // decodeAudioData takes the buffer over, so hand it a copy and keep the original.
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      this.decoded.set(file, decoded);
      if (this.decoded.size > 12) this.decoded.delete(this.decoded.keys().next().value!);
      return decoded;
    } catch {
      return null;
    }
  }

  /** Fetch every recording, a few at a time, so no line waits on the network. */
  private prefetch(): void {
    const files = [...new Set(Object.values(this.files))];
    let i = 0;
    const pump = (): void => {
      const file = files[i++];
      if (file) void this.fetchBytes(file).then(pump);
    };
    for (let k = 0; k < 3; k++) pump();
  }

  private synthesize(line: Line, done: () => void): Playing | null {
    if (!this.synth) return null;
    const p = PROFILES[line.who] ?? { pitch: 1, rate: 1, female: false };
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(line.text);
      const pool = this.voices.filter((v) => FEMALE_HINTS.test(v.name) === p.female);
      const voice = pool[0] ?? this.voices[0];
      if (voice) u.voice = voice;
      u.pitch = p.pitch;
      u.rate = p.rate;
      u.volume = 1;
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        done();
      };
      // Some browsers never say a synthesized line is over: give up after about as long as it should take.
      const timer = setTimeout(finish, 1500 + line.text.length * 80);
      u.onend = finish;
      u.onerror = finish;
      speechSynthesis.speak(u);
      return {
        stop: () => {
          over = true;
          clearTimeout(timer);
          speechSynthesis.cancel();
        },
      };
    } catch {
      // Speech is optional; the text carries the line.
      return null;
    }
  }
}
