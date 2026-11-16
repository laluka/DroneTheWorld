/**
 * Camera math shared by the renderers, the lens post-pass and the OSD.
 *
 * World frame is local ENU (x east, y north, z up). A camera is an orthonormal basis: `r` (screen right),
 * `u` (screen up), `f` (forward), with u = r × f. The drone can point its camera anywhere (loops, rolls, inverted);
 * the map renderer can't look above the horizon, so it renders a safe nearby view and the lens pass re-projects
 * that image to the true orientation. A pure camera rotation is an exact image warp, so nothing is approximated.
 */
export type V3 = [number, number, number];
export interface CamBasis { r: V3; u: V3; f: V3 }

/** Renderer camera in MapLibre convention: heading cw from north, pitch 0 = straight down / 90 = horizon, roll right-positive. */
export interface RenderCam { lng: number; lat: number; alt: number; heading: number; pitch: number; roll: number }

/**
 * Lens: rectilinear frustum of the rendered image (tan of the half vertical FOV and the aspect) plus barrel distortion.
 * Distortion is radial in pixel space, normalised so the output corners land exactly on the rendered corners:
 * a (pixel offset / half-diagonal) → tangent-plane point a·(1 + k|a|²)/(1 + k) · tanDiag.
 */
export interface Lens { tanY: number; aspect: number; k: number }

const DEG = Math.PI / 180;
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Basis from MapLibre-style heading / pitch / roll (degrees). */
export function basisFrom(heading: number, pitch: number, roll: number): CamBasis {
  const h = heading * DEG, p = pitch * DEG, rl = roll * DEG;
  const f: V3 = [Math.sin(h) * Math.sin(p), Math.cos(h) * Math.sin(p), -Math.cos(p)];
  const r0: V3 = [Math.cos(h), -Math.sin(h), 0];
  const u0 = cross(r0, f);
  const c = Math.cos(rl), s = Math.sin(rl);
  const r: V3 = [r0[0] * c - u0[0] * s, r0[1] * c - u0[1] * s, r0[2] * c - u0[2] * s];
  const u: V3 = [u0[0] * c + r0[0] * s, u0[1] * c + r0[1] * s, u0[2] * c + r0[2] * s];
  return { r, u, f };
}

/** Heading / pitch / roll of a basis (inverse of basisFrom). Looking straight up or down, heading follows the screen top. */
export function eulerOfBasis(b: CamBasis) {
  const { f, u } = b;
  const pitch = Math.acos(Math.max(-1, Math.min(1, -f[2]))) / DEG;
  const horiz = Math.hypot(f[0], f[1]);
  let heading: number;
  if (horiz > 1e-3) heading = Math.atan2(f[0], f[1]) / DEG;
  else heading = f[2] < 0 ? Math.atan2(u[0], u[1]) / DEG : Math.atan2(-u[0], -u[1]) / DEG;
  heading = (heading + 360) % 360;
  const h = heading * DEG;
  const r0: V3 = [Math.cos(h), -Math.sin(h), 0];
  const u0 = cross(r0, f);
  const roll = Math.atan2(-dot(b.r, u0), dot(b.r, r0)) / DEG;
  return { heading, pitch, roll, elevation: pitch - 90 };
}

/**
 * Pick what the renderer should draw for a true camera. Below `maxPitch` the renderer draws the exact view;
 * above it, it draws the closest safe view (same heading, unrolled as it looks up so the ground band stays covered)
 * and the lens pass rotates it into place. `prevHeading` keeps the render heading still when looking near-vertical up,
 * where the look heading spins but no ground is in view.
 */
export function chooseRenderCam(cam: CamBasis, maxPitch: number, prevHeading: number | null) {
  const e = eulerOfBasis(cam);
  if (e.pitch <= maxPitch) return { heading: e.heading, pitch: e.pitch, roll: e.roll };
  const over = e.pitch - maxPitch;
  const w = Math.max(0, 1 - over / 12);
  const heading = e.pitch > 145 && prevHeading !== null ? prevHeading : e.heading;
  return { heading, pitch: maxPitch, roll: e.roll * w };
}

const tanDiag = (l: Lens) => l.tanY * Math.hypot(l.aspect, 1);

/** World direction → screen pixel through the lens (with distortion). null when behind the camera. */
export function toScreen(cam: CamBasis, lens: Lens, d: V3, W: number, H: number): { x: number; y: number; z: number } | null {
  const z = dot(d, cam.f);
  if (z <= 1e-6) return null;
  const D = tanDiag(lens);
  const gx = dot(d, cam.r) / z / D, gy = dot(d, cam.u) / z / D;
  const g = Math.hypot(gx, gy);
  let s = g;
  if (lens.k > 0 && g > 0) {
    // invert s(1 + k s²)/(1 + k) = g (monotonic for k ≥ 0)
    const target = g * (1 + lens.k);
    for (let i = 0; i < 6; i++) s -= (s * (1 + lens.k * s * s) - target) / (1 + 3 * lens.k * s * s);
  }
  const m = g > 0 ? s / g : 1;
  const half = Math.hypot(W, H) / 2;
  return { x: W / 2 + gx * m * half, y: H / 2 - gy * m * half, z };
}

/** Screen pixel → world direction through the lens (unnormalised). */
export function fromScreen(cam: CamBasis, lens: Lens, x: number, y: number, W: number, H: number): V3 {
  const half = Math.hypot(W, H) / 2;
  const ax = (x - W / 2) / half, ay = (H / 2 - y) / half;
  const m = (1 + lens.k * (ax * ax + ay * ay)) / (1 + lens.k) * tanDiag(lens);
  const tx = ax * m, ty = ay * m;
  return [cam.f[0] + cam.r[0] * tx + cam.u[0] * ty, cam.f[1] + cam.r[1] * tx + cam.u[1] * ty, cam.f[2] + cam.r[2] * tx + cam.u[2] * ty];
}
