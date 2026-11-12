/** Gamepad axis mapping + calibration. DJI remotes over USB expose vendor-specific axis order, so we learn it. */
export type AxisName = 'throttle' | 'yaw' | 'pitch' | 'roll';
export const AXIS_NAMES: AxisName[] = ['throttle', 'yaw', 'pitch', 'roll'];

export interface AxisMap { axis: number; sign: 1 | -1; rest: number; }
export interface GamepadMap {
  id: string;
  axes: Partial<Record<AxisName, AxisMap>>;
  turboButton: number | null;
  /** optional flight-mode switch: a button cycles modes, an axis selects by position */
  modeSwitch?: { kind: 'button' | 'axis'; index: number } | null;
  /** true once the user ran the calibration wizard for this controller */
  calibrated?: boolean;
  deadzone: number;
  expo: number;
}

const KEY = 'drone.gamepads';

export const isDji = (id: string) => /dji|2ca3/i.test(id);

/** Default mapping before calibration. DJI remotes report roll, pitch, throttle, yaw on axes 0..3 (up/right positive). */
export function defaultMap(id: string): GamepadMap {
  if (isDji(id)) {
    return {
      id,
      axes: {
        roll: { axis: 0, sign: 1, rest: 0 },
        pitch: { axis: 1, sign: 1, rest: 0 },
        throttle: { axis: 2, sign: 1, rest: 0 },
        yaw: { axis: 3, sign: 1, rest: 0 },
      },
      turboButton: null,
      deadzone: 0.04,
      expo: 0,
    };
  }
  // Xbox-style (mode 2): left stick throttle/yaw, right stick pitch/roll
  return {
    id,
    axes: {
      yaw: { axis: 0, sign: 1, rest: 0 },
      throttle: { axis: 1, sign: -1, rest: 0 },
      roll: { axis: 2, sign: 1, rest: 0 },
      pitch: { axis: 3, sign: -1, rest: 0 },
    },
    turboButton: 7,
    deadzone: 0.08,
    expo: 0.3,
  };
}

function loadAll(): Record<string, GamepadMap> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function loadMap(id: string): GamepadMap | null { return loadAll()[id] ?? null; }
export function saveMap(m: GamepadMap) { const all = loadAll(); all[m.id] = m; try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ } }
export function clearMap(id: string) { const all = loadAll(); delete all[id]; try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ } }

/** Read one mapped axis: deadzone around rest, then expo. Returns -1..1. */
export function readAxis(pad: Gamepad, m: GamepadMap, name: AxisName): number {
  const a = m.axes[name];
  if (!a) return 0;
  const raw = pad.axes[a.axis];
  if (raw === undefined) return 0;
  let v = (raw - a.rest) * a.sign;
  // normalise to the available travel on each side of rest
  const span = v >= 0 ? Math.max(0.2, 1 - a.rest * a.sign) : Math.max(0.2, 1 + a.rest * a.sign);
  v = v / span;
  const dz = m.deadzone;
  if (Math.abs(v) < dz) return 0;
  v = (v - Math.sign(v) * dz) / (1 - dz);
  v = Math.max(-1, Math.min(1, v));
  return v * (1 - m.expo) + v * v * v * m.expo;
}

export type CalibStep = 'rest' | AxisName | 'turbo' | 'switch' | 'done';
export const STEPS: CalibStep[] = ['rest', 'throttle', 'yaw', 'pitch', 'roll', 'turbo', 'switch', 'done'];

export const STEP_TEXT: Record<CalibStep, { title: string; hint: string }> = {
  rest: { title: 'Leave both sticks at rest', hint: 'Throttle at hover position (center for DJI N/S modes, mid-stick in M mode).' },
  throttle: { title: 'Push THROTTLE up', hint: 'Then let it return to rest.' },
  yaw: { title: 'Push YAW right', hint: 'Then let it return to rest.' },
  pitch: { title: 'Push PITCH forward', hint: 'Then let it return to rest.' },
  roll: { title: 'Push ROLL right', hint: 'Then let it return to rest.' },
  turbo: { title: 'Press the button to use for TURBO', hint: 'Optional: any button, or skip.' },
  switch: { title: 'Flip your FLIGHT MODE switch', hint: 'Optional: a switch or button. Positions pick Angle / Cine / Acro, a button cycles them. Or skip.' },
  done: { title: 'Controller mapped', hint: 'Settings saved for this controller.' },
};

/** Step-by-step learning of axis order and direction. Call update() every frame with the live pad. */
export class Calibrator {
  step: CalibStep = 'rest';
  map: GamepadMap;
  private rest: number[] = [];
  private restSamples: number[][] = [];
  private restSince = 0;
  private waitReturn = false;
  private used = new Set<number>();

  constructor(pad: Gamepad, base?: GamepadMap | null) {
    this.map = { ...(base ?? defaultMap(pad.id)), id: pad.id, axes: {}, turboButton: null, modeSwitch: null, calibrated: true };
  }

  skip() {
    if (this.step === 'done') return;
    this.advance();
  }

  private advance() {
    this.step = STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(this.step) + 1)];
    this.waitReturn = true;
  }

  update(pad: Gamepad, now: number) {
    if (this.step === 'done') return;
    const axes = Array.from(pad.axes);

    if (this.step === 'rest') {
      this.restSamples.push(axes);
      if (this.restSamples.length > 90) this.restSamples.shift();
      if (!this.restSince) this.restSince = now;
      if (now - this.restSince > 1500 && this.restSamples.length >= 30) {
        const stable = axes.every((v, i) => this.restSamples.every((s) => Math.abs((s[i] ?? 0) - v) < 0.05));
        if (stable) {
          this.rest = axes.map((_v, i) => this.restSamples.reduce((a, s) => a + (s[i] ?? 0), 0) / this.restSamples.length);
          this.advance();
        } else {
          this.restSince = now; this.restSamples = [];
        }
      }
      return;
    }

    // require sticks back near rest between steps (only the axes learned so far plus unlearned ones; a flipped switch may stay put)
    const atRest = axes.every((v, i) => Math.abs(v - (this.rest[i] ?? 0)) < 0.25);
    if (this.waitReturn) { if (atRest) this.waitReturn = false; return; }

    if (this.step === 'turbo') {
      const idx = pad.buttons.findIndex((b) => b.pressed);
      if (idx >= 0) { this.map.turboButton = idx; this.advance(); }
      return;
    }

    if (this.step === 'switch') {
      const idx = pad.buttons.findIndex((b, i) => b.pressed && i !== this.map.turboButton);
      if (idx >= 0) { this.map.modeSwitch = { kind: 'button', index: idx }; this.advance(); return; }
      const ax = axes.findIndex((v, i) => !this.used.has(i) && Math.abs(v - (this.rest[i] ?? 0)) > 0.5);
      if (ax >= 0) { this.map.modeSwitch = { kind: 'axis', index: ax }; this.advance(); }
      return;
    }

    let best = -1, bestDev = 0;
    axes.forEach((v, i) => {
      if (this.used.has(i)) return;
      const d = v - (this.rest[i] ?? 0);
      if (Math.abs(d) > Math.abs(bestDev)) { bestDev = d; best = i; }
    });
    if (best >= 0 && Math.abs(bestDev) > 0.55) {
      this.map.axes[this.step as AxisName] = { axis: best, sign: bestDev > 0 ? 1 : -1, rest: this.rest[best] ?? 0 };
      this.used.add(best);
      this.advance();
    }
  }
}
