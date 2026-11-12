/** Nearby notable places from Wikipedia, shown as beacons; fly close to "discover" them. */
export interface Poi {
  id: number;
  title: string;
  description: string;
  lat: number;
  lng: number;
  thumb: string | null;
  /** cached ground elevation at the place, MSL */
  ground: number | null;
}
export interface Discovered { id: number; title: string; description: string; thumb: string | null; lat: number; lng: number; at: number; }

const API = 'https://en.wikipedia.org/w/api.php';
const KEY = 'drone.passport';
const FETCH_RADIUS = 10_000;
/** horizontal distance that counts as "visited", meters */
export const DISCOVER_RADIUS = 140;

const mPerDegLat = 111_132;
export const distM = (lat1: number, lng1: number, lat2: number, lng2: number) =>
  Math.hypot((lng2 - lng1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), (lat2 - lat1) * mPerDegLat);

export class Discoveries {
  pois: Poi[] = [];
  passport: Discovered[] = [];
  private lastFetch: { lat: number; lng: number } | null = null;
  private fetching = false;
  private known = new Map<number, Poi>();
  onDiscover: ((p: Poi, total: number) => void) | null = null;

  constructor() {
    try { this.passport = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { this.passport = []; }
  }

  isFound(id: number) { return this.passport.some((d) => d.id === id); }

  /** Call often; fetches when the drone moved far from the last query point. */
  update(lat: number, lng: number, agl = 0) {
    if (!this.fetching && (!this.lastFetch || distM(lat, lng, this.lastFetch.lat, this.lastFetch.lng) > 3000)) this.fetch(lat, lng);
    if (agl > 500) return;
    for (const p of this.pois) {
      if (this.isFound(p.id)) continue;
      if (distM(lat, lng, p.lat, p.lng) < DISCOVER_RADIUS) this.discover(p);
    }
  }

  /** Forget the current area (after a teleport). */
  reset() { this.lastFetch = null; this.pois = []; this.known.clear(); }

  private async fetch(lat: number, lng: number) {
    this.fetching = true;
    this.lastFetch = { lat, lng };
    try {
      const q = new URLSearchParams({
        action: 'query', generator: 'geosearch', ggscoord: `${lat.toFixed(5)}|${lng.toFixed(5)}`,
        ggsradius: String(FETCH_RADIUS), ggslimit: '80', prop: 'pageimages|description|coordinates',
        piprop: 'thumbnail', pithumbsize: '400', format: 'json', origin: '*',
      });
      const r = await fetch(`${API}?${q}`);
      const j = await r.json();
      const pages: any[] = Object.values(j?.query?.pages ?? {});
      for (const pg of pages) {
        const c = pg.coordinates?.[0];
        if (!c || this.known.has(pg.pageid)) continue;
        // Places with a picture are the fun ones; skip the rest to keep the sky readable.
        if (!pg.thumbnail?.source) continue;
        this.known.set(pg.pageid, { id: pg.pageid, title: pg.title, description: pg.description ?? '', lat: c.lat, lng: c.lon, thumb: pg.thumbnail.source, ground: null });
      }
      // keep the closest ~60 around the current position
      this.pois = [...this.known.values()]
        .sort((a, b) => distM(lat, lng, a.lat, a.lng) - distM(lat, lng, b.lat, b.lng))
        .slice(0, 60);
    } catch { /* offline or rate limited: try again after moving */ }
    finally { this.fetching = false; }
  }

  private discover(p: Poi) {
    this.passport.unshift({ id: p.id, title: p.title, description: p.description, thumb: p.thumb, lat: p.lat, lng: p.lng, at: Date.now() });
    try { localStorage.setItem(KEY, JSON.stringify(this.passport.slice(0, 500))); } catch { /* ignore */ }
    this.onDiscover?.(p, this.passport.length);
  }

  /** Nearest place not yet discovered. */
  nearest(lat: number, lng: number): { poi: Poi; dist: number } | null {
    let best: Poi | null = null, bd = Infinity;
    for (const p of this.pois) {
      if (this.isFound(p.id)) continue;
      const d = distM(lat, lng, p.lat, p.lng);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { poi: best, dist: bd } : null;
  }
}

/** Short intro text for the discovery card. */
export async function summary(title: string): Promise<string> {
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
    if (!r.ok) return '';
    const j = await r.json();
    return (j.extract as string) ?? '';
  } catch { return ''; }
}
