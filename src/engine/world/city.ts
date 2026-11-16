import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CityReq, CityRes } from './city.worker';
import type { TerrainCache } from './terrain';
import { kAt, latOf, tileOf, tileSize, tileX0, tileY0 } from './merc';
import type { View } from './ground';

interface Tree { X: number; Y: number; base: number; h: number; r: number }
interface CityTile {
  x: number; y: number;
  state: 'loading' | 'ready' | 'failed';
  objects: THREE.Object3D[];
  /** tree meshes: [near detail, far detail] per kind */
  lods: [THREE.InstancedMesh, THREE.InstancedMesh][];
  /** night-only objects (street lights) */
  night: THREE.Object3D[];
  trees: Tree[];
  grid: Map<number, Tree[]>;
}
const GRID = 24;
/** near-ring tiles a far ring can step aside for: (2·2+3)² covers radius 2 plus the ring being dropped */
const MAX_HOLES = 49;

/** Uniforms shared by the world's materials. */
export interface WorldUniforms {
  uTime: { value: number };
  /** 0 day … 1 night */
  uNight: { value: number };
  /** wrapped world position of the camera (real meters), for world-anchored patterns */
  uCamOff: { value: THREE.Vector2 };
  uSkyTint: { value: THREE.Color };
}

export interface CityOptions {
  /** tile zoom: 14 for the detailed ring, 13 for the far skyline */
  z: number;
  radius: number;
  /** far ring: tall buildings only, nothing else */
  lite: boolean;
  treeDensity: number;
  shadows: boolean;
}

/**
 * OSM buildings with procedural facades and roofs, trees, water and street lights around the drone.
 * Trees are solid obstacles. A lite instance draws the far skyline and hides itself where the detailed ring is.
 */
export class City {
  readonly group = new THREE.Group();
  private tiles = new Map<string, CityTile>();
  private worker = new Worker(new URL('./city.worker.ts', import.meta.url), { type: 'module' });
  private waiting = new Map<number, (r: CityRes) => void>();
  private nextId = 1;
  private loading = 0;
  private template: string | null = null;
  readonly material: THREE.MeshStandardMaterial;
  private waterMat: THREE.MeshStandardMaterial;
  private treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private treeGeo = [[broadleaf(true), broadleaf(false)], [conifer(true), conifer(false)]];
  private lampMat: THREE.PointsMaterial;
  private poolMat: THREE.PointsMaterial;
  /** camera-relative rects (xmin, ymin, xmax, ymax) where a lite ring must not draw: the near ring's live tiles */
  readonly holes = { value: Array.from({ length: MAX_HOLES }, () => new THREE.Vector4()) };
  /** ground height under the drone, to pick tree detail by height above ground */
  lastGround = 0;
  night = false;

