import type { Controls } from './input';
import type { Surface } from './engine/types';

export type Probe = (lng: number, lat: number) => Surface | null;

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
  heading: number;
  /** camera neutral tilt (MapLibre pitch convention: 0 = straight down, 90 = horizon). FPV cam uptilt. */
  camTilt: number;
  /** effective camera pitch after body tilt */
  camPitch: number;
  /** camera roll in degrees (body roll, camera is fixed to the frame) */
  roll: number;
  /** body pitch forward in degrees, positive = nose down */
  bodyPitch: number;
  vE: number;
  vN: number;
  vU: number;
  /** horizontal ground speed m/s (after altitude scaling) */
  groundSpeed: number;
  /** speed multiplier currently applied (grows with altitude) */
  scale: number;
  boost: boolean;
  /** 0..1 throttle-ish motor effort, for audio and OSD */
  motor: number;
  distance: number;
  flightTime: number;
  battery: number;
  /** last control frame, for the OSD */
  stick: { pitch: number; roll: number; yaw: number; throttle: number };
}

/** FPV freestyle quad tuning. Velocities in m/s, angles in degrees. */
const TUNE = {
  acc: 24,
  accBoost: 48,
  drag: 0.75,
  maxSpeed: 32,       // ~115 km/h
  maxSpeedBoost: 60,  // ~215 km/h
  vAcc: 20,
  vAccBoost: 34,
  vDrag: 2.2,
  maxVS: 13,
  maxVSBoost: 24,
  yawRate: 130,
  yawRateBoost: 170,
  yawTau: 0.11,
  lookSens: 0.18,
  camTiltSens: 0.1,
  camTiltKeyRate: 40,
  camTiltMin: 25,
  camTiltMax: 86,
  minAGL: 1.5,
  bodyRadius: 2.5,
  maxAGL: 18000,
  pitchGain: 16,      // body nose-down at full forward stick
  pitchGainBoost: 24,
  rollGain: 26,       // body roll at full roll stick
  yawRollGain: 0.11,  // extra bank from yaw rate (deg per deg/s)
  attitudeTau: 0.16,
};

const deg = Math.PI / 180;

export class Drone {
  s: DroneState = {
    lng: 2.3015, lat: 48.8515, alt: 250, ground: 0, floor: 0, impact: 0, impacts: 0, heading: 325, camTilt: 84, camPitch: 84, roll: 0, bodyPitch: 0,
    vE: 0, vN: 0, vU: 0, groundSpeed: 0, scale: 1, boost: false, motor: 0, distance: 0, flightTime: 0, battery: 100,
    stick: { pitch: 0, roll: 0, yaw: 0, throttle: 0 },
  };
  private yawVel = 0;
  private settleUntil = 0;
  private targetAGL = 200;
  private camTiltMax = TUNE.camTiltMax;
  private lastImpactT = 0;

  /** Renderer-dependent: MapLibre can't look above the horizon, Cesium can. */
  setCamLimits(maxTilt: number) {
    this.camTiltMax = maxTilt;
    this.s.camTilt = Math.min(this.s.camTilt, maxTilt);
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
    s.ground = 0;
    s.floor = 0;
    s.impact = 0;
    s.alt = agl;
    this.targetAGL = agl;
    this.settleUntil = performance.now() + 3500;
  }

  levelCamera() { this.s.camTilt = 84; }

  /** Floor under a point for the current altitude: a roof if we are above it, else terrain. */
  private floorOf(sf: Surface | null, alt: number): number | null {
    if (!sf) return null;
    if (sf.solid && alt >= sf.solid.top - 1.5) return sf.solid.top;
    return sf.ground;
  }

  /** True when a point would put the drone inside a solid volume at this altitude. */
  private blocked(sf: Surface | null, alt: number) {
    return !!sf?.solid && alt > sf.solid.base - 0.5 && alt < sf.solid.top - 0.3;
  }

