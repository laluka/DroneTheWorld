/** Web Mercator (EPSG:3857) helpers. Y is north-positive meters; tile (z, x, y) has its NW corner at (X0, Y0). */
export const R = 6378137;
export const WORLD = 2 * Math.PI * R;
export const HALF = WORLD / 2;
const DEG = Math.PI / 180;

export const mercX = (lng: number) => lng * DEG * R;
export const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * DEG) / 2)) * R;
export const lngOf = (X: number) => X / R / DEG;
export const latOf = (Y: number) => (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) / DEG;
/** Mercator meters per real meter at a latitude. */
export const kAt = (lat: number) => 1 / Math.cos(lat * DEG);

export const tileSize = (z: number) => WORLD / 2 ** z;
export const tileX0 = (z: number, x: number) => -HALF + x * tileSize(z);
export const tileY0 = (z: number, y: number) => HALF - y * tileSize(z);
export const tileOf = (z: number, X: number, Y: number) => {
  const s = tileSize(z), n = 2 ** z;
  return { x: Math.min(n - 1, Math.max(0, Math.floor((X + HALF) / s))), y: Math.min(n - 1, Math.max(0, Math.floor((HALF - Y) / s))) };
};
export const wrapX = (z: number, x: number) => { const n = 2 ** z; return ((x % n) + n) % n; };
