import type { DroneState } from './drone';
import { dot } from './camera';

/**
 * Procedural FPV quad sound. Each motor is one oscillator whose spectrum is a spinning tri-blade prop:
 * the blade-pass tone (3× rotation) and its harmonics dominate, with a little rotor imbalance (1×) and the
 * motor's electrical whine (7× for 14 poles). Rotation speed follows each motor's thrust command (rpm ∝ √thrust),
 * so flips, punches and yaw are audible motor by motor. Plus a throttle-punch transient, prop-wash chop when
 * falling through your own wash, and wind panned by sideslip.
 */
const PROP_HARMONICS: Record<number, number> = {
  1: 0.22, 2: 0.1, 3: 1, 4: 0.08, 5: 0.05, 6: 0.42, 7: 0.16, 8: 0.04, 9: 0.22, 10: 0.03, 12: 0.12, 14: 0.06, 15: 0.07, 18: 0.04, 21: 0.03, 24: 0.02,
};

export class DroneAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private motors: { osc: OscillatorNode; gain: GainNode }[] = [];
  private tone!: BiquadFilterNode;
  private wash!: GainNode;
  private washFilter!: BiquadFilterNode;
  private washLfo!: OscillatorNode;
  private washDepth!: GainNode;
  private wind!: GainNode;
  private windFilter!: BiquadFilterNode;
  private windPan!: StereoPannerNode;
  private _muted = false;
  private _volume = 0.6;
  private started = false;
  private lastAvg = 0;
  private punch = 0;
  private lastT = 0;

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

    // motors: prop spectrum per motor, through a resonant lowpass that opens with load and on throttle punches
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 2400;
    this.tone.Q.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 110;
    this.tone.connect(hp).connect(comp);
    const n = 25;
    const real = new Float32Array(n), imag = new Float32Array(n);
    for (const [h, a] of Object.entries(PROP_HARMONICS)) imag[+h] = a;
    const wave = ctx.createPeriodicWave(real, imag);
    for (let i = 0; i < 4; i++) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = 150;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      osc.connect(g).connect(this.tone);
      osc.start();
      this.motors.push({ osc, gain: g });
    }

    // prop wash: band of noise, chopped by an LFO when falling through your own wash
    const n1 = this.noise(ctx, 2);
    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = 'bandpass';
    this.washFilter.frequency.value = 1200;
    this.washFilter.Q.value = 0.8;
    this.wash = ctx.createGain();
    this.wash.gain.value = 0;
    this.washLfo = ctx.createOscillator();
    this.washLfo.type = 'triangle';
    this.washLfo.frequency.value = 18;
    this.washDepth = ctx.createGain();
    this.washDepth.gain.value = 0;
    this.washLfo.connect(this.washDepth).connect(this.wash.gain);
    this.washLfo.start();
    n1.connect(this.washFilter).connect(this.wash).connect(comp);
    n1.start();

    // wind: rumble that grows with airspeed, panned by sideslip
    const n2 = this.noise(ctx, 3);
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 300;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    this.windPan = ctx.createStereoPanner();
    n2.connect(this.windFilter).connect(this.wind).connect(this.windPan).connect(comp);
    n2.start();

    this.master.gain.setTargetAtTime(this._muted ? 0 : this.level(), ctx.currentTime, 0.4);
  }

  setMuted(m: boolean) {
    this._muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.level(), this.ctx.currentTime, 0.1);
  }

  update(s: DroneState) {
    if (!this.ctx || this._muted) return;
    const t = this.ctx.currentTime;
    const dt = Math.max(1 / 240, Math.min(0.1, t - this.lastT || 1 / 60));
    this.lastT = t;
    const boost = s.boost ? 1.06 : 1;
    let avg = 0;
    this.motors.forEach((m, i) => {
      const cmd = Math.max(0, Math.min(1, s.motors[i]));
      avg += cmd / 4;
      // rotation Hz: idle ~10k rpm, hover ~22k, full ~46k; small per-motor offset makes the natural beating
      const rot = (50 + 720 * Math.pow(cmd, 0.62)) * boost + i * 1.3;
      m.osc.frequency.setTargetAtTime(rot, t, 0.025);
      m.gain.gain.setTargetAtTime(0.035 + cmd * 0.075, t, 0.03);
    });
    // throttle punch: brief brightness when the motors spool up fast
    const rise = Math.max(0, (avg - this.lastAvg) / dt);
    this.lastAvg = avg;
    this.punch = Math.max(rise * 0.5, this.punch * Math.exp(-dt * 6));
    const punch = Math.min(1, this.punch);
    this.tone.frequency.setTargetAtTime(900 + avg * 3800 + punch * 2600, t, 0.03);
    this.tone.Q.setTargetAtTime(1.4 + punch * 2.5, t, 0.05);

    // prop wash: descending along the props' axis into your own turbulent air, worst at low throttle
    const v: [number, number, number] = [s.vE, s.vN, s.vU];
    const fall = Math.max(0, -dot(v, s.cam.u));
    const washAmt = Math.min(1, fall / 9) * (0.6 + (1 - avg) * 0.6);
    this.wash.gain.setTargetAtTime(0.03 + avg * 0.12 + washAmt * 0.25, t, 0.06);
    this.washDepth.gain.setTargetAtTime(washAmt * 0.22, t, 0.06);
    this.washLfo.frequency.setTargetAtTime(10 + avg * 25, t, 0.1);
    this.washFilter.frequency.setTargetAtTime(700 + avg * 1600, t, 0.1);

    const air = Math.hypot(s.vE, s.vN, s.vU);
    const speed01 = Math.min(1, air / 45);
    this.wind.gain.setTargetAtTime(Math.min(0.9, speed01 * speed01 * 1.2), t, 0.2);
    this.windFilter.frequency.setTargetAtTime(250 + speed01 * 1100, t, 0.2);
    this.windPan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, dot(v, s.cam.r) / (air + 4))), t, 0.15);
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
