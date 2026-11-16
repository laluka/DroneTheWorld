import { describe, expect, test } from 'vitest';
import { Drone } from '../drone';
import type { Controls } from '../input';

const ctl = (c: Partial<Controls> = {}): Controls => ({
  pitch: 0, roll: 0, throttle: 0, yaw: 0, gimbal: 0, boost: false, lookDX: 0, lookDY: 0, wheel: 0, source: 'gamepad', ...c,
});

/** A drone in acro, high above flat ground, past its post-teleport settle phase. */
function fly(mode: 'acro' | 'angle' = 'acro') {
  const d = new Drone();
  d.setMode(mode);
  d.teleport(2.3, 48.85, 0, 300);
  const ground = () => ({ ground: 0 });
  let now = performance.now() + 10_000;
  const run = (seconds: number, c: Controls, fps = 60, each?: () => void) => {
    const dt = 1 / fps;
    for (let t = 0; t < seconds - 1e-9; t += dt) { now += dt * 1000; d.step(dt, c, ground, now); each?.(); }
  };
  return { d, run };
}

describe('flight model', () => {
  test('centred throttle hovers', () => {
    const { d, run } = fly();
    const alt = d.s.alt;
    run(3, ctl());
    expect(Math.abs(d.s.alt - alt)).toBeLessThan(0.5);
  });

  test('same inputs give the same flight at any frame rate', () => {
    const c = ctl({ pitch: 0.3, roll: 0.15, throttle: 0.3 });
    const a = fly(), b = fly();
    a.run(2, c, 30);
    b.run(2, c, 144);
    const m = 111_320 * Math.cos(48.85 * Math.PI / 180);
    const dx = (a.d.s.lng - b.d.s.lng) * m, dy = (a.d.s.lat - b.d.s.lat) * 111_132;
    expect(Math.hypot(dx, dy)).toBeLessThan(1.5);
    expect(Math.abs(a.d.s.alt - b.d.s.alt)).toBeLessThan(1);
  });

  test('acro can loop: the camera goes past vertical and inverted, then comes round', () => {
    const { d, run } = fly();
    let maxUp = -1, minUpZ = 1;
    run(0.54, ctl({ pitch: -1, throttle: 0.6 }), 120, () => {
      maxUp = Math.max(maxUp, d.s.cam.f[2]);
      minUpZ = Math.min(minUpZ, d.s.cam.u[2]);
    });
    expect(maxUp).toBeGreaterThan(0.95); // looked straight up
    expect(minUpZ).toBeLessThan(-0.95); // was upside down
    expect(d.s.cam.u[2]).toBeGreaterThan(0.5); // back upright-ish after ~360°
  });

  test('acro can barrel roll', () => {
    const { d, run } = fly();
    let minUpZ = 1;
    run(0.54, ctl({ roll: 1 }), 120, () => { minUpZ = Math.min(minUpZ, d.s.cam.u[2]); });
    expect(minUpZ).toBeLessThan(-0.9);
  });

  test('absolute throttle: hover point holds height, bottom stick is idle', () => {
    const { d, run } = fly();
    d.absThrottle = true;
    d.hover = 0.35;
    const alt = d.s.alt;
    run(2, ctl({ throttle: 0.35 * 2 - 1 }));
    expect(Math.abs(d.s.alt - alt)).toBeLessThan(0.5);
    run(1, ctl({ throttle: -1 }));
    expect(d.s.vU).toBeLessThan(-5);
  });

  test('motors differ while rotating, for the sound', () => {
    const { d, run } = fly();
    run(0.1, ctl({ roll: 1 }), 120);
    const [fr, rr, rl, fl] = d.s.motors;
    expect(rl + fl).toBeGreaterThan(fr + rr); // rolling right: left motors push harder
  });
});
