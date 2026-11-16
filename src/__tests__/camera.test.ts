import { describe, expect, test } from 'vitest';
import { basisFrom, chooseRenderCam, eulerOfBasis, fromScreen, toScreen, type Lens } from '../camera';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('camera', () => {
  test('heading / pitch / roll round-trip, including inverted and looking up', () => {
    for (const [h, p, r] of [[10, 30, 0], [200, 84, -35], [90, 150, 170], [300, 120, 60], [45, 10, -120]]) {
      const e = eulerOfBasis(basisFrom(h, p, r));
      close(e.heading, h, 1e-6); close(e.pitch, p, 1e-6); close(e.roll, r, 1e-6);
    }
  });

  test('lens: screen ↔ world round-trip with barrel distortion', () => {
    const cam = basisFrom(30, 100, 25);
    const lens: Lens = { tanY: Math.tan((75 * Math.PI) / 360), aspect: 16 / 9, k: 0.22 };
    for (const [x, y] of [[960, 540], [10, 10], [1900, 1000], [400, 700]]) {
      const p = toScreen(cam, lens, fromScreen(cam, lens, x, y, 1920, 1080), 1920, 1080)!;
      close(p.x, x, 1e-3); close(p.y, y, 1e-3);
    }
    const c = toScreen(cam, lens, cam.f, 1920, 1080)!;
    close(c.x, 960); close(c.y, 540);
  });

  test('render camera is exact below the renderer limit and clamped above it', () => {
    const down = chooseRenderCam(basisFrom(40, 70, 20), 79, null);
    close(down.pitch, 70); close(down.roll, 20); close(down.heading, 40);
    const up = chooseRenderCam(basisFrom(40, 120, 30), 79, null);
    expect(up.pitch).toBe(79);
    close(up.roll, 0);
  });
});