  constructor(private terrain: TerrainCache, private o: CityOptions, u: WorldUniforms) {
    this.worker.onmessage = (e: MessageEvent<CityRes>) => { this.waiting.get(e.data.id)?.(e.data); this.waiting.delete(e.data.id); };
    this.material = facadeMaterial(u, o.lite ? this.holes : null);
    this.waterMat = waterMaterial(u);
    const glow = glowTexture();
    this.lampMat = new THREE.PointsMaterial({ map: glow, color: 0xffc27a, size: 7, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.poolMat = new THREE.PointsMaterial({ map: glow, color: 0x6e4a26, size: 26, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  }

  setTemplate(url: string) { this.template = url; }
  get pending() { return this.loading; }

  /** Camera-relative rects of this ring's tiles that are on screen (what a far ring must leave to it). */
  coverage(v: View, out: THREE.Vector4[]): number {
    const z = this.o.z;
    let n = 0;
    for (const t of this.tiles.values()) {
      if (t.state !== 'ready' || n >= out.length) continue;
      out[n++].set((tileX0(z, t.x) - v.camX) / v.k, (tileY0(z, t.y + 1) - v.camY) / v.k, (tileX0(z, t.x + 1) - v.camX) / v.k, (tileY0(z, t.y) - v.camY) / v.k);
    }
    for (let i = n; i < out.length; i++) out[i].set(0, 0, 0, 0);
    return n;
  }

  update(v: View) {
    if (!this.template) return;
    const z = this.o.z;
    const { x, y } = tileOf(z, v.camX, v.camY);
    const R = this.o.radius;
    const want = new Set<string>();
    const order: [number, number, number][] = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) order.push([x + dx, y + dy, dx * dx + dy * dy]);
    order.sort((a, b) => a[2] - b[2]);
    for (const [tx, ty] of order) {
      const key = `${tx}/${ty}`;
      want.add(key);
      if (!this.tiles.has(key) && this.loading < 3) this.load(tx, ty);
    }
    for (const [key, t] of this.tiles) {
      const far = Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) > R + 1;
      if (far && t.state !== 'loading') { this.drop(key, t); continue; }
      // tiles stay on screen until dropped (one ring out), so nothing blinks when you cross a tile border
      const show = t.state === 'ready';
      for (const o of t.objects) {
        o.visible = show;
        o.position.set((tileX0(z, t.x) - v.camX) / v.k, (tileY0(z, t.y) - v.camY) / v.k, -v.alt);
        o.scale.set(1 / v.k, 1 / v.k, 1);
      }
      // detailed, shadow-casting trees only in the tiles around the drone
      const near = Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) <= 1 && v.alt - this.lastGround < 500;
      for (const [hi, lo] of t.lods) { hi.visible = show && near; lo.visible = show && !near; }
      for (const o of t.night) o.visible = show && this.night;
    }
  }

  private drop(key: string, t: CityTile) {
    for (const o of t.objects) {
      this.group.remove(o);
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
    }
    this.tiles.delete(key);
  }

  private async load(tx: number, ty: number) {
    const z = this.o.z;
    const key = `${tx}/${ty}`;
    const tile: CityTile = { x: tx, y: ty, state: 'loading', objects: [], lods: [], night: [], trees: [], grid: new Map() };
    this.tiles.set(key, tile);
    this.loading++;
    try {
      const size = tileSize(z);
      const k = kAt(latOf(tileY0(z, ty) - size / 2));
      const id = this.nextId++;
      const url = this.template!.replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      const req: CityReq = { id, url, size, k, treeDensity: this.o.treeDensity, seed: (tx * 92821) ^ (ty * 68917), tx, ty, lite: this.o.lite };
      const res = await new Promise<CityRes>((resolve) => { this.waiting.set(id, resolve); this.worker.postMessage(req); });
      const ht = await this.terrain.ensure(z, tx, ty);
      if (this.tiles.get(key) !== tile) return;
      if (!res.ok) { tile.state = 'failed'; return; }
      const X0 = tileX0(z, tx), Y0 = tileY0(z, ty);
      const ground = (lx: number, ly: number) => (ht ? this.terrain.sample(ht, X0 + lx, Y0 + ly) : 0);

      if (res.pos.length) {
        // lift every building onto the terrain at its centroid
        const nb = res.cent.length / 2;
        const base = new Float32Array(nb);
        for (let b = 0; b < nb; b++) base[b] = ground(res.cent[b * 2], res.cent[b * 2 + 1]);
        for (let i = 0; i < res.bidx.length; i++) res.pos[i * 3 + 2] += base[res.bidx[i]] - 0.3;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(res.pos, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(res.nrm, 3));
        g.setAttribute('color', new THREE.BufferAttribute(res.col, 3));
        g.setAttribute('aFac', new THREE.BufferAttribute(res.fac, 4));
        g.setAttribute('aSeed', new THREE.BufferAttribute(res.seed, 1));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.material);
        m.castShadow = this.o.shadows; m.receiveShadow = this.o.shadows;
        tile.objects.push(m);
      }

      if (res.water.length) {
        // drape the water on the terrain, a little above the smoothed river bed
        const n = res.water.length / 2;
        const p = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { p[i * 3] = res.water[i * 2]; p[i * 3 + 1] = res.water[i * 2 + 1]; p[i * 3 + 2] = ground(res.water[i * 2], res.water[i * 2 + 1]) + 0.6; }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(p, 3));
        g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
        g.computeBoundingSphere();
        const m = new THREE.Mesh(g, this.waterMat);
        m.receiveShadow = this.o.shadows;
        m.renderOrder = 1;
        tile.objects.push(m);
      }

      if (res.lamps.length) {
        const n = res.lamps.length / 2;
        const heads = new Float32Array(n * 3), pools = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const lx = res.lamps[i * 2], ly = res.lamps[i * 2 + 1], b = ground(lx, ly);
          heads.set([lx, ly, b + 7], i * 3);
          pools.set([lx, ly, b + 1.2], i * 3);
        }
        for (const [arr, mat] of [[heads, this.lampMat], [pools, this.poolMat]] as const) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
          g.computeBoundingSphere();
          const pts = new THREE.Points(g, mat);
          pts.renderOrder = 2;
          tile.objects.push(pts);
          tile.night.push(pts);
        }
      }

      if (res.trees.length) {
        const n = res.trees.length / 4;
        const counts = [0, 0];
        for (let i = 0; i < n; i++) counts[res.trees[i * 4 + 3]]++;
        const meshes = this.treeGeo.map(([geo], kind) => {
          const im = new THREE.InstancedMesh(geo, this.treeMat, Math.max(1, counts[kind]));
          im.count = counts[kind];
          im.castShadow = this.o.shadows; im.receiveShadow = false;
          return im;
        });
        const used = [0, 0];
        const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
        const zAxis = new THREE.Vector3(0, 0, 1);
        let rnd = (tx * 31 + ty * 17) % 1000;
        for (let i = 0; i < n; i++) {
          const lx = res.trees[i * 4], ly = res.trees[i * 4 + 1], h = res.trees[i * 4 + 2], kind = res.trees[i * 4 + 3];
          const b = ground(lx, ly);
          rnd = (rnd * 9301 + 49297) % 233280;
          const r1 = rnd / 233280;
          q.setFromAxisAngle(zAxis, r1 * Math.PI * 2);
          const w = h * (kind ? 0.8 : 0.9 + r1 * 0.3);
          sc.set(w * k, w * k, h);
          p.set(lx, ly, b - 0.2);
          mtx.compose(p, q, sc);
          const im = meshes[kind];
          im.setMatrixAt(used[kind], mtx);
          c.setRGB(0.8 + r1 * 0.35, 0.82 + ((r1 * 7.3) % 1) * 0.3, 0.75 + ((r1 * 3.1) % 1) * 0.3);
          im.setColorAt(used[kind]++, c);
          const tree: Tree = { X: X0 + lx, Y: Y0 + ly, base: b, h, r: (kind ? 0.22 : 0.32) * w };
          tile.trees.push(tree);
          const cell = this.cell(tree.X, tree.Y);
          let arr = tile.grid.get(cell);
          if (!arr) tile.grid.set(cell, (arr = []));
          arr.push(tree);
        }
        meshes.forEach((im, kind) => {
          if (!im.count) return;
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.computeBoundingSphere();
          // far version shares the instance data, never casts shadows
          const lo = new THREE.InstancedMesh(this.treeGeo[kind][1], this.treeMat, im.count);
          lo.instanceMatrix = im.instanceMatrix;
          lo.instanceColor = im.instanceColor;
          lo.boundingSphere = im.boundingSphere;
          tile.objects.push(im, lo);
          tile.lods.push([im, lo]);
        });
      }
      for (const o of tile.objects) { o.visible = false; this.group.add(o); }
      tile.state = 'ready';
    } catch (e) {
      console.warn('city tile failed', e);
      tile.state = 'failed';
    } finally {
      this.loading--;
    }
  }

  private cell(X: number, Y: number) {
    const s = tileSize(this.o.z) / GRID;
    return Math.floor(X / s) * 100003 + Math.floor(Y / s);
  }

  /** Tree crowns covering a point (Mercator), as solid volumes. */
  treesAt(X: number, Y: number, k: number): { base: number; top: number }[] {
    const { x, y } = tileOf(this.o.z, X, Y);
    const t = this.tiles.get(`${x}/${y}`);
    if (!t || t.state !== 'ready') return [];
    const out: { base: number; top: number }[] = [];
    const s = tileSize(this.o.z) / GRID;
    const cx = Math.floor(X / s), cy = Math.floor(Y / s);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const tr of t.grid.get((cx + dx) * 100003 + (cy + dy)) ?? []) {
        // the solid core of the crown: leaves at the edge brush past, branches near the trunk stop you
        if (Math.hypot(tr.X - X, tr.Y - Y) / k < tr.r * 0.6) out.push({ base: tr.base + tr.h * 0.35, top: tr.base + tr.h * 0.92 });
      }
    }
    return out;
  }
}

