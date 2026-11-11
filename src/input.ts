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
  /** -1..1 gimbal tilt (up positive), keyboard only */
  gimbal: number;
  boost: boolean;
  /** accumulated look delta in pixels since last frame */
  lookDX: number;
  lookDY: number;
  /** accumulated wheel delta since last frame */
  wheel: number;
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
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    this.x = dx / max;
    this.y = -dy / max;
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
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
  touchBoost = false;
  enabled = true;
  onKey: KeyHandler | null = null;
  readonly isTouch: boolean;

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
  }

  attachSticks(left: HTMLElement, right: HTMLElement) {
    this.stickL = new VirtualStick(left, left.querySelector('.knob')!);
    this.stickR = new VirtualStick(right, right.querySelector('.knob')!);
  }

  private key(...codes: string[]) {
    for (const c of codes) if (this.keys.has(c)) return 1;
    return 0;
  }

  private gamepad(c: Controls) {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p) continue;
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const lx = dz(p.axes[0] ?? 0), ly = dz(p.axes[1] ?? 0), rx = dz(p.axes[2] ?? 0), ry = dz(p.axes[3] ?? 0);
      c.yaw += lx;
      c.throttle += -ly;
      c.roll += rx;
      c.pitch += -ry;
      if (p.buttons[7]?.pressed || p.buttons[5]?.pressed) c.boost = true; // RT / RB
      c.throttle += (p.buttons[0]?.pressed ? 1 : 0) - (p.buttons[1]?.pressed ? 1 : 0); // A / B
      c.gimbal += (p.buttons[12]?.pressed ? 1 : 0) - (p.buttons[13]?.pressed ? 1 : 0); // d-pad
      break;
    }
  }

  /** Read & reset the accumulated controls for this frame. */
  poll(): Controls {
    const c: Controls = {
      pitch: this.key('KeyW', 'ArrowUp') - this.key('KeyS', 'ArrowDown'),
      roll: this.key('KeyD', 'ArrowRight') - this.key('KeyA', 'ArrowLeft'),
      throttle: this.key('Space', 'KeyX') - this.key('KeyC', 'KeyZ'),
      yaw: this.key('KeyE') - this.key('KeyQ'),
      gimbal: this.key('KeyI') - this.key('KeyK'),
      boost: this.key('ShiftLeft', 'ShiftRight') === 1 || this.touchBoost,
      lookDX: this.lookDX,
      lookDY: this.lookDY,
      wheel: this.wheel,
    };
    this.lookDX = this.lookDY = this.wheel = 0;
    if (this.stickL) {
      c.yaw += this.stickL.x;
      c.throttle += this.stickL.y;
    }
    if (this.stickR) {
      c.roll += this.stickR.x;
      c.pitch += this.stickR.y;
    }
    this.gamepad(c);
    const cl = (v: number) => Math.max(-1, Math.min(1, v));
    c.pitch = cl(c.pitch); c.roll = cl(c.roll); c.throttle = cl(c.throttle); c.yaw = cl(c.yaw); c.gimbal = cl(c.gimbal);
    return c;
  }

  clear() {
    this.keys.clear();
    this.lookDX = this.lookDY = this.wheel = 0;
    this.dragging = false;
    this.dragId = null;
  }
}
