import * as THREE from 'three';
import type { Engine, Surface } from '../types';
import { basisFrom, type RenderCam } from '../../camera';
import { BuildingField } from '../../buildings';
import { TerrainCache, TERRAIN_MAX_Z } from './terrain';
import { Ground, type View } from './ground';
import { City, type WorldUniforms } from './city';
import { kAt, mercX, mercY, tileOf } from './merc';

const OFM_PLANET = 'https://tiles.openfreemap.org/planet';
const SUN_AZ = 225, SUN_EL = 50;
const CLOUD_ALT = 1800;

/** Day and night looks: sky gradient, fog, lights. */
const LOOKS = {
  day: {
    zenith: '#3a86d8', mid: '#7fb3e6', horizon: '#e9e3d3', ground: '#c9c2b0', reflect: '#a9c6e2',
    sun: 0xfff0d8, sunI: 2.4, hemiSky: 0xcfe0f2, hemiGround: 0x8a7f6c, hemiI: 1.35, cloudLit: '#fbf8f2', cloudDark: '#a7afba',
  },
  night: {
    zenith: '#03060f', mid: '#081127', horizon: '#18233f', ground: '#0b1020', reflect: '#2a3a5c',
    sun: 0x9db4ff, sunI: 0.35, hemiSky: 0x3a4d78, hemiGround: 0x0c1020, hemiI: 0.45, cloudLit: '#2a3550', cloudDark: '#121a2c',
  },
};

/**
 * Keyless 3D world: Esri imagery on Terrarium terrain streamed to the horizon, OSM buildings with procedural facades,
 * roofs and sun shadows, trees, water, street lights at night, a far skyline ring, clouds and haze.
 * Renders any camera orientation.
 */
export class WorldEngine implements Engine {
  readonly id = 'world' as const;
  readonly maxCamTilt = 180;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private terrain = new TerrainCache();
  private ground: Ground;
  private city: City;
  private skyline: City;
  private buildings = new BuildingField();
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private sunDir: THREE.Vector3;
  private fog: THREE.FogExp2;
  private dome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private frame = 0;
  private lastAgl = 100;
  private t0 = performance.now();
  private isNight = false;
  readonly uniforms: WorldUniforms = {
    uTime: { value: 0 }, uNight: { value: 0 }, uCamOff: { value: new THREE.Vector2() }, uSkyTint: { value: new THREE.Color(LOOKS.day.reflect) },
  };

