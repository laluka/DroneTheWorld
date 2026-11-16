import { tileOf, tileSize, tileX0, tileY0 } from './merc';

/** AWS / Mapzen Terrarium elevation tiles: height = R·256 + G + B/256 − 32768. */
const URL_T = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_MAX_Z = 14;
const SIZE = 256;
const MAX_TILES = 220;

export interface HeightTile { z: number; x: number; y: number; h: Float32Array }

/** Decoded elevation tiles, shared by the ground mesh, building placement and collision. */
export class TerrainCache {
  private tiles = new Map<string, HeightTile | Promise<HeightTile | null> | null>();
  private order: string[] = [];
  private canvas = new OffscreenCanvas(SIZE, SIZE);
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  get(z: number, x: number, y: number): HeightTile | null {
    const t = this.tiles.get(`${z}/${x}/${y}`);
    return t && !(t instanceof Promise) ? t : null;
  }

  ensure(z: number, x: number, y: number): Promise<HeightTile | null> {
    const key = `${z}/${x}/${y}`;
    const t = this.tiles.get(key);
    if (t !== undefined) return t instanceof Promise ? t : Promise.resolve(t);
    const p = this.load(z, x, y).then((r) => { this.tiles.set(key, r); return r; });
    this.tiles.set(key, p);
    this.order.push(key);
    while (this.order.length > MAX_TILES) this.tiles.delete(this.order.shift()!);
    return p;
  }

  private async load(z: number, x: number, y: number): Promise<HeightTile | null> {
    try {
      const r = await fetch(URL_T.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      this.ctx.clearRect(0, 0, SIZE, SIZE);
      this.ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
      bmp.close();
      const px = this.ctx.getImageData(0, 0, SIZE, SIZE).data;
      const h = new Float32Array(SIZE * SIZE);
      for (let i = 0; i < h.length; i++) h[i] = Math.max(-12, px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768);
      // SRTM-derived detail is a surface model: buildings and canopy show up as bumps. Smooth them out up close.
      if (z >= 12) { blur(h, z >= 14 ? 3 : 2); blur(h, z >= 14 ? 3 : 2); }
      return { z, x, y, h };
    } catch {
      return null;
    }
  }

  /** Bilinear height of a loaded tile at Mercator (X, Y). Tile edges clamp, so neighbours may differ by a little. */
  sample(t: HeightTile, X: number, Y: number) {
    const s = tileSize(t.z);
    const fx = Math.max(0, Math.min(SIZE - 1.001, ((X - tileX0(t.z, t.x)) / s) * SIZE - 0.5));
    const fy = Math.max(0, Math.min(SIZE - 1.001, ((tileY0(t.z, t.y) - Y) / s) * SIZE - 0.5));
    const ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const h = t.h, i = iy * SIZE + ix;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - ay) + (h[i + SIZE] * (1 - ax) + h[i + SIZE + 1] * ax) * ay;
  }

  /** Best available height at a point (finest loaded zoom at or below `maxZ`), with the zoom it came from. */
  heightAt(X: number, Y: number, maxZ = TERRAIN_MAX_Z): { h: number; z: number } | null {
    for (let z = maxZ; z >= 0; z--) {
      const { x, y } = tileOf(z, X, Y);
      const t = this.get(z, x, y);
      if (t) return { h: this.sample(t, X, Y), z };
    }
    return null;
  }
}

/** Separable box blur in place, radius r, edge-clamped. */
function blur(h: Float32Array, r: number) {
  const tmp = new Float32Array(SIZE);
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < SIZE; a++) {
      for (let b = 0; b < SIZE; b++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          const c = Math.min(SIZE - 1, Math.max(0, b + k));
          sum += pass ? h[c * SIZE + a] : h[a * SIZE + c];
        }
        tmp[b] = sum / (2 * r + 1);
      }
      for (let b = 0; b < SIZE; b++) if (pass) h[b * SIZE + a] = tmp[b]; else h[a * SIZE + b] = tmp[b];
    }
  }
}
