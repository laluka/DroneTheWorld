import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

/** One building footprint in tile-local integer coordinates. */
interface Footprint {
  minX: number; minY: number; maxX: number; maxY: number;
  rings: Int32Array[]; // flat [x0,y0,x1,y1,...]
  height: number;
  base: number;
}
interface TileIndex {
  extent: number;
  items: Footprint[];
  grid: number[][]; // GRID*GRID cells of item indices
}

const Z = 14;
const GRID = 32;
const MAX_TILES = 36;

const tileXY = (lng: number, lat: number) => {
  const n = 2 ** Z;
  const x = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
};

/**
 * Building volumes around the drone, decoded from OpenMapTiles vector tiles (z14, `building` layer).
 * Used for collision only; rendering stays in MapLibre. Tiles come from the HTTP cache MapLibre already filled.
 */
export class BuildingField {
  private tiles = new Map<string, TileIndex | 'loading' | 'failed'>();
  private order: string[] = [];
  private template: string | null = null;

  setTemplate(url: string | null) { if (url && url !== this.template) { this.template = url; this.tiles.clear(); this.order = []; } }
  get ready() { return !!this.template; }

  /** Make sure the 3×3 tiles around a point are loading. Cheap to call every frame. */
  prefetch(lng: number, lat: number) {
    if (!this.template) return;
    const { x, y } = tileXY(lng, lat);
    const tx = Math.floor(x), ty = Math.floor(y);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) this.ensure(tx + dx, ty + dy);
  }

  private ensure(tx: number, ty: number) {
    const n = 2 ** Z;
    tx = ((tx % n) + n) % n;
    if (ty < 0 || ty >= n) return;
    const key = `${tx}/${ty}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    this.order.push(key);
    while (this.order.length > MAX_TILES) this.tiles.delete(this.order.shift()!);
    const url = this.template!.replace('{z}', String(Z)).replace('{x}', String(tx)).replace('{y}', String(ty));
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => { if (this.tiles.get(key) === 'loading') this.tiles.set(key, decode(buf)); })
      .catch(() => { if (this.tiles.get(key) === 'loading') this.tiles.set(key, 'failed'); });
  }

  /**
   * Every building volume covering a point (OSM buildings are often stacked parts: legs, floors, spires),
   * as heights above local ground. null on open ground, undefined while the tile is still loading.
   */
  at(lng: number, lat: number): { base: number; top: number }[] | null | undefined {
    const { x, y } = tileXY(lng, lat);
    const tx = Math.floor(x), ty = Math.floor(y);
    const t = this.tiles.get(`${tx}/${ty}`);
    if (!t || t === 'loading') return undefined;
    if (t === 'failed') return null;
    const px = (x - tx) * t.extent, py = (y - ty) * t.extent;
    const gx = Math.min(GRID - 1, Math.max(0, Math.floor((px / t.extent) * GRID)));
    const gy = Math.min(GRID - 1, Math.max(0, Math.floor((py / t.extent) * GRID)));
    let out: { base: number; top: number }[] | null = null;
    for (const i of t.grid[gy * GRID + gx]) {
      const f = t.items[i];
      if (px < f.minX || px > f.maxX || py < f.minY || py > f.maxY) continue;
      if (inside(f.rings, px, py)) (out ??= []).push({ base: f.base, top: f.height });
    }
    return out;
  }
}

function decode(buf: ArrayBuffer): TileIndex {
  const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const layer = vt.layers.building;
  const extent = layer?.extent ?? 4096;
  const items: Footprint[] = [];
  const grid: number[][] = Array.from({ length: GRID * GRID }, () => []);
  if (!layer) return { extent, items, grid };
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    if (f.type !== 3) continue;
    const h = Number(f.properties.render_height ?? 8);
    if (!(h > 1.5)) continue;
    const base = Number(f.properties.render_min_height ?? 0) || 0;
    const geom = f.loadGeometry();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const rings = geom.map((ring) => {
      const a = new Int32Array(ring.length * 2);
      ring.forEach((p, k) => {
        a[k * 2] = p.x; a[k * 2 + 1] = p.y;
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      });
      return a;
    });
    const idx = items.push({ minX, minY, maxX, maxY, rings, height: h, base }) - 1;
    const c = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor((v / extent) * GRID)));
    for (let gy = c(minY); gy <= c(maxY); gy++) for (let gx = c(minX); gx <= c(maxX); gx++) grid[gy * GRID + gx].push(idx);
  }
  return { extent, items, grid };
}

/** Even-odd point in polygon over all rings (handles holes and multipolygons). */
function inside(rings: Int32Array[], x: number, y: number) {
  let c = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}
