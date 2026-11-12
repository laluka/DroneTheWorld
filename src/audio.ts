/**
 * Procedural FPV quad sound: four motors with their own pitch (from a real motor mix),
 * prop-wash noise, wind, all through a compressor so it stays present without clipping.
 */
export interface AudioDrive {
  motor: number;
  boost: boolean;
  stick: { pitch: number; roll: number; yaw: number; throttle: number };
}

/** quad-X motor mix: front-right, rear-right, rear-left, front-left */
const MIX: [number, number, number][] = [
  // [pitch, roll, yaw]
  [-1, -1, +1],
  [+1, -1, -1],
  [+1, +1, +1],
  [-1, +1, -1],
];

export class DroneAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private motors: { osc: OscillatorNode; sub: OscillatorNode; gain: GainNode }[] = [];
  private tone!: BiquadFilterNode;
  private wash!: GainNode;
  private washFilter!: BiquadFilterNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private _muted = false;
  private _volume = 0.6;
  private started = false;

  get muted() { return this._muted; }

  /** 0..1 */
  setVolume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.ctx && !this._muted) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.1);
  }
  private level() { return 1.1 * this._volume; }

  private noise(ctx: AudioContext, seconds: number) {
    const len = ctx.sampleRate * seconds;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  start() {
    if (this.started) { this.ctx?.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.started = true;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.15;
    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;
    comp.connect(this.master).connect(ctx.destination);

    // motors: saw + square sub an octave down, shaped by a resonant lowpass that opens with load
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 1800;
    this.tone.Q.value = 2.5;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 90;
    this.tone.connect(hp).connect(comp);
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const sub = ctx.createOscillator();
      sub.type = 'square';
      const g = ctx.createGain();
      g.gain.value = 0.09;
      const sg = ctx.createGain();
      sg.gain.value = 0.35;
      osc.connect(g);
      sub.connect(sg).connect(g);
      g.connect(this.tone);
      osc.start(); sub.start();
      this.motors.push({ osc, sub, gain: g });
    }

    // prop wash: band of noise around the blade-pass region
    const n1 = this.noise(ctx, 2);
    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = 'bandpass';
    this.washFilter.frequency.value = 1400;
    this.washFilter.Q.value = 0.9;
    this.wash = ctx.createGain();
    this.wash.gain.value = 0;
    n1.connect(this.washFilter).connect(this.wash).connect(comp);
    n1.start();

    // wind: low rumble that grows with airspeed
    const n2 = this.noise(ctx, 3);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 300;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    n2.connect(this.windFilter).connect(this.wind).connect(comp);
    n2.start();

    this.master.gain.setTargetAtTime(this._muted ? 0 : this.level(), ctx.currentTime, 0.4);
  }

  setMuted(m: boolean) {
    this._muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.level(), this.ctx.currentTime, 0.1);
  }

  /** speed01: airspeed normalised 0..1 */
  update(d: AudioDrive, speed01: number) {
    if (!this.ctx || this._muted) return;
    const t = this.ctx.currentTime;
    const load = Math.max(0, Math.min(1.2, d.motor + (d.boost ? 0.1 : 0)));
    this.motors.forEach((m, i) => {
      const [kp, kr, ky] = MIX[i];
      const diff = (kp * d.stick.pitch + kr * d.stick.roll) * 0.18 + ky * d.stick.yaw * 0.1;
      const ml = Math.max(0.05, Math.min(1.3, load + diff * (0.4 + load)));
      const f = 150 + ml * 620 + i * 3.7; // slight per-motor offset makes the natural beating
      m.osc.frequency.setTargetAtTime(f, t, 0.05);
      m.sub.frequency.setTargetAtTime(f / 2, t, 0.05);
      m.gain.gain.setTargetAtTime(0.06 + ml * 0.08, t, 0.06);
    });
    this.tone.frequency.setTargetAtTime(900 + load * 3200, t, 0.08);
    this.wash.gain.setTargetAtTime(0.04 + load * 0.22, t, 0.08);
    this.washFilter.frequency.setTargetAtTime(900 + load * 1800, t, 0.1);
    this.wind.gain.setTargetAtTime(Math.min(0.9, speed01 * speed01 * 1.2), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(250 + speed01 * 900, t, 0.2);
  }

  /** Two soft bell notes for a discovery. */
  chime() {
    if (!this.ctx || this._muted) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    [880, 1318.5].forEach((f, i) => {
      const t = t0 + i * 0.12;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(this.master);
      o.start(t); o.stop(t + 1);
    });
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
    g.gain.exponentialRampToValueAtTime(0.5 + strength * 0.6, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.32);
  }

  suspend() { this.ctx?.suspend(); }
  resume() { if (this.started) this.ctx?.resume(); }
}
