import { AXIS_NAMES, defaultMap, loadMap, readAxis, type AxisName, type GamepadMap } from './gamepad';

/** Aggregates keyboard, mouse, touch sticks and gamepad into one per-frame control frame. */
export interface Controls {
  /** -1..1, forward positive */
  pitch: number;
  /** -1..1, right positive */
  roll: number;
  /** -1..1, up positive */
  throttle: number;
  /** -1..1, clockwise positive */
  yaw: number;
  /** -1..1 camera tilt (up positive), keyboard only */
  gimbal: number;
  boost: boolean;
  /** accumulated look delta in pixels since last frame */
  lookDX: number;
  lookDY: number;
  /** accumulated wheel delta since last frame */
  wheel: number;
  /** which device produced the dominant stick input this frame */
  source: 'keyboard' | 'gamepad' | 'touch' | 'none';
}

type KeyHandler = (code: string, ev: KeyboardEvent) => void;

class VirtualStick {
  x = 0;
  y = 0;
  private pointerId: number | null = null;
  private radius: number;
  constructor(private el: HTMLElement, private knob: HTMLElement) {
    this.radius = el.clientWidth / 2;
    el.addEventListener('pointerdown', (e) => {
      if (this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      this.move(e);
      e.stopPropagation();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      this.move(e);
      e.stopPropagation();
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.x = this.y = 0;
      knob.style.transform = '';
      e.stopPropagation();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  private move(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    this.radius = r.width / 2;
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    const max = this.radius * 0.8;
    if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
    this.x = dx / max;
    this.y = -dy / max;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}

/** Keyboard keys are binary; ramp them so they feel like a stick (rise ~120 ms, release ~70 ms). */
class Ramp {
  v = 0;
  update(target: number, dt: number) {
    const tau = Math.abs(target) > Math.abs(this.v) ? 0.12 : 0.07;
    this.v += (target - this.v) * Math.min(1, dt / tau);
    if (Math.abs(this.v) < 0.002) this.v = 0;
    return this.v;
  }
}

export class Input {
  private keys = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  private wheel = 0;
  private dragging = false;
  private dragId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private stickL?: VirtualStick;
  private stickR?: VirtualStick;
  private ramps = { pitch: new Ramp(), roll: new Ramp(), yaw: new Ramp(), throttle: new Ramp() };
  touchBoost = false;
  enabled = true;
  /** Keyboard sensitivity multiplier for yaw/throttle (menu "rates"). */
  keyRates = 1;
  onKey: KeyHandler | null = null;
  readonly isTouch: boolean;

  // gamepad
  private mapCache = new Map<string, GamepadMap>();
  /** Last live readings per axis for the menu meters. */
  padLive: Record<AxisName, number> = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  padId: string | null = null;
  padLastActive = 0;
  /** Flight-mode request from the controller switch: a mode name, 'cycle' for a button, or null. Read & cleared by the app. */
  padModeRequest: 'angle' | 'acro' | 'cine' | 'cycle' | null = null;
  private switchPrev: number | null = null;
  /** Set during calibration so normal reading is bypassed. */
  padPassthrough: ((pad: Gamepad) => void) | null = null;

  constructor(surface: HTMLElement) {
    this.isTouch = window.matchMedia('(pointer: coarse)').matches && 'ontouchstart' in window;

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!e.repeat) this.onKey?.(e.code, e);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    surface.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.dragId !== null) return;
      this.dragId = e.pointerId;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      surface.setPointerCapture(e.pointerId);
    });
    surface.addEventListener('pointermove', (e) => {
      if (!this.dragging || e.pointerId !== this.dragId) return;
      this.lookDX += e.clientX - this.lastX;
      this.lookDY += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.dragId) return;
      this.dragging = false;
      this.dragId = null;
    };
    surface.addEventListener('pointerup', up);
    surface.addEventListener('pointercancel', up);
    surface.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.wheel += e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY;
    }, { passive: false });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepadconnected', (e) => { this.padId = e.gamepad.id; this.mapCache.delete(e.gamepad.id); });
    window.addEventListener('gamepaddisconnected', () => { this.padId = null; });
  }

  attachSticks(left: HTMLElement, right: HTMLElement) {
    this.stickL = new VirtualStick(left, left.querySelector('.knob')!);
    this.stickR = new VirtualStick(right, right.querySelector('.knob')!);
  }

  /** First connected gamepad, if any. */
  pad(): Gamepad | null {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) if (p) return p;
    return null;
  }

  mapFor(id: string): GamepadMap {
    let m = this.mapCache.get(id);
    if (!m) { m = loadMap(id) ?? defaultMap(id); this.mapCache.set(id, m); }
    return m;
  }
  setMap(m: GamepadMap) { this.mapCache.set(m.id, m); this.switchPrev = null; }
  invalidateMap(id: string) { this.mapCache.delete(id); }

  private key(...codes: string[]) {
    for (const c of codes) if (this.keys.has(c)) return 1;
    return 0;
  }

  private gamepad(c: Controls, now: number) {
    const p = this.pad();
    if (!p) { this.padId = null; return; }
    this.padId = p.id;
    if (this.padPassthrough) { this.padPassthrough(p); return; }
    const m = this.mapFor(p.id);
    let active = false;
    for (const name of AXIS_NAMES) {
      const v = readAxis(p, m, name);
      this.padLive[name] = v;
      if (Math.abs(v) > 0.02) active = true;
      c[name] += v;
    }
    if (m.turboButton !== null && p.buttons[m.turboButton]?.pressed) { c.boost = true; active = true; }
    if (m.modeSwitch) {
      const sw = m.modeSwitch;
      if (sw.kind === 'button') {
        const v = p.buttons[sw.index]?.pressed ? 1 : 0;
        if (this.switchPrev === 0 && v === 1) this.padModeRequest = 'cycle';
        this.switchPrev = v;
      } else {
        const raw = p.axes[sw.index] ?? 0;
        const pos = raw < -0.33 ? 0 : raw > 0.33 ? 2 : 1;
        if (this.switchPrev !== pos) this.padModeRequest = (['angle', 'cine', 'acro'] as const)[pos];
        this.switchPrev = pos;
      }
    }
    // d-pad camera tilt on standard pads
    c.gimbal += (p.buttons[12]?.pressed ? 1 : 0) - (p.buttons[13]?.pressed ? 1 : 0);
    if (active) { this.padLastActive = now; c.source = 'gamepad'; }
  }

  /** Read & reset the accumulated controls for this frame. */
  poll(dt = 1 / 60, now = performance.now()): Controls {
    const r = this.keyRates;
    const kPitch = this.ramps.pitch.update(this.key('KeyW', 'ArrowUp') - this.key('KeyS', 'ArrowDown'), dt);
    const kRoll = this.ramps.roll.update(this.key('KeyD', 'ArrowRight') - this.key('KeyA', 'ArrowLeft'), dt);
    const kThr = this.ramps.throttle.update((this.key('Space', 'KeyX') - this.key('KeyC', 'KeyZ')) * r, dt);
    const kYaw = this.ramps.yaw.update((this.key('KeyE') - this.key('KeyQ')) * r, dt);
    const c: Controls = {
      pitch: kPitch,
      roll: kRoll,
      throttle: kThr,
      yaw: kYaw,
      gimbal: this.key('KeyI') - this.key('KeyK'),
      boost: this.key('ShiftLeft', 'ShiftRight') === 1 || this.touchBoost,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      wheel: this.wheel,
      source: Math.abs(kPitch) + Math.abs(kRoll) + Math.abs(kThr) + Math.abs(kYaw) > 0.02 ? 'keyboard' : 'none',
    };
    this.lookDX = this.lookDY = this.wheel = 0;
    if (this.stickL) { c.yaw += this.stickL.x; c.throttle += this.stickL.y; if (this.stickL.x || this.stickL.y) c.source = 'touch'; }
    if (this.stickR) { c.roll += this.stickR.x; c.pitch += this.stickR.y; if (this.stickR.x || this.stickR.y) c.source = 'touch'; }
    this.gamepad(c, now);
    const cl = (v: number) => Math.max(-1, Math.min(1, v));
    c.pitch = cl(c.pitch); c.roll = cl(c.roll); c.throttle = cl(c.throttle); c.yaw = cl(c.yaw); c.gimbal = cl(c.gimbal);
    return c;
  }

  clear() {
    this.keys.clear();
    this.lookDX = this.lookDY = this.wheel = 0;
    this.dragging = false;
    this.dragId = null;
    for (const r of Object.values(this.ramps)) r.v = 0;
  }
}
