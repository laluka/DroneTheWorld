/** Procedural quad-rotor hum + wind, driven by motor effort and speed. */
export class DroneAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private oscs: OscillatorNode[] = [];
  private oscGain!: GainNode;
  private filter!: BiquadFilterNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private lfo!: OscillatorNode;
  private lfoGain!: GainNode;
  private _muted = false;
  private _volume = 0.4;
  private started = false;

  get muted() { return this._muted; }
  /** 0..1 */
  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.ctx && !this._muted) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.1);
  }
  private level() { return 0.35 * this._volume * this._volume; }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  start() {
    if (this.started) { this.ctx?.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.started = true;
    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.0001;
    this.master.connect(ctx.destination);

    // rotors: four detuned saws through a lowpass, with a slow beating LFO
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 700;
    this.filter.Q.value = 1.2;
    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 0.12;
    this.oscGain.connect(this.filter).connect(this.master);
    const base = 150;
    for (const d of [-7, -2, 3, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = base;
      o.detune.value = d * 4;
      o.connect(this.oscGain);
      o.start();
      this.oscs.push(o);
    }
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 7;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 0.04;
    this.lfo.connect(this.lfoGain).connect(this.oscGain.gain);
    this.lfo.start();

    // wind: filtered noise
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; data[i] = last * 3.5; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 400;
    this.windFilter.Q.value = 0.6;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    src.connect(this.windFilter).connect(this.wind).connect(this.master);
    src.start();

    this.master.gain.setTargetAtTime(this._muted ? 0 : this.level(), ctx.currentTime, 0.8);
  }

  setMuted(m: boolean) {
    this._muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.level(), this.ctx.currentTime, 0.15);
  }

  /** motor 0..1, speed normalized 0..1 */
  update(motor: number, speed01: number, boost: boolean) {
    if (!this.ctx || this._muted) return;
    const t = this.ctx.currentTime;
    const f = 130 + motor * 220 + (boost ? 60 : 0);
    for (const o of this.oscs) o.frequency.setTargetAtTime(f, t, 0.12);
    this.filter.frequency.setTargetAtTime(500 + motor * 1400 + speed01 * 800, t, 0.15);
    this.lfo.frequency.setTargetAtTime(5 + motor * 9, t, 0.3);
    this.wind.gain.setTargetAtTime(Math.min(0.7, speed01 * 0.8), t, 0.25);
    this.windFilter.frequency.setTargetAtTime(300 + speed01 * 1200, t, 0.25);
  }

  /** Short low thud for collisions. */
  thump(strength: number) {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.25);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 + strength * 0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }

  suspend() { this.ctx?.suspend(); }
  resume() { if (this.started) this.ctx?.resume(); }
}