/** Soft round sprite for lights. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.15, 'rgba(255,255,255,0.75)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Unit-height broadleaf tree (z up): trunk and a lumpy crown of foliage clumps, vertex-coloured. */
function broadleaf(near: boolean) {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.45, near ? 6 : 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.225);
  if (!near) {
    const g = mergeVertices(new THREE.IcosahedronGeometry(0.34, 0).deleteAttribute('normal').deleteAttribute('uv')).scale(1, 1, 0.9).translate(0, 0, 0.63);
    g.computeVertexNormals();
    return paint([trunk, g], [0x4e3d2c, 0x44663a]);
  }
  // a few overlapping smooth blobs read as foliage clumps
  const blobs = [[0, 0, 0.62, 0.3, 1], [0.14, 0.05, 0.55, 0.21, 0], [-0.11, 0.1, 0.6, 0.21, 0], [0.03, -0.13, 0.75, 0.2, 0]].map(([x, y, z, r, d]) => {
    const g = mergeVertices(new THREE.IcosahedronGeometry(r, d).deleteAttribute('normal').deleteAttribute('uv'));
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const f = 1 + Math.sin(p.getX(i) * 41.1 + p.getY(i) * 27.3 + p.getZ(i) * 33.7) * 0.07;
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i) * f * 0.9);
    }
    g.translate(x, y, z);
    g.computeVertexNormals();
    return g;
  });
  return paint([trunk, ...blobs], [0x4e3d2c, 0x3f6130, 0x48693a, 0x3b5a2c, 0x4c6d3d]);
}

