import * as THREE from 'three';
import { TERRAIN_MAX_Z, type TerrainCache } from './terrain';
import { kAt, latOf, tileSize, tileOf, tileX0, tileY0, wrapX } from './merc';
import type { WorldUniforms } from './city';

const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const MAX_Z = 19;
const ROOT_Z = 5;
const SEG = 24;
const MAX_LOADING = 12;
const MAX_READY = 650;

/** What the world is seen from this frame. Positions are camera-relative real meters (x east, y north, z up). */
export interface View {
  camX: number; camY: number; alt: number;
  /** Mercator meters per real meter at the camera */
  k: number;
  frustum: THREE.Frustum;
  frame: number;
}

type State = 'idle' | 'queued' | 'loading' | 'ready' | 'failed';
class Node {
  kids: Node[] | null = null;
  state: State = 'idle';
  mesh: THREE.Mesh | null = null;
  lastUsed = 0;
  prio = 0;
  noSplit = false;
  constructor(public z: number, public x: number, public y: number, public minH: number, public maxH: number) {}
}

/** Shared grid topology (with a skirt around the edge to hide cracks between levels of detail). */
function gridIndex() {
  const n = SEG + 1, idx: number[] = [];
  for (let j = 0; j < SEG; j++) for (let i = 0; i < SEG; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // skirt vertices follow the grid: 4 edges × n, in order top, right, bottom, left
  const edge = (k: number) => [...Array(n).keys()].map((t) => (k === 0 ? t : k === 1 ? t * n + SEG : k === 2 ? SEG * n + (SEG - t) : (SEG - t) * n));
  let s = n * n;
  for (let k = 0; k < 4; k++) {
    const e = edge(k);
    for (let t = 0; t < SEG; t++) {
      const a = e[t], b = e[t + 1], sa = s + t, sb = s + t + 1;
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa); // both faces: skirts are seen from either side
    }
    s += n;
  }
  return { idx: new Uint32Array(idx), edges: [0, 1, 2, 3].map(edge) };
}

/** Satellite imagery draped on terrain, as a distance-driven quadtree streaming down to 0.3 m pixels. */
export class Ground {
  readonly group = new THREE.Group();
  private roots = new Map<string, Node>();
  private queue: Node[] = [];
  private loading = 0;
  private ready = new Set<Node>();
  private drawn: THREE.Mesh[] = [];
  private topo = gridIndex();
  private box = new THREE.Box3();
  private origin = new THREE.Vector3();
  private aniso: number;
  constructor(private terrain: TerrainCache, renderer: THREE.WebGLRenderer, private split: number, private uniforms: WorldUniforms) {
    this.aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  }

  get pending() { return this.queue.length + this.loading; }