  constructor(private container: HTMLElement, private quality: 'high' | 'low') {
    const high = quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ antialias: high, logarithmicDepthBuffer: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : 1));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = high;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(this.vfov, 1, 0.4, 600_000);
    this.camera.matrixAutoUpdate = false;

    this.fog = new THREE.FogExp2(new THREE.Color(LOOKS.day.horizon), 1 / 10000);
    this.scene.fog = this.fog;
    const el = (SUN_EL * Math.PI) / 180, az = (SUN_AZ * Math.PI) / 180;
    this.sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el));
    this.dome = skyDome(this.sunDir);
    this.scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(LOOKS.day.sun, LOOKS.day.sunI);
    this.sun.castShadow = high;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(LOOKS.day.hemiSky, LOOKS.day.hemiGround, LOOKS.day.hemiI);
    this.hemi.position.set(0, 0, 1);
    this.scene.add(this.hemi);

    this.ground = new Ground(this.terrain, this.renderer, high ? 1.7 : 1.1, this.uniforms);
    this.city = new City(this.terrain, { z: 14, radius: high ? 2 : 1, lite: false, treeDensity: high ? 1 : 0.4, shadows: high }, this.uniforms);
    this.skyline = new City(this.terrain, { z: 13, radius: high ? 2 : 1, lite: true, treeDensity: 0, shadows: false }, this.uniforms);
    this.scene.add(this.ground.group, this.city.group, this.skyline.group);
    this.setNight(false);
    this.resize();
  }

  get vfov() { return this.quality === 'low' ? 62 : 75; }

  /** Vector tile URL template for buildings / trees (OpenFreeMap). */
  async init() {
    const j = await (await fetch(OFM_PLANET)).json();
    const t = j.tiles?.[0];
    if (!t) throw new Error('no vector tiles');
    this.buildings.setTemplate(t);
    this.city.setTemplate(t);
    this.skyline.setTemplate(t);
  }

  /** Day, or night with moonlight, lit windows and street lights. */
  setNight(on: boolean) {
    this.isNight = on;
    const L = on ? LOOKS.night : LOOKS.day;
    this.uniforms.uNight.value = on ? 1 : 0;
    this.uniforms.uSkyTint.value.set(L.reflect);
    this.fog.color.set(L.horizon);
    this.sun.color.setHex(L.sun); this.sun.intensity = L.sunI;
    this.hemi.color.setHex(L.hemiSky); this.hemi.groundColor.setHex(L.hemiGround); this.hemi.intensity = L.hemiI;
    const su = this.dome.material.uniforms;
    su.uZenith.value.set(L.zenith); su.uMid.value.set(L.mid); su.uHorizon.value.set(L.horizon); su.uGround.value.set(L.ground);
    su.uCloudLit.value.set(L.cloudLit); su.uCloudDark.value.set(L.cloudDark);
    su.uNight.value = on ? 1 : 0;
    this.city.night = on;
  }

  setCamera(c: RenderCam) {
    const b = basisFrom(c.heading, c.pitch, c.roll);
    const cam = this.camera;
    cam.matrix.makeBasis(new THREE.Vector3(...b.r), new THREE.Vector3(...b.u), new THREE.Vector3(-b.f[0], -b.f[1], -b.f[2]));
    cam.updateMatrixWorld(true);
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));

    const k = kAt(c.lat);
    const view: View = { camX: mercX(c.lng), camY: mercY(c.lat), alt: c.alt, k, frustum: this.frustum, frame: ++this.frame };
    const g = this.terrain.heightAt(view.camX, view.camY);
    const agl = Math.max(1, c.alt - (g?.h ?? 0));
    this.lastAgl = agl;
    this.city.lastGround = g?.h ?? 0;
    const time = (performance.now() - this.t0) / 1000;
    this.uniforms.uTime.value = time;
    this.ground.update(view);
    this.city.update(view);
    this.city.coverage(view, this.skyline.holes.value);
    this.skyline.update(view);

    const su = this.dome.material.uniforms;
    su.uCam.value.set(((view.camX / k) % 100000 + 100000) % 100000, ((view.camY / k) % 100000 + 100000) % 100000, c.alt);
    su.uTime.value = time;

    // haze thins out with height so the view opens up as you climb
    this.fog.density = (this.isNight ? 1.4 : 1) / (9000 + agl * 22);
    // sun shadows around the ground point you're looking at, sized to the altitude
    const reach = Math.min(agl, 600);
    const half = Math.ceil((220 + reach * 0.6) / 50) * 50; // stepped, so the shadow map doesn't rescale every frame
    // Snap the shadow frustum to whole shadow-map texels in world space, so shadows don't shimmer as the drone moves.
    const texel = (half * 2) / this.sun.shadow.mapSize.x;
    // axes of the shadow camera (three's lookAt: z toward the light, x = up × z with up = +Y)
    const lz = this.sunDir, lx = new THREE.Vector3(0, 1, 0).cross(lz).normalize(), ly = lz.clone().cross(lx);
    const W = new THREE.Vector3(view.camX / k + b.f[0] * reach * 0.6, view.camY / k + b.f[1] * reach * 0.6, (g?.h ?? 0));
    const px = W.dot(lx), py = W.dot(ly);
    W.addScaledVector(lx, Math.round(px / texel) * texel - px).addScaledVector(ly, Math.round(py / texel) * texel - py);
    const tx = W.x - view.camX / k, ty = W.y - view.camY / k;
    const tz = W.z - c.alt;
    this.sun.target.position.set(tx, ty, tz);
    this.sun.position.set(tx + this.sunDir.x * 3000, ty + this.sunDir.y * 3000, tz + this.sunDir.z * 3000);
    const sc = this.sun.shadow.camera;
    if (sc.right !== half) { sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 10; sc.far = 6000; sc.updateProjectionMatrix(); }
    this.sun.castShadow = this.quality === 'high' && agl < 1500 && !this.isNight;

    this.renderer.render(this.scene, this.camera);
  }

  sky() { return null; }

  surface(lng: number, lat: number): Surface | null {
    const X = mercX(lng), Y = mercY(lat);
    const { x, y } = tileOf(TERRAIN_MAX_Z, X, Y);
    this.terrain.ensure(TERRAIN_MAX_Z, x, y);
    const t = this.terrain.heightAt(X, Y);
    if (!t || t.z < 10) return null;
    // collide with the ground you can see: while finer terrain streams in, the drawn mesh can sit above the raw data
    const drawn = this.ground.drawnHeightAt(X, Y);
    const ground = drawn !== null ? Math.max(t.h, drawn) : t.h;
    this.buildings.prefetch(lng, lat);
    const solids: { base: number; top: number }[] = [];
    for (const v of this.buildings.at(lng, lat) ?? []) solids.push({ base: ground + v.base, top: ground + v.top });
    if (this.lastAgl < 400) solids.push(...this.city.treesAt(X, Y, kAt(lat)));
    return solids.length ? { ground, solids } : { ground };
  }

  tilesLoaded() { return this.ground.pending === 0 && this.city.pending === 0; }
  show() { this.container.style.display = ''; this.resize(); }
  hide() { this.container.style.display = 'none'; }
  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.fov = this.vfov;
    this.camera.updateProjectionMatrix();
  }
  snapshot() { return this.renderer.domElement; }
}