/** Unit-height conifer: trunk and stacked cones. */
function conifer(near: boolean) {
  const seg = near ? 9 : 5;
  const trunk = new THREE.CylinderGeometry(0.03, 0.045, 0.3, near ? 5 : 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.15);
  const low = new THREE.ConeGeometry(0.28, 0.55, seg, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.42);
  const top = new THREE.ConeGeometry(0.19, 0.5, seg, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.72);
  if (!near) return paint([trunk, low, top], [0x47382a, 0x26432a, 0x2e4f31]);
  const mid = new THREE.ConeGeometry(0.23, 0.42, seg, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.6);
  return paint([trunk, low, mid, top], [0x47382a, 0x26432a, 0x2b4a2e, 0x315334]);
}

function paint(parts: THREE.BufferGeometry[], colors: number[]) {
  const c = new THREE.Color();
  const geos = parts.map((g, i) => {
    const gg = g.index ? g.toNonIndexed() : g;
    c.setHex(colors[i]);
    const p = gg.attributes.position;
    const arr = new Float32Array(p.count * 3);
    // darker low in the crown (self-shadowing), lighter at the top
    for (let k = 0; k < p.count; k++) {
      const f = i === 0 ? 1 : 0.55 + 0.6 * Math.min(1, Math.max(0, (p.getZ(k) - 0.35) / 0.6));
      arr[k * 3] = c.r * f; arr[k * 3 + 1] = c.g * f; arr[k * 3 + 2] = c.b * f;
    }
    gg.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    gg.deleteAttribute('uv');
    return gg;
  });
  return mergeGeometries(geos)!;
}

