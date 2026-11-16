import type { Controls } from './input';
import type { Surface } from './engine/types';
import { basisFrom, eulerOfBasis, type CamBasis } from './camera';

export type Probe = (lng: number, lat: number) => Surface | null;

/**
 * - angle: self-levelling, stick = tilt angle, real thrust/gravity/momentum, throttle centre holds altitude.
 * - acro:  stick = rotation rate (Betaflight-like), attitude is kept, throttle centre = hover thrust.
 * - cine:  smooth velocity-based flight for sightseeing.
 */
export type FlightMode = 'angle' | 'acro' | 'cine';
export const FLIGHT_MODES: FlightMode[] = ['angle', 'acro', 'cine'];

export interface DroneState {
  lng: number;
  lat: number;
  /** altitude above mean sea level, meters */
  alt: number;
  /** terrain elevation under the drone (MSL), meters */
  ground: number;
  /** what the drone would land on: terrain, or a roof when flying above one */
  floor: number;
  /** 0..1 impact strength of the latest collision, decays over time */
  impact: number;
  /** increments on every collision so the UI can react once */
  impacts: number;
  /** camera heading, degrees clockwise from north */
  heading: number;
  /** cine mode: camera neutral tilt (MapLibre pitch: 0 = straight down, 90 = horizon) */
  camTilt: number;
  /** angle/acro: FPV camera uptilt above the frame's forward axis, degrees */
  uptilt: number;
  /** camera look pitch (MapLibre convention: 0 = down, 90 = horizon, 180 = up) */
  camPitch: number;
  /** full FPV camera orientation (any attitude: loops, rolls, inverted) */
  cam: CamBasis;
  /** image-space shake (impacts), applied to the rendered frame, not the camera */
  jitter: { x: number; y: number; r: number };
  /** camera roll in degrees */
  roll: number;
  /** body pitch in degrees, positive = nose down */
  bodyPitch: number;
  vE: number;
  vN: number;
  vU: number;
  /** horizontal ground speed m/s (after altitude scaling) */
  groundSpeed: number;
  /** horizontal speed multiplier currently applied (grows with altitude) */
  scale: number;
  /** vertical speed multiplier currently applied */
  vScale: number;
  boost: boolean;
  mode: FlightMode;
  /** 0..1 motor load, for audio and OSD */
  motor: number;
  /** per-motor command 0..1 (front-right, rear-right, rear-left, front-left), for audio */
  motors: [number, number, number, number];
  /** body angular rates, deg/s (pitch nose-down, roll right, yaw right), for audio */
  rates: [number, number, number];
  distance: number;
  flightTime: number;
  battery: number;
  /** last control frame, for the OSD */
  stick: { pitch: number; roll: number; yaw: number; throttle: number };
}

const G = 9.81;
const deg = Math.PI / 180;

const TUNE = {
  // shared
  lookSens: 0.18,
  /** camera height when resting on the ground / a roof */
  minAGL: 0.4,
  /** collision radius: a 5" quad is ~25 cm across; a little margin so walls don't fill the lens */
  bodyRadius: 0.6,
  maxAGL: 18000,
  // cine (velocity based)
  acc: 24, accBoost: 48, drag: 0.75, maxSpeed: 32, maxSpeedBoost: 60,
  vAcc: 20, vAccBoost: 34, vDrag: 2.2, maxVS: 13, maxVSBoost: 24,
  yawRate: 130, yawRateBoost: 170, yawTau: 0.11,
  camTiltSens: 0.1, camTiltKeyRate: 40, camTiltMin: 25, camTiltCineMax: 88,
  pitchGain: 16, pitchGainBoost: 24, rollGain: 26, yawRollGain: 0.11, attitudeTau: 0.16,
  // physics (angle / acro)
  /** max thrust as a multiple of hover thrust */
  thrustMax: 3.6,
  thrustMaxBoost: 4.6,
  /** absolute throttle: motor idle as a fraction of max thrust (air mode keeps authority at idle) */
  idle: 0.04,
  /** quadratic air drag, 1/m: terminal ~45 m/s at full forward tilt */
  dragQ: 0.0065,
  dragLin: 0.08,
  // Betaflight "BF" rates: rc rate, super rate, expo → ~670°/s roll/pitch, ~500°/s yaw at full stick
  rcRate: 1.0, superRate: 0.7, rcExpo: 0.1,
  yawRcRate: 1.0, yawSuperRate: 0.6, yawExpo: 0.1,
  angleMax: 55, angleMaxBoost: 68, angleYaw: 200, angleResponse: 9,
  uptiltDefault: 20,
  uptiltMin: 0,
  uptiltMax: 50,
  /** physics rate, Hz: fixed steps make the feel identical at any frame rate */
  hz: 240,
};

