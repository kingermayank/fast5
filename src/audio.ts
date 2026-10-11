/**
 * Procedural sound: everything is synthesized with WebAudio, so there are no
 * audio files. Browsers only allow sound after a user gesture, so the context
 * starts on the first key press or click.
 */
export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private engine?: { osc: OscillatorNode[]; gain: GainNode; filter: BiquadFilterNode };
  private siren?: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode };
  private scrape?: { gain: GainNode; filter: BiquadFilterNode };
  private screech?: { gain: GainNode; filter: BiquadFilterNode };
  private nosHiss?: GainNode;

  constructor() {
    const unlock = () => this.start();
    window.addEventListener('keydown', unlock, { once: false });
    window.addEventListener('pointerdown', unlock, { once: false });
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  private start(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws through a low-pass, with a growl from a waveshaper.
    const eg = ctx.createGain();
    eg.gain.value = 0;
    const ef = ctx.createBiquadFilter();
    ef.type = 'lowpass';
    ef.frequency.value = 600;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 3);
    }
    shaper.curve = curve;
    const osc = [ctx.createOscillator(), ctx.createOscillator()];
    osc[0].type = 'sawtooth';
    osc[1].type = 'square';
    osc[1].detune.value = -1200;
    for (const o of osc) {
      o.frequency.value = 45;
      o.connect(shaper);
      o.start();
    }
    shaper.connect(ef).connect(eg).connect(this.master);
    this.engine = { osc, gain: eg, filter: ef };

    // Siren: a sine swept up and down by a slow LFO.
    const sg = ctx.createGain();
    sg.gain.value = 0;
    const so = ctx.createOscillator();
    so.type = 'triangle';
    so.frequency.value = 900;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.45;
    const lfoAmp = ctx.createGain();
    lfoAmp.gain.value = 330;
    lfo.connect(lfoAmp).connect(so.frequency);
    so.connect(sg).connect(this.master);
    so.start();
    lfo.start();
    this.siren = { osc: so, lfo, gain: sg };

    // Steel on asphalt: looped band-passed noise.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bf = ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 2400;
    bf.Q.value = 0.8;
    const scg = ctx.createGain();
    scg.gain.value = 0;
    src.connect(bf).connect(scg).connect(this.master);
    src.start();
    this.scrape = { gain: scg, filter: bf };

    // Tire screech: narrow band-passed noise around 1 kHz, wobbling.
    const tsrc = ctx.createBufferSource();
    tsrc.buffer = this.noise;
    tsrc.loop = true;
    const tf = ctx.createBiquadFilter();
    tf.type = 'bandpass';
    tf.frequency.value = 1100;
    tf.Q.value = 6;
    const tg = ctx.createGain();
    tg.gain.value = 0;
    tsrc.connect(tf).connect(tg).connect(this.master);
    tsrc.start();
    this.screech = { gain: tg, filter: tf };

    // Nitrous: a high hiss while it's firing.
    const nsrc = ctx.createBufferSource();
    nsrc.buffer = this.noise;
    nsrc.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 3500;
    const ng = ctx.createGain();
    ng.gain.value = 0;
    nsrc.connect(nf).connect(ng).connect(this.master);
    nsrc.start();
    this.nosHiss = ng;
  }

  /** Per-frame: engine pitch from speed and throttle, siren from nearest cop, scrape from vault drag. */
  update(speed: number, throttle: number, copDistance: number, vaultDrag: number): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (this.engine) {
      // Fake gear changes: pitch rises within each band.
      const gearSpan = 14;
      const inGear = (Math.abs(speed) % gearSpan) / gearSpan;
      const gear = Math.floor(Math.abs(speed) / gearSpan);
      const f = 38 + gear * 6 + inGear * 55 + throttle * 10;
      for (const o of this.engine.osc) o.frequency.setTargetAtTime(f, t, 0.05);
      this.engine.filter.frequency.setTargetAtTime(400 + throttle * 1400 + Math.abs(speed) * 10, t, 0.08);
      this.engine.gain.gain.setTargetAtTime(0.08 + throttle * 0.12, t, 0.1);
    }
    if (this.siren) {
      const v = copDistance < 220 ? Math.pow(1 - copDistance / 220, 1.5) * 0.12 : 0;
      this.siren.gain.gain.setTargetAtTime(v, t, 0.2);
    }
    if (this.scrape) {
      this.scrape.gain.gain.setTargetAtTime(Math.min(0.25, vaultDrag * 0.012), t, 0.05);
      this.scrape.filter.frequency.setTargetAtTime(1800 + vaultDrag * 40, t, 0.1);
    }
  }

  /** Tire squeal (0..1) and nitrous hiss on/off. */
  tires(slip: number, nos: boolean): void {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (this.screech) {
      this.screech.gain.gain.setTargetAtTime(Math.min(0.18, slip * 0.18), t, 0.05);
      this.screech.filter.frequency.setTargetAtTime(900 + Math.sin(t * 13) * 120 + slip * 300, t, 0.05);
    }
    this.nosHiss?.gain.setTargetAtTime(nos ? 0.16 : 0, t, 0.06);
  }

  /** Nitrous kick: a low thump and a rising whoosh. */
  whoosh(): void {
    this.burst(0.9, 1800, 0.5, 'bandpass');
    this.burst(0.25, 200, 0.5);
  }

  /** Breaking glass: a sharp crack and a shower of high tinkles. */
  shatter(): void {
    this.burst(0.15, 5000, 0.7, 'highpass');
    for (let i = 0; i < 6; i++) {
      setTimeout(() => this.ping(2500 + Math.random() * 3000, 0.08), 40 + i * 50 + Math.random() * 60);
    }
  }

  /** A tire letting go. */
  bang(): void {
    this.burst(0.18, 600, 1.0);
    this.burst(0.5, 3000, 0.3, 'highpass');
  }

  /** Bank alarm: a two-tone bell for a few seconds. */
  alarm(seconds = 6): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    const g = ctx.createGain();
    const t = ctx.currentTime;
    for (let k = 0; k < seconds * 4; k++) o.frequency.setValueAtTime(k % 2 ? 880 : 1175, t + k * 0.25);
    g.gain.setValueAtTime(0.05, t);
    g.gain.setValueAtTime(0.05, t + seconds - 0.3);
    g.gain.linearRampToValueAtTime(0, t + seconds);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + seconds);
  }

  /** A short bright tone (UI stingers, glass tinkles). */
  ping(freq: number, volume = 0.15, duration = 0.25): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.05);
  }

  /** Silence the continuous layers (cutscenes, menus). */
  quiet(): void {
    this.update(0, 0, 1e9, 0);
    this.tires(0, false);
    if (this.engine && this.ready) this.engine.gain.gain.setTargetAtTime(0.03, this.ctx!.currentTime, 0.2);
  }

  /** One-shot noise burst: crashes, gunshots, debris. */
  private burst(duration: number, freq: number, volume: number, type: BiquadFilterType = 'lowpass'): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(volume, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + duration + 0.05);
  }

  crash(power = 1): void {
    this.burst(0.7, 900, 0.9 * power);
    this.burst(0.25, 4000, 0.4 * power, 'highpass');
  }

  gunshot(): void {
    this.burst(0.12, 2500, 0.5, 'highpass');
    this.burst(0.2, 300, 0.4);
  }

  /** A heavy metallic thud when the cables snap taut. */
  clank(): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.3);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.45);
    this.burst(0.3, 3000, 0.3, 'bandpass');
  }
}