/**
 * Buildings: vertex colour per building, with procedural floors and windows on the walls (shopfronts at street level,
 * curtain walls on some towers), glass that reflects the sky and lights up at night, contact shadow at the base,
 * a coping band on flat roofs and roof grain. A far-ring variant discards itself inside the near ring.
 */
function facadeMaterial(u: WorldUniforms, hole: { value: THREE.Vector4[] } | null) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 });
  m.customProgramCacheKey = () => (hole ? 'facade-far' : 'facade');
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = u.uNight;
    if (hole) sh.uniforms.uHoles = hole;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aFac;\nattribute float aSeed;\nvarying vec4 vFac;\nvarying float vSeed;\nvarying vec2 vRelXY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFac = aFac; vSeed = aSeed;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRelXY = (modelMatrix * vec4(transformed, 1.0)).xy;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vFac;
varying float vSeed;
varying vec2 vRelXY;
uniform float uNight;
${hole ? `uniform vec4 uHoles[${MAX_HOLES}];` : ''}
float fHash(vec2 p) { p = fract(p * vec2(233.34, 851.73)); p += dot(p, p + 23.45); return fract(p.x * p.y); }
float fNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fHash(i), fHash(i + vec2(1, 0)), u.x), mix(fHash(i + vec2(0, 1)), fHash(i + vec2(1, 1)), u.x), u.y);
}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${hole ? `for (int i = 0; i < ${MAX_HOLES}; i++) { vec4 h = uHoles[i]; if (vRelXY.x > h.x && vRelXY.x < h.z && vRelXY.y > h.y && vRelXY.y < h.w) discard; }` : ''}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float gWin = 0.0;
float gLit = 0.0;
{
  float u = vFac.x, v = vFac.y, kind = vFac.z, H = vFac.w;
  if (kind > 0.5 && kind < 1.5) {
    float floorH = mix(3.0, 3.6, fract(vSeed * 3.7));
    float bay = mix(2.4, 3.8, fract(vSeed * 5.3));
    float glassy = step(0.72, fract(vSeed * 7.31)) * step(42.0, H);
    float gf = H > 9.0 ? 4.2 : 0.0;
    float win = 0.0;
    vec2 cellId;
    if (glassy > 0.5) {
      float fx = fract(u / 1.5), fy = fract(v / floorH);
      win = (1.0 - step(fx, 0.07)) * (1.0 - step(fy, 0.1));
      cellId = floor(vec2(u / 4.5, v / floorH));
    } else if (v < gf) {
      float fx = fract(u / 5.0);
      win = step(0.08, fx) * step(fx, 0.92) * step(0.3, v) * step(v, gf - 0.7);
      cellId = vec2(floor(u / 5.0), -1.0);
    } else {
      float fx = fract(u / bay), fy = fract((v - gf) / floorH);
      win = step(0.27, fx) * step(fx, 0.73) * step(0.3, fy) * step(fy, 0.84);
      // light stone frame and sill around each window, a thin cornice line every floor
      float frame = step(0.23, fx) * step(fx, 0.77) * step(0.24, fy) * step(fy, 0.88) - win;
      float cornice = step(fy, 0.04);
      diffuseColor.rgb *= 1.0 + 0.16 * frame - 0.07 * cornice;
      cellId = floor(vec2(u / bay, (v - gf) / floorH));
    }
    win *= step(v, H - 0.9) * step(5.0, H);
    float wn = fHash(cellId + vSeed * 31.0);
    // far away the grid would shimmer: fade to its average
    float px = max(fwidth(u / 3.0), fwidth(v / 3.2));
    float fade = smoothstep(0.12, 0.4, px);
    float lit = win * step(0.58, wn) * (v < gf ? 1.6 : 1.0);
    win = mix(win, 0.22, fade);
    gLit = mix(lit, 0.07, fade);
    diffuseColor.rgb *= 0.93 + 0.1 * fNoise(vec2(u, v) * 0.7 + vSeed * 50.0);
    diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(0.0, 2.8, v));
    // coping band at the top of the wall
    diffuseColor.rgb *= 1.0 + 0.12 * step(H - 0.6, v);
    vec3 glass = vec3(0.035, 0.045, 0.055) * (0.6 + 0.8 * wn) + vec3(0.12, 0.1, 0.07) * step(0.86, wn) * (1.0 - uNight);
    diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
    gWin = win;
  } else if (kind > 2.5) {
    // open steel lattice (Eiffel-type towers): legs at the corners, X-bracing, girders, arches at the base
    float u = vFac.x, v = vFac.y, w = vFac.w;
    float bar = step(w - 2.2, abs(u));
    bar = max(bar, step(fract((u + v) / 5.0), 0.13));
    bar = max(bar, step(fract((u - v) / 5.0), 0.13));
    bar = max(bar, step(fract(v / 7.0), 0.07));
    float arch = (u / max(w - 5.0, 1.0)) * (u / max(w - 5.0, 1.0)) + (v / 39.0) * (v / 39.0);
    if (bar < 0.5 || (v < 39.0 && arch < 1.0 && abs(u) < w - 2.2)) discard;
    diffuseColor.rgb *= 0.85 + 0.15 * fract(v * 0.37);
  } else if (kind > 1.5) {
    // rooftop boxes: plain, darker at the foot
    diffuseColor.rgb *= (0.9 + 0.1 * fNoise(vFac.xy * 2.0)) * mix(0.6, 1.0, smoothstep(0.0, 1.0, v));
  } else if (kind > -0.5) {
    diffuseColor.rgb *= 0.82 + 0.22 * fNoise(vFac.xy * 0.5 + vSeed * 40.0) + 0.06 * fNoise(vFac.xy * 3.0);
  }
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.1, gWin);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 2.5);
  totalEmissiveRadiance += gWin * (1.0 - uNight) * mix(vec3(0.03, 0.045, 0.06), vec3(0.32, 0.42, 0.52), fres);
  float warm = fract(vSeed * 13.7 + gLit);
  totalEmissiveRadiance += uNight * gLit * mix(vec3(1.0, 0.68, 0.36), vec3(0.85, 0.9, 1.0), step(0.8, warm)) * 1.3;
}`);
  };
  return m;
}

/** Rivers, lakes and sea: dark water with moving ripples, sky reflection by the Fresnel term and sun glints. */
function waterMaterial(u: WorldUniforms) {
  const m = new THREE.MeshStandardMaterial({ color: 0x1c3a44, roughness: 0.07, metalness: 0, transparent: true, opacity: 0.92 });
  m.customProgramCacheKey = () => 'water';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = u.uTime;
    sh.uniforms.uCamOff = u.uCamOff;
    sh.uniforms.uSkyTint = u.uSkyTint;
    sh.uniforms.uNight = u.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRelW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRelW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRelW;
uniform float uTime, uNight;
uniform vec2 uCamOff;
uniform vec3 uSkyTint;
vec2 waveGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = normalize(vec2(1.0, 0.35)), d2 = normalize(vec2(-0.45, 1.0)), d3 = normalize(vec2(0.8, -0.7)), d4 = normalize(vec2(-0.2, -1.0));
  g += d1 * cos(dot(p, d1) * 0.9 + t * 1.3) * 0.9;
  g += d2 * cos(dot(p, d2) * 1.7 + t * 1.9) * 0.55;
  g += d3 * cos(dot(p, d3) * 3.1 + t * 2.6) * 0.3;
  g += d4 * cos(dot(p, d4) * 6.3 + t * 3.4) * 0.15;
  return g;
}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
{
  vec2 wp = vRelW.xy + uCamOff;
  float dist = length(vRelW);
  float amp = 0.06 * (1.0 - smoothstep(60.0, 900.0, dist)) + 0.012;
  vec2 g = waveGrad(wp, uTime) * amp;
  vec3 nw = normalize(vec3(-g.x, -g.y, 1.0));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
{
  float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 4.0);
  totalEmissiveRadiance += mix(vec3(0.01, 0.025, 0.03), uSkyTint, 0.06 + 0.9 * fres) * (1.0 - 0.75 * uNight);
}`);
  };
  return m;
}