  update(v: View) {
    for (const m of this.drawn) m.visible = false;
    this.drawn = [];
    // detail-noise coordinates: world position, wrapped to keep float precision
    this.uniforms.uCamOff.value.set(((v.camX / v.k) % 4096 + 4096) % 4096, ((v.camY / v.k) % 4096 + 4096) % 4096);

    const { x, y } = tileOf(ROOT_Z, v.camX, v.camY);
    const n = 2 ** ROOT_Z;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ty = y + dy;
      if (ty < 0 || ty >= n) continue;
      const tx = x + dx;
      const key = `${tx}/${ty}`;
      let r = this.roots.get(key);
      if (!r) { r = new Node(ROOT_Z, tx, ty, -100, 5000); this.roots.set(key, r); }
      this.visit(r, v);
    }
    this.pump(v);
    this.evict(v);
  }

  /** Box of a node in camera-relative real meters. */
  private bounds(nd: Node, v: View) {
    const s = tileSize(nd.z), X0 = tileX0(nd.z, nd.x), Y0 = tileY0(nd.z, nd.y);
    this.box.min.set((X0 - v.camX) / v.k, (Y0 - s - v.camY) / v.k, nd.minH - v.alt - 5);
    this.box.max.set((X0 + s - v.camX) / v.k, (Y0 - v.camY) / v.k, nd.maxH - v.alt + 5);
    return this.box;
  }

  private inView(nd: Node, v: View) { return v.frustum.intersectsBox(this.bounds(nd, v)); }

  /** Draws the node or its children; returns false when nothing could be drawn for it yet. */
  private visit(nd: Node, v: View): boolean {
    if (!this.inView(nd, v)) return true;
    nd.lastUsed = v.frame;
    const dist = this.box.distanceToPoint(this.origin);
    const sizeReal = tileSize(nd.z) / v.k;
    if (nd.z < MAX_Z && !nd.noSplit && dist < sizeReal * this.split) {
      if (!nd.kids) {
        nd.kids = [];
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) nd.kids.push(new Node(nd.z + 1, nd.x * 2 + i, nd.y * 2 + j, nd.minH, nd.maxH));
      }
      let allReady = true;
      for (const kd of nd.kids) {
        if (!this.inView(kd, v)) continue;
        kd.lastUsed = v.frame;
        if (kd.state === 'failed') nd.noSplit = true;
        if (kd.state !== 'ready') { allReady = false; this.request(kd, this.box.distanceToPoint(this.origin) / (tileSize(kd.z) / v.k)); }
      }
      if (allReady && !nd.noSplit) {
        for (const kd of nd.kids) this.visit(kd, v);
        return true;
      }
    }
    if (nd.state === 'ready') { this.draw(nd, v); return true; }
    this.request(nd, dist / sizeReal);
    return false;
  }

  private draw(nd: Node, v: View) {
    const m = nd.mesh!;
    m.visible = true;
    m.position.set((tileX0(nd.z, nd.x) - v.camX) / v.k, (tileY0(nd.z, nd.y) - v.camY) / v.k, -v.alt);
    m.scale.set(1 / v.k, 1 / v.k, 1);
    this.drawn.push(m);
  }

  private request(nd: Node, prio: number) {
    nd.prio = nd.z * 4 + Math.min(4, prio);
    if (nd.state === 'idle') { nd.state = 'queued'; this.queue.push(nd); }
  }

  private pump(v: View) {
    // drop requests nobody needs any more, then start the coarsest / closest first
    this.queue = this.queue.filter((nd) => {
      if (nd.lastUsed < v.frame - 2) { nd.state = 'idle'; return false; }
      return true;
    });
    this.queue.sort((a, b) => a.prio - b.prio);
    while (this.loading < MAX_LOADING && this.queue.length) this.load(this.queue.shift()!);
  }

  private async load(nd: Node) {
    nd.state = 'loading';
    this.loading++;
    try {
      const tz = Math.min(nd.z, TERRAIN_MAX_Z);
      const sh = nd.z - tz;
      const [tex, ht] = await Promise.all([this.texture(nd), this.terrain.ensure(tz, nd.x >> sh, nd.y >> sh)]);
      if (!tex) { nd.state = 'failed'; return; }
      nd.mesh = this.mesh(nd, tex, ht);
      nd.state = 'ready';
      this.ready.add(nd);
    } catch {
      nd.state = 'failed';
    } finally {
      this.loading--;
    }
  }

  private async texture(nd: Node): Promise<THREE.Texture | null> {
    const url = IMAGERY.replace('{z}', String(nd.z)).replace('{y}', String(nd.y)).replace('{x}', String(wrapX(nd.z, nd.x)));
    const r = await fetch(url);
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob());
    if (nd.z >= 13 && isPlaceholder(bmp)) { bmp.close(); return null; }
    const t = new THREE.Texture(bmp);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = this.aniso;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  }

  private mesh(nd: Node, tex: THREE.Texture, ht: ReturnType<TerrainCache['get']>) {
    const n = SEG + 1, s = tileSize(nd.z), X0 = tileX0(nd.z, nd.x), Y0 = tileY0(nd.z, nd.y);
    const pos = new Float32Array((n * n + 4 * n) * 3);
    const uv = new Float32Array((n * n + 4 * n) * 2);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const X = X0 + (i / SEG) * s, Y = Y0 - (j / SEG) * s;
      const h = ht ? Math.max(-12, this.terrain.sample(ht, X, Y)) : 0;
      const o = j * n + i;
      pos[o * 3] = (i / SEG) * s; pos[o * 3 + 1] = -(j / SEG) * s; pos[o * 3 + 2] = h;
      uv[o * 2] = i / SEG; uv[o * 2 + 1] = j / SEG;
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    const skirt = (s / kAt(latOf(Y0 - s / 2))) * 0.02 + 3;
    let o = n * n;
    for (const e of this.topo.edges) for (const src of e) {
      pos[o * 3] = pos[src * 3]; pos[o * 3 + 1] = pos[src * 3 + 1]; pos[o * 3 + 2] = pos[src * 3 + 2] - skirt;
      uv[o * 2] = uv[src * 2]; uv[o * 2 + 1] = uv[src * 2 + 1];
      o++;
    }
    nd.minH = lo; nd.maxH = hi;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(this.topo.idx, 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    groundDetail(mat, this.uniforms);
    const m = new THREE.Mesh(g, mat);
    m.matrixAutoUpdate = true;
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.visible = false;
    this.group.add(m);
    return m;
  }

  private evict(v: View) {
    if (this.ready.size <= MAX_READY) return;
    const old = [...this.ready].filter((nd) => nd.lastUsed < v.frame - 1 && nd.z > ROOT_Z).sort((a, b) => a.lastUsed - b.lastUsed);
    for (const nd of old.slice(0, this.ready.size - MAX_READY)) {
      const m = nd.mesh!;
      this.group.remove(m);
      m.geometry.dispose();
      const mat = m.material as THREE.MeshLambertMaterial;
      mat.map?.dispose();
      mat.dispose();
      nd.mesh = null;
      nd.state = 'idle';
      nd.kids = null;
      this.ready.delete(nd);
    }
  }
}

/** Fine procedural grain on the imagery up close, plus a touch more contrast, so low flying keeps texture. */
function groundDetail(mat: THREE.MeshLambertMaterial, uniforms: WorldUniforms) {
  mat.customProgramCacheKey = () => 'ground-detail';
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCamOff = uniforms.uCamOff;
    sh.uniforms.uNight = uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRel;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRel = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vRel;
uniform vec2 uCamOff;
uniform float uNight;
float gHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), u.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), u.x), u.y);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec2 wp = vRel.xy + uCamOff;
  float n = gNoise(wp * 1.7) * 0.45 + gNoise(wp * 5.3) * 0.3 + gNoise(wp * 0.37) * 0.25;
  float fade = 1.0 - smoothstep(20.0, 260.0, length(vRel));
  diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.32 * fade;
  float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = max(mix(vec3(l), diffuseColor.rgb, 1.15), 0.0);
  // night: imagery is a daytime photo, so take it down to moonlight
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.22, 0.25, 0.36), uNight);
}`);
  };
}

/**
 * Where Esri has no imagery at a zoom it serves a flat grey "Map data not yet available" tile instead of a 404.
 * Spot it (uniform light grey) so the parent tile stays on screen.
 */
const probe = new OffscreenCanvas(8, 8);
const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;
function isPlaceholder(bmp: ImageBitmap) {
  probeCtx.drawImage(bmp, 0, 0, 8, 8);
  const d = probeCtx.getImageData(0, 0, 8, 8).data;
  let grey = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6 && r > 185 && r < 235) grey++;
  }
  return grey >= 56;
}
