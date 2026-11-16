/// <reference lib="webworker" />
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';

/**
 * Builds one z14 tile of city: building meshes from OSM footprints/heights, and tree positions in woods and parks.
 * Output is tile-local: x east / y north in Mercator meters from the tile's NW corner, z in real meters above the
 * building's own ground (the main thread lifts each building onto the terrain).
 */
export interface CityReq {
  id: number; url: string; size: number; k: number; treeDensity: number; seed: number;
  /** tile coordinates, for world-stable per-building seeds */
  tx: number; ty: number;
  /** far ring: buildings only, no clutter / trees / water / lamps */
  lite: boolean;
}
export interface CityRes {
  id: number;
  ok: boolean;
  pos: Float32Array; nrm: Float32Array; col: Float32Array;
  /** per vertex: facade u (m along the wall) / v (m up), kind (1 wall, 0 roof, -1 underside), building height */
  fac: Float32Array;
  seed: Float32Array;
  /** per vertex building index, and per building centroid (x, y) */
  bidx: Uint32Array; cent: Float32Array;
  /** per tree: x, y, height (m), kind (0 broadleaf, 1 conifer) */
  trees: Float32Array;
  /** water surface triangles, x y per vertex */
  water: Float32Array;
  /** street lamp positions, x y */
  lamps: Float32Array;
}

const WALLS = ['#d9cdb4', '#d4c6aa', '#e3d9c3', '#cbbd9f', '#bfa98a', '#c4b8a6', '#e8e3d8', '#a8a49c', '#d8d2c4', '#c9a982', '#e6dccb', '#b5a58e', '#ddd5c5', '#cfc8ba', '#b98d74', '#e9e4da'];
const TOWERS = ['#aab4bd', '#8f9aa3', '#c5ccd2', '#7d8790', '#b9c3c9', '#d0d5d8'];
const TILES = ['#9a4f3a', '#a85b42', '#7d4535', '#5a5d63', '#4d5156', '#6b4a3c', '#8e5a45', '#62666b'];
const ROOFS = ['#6f7378', '#5e6166', '#7a7a74', '#8c8a83', '#94604c', '#5b5d60', '#4d5054', '#a0a39f', '#7d756b', '#6c6a64', '#8f9497'];

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin = (c: [number, number, number]): [number, number, number] => [srgbToLin(c[0]), srgbToLin(c[1]), srgbToLin(c[2])];

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}

type Ring = { x: number; y: number }[];
const area = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x - r[i].x) * (r[j].y + r[i].y); return a / 2; };

/**
 * Clip a closed ring to the tile square [0, ext]² (Sutherland–Hodgman). Vector tiles carry a buffer past their edge,
 * so without this a building or lake crossing a tile border is drawn twice, overlapping its neighbour's copy.
 */
function clipRing(ring: Ring, ext: number): Ring {
  let pts = ring.slice(0, -1);
  const edges: [(p: { x: number; y: number }) => boolean, (a: { x: number; y: number }, b: { x: number; y: number }) => { x: number; y: number }][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= ext, (a, b) => ({ x: ext, y: a.y + ((b.y - a.y) * (ext - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= ext, (a, b) => ({ x: a.x + ((b.x - a.x) * (ext - a.y)) / (b.y - a.y), y: ext })],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); }
      else if (inside(a)) out.push(cut(a, b));
    }
    pts = out;
  }
  return pts.length >= 3 ? [...pts, pts[0]] : [];
}
const clipped = (rings: Ring[], ext: number) => rings.map((r) => clipRing(r, ext)).filter((r) => r.length >= 4);
/** True for a wall lying on the tile border: that's where a clipped building continues in the next tile. */
const onBorder = (a: { x: number; y: number }, b: { x: number; y: number }, ext: number) =>
  (a.x <= 0 && b.x <= 0) || (a.x >= ext && b.x >= ext) || (a.y <= 0 && b.y <= 0) || (a.y >= ext && b.y >= ext);

