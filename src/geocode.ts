export interface GeoResult { name: string; detail: string; lng: number; lat: number; kind: string; }

const BASE = 'https://photon.komoot.io';
let reverseCtl: AbortController | null = null;

export async function search(q: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const url = `${BASE}/api/?q=${encodeURIComponent(q)}&limit=7&lang=en`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`geocoder ${r.status}`);
  const j = await r.json();
  const out: GeoResult[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (typeof lng !== 'number') continue;
    const name = p.name || p.street || p.city || p.country || q;
    const parts = [p.city && p.city !== name ? p.city : null, p.state && p.state !== name ? p.state : null, p.country].filter(Boolean);
    // Photon often returns the same place twice (node + way); keep the first.
    if (out.some((o) => o.name === name && Math.abs(o.lng - lng) < 0.003 && Math.abs(o.lat - lat) < 0.003)) continue;
    out.push({ name, detail: parts.join(', '), lng, lat, kind: p.osm_value || p.type || '' });
  }
  return out;
}

/** Best-effort human readable place for the HUD. Never throws. */
export async function reverse(lng: number, lat: number): Promise<string | null> {
  reverseCtl?.abort();
  reverseCtl = new AbortController();
  try {
    const r = await fetch(`${BASE}/reverse?lon=${lng.toFixed(5)}&lat=${lat.toFixed(5)}&lang=en`, { signal: reverseCtl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const p = j.features?.[0]?.properties;
    if (!p) return null;
    const a = p.district || p.locality || p.city || p.county || p.state;
    const b = p.city && p.city !== a ? p.city : p.country;
    return [a, b].filter(Boolean).join(' · ') || null;
  } catch {
    return null;
  }
}