  step(dt: number, c: Controls, probe: Probe | null, now: number) {
    const s = this.s;
    dt = Math.min(dt, 0.05);
    const here = probe ? probe(s.lng, s.lat) : null;
    if (here) { s.ground = here.ground; s.floor = this.floorOf(here, s.alt) ?? s.ground; }

    // Settle phase after a teleport: keep requested height above the floor while data streams in.
    if (now < this.settleUntil) {
      const want = s.floor + this.targetAGL;
      if (Math.abs(s.alt - want) > 0.5) s.alt += (want - s.alt) * Math.min(1, dt * 6);
    }

    const agl = Math.max(0, s.alt - s.floor);
    const boost = c.boost;
    s.boost = boost;
    s.stick = { pitch: c.pitch, roll: c.roll, yaw: c.yaw, throttle: c.throttle };

    // Altitude-based speed scaling: higher = faster, so crossing a continent stays fun.
    const scale = Math.min(80, Math.max(1, agl / 120));
    s.scale = scale;

    // --- yaw (stick + mouse) ---
    const yawTarget = c.yaw * (boost ? TUNE.yawRateBoost : TUNE.yawRate);
    this.yawVel += (yawTarget - this.yawVel) * Math.min(1, dt / TUNE.yawTau);
    s.heading += this.yawVel * dt + c.lookDX * TUNE.lookSens;
    s.heading = ((s.heading % 360) + 360) % 360;

    // --- camera tilt (mouse Y / keys) ---
    s.camTilt += c.gimbal * TUNE.camTiltKeyRate * dt - c.lookDY * TUNE.camTiltSens;
    s.camTilt = Math.max(TUNE.camTiltMin, Math.min(this.camTiltMax, s.camTilt));

    // --- horizontal dynamics (body frame -> ENU) ---
    const acc = boost ? TUNE.accBoost : TUNE.acc;
    const h = s.heading * deg;
    const sinH = Math.sin(h), cosH = Math.cos(h);
    const aF = c.pitch * acc;
    const aR = c.roll * acc;
    s.vE += (aF * sinH + aR * cosH) * dt;
    s.vN += (aF * cosH - aR * sinH) * dt;
    const dragK = Math.exp(-TUNE.drag * dt);
    s.vE *= dragK;
    s.vN *= dragK;
    const maxSpd = boost ? TUNE.maxSpeedBoost : TUNE.maxSpeed;
    const spd = Math.hypot(s.vE, s.vN);
    if (spd > maxSpd) { s.vE *= maxSpd / spd; s.vN *= maxSpd / spd; }

    // --- vertical ---
    const vAcc = boost ? TUNE.vAccBoost : TUNE.vAcc;
    s.vU += c.throttle * vAcc * dt;
    s.vU -= c.wheel * 0.03 * (boost ? 2 : 1);
    s.vU *= Math.exp(-TUNE.vDrag * dt);
    const maxVS = boost ? TUNE.maxVSBoost : TUNE.maxVS;
    s.vU = Math.max(-maxVS * 1.3, Math.min(maxVS, s.vU));

    // --- integrate position ---
    const mPerDegLat = 111_132;
    const mPerDegLng = 111_320 * Math.max(0.05, Math.cos(s.lat * deg));
    const vScale = Math.min(60, Math.max(1, agl / 150));
    const dE = s.vE * scale * dt, dN = s.vN * scale * dt;
    s.alt += s.vU * vScale * dt;

    // --- building collision: probe a little ahead of the camera, slide along walls, bounce on impact ---
    const insideNow = this.blocked(here, s.alt);
    const step = Math.hypot(dE, dN);
    let moveE = dE, moveN = dN;
    if (probe && step > 1e-4 && !insideNow) {
      const ahead = (e: number, n: number) => {
        const len = Math.hypot(e, n) || 1;
        const r = TUNE.bodyRadius;
        return probe(s.lng + (e + (e / len) * r) / mPerDegLng, s.lat + (n + (n / len) * r) / mPerDegLat);
      };
      if (this.blocked(ahead(dE, dN), s.alt)) {
        const hitSpeed = Math.hypot(s.vE, s.vN) * scale;
        // try sliding along one axis
        if (Math.abs(dE) > 1e-4 && !this.blocked(ahead(dE, 0), s.alt)) { moveN = 0; s.vN *= -0.2; }
        else if (Math.abs(dN) > 1e-4 && !this.blocked(ahead(0, dN), s.alt)) { moveE = 0; s.vE *= -0.2; }
        else { moveE = moveN = 0; s.vE *= -0.35; s.vN *= -0.35; }
        if (hitSpeed > 2.5 && now - this.lastImpactT > 350) {
          this.lastImpactT = now;
          s.impact = Math.min(1, Math.max(s.impact, hitSpeed / 25));
          s.impacts++;
          s.battery = Math.max(3, s.battery - Math.min(4, hitSpeed / 10));
        }
      }
    }
    s.lng += moveE / mPerDegLng;
    s.lat += moveN / mPerDegLat;
    if (s.lng > 180) s.lng -= 360;
    if (s.lng < -180) s.lng += 360;
    s.lat = Math.max(-84, Math.min(84, s.lat));

    // --- floor & ceiling ---
    const after = probe ? probe(s.lng, s.lat) : null;
    if (after) { s.ground = after.ground; }
    if (this.blocked(after, s.alt)) {
      // Spawned or streamed into a building: rise out of it quickly.
      s.alt += Math.min(after!.solid!.top + TUNE.minAGL - s.alt, Math.max(4, (after!.solid!.top - s.alt) * 6) * dt);
      if (s.vU < 0) s.vU = 0;
    }
    s.floor = this.floorOf(after, s.alt) ?? s.floor;
    const minAlt = s.floor + TUNE.minAGL;
    if (s.alt < s.floor) { s.alt = s.floor; }
    if (s.alt < minAlt) {
      // Soft landing: ease up instead of snapping when terrain detail streams in.
      s.alt += (minAlt - s.alt) * Math.min(1, dt * 12);
      if (s.vU < 0) s.vU = 0;
    }
    const maxAlt = s.ground + TUNE.maxAGL;
    if (s.alt > maxAlt) { s.alt = maxAlt; if (s.vU > 0) s.vU = 0; }

    // --- body attitude: the camera is bolted to the frame ---
    const k = Math.min(1, dt / TUNE.attitudeTau);
    const pitchTarget = c.pitch * (boost ? TUNE.pitchGainBoost : TUNE.pitchGain);
    s.bodyPitch += (pitchTarget - s.bodyPitch) * k;
    const bankTarget = c.roll * TUNE.rollGain + this.yawVel * TUNE.yawRollGain * Math.min(1, spd / 8 + 0.35);
    s.roll += (bankTarget - s.roll) * k;
    s.impact *= Math.exp(-dt * 3.5);
    const shake = s.impact * s.impact;
    s.roll += Math.sin(now * 0.061) * shake * 9;
    s.camPitch = Math.max(5, Math.min(this.camTiltMax, s.camTilt - s.bodyPitch + Math.sin(now * 0.047) * shake * 6));

    // --- telemetry ---
    s.groundSpeed = spd * scale;
    s.distance += s.groundSpeed * dt;
    s.flightTime += dt;
    const effort = Math.min(1, 0.28 + (Math.abs(c.pitch) + Math.abs(c.roll)) * 0.3 + Math.max(0, c.throttle) * 0.5 + Math.abs(c.yaw) * 0.1);
    s.motor += (effort * (boost ? 1.3 : 1) - s.motor) * Math.min(1, dt * 4);
    s.battery = Math.max(3, s.battery - dt * (0.06 + s.motor * 0.09) * (boost ? 1.5 : 1));
  }
}