/** Split MVT rings into polygons: a ring with the first ring's winding starts a new polygon, the others are its holes. */
function polygons(rings: Ring[]) {
  const out: Ring[][] = [];
  let sign = 0;
  for (const r of rings) {
    if (r.length < 4) continue;
    const a = area(r);
    if (a === 0) continue;
    if (!sign) sign = Math.sign(a);
    if (Math.sign(a) === sign || !out.length) out.push([r]); else out[out.length - 1].push(r);
  }
  return out;
}

function insideAny(polys: Ring[][], x: number, y: number) {
  for (const p of polys) {
    let c = false;
    for (const r of p) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i].y > y) !== (r[j].y > y) && x < ((r[j].x - r[i].x) * (y - r[i].y)) / (r[j].y - r[i].y) + r[i].x) c = !c;
    }
    if (c) return true;
  }
  return false;
}

type V3 = [number, number, number];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * If a ring is (nearly) a rectangle, its corners in local Mercator x/y ordered so AB is a long side,
 * plus the short side and area in real meters. Collinear points are dropped first.
 */
function rectOf(ring: Ring, s: number, k: number) {
  const pts = ring.slice(0, -1).map((p) => [p.x * s, -p.y * s] as [number, number]);
  const keep: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const turn = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
    if (turn > 0.17) keep.push(b);
  }
  if (keep.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const a = keep[(i + 3) % 4], b = keep[i], c = keep[(i + 1) % 4];
    const u = [a[0] - b[0], a[1] - b[1]], v = [c[0] - b[0], c[1] - b[1]];
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]));
    if (Math.abs(cos) > 0.21) return null; // corners within ~12° of square
  }
  const len = (i: number) => Math.hypot(keep[(i + 1) % 4][0] - keep[i][0], keep[(i + 1) % 4][1] - keep[i][1]) / k;
  const corners = len(0) >= len(1) ? keep : [keep[1], keep[2], keep[3], keep[0]];
  const l0 = Math.max(len(0), len(1)), l1 = Math.min(len(0), len(1));
  if (l1 < 3) return null;
  return { corners, short: l1, area: l0 * l1 };
}

type Put = (x: number, y: number, z: number, n: V3, color: V3, fu: number, fv: number, kind: number, top: number, seed: number) => void;