/** quad-X motor mix [pitch nose-down, roll right, yaw right]: front-right, rear-right, rear-left, front-left */
const MIX: [number, number, number][] = [[-1, -1, 1], [1, -1, -1], [1, 1, 1], [-1, 1, -1]];

// ---------- tiny quaternion helpers (w, x, y, z); body frame: x right, y forward, z up; world: E, N, U ----------
type Q = [number, number, number, number];
type V = [number, number, number];
const qMul = (a: Q, b: Q): Q => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
const qAxis = (x: number, y: number, z: number, a: number): Q => { const s = Math.sin(a / 2); return [Math.cos(a / 2), x * s, y * s, z * s]; };
const qNorm = (q: Q): Q => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
const qRot = (q: Q, v: V): V => {
  const p = qMul(qMul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [p[1], p[2], p[3]];
};
/** heading (cw from north), nose-down pitch, right roll → orientation */
const qFromEuler = (hd: number, pd: number, rl: number): Q =>
  qMul(qMul(qAxis(0, 0, 1, -hd * deg), qAxis(1, 0, 0, -pd * deg)), qAxis(0, 1, 0, rl * deg));
const eulerOf = (q: Q) => {
  const f = qRot(q, [0, 1, 0]), r = qRot(q, [1, 0, 0]), u = qRot(q, [0, 0, 1]);
  return {
    heading: ((Math.atan2(f[0], f[1]) / deg) + 360) % 360,
    pitchDown: -Math.asin(Math.max(-1, Math.min(1, f[2]))) / deg,
    roll: Math.atan2(-r[2], u[2]) / deg,
    up: u,
  };
};
const shape = (x: number, rate: number, expo: number) => (x * (1 - expo) + x * x * x * expo) * rate;
/** Betaflight rate curve, degrees per second. */
const bfRate = (x: number, rcRate: number, superRate: number, expo: number) => {
  const a = Math.abs(x);
  const e = x * Math.pow(a, 3) * expo + x * (1 - expo);
  let r = 200 * rcRate * e;
  if (superRate) r *= 1 / Math.max(0.01, Math.min(1, 1 - Math.abs(e) * superRate));
  return r;
};

export class Drone {
  s: DroneState = {
    lng: 2.3015, lat: 48.8515, alt: 250, ground: 0, floor: 0, impact: 0, impacts: 0, heading: 325,
    camTilt: 84, uptilt: TUNE.uptiltDefault, camPitch: 84, cam: basisFrom(325, 84, 0), jitter: { x: 0, y: 0, r: 0 }, roll: 0, bodyPitch: 0,
    vE: 0, vN: 0, vU: 0, groundSpeed: 0, scale: 1, vScale: 1, boost: false, mode: 'angle', motor: 0,
    motors: [0, 0, 0, 0], rates: [0, 0, 0],
    distance: 0, flightTime: 0, battery: 100, stick: { pitch: 0, roll: 0, yaw: 0, throttle: 0 },
  };
  /**
   * Throttle mapping for real radios. false: centre stick = hover (spring-centred sticks, keyboard, touch).
   * true: bottom = motor idle, `hover` (0..1 of stick travel) = hover, top = full power, like a real quad.
   */
  absThrottle = false;
  hover = 0.35;
  private q: Q = qFromEuler(325, 0, 0);
  private yawVel = 0;
  private settleUntil = 0;
  private targetAGL = 200;
  private lastImpactT = 0;
  private thrust = 1;
  private acc = 0;
  private w: V = [0, 0, 0];
  private alpha: V = [0, 0, 0];

  setMode(m: FlightMode) {
    const s = this.s;
    s.mode = m;
    // keep heading and momentum, level the frame
    this.q = qFromEuler(s.heading, 0, 0);
    s.bodyPitch = 0;
    s.roll = 0;
    this.thrust = 1;
  }

  /** Keep the current height above ground while the vertical datum / terrain source changes. */
  holdAGL() {
    this.targetAGL = Math.max(2, this.s.alt - this.s.floor);
    this.settleUntil = performance.now() + 2500;
  }

  /** Jump to a place and hold a target AGL until terrain data arrives. */
  teleport(lng: number, lat: number, heading: number, agl: number, camTilt = 84) {
    const s = this.s;
    s.lng = lng; s.lat = lat; s.heading = heading; s.camTilt = camTilt; s.camPitch = camTilt;
    s.vE = s.vN = s.vU = 0; s.roll = 0; s.bodyPitch = 0; this.yawVel = 0;
    this.q = qFromEuler(heading, 0, 0);
    this.thrust = 1;
    this.acc = 0;
    s.ground = 0;
    s.floor = 0;
    s.impact = 0;
    s.alt = agl;
    this.targetAGL = agl;
    this.settleUntil = performance.now() + 3500;
    this.updateCamera();
  }

  levelCamera() {
    this.s.camTilt = 84;
    this.s.uptilt = TUNE.uptiltDefault;
    if (this.s.mode !== 'cine') this.q = qFromEuler(eulerOf(this.q).heading, 0, 0);
  }

  /** Floor under a point for the current altitude: the highest roof at or below us, else terrain. */
  private floorOf(sf: Surface | null, alt: number): number | null {
    if (!sf) return null;
    let f = sf.ground;
    for (const v of sf.solids ?? []) if (alt >= v.top - 1.5 && v.top > f) f = v.top;
    return f;
  }

  /** The solid volume that would contain the drone at this altitude, if any. */
  private inside(sf: Surface | null, alt: number) {
    for (const v of sf?.solids ?? []) if (alt > v.base - 0.5 && alt < v.top - 0.3) return v;
    return null;
  }

  private blocked(sf: Surface | null, alt: number) {
    return this.inside(sf, alt) !== null;
  }

  private hit(strength: number, now: number) {
    const s = this.s;
    if (strength < 0.1 || now - this.lastImpactT < 350) return;
    this.lastImpactT = now;
    s.impact = Math.min(1, Math.max(s.impact, strength));
    s.impacts++;
    s.battery = Math.max(3, s.battery - Math.min(4, strength * 4));
  }

  step(dt: number, c: Controls, probe: Probe | null, now: number) {
    const s = this.s;
    dt = Math.min(dt, 0.25);
    const here = probe ? probe(s.lng, s.lat) : null;
    if (here) { s.ground = here.ground; s.floor = this.floorOf(here, s.alt) ?? s.ground; }

    // Settle phase after a teleport: keep requested height above the floor while data streams in.
    const settling = now < this.settleUntil;
    if (settling) {
      const want = s.floor + this.targetAGL;
      if (Math.abs(s.alt - want) > 0.5) s.alt += (want - s.alt) * Math.min(1, dt * 6);
      s.vU = 0;
    }

    const agl = Math.max(0, s.alt - s.floor);
    s.boost = c.boost;
    s.stick = { pitch: c.pitch, roll: c.roll, yaw: c.yaw, throttle: c.throttle };

    // Altitude-based speed scaling, so crossing a continent stays fun. In the physics modes it only starts high up
    // and is the same on every axis, so manoeuvres near the ground keep their true shape and momentum.
    if (s.mode === 'cine') {
      s.scale = Math.min(80, Math.max(1, agl / 120));
      s.vScale = Math.min(60, Math.max(1, agl / 150));
    } else {
      s.scale = s.vScale = Math.min(60, Math.max(1, agl / 400));
    }

    // Per-frame inputs (mouse look, wheel) apply once; the dynamics run at a fixed rate.
    this.frameInputs(c);
    const h = 1 / TUNE.hz;
    this.acc += dt;
    let dE = 0, dN = 0, dU = 0;
    while (this.acc >= h) {
      this.acc -= h;
      if (s.mode === 'cine') this.cine(h, c); else this.physics(h, c, settling);
      dE += s.vE * h; dN += s.vN * h; dU += s.vU * h;
    }
    this.updateCamera();

    // --- integrate position ---
    const mPerDegLat = 111_132;
    const mPerDegLng = 111_320 * Math.max(0.05, Math.cos(s.lat * deg));
    dE *= s.scale; dN *= s.scale;
    s.alt += dU * s.vScale;

    // --- building collision: probe a little ahead of the camera, slide along walls, bounce on impact ---
    const insideNow = this.blocked(here, s.alt);
    let moveE = dE, moveN = dN;
    if (probe && Math.hypot(dE, dN) > 1e-4 && !insideNow) {
      const ahead = (e: number, n: number) => {
        const len = Math.hypot(e, n) || 1;
        const r = TUNE.bodyRadius;
        return probe(s.lng + (e + (e / len) * r) / mPerDegLng, s.lat + (n + (n / len) * r) / mPerDegLat);
      };
      if (this.blocked(ahead(dE, dN), s.alt)) {
        const hitSpeed = Math.hypot(s.vE, s.vN) * s.scale;
        if (Math.abs(dE) > 1e-4 && !this.blocked(ahead(dE, 0), s.alt)) { moveN = 0; s.vN *= -0.2; }
        else if (Math.abs(dN) > 1e-4 && !this.blocked(ahead(0, dN), s.alt)) { moveE = 0; s.vE *= -0.2; }
        else { moveE = moveN = 0; s.vE *= -0.35; s.vN *= -0.35; }
        if (hitSpeed > 2.5) this.hit(hitSpeed / 25, now);
      }
    }
    s.lng += moveE / mPerDegLng;
    s.lat += moveN / mPerDegLat;
    if (s.lng > 180) s.lng -= 360;
    if (s.lng < -180) s.lng += 360;
    s.lat = Math.max(-84, Math.min(84, s.lat));

    // --- floor & ceiling ---
    const after = probe ? probe(s.lng, s.lat) : null;
    if (after) s.ground = after.ground;
    const stuck = this.inside(after, s.alt);
    if (stuck) {
      // Spawned or streamed into a building: rise out of it quickly.
      s.alt += Math.min(stuck.top + TUNE.minAGL - s.alt, Math.max(4, (stuck.top - s.alt) * 6) * dt);
      if (s.vU < 0) s.vU = 0;
    }
    s.floor = this.floorOf(after, s.alt) ?? s.floor;
    const minAlt = s.floor + TUNE.minAGL;
    if (s.alt < s.floor) s.alt = s.floor;
    if (s.alt < minAlt) {
      // touching down: hard landings register as impacts, then ground friction
      if (s.mode !== 'cine' && s.vU < -6) this.hit(-s.vU / 18, now);
      s.alt += (minAlt - s.alt) * Math.min(1, dt * 12);
      if (s.vU < 0) s.vU = 0;
      if (s.mode !== 'cine') {
        const f = Math.exp(-dt * 3); s.vE *= f; s.vN *= f;
        // resting on the ground, the quad settles flat on its landing gear instead of balancing on a prop
        const lvl = qFromEuler(eulerOf(this.q).heading, 0, 0);
        const sgn = lvl[0] * this.q[0] + lvl[1] * this.q[1] + lvl[2] * this.q[2] + lvl[3] * this.q[3] < 0 ? -1 : 1;
        const k = Math.min(1, dt * 4);
        this.q = qNorm(this.q.map((v, i) => v + (lvl[i] * sgn - v) * k) as Q);
        this.updateCamera();
      }
    }
    const maxAlt = s.ground + TUNE.maxAGL;
    if (s.alt > maxAlt) { s.alt = maxAlt; if (s.vU > 0) s.vU = 0; }

    // --- impact shake only (applied to the rendered image via CSS, never to the map camera) ---
    s.impact *= Math.exp(-dt * 3.5);
    const shake = s.impact * s.impact;
    s.jitter = shake > 0.002
      ? { x: Math.sin(now * 0.05) * shake * 14, y: Math.sin(now * 0.043) * shake * 14, r: Math.sin(now * 0.061) * shake * 4 }
      : { x: 0, y: 0, r: 0 };

    // --- telemetry ---
    const spd = Math.hypot(s.vE, s.vN);
    s.groundSpeed = spd * s.scale;
    s.distance += s.groundSpeed * dt;
    s.flightTime += dt;
    s.battery = Math.max(3, s.battery - dt * (0.06 + s.motor * 0.09) * (s.boost ? 1.5 : 1));
  }

  /** Mouse yaw / camera tilt / wheel: accumulated deltas, applied once per frame. */
  private frameInputs(c: Controls) {
    const s = this.s;
    if (s.mode === 'cine') {
      s.heading = (((s.heading + c.lookDX * TUNE.lookSens) % 360) + 360) % 360;
      s.camTilt = Math.max(TUNE.camTiltMin, Math.min(TUNE.camTiltCineMax, s.camTilt - c.lookDY * TUNE.camTiltSens));
      s.vU -= c.wheel * 0.03 * (c.boost ? 2 : 1);
    } else {
      // yaw around the world vertical, Y adjusts camera uptilt
      if (c.lookDX) this.q = qNorm(qMul(qAxis(0, 0, 1, -c.lookDX * TUNE.lookSens * deg), this.q));
      s.uptilt = Math.max(TUNE.uptiltMin, Math.min(TUNE.uptiltMax, s.uptilt + c.lookDY * 0.08));
    }
  }

  /** Thrust from the throttle stick, as a multiple of hover thrust. */
  private throttleThrust(throttle: number, tMax: number) {
    if (!this.absThrottle) return throttle >= 0 ? 1 + throttle * (tMax - 1) : 1 + throttle; // [-1,1] → [0, tMax], centre = hover
    const x = Math.max(0, Math.min(1, (throttle + 1) / 2));
    const idle = TUNE.idle * tMax;
    const hov = Math.max(0.1, Math.min(0.8, this.hover));
    // power curve through (0, idle), (hover, 1), (1, tMax)
    const gamma = Math.log((1 - idle) / (tMax - idle)) / Math.log(hov);
    return idle + (tMax - idle) * Math.pow(x, gamma);
  }

  /** Thrust-vector flight: rates (acro) or self-levelling angles (angle), gravity, drag. One fixed step. */
  private physics(dt: number, c: Controls, settling: boolean) {
    const s = this.s;
    const boost = c.boost;
    s.uptilt = Math.max(TUNE.uptiltMin, Math.min(TUNE.uptiltMax, s.uptilt + c.gimbal * 30 * dt));
    const prevQ = this.q;

    if (s.mode === 'acro') {
      // binary keys at full rate are uncontrollable; real sticks get full Betaflight-like rates
      const k = (boost ? 1.15 : 1) * (c.source === 'keyboard' ? 0.45 : 1);
      const p = bfRate(c.pitch, TUNE.rcRate, TUNE.superRate, TUNE.rcExpo) * k; // nose-down rate
      const r = bfRate(c.roll, TUNE.rcRate, TUNE.superRate, TUNE.rcExpo) * k;
      const y = bfRate(c.yaw, TUNE.yawRcRate, TUNE.yawSuperRate, TUNE.yawExpo) * k;
      // body-frame rates: nose-down = -x, right roll = +y, right yaw = -z
      const w: V = [-p * deg, r * deg, -y * deg];
      const mag = Math.hypot(w[0], w[1], w[2]);
      if (mag > 1e-9) this.q = qNorm(qMul(this.q, qAxis(w[0] / mag, w[1] / mag, w[2] / mag, mag * dt)));
    } else {
      const e = eulerOf(this.q);
      const max = boost ? TUNE.angleMaxBoost : TUNE.angleMax;
      const k = Math.min(1, dt * TUNE.angleResponse);
      const pd = e.pitchDown + (c.pitch * max - e.pitchDown) * k;
      const rl = e.roll + (c.roll * max - e.roll) * k;
      const hd = e.heading + shape(c.yaw, TUNE.angleYaw * (boost ? 1.2 : 1), 0.3) * dt;
      this.q = qFromEuler(hd, pd, rl);
    }
    this.trackRates(prevQ, dt);

    const e = eulerOf(this.q);
    // thrust along body up
    const tMax = boost ? TUNE.thrustMaxBoost : TUNE.thrustMax;
    let t = this.throttleThrust(c.throttle, tMax);
    if (s.mode === 'angle') t = Math.min(tMax, t / Math.max(0.4, e.up[2])); // altitude assist when tilted
    t -= c.wheel * 0.004;
    this.thrust += (Math.max(0, t) - this.thrust) * Math.min(1, dt * 14); // motor spool
    const a = this.thrust * G;
    const v = Math.hypot(s.vE, s.vN, s.vU);
    const drag = TUNE.dragQ * v + TUNE.dragLin;
    s.vE += (e.up[0] * a - drag * s.vE) * dt;
    s.vN += (e.up[1] * a - drag * s.vN) * dt;
    s.vU += (e.up[2] * a - G - drag * s.vU) * dt;
    if (settling) s.vU = 0;

    s.bodyPitch = e.pitchDown;
    const load = this.thrust / tMax;
    s.motor += (Math.min(1, 0.15 + load * 1.1) - s.motor) * Math.min(1, dt * 10);
    this.mixMotors(load);
  }

  /** Body angular rate and its (smoothed) acceleration, from the attitude change of one step. */
  private trackRates(prev: Q, dt: number) {
    const d = qMul([prev[0], -prev[1], -prev[2], -prev[3]], this.q);
    const sgn = d[0] < 0 ? -1 : 1;
    const sh = Math.hypot(d[1], d[2], d[3]);
    const ang = 2 * Math.atan2(sh, Math.abs(d[0]));
    const k = sh > 1e-9 ? (ang / dt / sh) * sgn : 0;
    const w: V = [d[1] * k, d[2] * k, d[3] * k];
    const f = Math.min(1, dt / 0.03);
    for (let i = 0; i < 3; i++) {
      this.alpha[i] += ((w[i] - this.w[i]) / dt - this.alpha[i]) * f;
      this.w[i] = w[i];
    }
    this.s.rates = [-w[0] / deg, w[1] / deg, -w[2] / deg];
  }

  /** What each motor would be doing: collective thrust plus the torque needed for the current rotation changes. */
  private mixMotors(load: number) {
    const s = this.s;
    const ap = -this.alpha[0], ar = this.alpha[1], ay = -this.alpha[2]; // rad/s² nose-down, right, yaw right
    const wy = -this.w[2];
    for (let i = 0; i < 4; i++) {
      const [mp, mr, my] = MIX[i];
      const torque = (mp * ap + mr * ar) * 0.0035 + my * (ay * 0.0012 + wy * 0.025);
      s.motors[i] = Math.max(0.02, Math.min(1, load + torque));
    }
  }

  /** Camera = frame orientation tilted up by `uptilt` (physics modes), or the cine gimbal. */
  private updateCamera() {
    const s = this.s;
    if (s.mode === 'cine') {
      const pitch = s.camTilt - s.bodyPitch;
      s.cam = basisFrom(s.heading, pitch, s.roll);
      s.camPitch = pitch;
      return;
    }
    const cq = qMul(this.q, qAxis(1, 0, 0, s.uptilt * deg));
    // body frame x right, y forward, z up → camera r, f, u
    s.cam = { r: qRot(cq, [1, 0, 0]), u: qRot(cq, [0, 0, 1]), f: qRot(cq, [0, 1, 0]) };
    const e = eulerOfBasis(s.cam);
    s.heading = e.heading;
    s.roll = e.roll;
    s.camPitch = e.pitch;
  }

  /** Smooth velocity-based flight (the original sightseeing model). One fixed step. */
  private cine(dt: number, c: Controls) {
    const s = this.s;
    const boost = c.boost;
    const yawTarget = c.yaw * (boost ? TUNE.yawRateBoost : TUNE.yawRate);
    this.yawVel += (yawTarget - this.yawVel) * Math.min(1, dt / TUNE.yawTau);
    s.heading = (((s.heading + this.yawVel * dt) % 360) + 360) % 360;

    s.camTilt += c.gimbal * TUNE.camTiltKeyRate * dt;
    s.camTilt = Math.max(TUNE.camTiltMin, Math.min(TUNE.camTiltCineMax, s.camTilt));

    const acc = boost ? TUNE.accBoost : TUNE.acc;
    const h = s.heading * deg;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    s.vE += (c.pitch * acc * sinH + c.roll * acc * cosH) * dt;
    s.vN += (c.pitch * acc * cosH - c.roll * acc * sinH) * dt;
    const dragK = Math.exp(-TUNE.drag * dt);
    s.vE *= dragK; s.vN *= dragK;
    const maxSpd = boost ? TUNE.maxSpeedBoost : TUNE.maxSpeed;
    const spd = Math.hypot(s.vE, s.vN);
    if (spd > maxSpd) { s.vE *= maxSpd / spd; s.vN *= maxSpd / spd; }

    const vAcc = boost ? TUNE.vAccBoost : TUNE.vAcc;
    s.vU += c.throttle * vAcc * dt;
    s.vU *= Math.exp(-TUNE.vDrag * dt);
    const maxVS = boost ? TUNE.maxVSBoost : TUNE.maxVS;
    s.vU = Math.max(-maxVS * 1.3, Math.min(maxVS, s.vU));

    const k = Math.min(1, dt / TUNE.attitudeTau);
    s.bodyPitch += (c.pitch * (boost ? TUNE.pitchGainBoost : TUNE.pitchGain) - s.bodyPitch) * k;
    const bankTarget = c.roll * TUNE.rollGain + this.yawVel * TUNE.yawRollGain * Math.min(1, spd / 8 + 0.35);
    s.roll += (bankTarget - s.roll) * k;
    this.q = qFromEuler(s.heading, 0, 0);

    const effort = Math.min(1, 0.28 + (Math.abs(c.pitch) + Math.abs(c.roll)) * 0.3 + Math.max(0, c.throttle) * 0.5 + Math.abs(c.yaw) * 0.1);
    s.motor += (effort * (boost ? 1.3 : 1) - s.motor) * Math.min(1, dt * 4);
    const st = s.motor * 0.8;
    for (let i = 0; i < 4; i++) {
      const [mp, mr, my] = MIX[i];
      s.motors[i] = Math.max(0.05, Math.min(1, st + (mp * c.pitch + mr * c.roll) * 0.06 + my * c.yaw * 0.04));
    }
    s.rates = [0, 0, this.yawVel];
  }
}