/**
 * Sky dome around the camera: horizon haze (same colour as the fog) up to a deep zenith, the sun (or moon),
 * a drifting cloud layer at 1.8 km seen in perspective, and stars at night.
 */
function skyDome(sunDir: THREE.Vector3) {
  const C = (h: string) => ({ value: new THREE.Color(h) });
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
    uniforms: {
      uZenith: C('#000'), uMid: C('#000'), uHorizon: C('#000'), uGround: C('#000'), uCloudLit: C('#fff'), uCloudDark: C('#888'),
      uSun: { value: sunDir.clone() }, uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uNight: { value: 0 },
    },
    vertexShader: `varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir;
uniform vec3 uZenith, uMid, uHorizon, uGround, uSun, uCloudLit, uCloudDark, uCam;
uniform float uTime, uNight;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float e = d.z;
  vec3 c = e > 0.0
    ? mix(mix(uHorizon, uMid, smoothstep(0.0, 0.16, e)), uZenith, smoothstep(0.12, 0.75, e))
    : mix(uHorizon, uGround, smoothstep(0.0, 0.08, -e));
  float s = max(dot(d, uSun), 0.0);
  vec3 disc = mix(vec3(1.0, 0.93, 0.8), vec3(0.8, 0.86, 1.0), uNight);
  c += disc * (pow(s, 900.0) * mix(6.0, 2.5, uNight) + pow(s, 40.0) * mix(0.25, 0.05, uNight) + pow(s, 6.0) * mix(0.08, 0.0, uNight));
  // stars
  if (uNight > 0.5 && e > 0.02) {
    vec2 sp = vec2(atan(d.y, d.x), acos(clamp(e, -1.0, 1.0))) * 260.0;
    vec2 cell = floor(sp);
    float st = h21(cell);
    vec2 off = vec2(h21(cell + 7.1), h21(cell + 1.7)) * 0.6 + 0.2;
    float dot1 = smoothstep(0.09, 0.0, length(fract(sp) - off));
    c += vec3(0.85, 0.9, 1.0) * step(0.993, st) * dot1 * smoothstep(0.02, 0.25, e) * (0.4 + 1.2 * h21(cell + 3.1));
  }
  // clouds: a layer seen from below, stretched in perspective, fading with distance
  if (e > 0.012 && uCam.z < ${CLOUD_ALT.toFixed(1)}) {
    float t = (${CLOUD_ALT.toFixed(1)} - uCam.z) / e;
    vec2 p = (uCam.xy + d.xy * t) / 1600.0 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbm(p);
    float cover = smoothstep(0.48, 0.78, n);
    float shade = smoothstep(0.35, 0.9, fbm(p * 1.7 + 4.0));
    vec3 cc = mix(uCloudDark, uCloudLit, shade * 0.75 + 0.25 * s);
    float fade = exp(-t / 30000.0) * smoothstep(0.012, 0.08, e);
    c = mix(c, cc, cover * fade * 0.95);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
  m.renderOrder = -1000;
  m.frustumCulled = false;
  return m;
}