/** Tapered open-lattice tower over a square footprint, with platforms, drawn double-sided (the shader cuts the holes). */
function latticeTower(corners: [number, number][], H: number, put: Put, k: number) {
  const cx = corners.reduce((a, c) => a + c[0], 0) / 4, cy = corners.reduce((a, c) => a + c[1], 0) / 4;
  const steel = lin(hex('#6e5c48'));
  // half-width (fraction of the base) by height (fraction of the top): curved legs, narrowing waist, needle top
  const prof: [number, number][] = [[0, 1], [0.08, 0.76], [0.17, 0.56], [0.26, 0.42], [0.35, 0.32], [0.5, 0.2], [0.65, 0.12], [0.8, 0.07], [0.9, 0.04], [1, 0.008]];
  const at = (f: number): [number, number][] => {
    let i = 0;
    while (i < prof.length - 2 && prof[i + 1][0] < f) i++;
    const [f0, w0] = prof[i], [f1, w1] = prof[i + 1];
    const w = w0 + ((w1 - w0) * (f - f0)) / (f1 - f0);
    return corners.map((c) => [cx + (c[0] - cx) * w, cy + (c[1] - cy) * w]);
  };
  const halfReal = (ring: [number, number][]) => Math.hypot(ring[1][0] - ring[0][0], ring[1][1] - ring[0][1]) / 2;
  const tri = (p: V3[], uv: [number, number, number][], n: V3) => {
    for (let k = 0; k < 3; k++) put(p[k][0], p[k][1], p[k][2], n, steel, uv[k][0], uv[k][1], 3, uv[k][2], 0.5);
    const nb: V3 = [-n[0], -n[1], -n[2]];
    for (const k of [0, 2, 1]) put(p[k][0], p[k][1], p[k][2], nb, steel, uv[k][0], uv[k][1], 3, uv[k][2], 0.5);
  };
  const steps = 40;
  for (let i = 0; i < steps; i++) {
    const f0 = i / steps, f1 = (i + 1) / steps, z0 = f0 * H, z1 = f1 * H;
    const r0 = at(f0), r1 = at(f1);
    for (let e = 0; e < 4; e++) {
      const a0 = r0[e], b0 = r0[(e + 1) % 4], a1 = r1[e], b1 = r1[(e + 1) % 4];
      const w0 = halfReal(r0) / k, w1 = halfReal(r1) / k; // real meters
      const ex = b0[0] - a0[0], ey = b0[1] - a0[1], el = Math.hypot(ex, ey) || 1;
      const n = norm([ey / el, -ex / el, 0.25]);
      const P: V3[] = [[a0[0], a0[1], z0], [b0[0], b0[1], z0], [b1[0], b1[1], z1], [a1[0], a1[1], z1]];
      const U: [number, number, number][] = [[-w0, z0, w0], [w0, z0, w0], [w1, z1, w1], [-w1, z1, w1]];
      tri([P[0], P[1], P[2]], [U[0], U[1], U[2]], n);
      tri([P[0], P[2], P[3]], [U[0], U[2], U[3]], n);
    }
  }
  // first and second floor platforms
  for (const f of [57 / 330, 115 / 330]) {
    const r = at(f).map((c) => [cx + (c[0] - cx) * 1.06, cy + (c[1] - cy) * 1.06] as [number, number]), z = f * H;
    const quad = (P: V3[], n: V3, fv: (p: V3) => number) => {
      for (const i of [0, 1, 2, 0, 2, 3]) put(P[i][0], P[i][1], P[i][2], n, steel, 0, fv(P[i]), 2, z, 0.5);
      for (const i of [0, 2, 1, 0, 3, 2]) put(P[i][0], P[i][1], P[i][2], [-n[0], -n[1], -n[2]], steel, 0, fv(P[i]), 2, z, 0.5);
    };
    for (const zz of [z, z + 4]) quad(r.map((c) => [c[0], c[1], zz] as V3), [0, 0, zz > z ? 1 : -1], () => 4);
    for (let e = 0; e < 4; e++) {
      const a = r[e], b = r[(e + 1) % 4];
      const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
      quad([[a[0], a[1], z], [b[0], b[1], z], [b[0], b[1], z + 4], [a[0], a[1], z + 4]], [ey / el, -ex / el, 0], (p) => p[2] - z);
    }
  }
}

async function build(q: CityReq): Promise<CityRes> {
  const empty = (ok: boolean): CityRes => ({ id: q.id, ok, pos: new Float32Array(), nrm: new Float32Array(), col: new Float32Array(), fac: new Float32Array(), seed: new Float32Array(), bidx: new Uint32Array(), cent: new Float32Array(), trees: new Float32Array(), water: new Float32Array(), lamps: new Float32Array() });
  let buf: ArrayBuffer;
  try {
    const r = await fetch(q.url);
    if (!r.ok) return empty(r.status === 404);
    buf = await r.arrayBuffer();
  } catch { return empty(false); }
  const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], fac: number[] = [], sd: number[] = [], bidx: number[] = [], cent: number[] = [];

  const bl = vt.layers.building;
  const extent = bl?.extent ?? 4096;
  const s = q.size / extent; // Mercator meters per tile unit
  const real = s / q.k; // real meters per tile unit
  const footprints: { minX: number; minY: number; maxX: number; maxY: number; polys: Ring[][] }[] = [];

  // Lattice towers (the Eiffel Tower and its kin): OSM stacks them as solid parts (legs, then shafts). Find each part
  // over 200 m, gather every part under it, and build one open steel tower instead.
  const towerParts = new Set<number>();
  if (bl && !q.lite) for (let fi = 0; fi < bl.length; fi++) {
    const f = bl.feature(fi);
    if (f.type !== 3 || !(Number(f.properties.render_height ?? 0) > 200)) continue;
    const [x0, y0, x1, y1] = f.bbox();
    if ((x1 - x0) * s / q.k > 60 || towerParts.has(fi)) continue; // a slim top: towers taper, office blocks don't
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let top = 0, baseIdx = -1, baseArea = 0;
    const parts: number[] = [];
    for (let j = 0; j < bl.length; j++) {
      const g = bl.feature(j);
      if (g.type !== 3 || g.properties.colour !== f.properties.colour) continue;
      const [a0, b0, a1, b1] = g.bbox();
      if (cx < a0 || cx > a1 || cy < b0 || cy > b1) continue;
      parts.push(j);
      top = Math.max(top, Number(g.properties.render_height ?? 0));
      if ((a1 - a0) * (b1 - b0) > baseArea) { baseArea = (a1 - a0) * (b1 - b0); baseIdx = j; }
    }
    // only true lattice towers stand on four separate legs; skyscrapers with a slim crown don't
    const legs = polygons(bl.feature(baseIdx).loadGeometry() as Ring[]);
    if (legs.length !== 4) continue;
    const corners = legs.map((poly) => {
      let best = poly[0][0], bd = -1;
      for (const p of poly[0]) { const d = (p.x - cx) ** 2 + (p.y - cy) ** 2; if (d > bd) { bd = d; best = p; } }
      return [best.x, best.y] as [number, number];
    });
    corners.sort((p, r) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(r[1] - cy, r[0] - cx));
    for (const j of parts) towerParts.add(j);
    const bi = cent.length / 2;
    const put: Put = (x, y, z, n, color, fu, fv, kind, tp, seed) => {
      pos.push(x, y, z); nrm.push(n[0], n[1], n[2]); col.push(color[0], color[1], color[2]); fac.push(fu, fv, kind, tp); sd.push(seed); bidx.push(bi);
    };
    latticeTower(corners.map(([x, y]) => [x * s, -y * s]), top, put, q.k);
    cent.push(cx * s, -cy * s);
  }

  if (bl) for (let fi = 0; fi < bl.length; fi++) {
    const f = bl.feature(fi);
    if (f.type !== 3 || f.properties.hide_3d || towerParts.has(fi)) continue;
    if (q.lite && Number(f.properties.render_height ?? 8) < 12) continue; // far away only the skyline matters
    const H = Number(f.properties.render_height ?? 8);
    if (!(H > 1.5)) continue;
    const base = Math.max(0, Number(f.properties.render_min_height ?? 0) || 0);
    if (base >= H) continue;
    // OpenMapTiles merges neighbouring buildings of equal height into one multipolygon feature:
    // every polygon is its own building, with its own ground point and colour.
    for (const rawPoly of polygons(f.loadGeometry() as Ring[])) {
    const outer = clipRing(rawPoly[0], extent);
    if (outer.length < 4) continue;
    const rings = [outer, ...clipped(rawPoly.slice(1), extent)];
    const cut = outer.length !== rawPoly[0].length || rings.length !== rawPoly.length;
    const polys = [rings];
    // lift from the centre of the unclipped outline: the same point in both tiles when a building crosses a border
    let rcx = 0, rcy = 0;
    for (let i = 0; i < rawPoly[0].length - 1; i++) { rcx += rawPoly[0][i].x; rcy += rawPoly[0][i].y; }
    rcx /= Math.max(1, rawPoly[0].length - 1); rcy /= Math.max(1, rawPoly[0].length - 1);
    // colours seeded by that point in world tile units, so both halves of a split building match
    const wx = Math.round((q.tx * extent + rcx) / 2), wy = Math.round((q.ty * extent + rcy) / 2);
    const r01 = rng((wx * 73856093) ^ (wy * 19349663))();
    const r02 = rng((wx * 83492791) ^ (wy * 2654435761) ^ 0x5bd1e995)();
    const tall = H > 40;
    let wall = lin(hex((tall ? TOWERS : WALLS)[Math.floor(r01 * (tall ? TOWERS : WALLS).length)]));
    const c = typeof f.properties.colour === 'string' && /^#[0-9a-f]{6}$/i.test(f.properties.colour) ? lin(hex(f.properties.colour)) : null;
    if (c) wall = [wall[0] * 0.4 + c[0] * 0.6, wall[1] * 0.4 + c[1] * 0.6, wall[2] * 0.4 + c[2] * 0.6];
    const bi = cent.length / 2;
    const put = (x: number, y: number, z: number, n: V3, color: V3, fu: number, fv: number, kind: number, top: number, seed: number) => {
      pos.push(x, y, z); nrm.push(n[0], n[1], n[2]); col.push(color[0], color[1], color[2]); fac.push(fu, fv, kind, top); sd.push(seed); bidx.push(bi);
    };
    /** A triangle (local Mercator x/y, real z) with a flat normal: facing up, or away from `from` when given. */
    const face = (pts: V3[], color: V3, kind: number, top: number, seed: number, from: V3 | null) => {
      const r = pts.map((p) => [p[0] / q.k, p[1] / q.k, p[2]] as V3); // real meters for the geometry
      let n = norm(cross3(sub3(r[1], r[0]), sub3(r[2], r[0])));
      const c: V3 = [(r[0][0] + r[1][0] + r[2][0]) / 3, (r[0][1] + r[1][1] + r[2][1]) / 3, (r[0][2] + r[1][2] + r[2][2]) / 3];
      const flip = from ? dot3(n, sub3(c, [from[0] / q.k, from[1] / q.k, from[2]])) < 0 : n[2] < 0;
      if (flip) { n = [-n[0], -n[1], -n[2]]; pts = [pts[0], pts[2], pts[1]]; }
      // the mesh is scaled (1/k, 1/k, 1): store the normal so it comes out right after the inverse-transpose
      const nl = norm([n[0] / q.k, n[1] / q.k, n[2]]);
      for (const p of pts) {
        const fu = kind === 1 ? 0 : kind === 2 ? (p[0] + p[1]) / q.k : p[0] / q.k;
        const fv = kind === 1 ? p[2] : kind === 2 ? p[2] - top : p[1] / q.k;
        put(p[0], p[1], p[2], nl, color, fu, fv, kind, top, seed);
      }
    };

    // Small, simple, roughly rectangular buildings get a pitched roof (gable or hipped), like most houses.
    const rect = !q.lite && !cut && polys.length === 1 && polys[0].length === 1 && base === 0 && H <= 16 ? rectOf(polys[0][0], s, q.k) : null;
    const pitched = rect && rect.area > 25 && rect.area < 900 && r02 < 0.85 ? rect : null;
    const pitch = ((30 + r02 * 12) * Math.PI) / 180;
    const rise = pitched ? Math.min((Math.tan(pitch) * pitched.short) / 2, H * 0.45, 7) : 0;
    const eave = H - rise;
    const roof = lin(hex(pitched ? TILES[Math.floor(r02 * 997) % TILES.length] : ROOFS[Math.floor(r02 * ROOFS.length)]));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const poly of polys) {
      // ---- walls ----
      poly.forEach((ring, ri) => {
        const ccw = area(ring) < 0; // tile y points down: negative shoelace here = counter-clockwise on the map
        const out = (ri === 0 ? 1 : -1) * (ccw ? 1 : -1);
        let u = 0;
        for (let i = 0; i < ring.length - 1; i++) {
          const a = ring[i], b = ring[i + 1];
          const ax = a.x * s, ay = -a.y * s, bx = b.x * s, by = -b.y * s;
          const dx = bx - ax, dy = by - ay;
          const len = Math.hypot(dx, dy);
          if (len < 1e-6) continue;
          const ul = len / q.k;
          if (onBorder(a, b, extent)) { u += ul; continue; }
          const nx = (dy / len) * out, ny = (-dx / len) * out;
          // a hair outward per building so overlapping OSM parts never share a plane (no flicker),
          // and ground-standing walls run below ground so slopes never show a gap under the building
          const push = (0.01 + r01 * 0.04) * q.k, ox = nx * push, oy = ny * push;
          const foot = base > 0 ? base : -12;
          const quad: [number, number, number, number][] = [[ax + ox, ay + oy, foot, u], [bx + ox, by + oy, foot, u + ul], [bx + ox, by + oy, eave, u + ul], [ax + ox, ay + oy, eave, u]];
          const order = out > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
          for (const k of order) { const v = quad[k]; put(v[0], v[1], v[2], [nx, ny, 0], wall, v[3], v[2], 1, eave, r01); }
          u += ul;
          if (ax < minX) minX = ax; if (ax > maxX) maxX = ax; if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
        }
      });

      if (pitched) {
        // ---- gable or hipped roof over the rectangle ----
        const [A, B, C, D] = pitched.corners.map((p) => [p[0], p[1], eave] as V3);
        const mid = (p: V3, p2: V3): V3 => [(p[0] + p2[0]) / 2, (p[1] + p2[1]) / 2, H];
        let R1 = mid(D, A), R2 = mid(B, C);
        const hip = r01 > 0.55;
        if (hip) {
          const L = Math.hypot(R2[0] - R1[0], R2[1] - R1[1]);
          const inset = Math.min(L / 2 - 1e-3, (pitched.short / 2) * q.k);
          const ux = (R2[0] - R1[0]) / L, uy = (R2[1] - R1[1]) / L;
          R1 = [R1[0] + ux * inset, R1[1] + uy * inset, H];
          R2 = [R2[0] - ux * inset, R2[1] - uy * inset, H];
        }
        const ctr: V3 = [(A[0] + C[0]) / 2, (A[1] + C[1]) / 2, eave];
        face([A, B, R2], roof, 0, H, r02, null); face([A, R2, R1], roof, 0, H, r02, null);
        face([C, D, R1], roof, 0, H, r02, null); face([C, R1, R2], roof, 0, H, r02, null);
        if (hip) { face([B, C, R2], roof, 0, H, r02, null); face([D, A, R1], roof, 0, H, r02, null); }
        else { face([B, C, R2], wall, 1, eave, r01, ctr); face([D, A, R1], wall, 1, eave, r01, ctr); }
        continue;
      }

      // ---- flat roof (and underside for raised parts) ----
      const flat: number[] = [], holes: number[] = [];
      poly.forEach((ring, ri) => {
        if (ri > 0) holes.push(flat.length / 2);
        for (let i = 0; i < ring.length - 1; i++) flat.push(ring[i].x * s, -ring[i].y * s);
      });
      const tri = earcut(flat, holes, 2);
      for (let t = 0; t < tri.length; t += 3) {
        let [a, b, c2] = [tri[t], tri[t + 1], tri[t + 2]];
        const cross = (flat[b * 2] - flat[a * 2]) * (flat[c2 * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c2 * 2] - flat[a * 2]);
        if (cross < 0) [b, c2] = [c2, b];
        const hz = H + r01 * 0.05;
        for (const k of [a, b, c2]) put(flat[k * 2], flat[k * 2 + 1], hz, [0, 0, 1], roof, flat[k * 2] / q.k, flat[k * 2 + 1] / q.k, 0, H, r02);
        if (base > 0) for (const k of [a, c2, b]) put(flat[k * 2], flat[k * 2 + 1], base, [0, 0, -1], wall, 0, base, -1, H, r01);
      }

      // ---- rooftop clutter on big flat roofs: plant rooms, HVAC boxes, vents ----
      const roofArea = Math.abs(area(poly[0])) * real * real;
      if (!q.lite && H > 6 && roofArea > 120) {
        const rr = rng((Math.floor(poly[0][0].x) * 31 + fi * 7919) ^ q.seed);
        const n = Math.min(6, 1 + Math.floor(roofArea / 350));
        const e0 = poly[0][0], e1 = poly[0][1];
        const ang = Math.atan2(e1.y - e0.y, e1.x - e0.x);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of poly[0]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
        for (let b = 0, tries = 0; b < n && tries < 30; tries++) {
          const tx = x0 + rr() * (x1 - x0), ty = y0 + rr() * (y1 - y0);
          const w = ((1.5 + rr() * 3.5) * q.k) / s / 2, d = ((1.2 + rr() * 2.5) * q.k) / s / 2, h = 0.8 + rr() * 2.2;
          // footprint corners in tile units, aligned with the building's first wall
          const cs = [[-w, -d], [w, -d], [w, d], [-w, d]].map(([px, py]) => ({ x: tx + px * ca - py * sa, y: ty + px * sa + py * ca }));
          if (!cs.every((p) => insideAny([poly], p.x, p.y))) continue;
          const grey = 0.55 + rr() * 0.3;
          const bc = lin([grey, grey, grey * 0.97]);
          const P = cs.map((p) => [p.x * s, -p.y * s] as [number, number]);
          const ctrB: V3 = [tx * s, -ty * s, H];
          for (let e = 0; e < 4; e++) {
            const a = P[e], c3 = P[(e + 1) % 4];
            face([[a[0], a[1], H], [c3[0], c3[1], H], [c3[0], c3[1], H + h]], bc, 2, H, r01, ctrB);
            face([[a[0], a[1], H], [c3[0], c3[1], H + h], [a[0], a[1], H + h]], bc, 2, H, r01, ctrB);
          }
          face([[P[0][0], P[0][1], H + h], [P[1][0], P[1][1], H + h], [P[2][0], P[2][1], H + h]], bc, 0, H + h, r01, null);
          face([[P[0][0], P[0][1], H + h], [P[2][0], P[2][1], H + h], [P[3][0], P[3][1], H + h]], bc, 0, H + h, r01, null);
          b++;
        }
      }
    }
    cent.push(rcx * s, -rcy * s);
    footprints.push({ minX: minX / s, minY: -maxY / s, maxX: maxX / s, maxY: -minY / s, polys });
    }
  }

  // ---- water surfaces (rivers, lakes, ponds, sea) ----
  const water: number[] = [];
  const waterPolys: Ring[][] = [];
  const wl = q.lite ? undefined : vt.layers.water;
  if (wl) for (let i = 0; i < wl.length; i++) {
    const f = wl.feature(i);
    if (f.type !== 3 || f.properties.brunnel === 'tunnel' || f.properties.class === 'swimming_pool') continue;
    for (const poly of polygons(clipped(f.loadGeometry() as Ring[], extent))) {
      waterPolys.push(poly);
      const flat: number[] = [], holes: number[] = [];
      poly.forEach((ring, ri) => {
        if (ri > 0) holes.push(flat.length / 2);
        for (let k = 0; k < ring.length - 1; k++) flat.push(ring[k].x * s, -ring[k].y * s);
      });
      const tri = earcut(flat, holes, 2);
      for (let t = 0; t < tri.length; t += 3) {
        let [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
        const cr = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
        if (cr < 0) [b, c] = [c, b];
        for (const v of [a, b, c]) water.push(flat[v * 2], flat[v * 2 + 1]);
      }
    }
  }
  const blockedAt = (x: number, y: number, pad = 0) =>
    footprints.some((b) => x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad && insideAny(b.polys, x, y)) ||
    insideAny(waterPolys, x, y);

  // ---- trees: woods densely, city parks sparsely; never inside a building or in water ----
  const trees: number[] = [];
  const rand = rng(q.seed * 7919 + 17);
  const plant = (polys: Ring[][], perM2: number, conifer: number, size = 1) => {
    for (const poly of polys) {
      const outer = poly[0];
      let a = Math.abs(area(outer));
      for (let i = 1; i < poly.length; i++) a -= Math.abs(area(poly[i]));
      const n = Math.min(4000, Math.floor(a * real * real * perM2 * q.treeDensity));
      if (n <= 0) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of outer) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      let placed = 0;
      for (let tries = 0; placed < n && tries < n * 4 && trees.length < 4 * 5000; tries++) {
        const x = x0 + rand() * (x1 - x0), y = y0 + rand() * (y1 - y0);
        if (x < 0 || y < 0 || x > extent || y > extent) continue;
        if (!insideAny([poly], x, y)) continue;
        if (blockedAt(x, y)) continue;
        const kind = rand() < conifer ? 1 : 0;
        trees.push(x * s, -y * s, ((kind ? 11 : 8) + rand() * (kind ? 12 : 9)) * size, kind);
        placed++;
      }
    }
  };
  // [trees per m², conifer share, size] by landcover class/subclass
  const GREEN: Record<string, [number, number, number]> = {
    'wood/forest': [1 / 70, 0.2, 1], 'wood/wood': [1 / 70, 0.15, 1],
    'grass/park': [1 / 300, 0.08, 1], 'grass/garden': [1 / 420, 0.05, 0.85], 'grass/village_green': [1 / 500, 0.05, 1],
    'grass/scrub': [1 / 90, 0.1, 0.4], 'grass/shrubbery': [1 / 60, 0, 0.3], 'grass/cemetery': [1 / 250, 0.4, 0.9],
  };
  const lc = q.lite ? undefined : vt.layers.landcover;
  if (lc) for (let i = 0; i < lc.length; i++) {
    const f = lc.feature(i);
    const g = GREEN[`${f.properties.class}/${f.properties.subclass ?? ''}`] ?? (f.properties.class === 'wood' ? GREEN['wood/wood'] : undefined);
    if (f.type === 3 && g) plant(polygons(f.loadGeometry() as Ring[]), g[0], g[1], g[2]);
  }
  // avenue trees: some main streets get a row on each side, never inside a building
  // ---- street lamps along lit roads (only drawn at night) ----
  const lamps: number[] = [];
  const LIT: Record<string, [number, number]> = { motorway: [16, 45], trunk: [13, 35], primary: [10, 28], secondary: [9, 28], tertiary: [7, 30], minor: [5, 32], service: [4, 40] };
  const tr = q.lite ? undefined : vt.layers.transportation;
  if (tr) for (let i = 0; i < tr.length && lamps.length < 2 * 3500; i++) {
    const f = tr.feature(i);
    const lit = LIT[f.properties.class as string];
    if (f.type !== 2 || !lit || f.properties.brunnel === 'tunnel') continue;
    const off = (lit[0] * q.k) / s, step = (lit[1] * q.k) / s;
    let side = 1;
    for (const line of f.loadGeometry() as Ring[]) {
      let carry = 0;
      for (let k = 0; k < line.length - 1; k++) {
        const a = line[k], b = line[k + 1];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        let d = carry;
        for (; d < len; d += step) {
          side = -side;
          const x = a.x + (dx * d) / len + (-dy / len) * off * side, y = a.y + (dy * d) / len + (dx / len) * off * side;
          if (x < 0 || y < 0 || x > extent || y > extent || blockedAt(x, y)) continue;
          lamps.push(x * s, -y * s);
        }
        carry = d - len;
      }
    }
  }

  if (tr) for (let i = 0; i < tr.length && trees.length < 4 * 5000; i++) {
    const f = tr.feature(i);
    const cls = f.properties.class;
    if (f.type !== 2 || f.properties.brunnel || !(cls === 'primary' || cls === 'secondary' || cls === 'tertiary')) continue;
    const lineRand = rng((Number(f.id ?? i) * 2654435761) ^ q.seed);
    if (lineRand() > 0.45) continue;
    const off = (cls === 'primary' ? 11 : 8) * q.k / s; // road half-width + sidewalk, in tile units
    const step = 11 * q.k / s;
    for (const line of f.loadGeometry() as Ring[]) {
      let carry = 0;
      for (let k = 0; k < line.length - 1; k++) {
        const a = line[k], b = line[k + 1];
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const nx = -dy / len, ny = dx / len;
        for (let d = carry; d < len; d += step) {
          for (const side of [-1, 1]) {
            const x = a.x + (dx * d) / len + nx * off * side, y = a.y + (dy * d) / len + ny * off * side;
            if (x < 0 || y < 0 || x > extent || y > extent) continue;
            if (blockedAt(x, y, 2)) continue;
            trees.push(x * s, -y * s, 9 + lineRand() * 5, 0);
          }
          carry = d + step - len;
        }
      }
    }
  }

  return {
    id: q.id, ok: true,
    pos: new Float32Array(pos), nrm: new Float32Array(nrm), col: new Float32Array(col), fac: new Float32Array(fac),
    seed: new Float32Array(sd), bidx: new Uint32Array(bidx), cent: new Float32Array(cent), trees: new Float32Array(trees),
    water: new Float32Array(water), lamps: new Float32Array(lamps),
  };
}

self.onmessage = async (e: MessageEvent<CityReq>) => {
  const r = await build(e.data);
  (self as unknown as Worker).postMessage(r, [r.pos.buffer, r.nrm.buffer, r.col.buffer, r.fac.buffer, r.seed.buffer, r.bidx.buffer, r.cent.buffer, r.trees.buffer, r.water.buffer, r.lamps.buffer]);
};
