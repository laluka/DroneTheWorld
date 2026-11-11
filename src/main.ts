import './style.css';
import { PRESETS, RANDOM_POOL, GRADS, type Place } from './config';
import { STYLE_IDS, type StyleId } from './mapstyle';
import { Drone } from './drone';
import { Input } from './input';
import { Hud } from './hud';
import { DroneAudio } from './audio';
import { search, reverse, type GeoResult } from './geocode';
import { MapLibreEngine } from './engine/maplibre';
import type { Engine } from './engine/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type ViewId = StyleId | 'photoreal';
const VIEW_IDS: ViewId[] = [...STYLE_IDS, 'photoreal'];

// ---------- settings (persisted) ----------
interface Settings { style: ViewId; sound: boolean; volume: number; quality: 'high' | 'low'; googleKey: string; }
const DEFAULTS: Settings = { style: 'satellite', sound: false, volume: 0.4, quality: 'high', googleKey: '' };
const settings: Settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('drone.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => { try { localStorage.setItem('drone.settings', JSON.stringify(settings)); } catch { /* ignore */ } };
/** Key baked at build time (GitHub Actions secret) or pasted in the menu. */
const googleKey = () => (settings.googleKey || (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || '').trim();

// ---------- state ----------
const drone = new Drone();
const hud = new Hud();
const audio = new DroneAudio();
const input = new Input($('surface'));
let flying = false;
let launched = false;
let currentPlaceName = '';
let lastReverse = { t: 0, lng: 0, lat: 0 };
let lastHashWrite = 0;
let switching = false;
let keyRowOpen = false;

// ---------- engines ----------
const maplibre = new MapLibreEngine($('map'), settings.quality, [drone.s.lng, drone.s.lat]);
let cesium: Engine | null = null;
let engine: Engine = maplibre;

async function loadCesium(): Promise<Engine> {
  if (cesium) return cesium;
  hud.toast('LOADING PHOTOREAL ENGINE…', 4000);
  (window as any).CESIUM_BASE_URL = './cesium/';
  const { CesiumEngine } = await import('./engine/cesium');
  const c = await CesiumEngine.create($('cesium'), googleKey(), settings.quality);
  cesium = c;
  return c;
}

/** Switch the active view (map style or photoreal engine). */
async function applyView(id: ViewId): Promise<boolean> {
  if (switching) return false;
  switching = true;
  try {
    if (id === 'photoreal') {
      if (!googleKey()) {
        keyRowOpen = true;
        openMenu();
        syncSeg();
        ($('gkey') as HTMLInputElement).focus();
        return false;
      }
      try {
        const c = await loadCesium();
        if (engine !== c) { engine.hide(); engine = c; c.show(); }
        drone.setCamLimits(c.maxCamTilt);
        drone.holdAGL();
        return true;
      } catch (e) {
        console.error(e);
        hud.toast('PHOTOREAL FAILED · CHECK KEY', 3500);
        $('key-error').textContent = 'Could not load Google 3D Tiles. Check that the key is valid, has the Map Tiles API enabled, and allows this site as referrer.';
        return false;
      }
    }
    await maplibre.setStyle(id, settings.quality);
    if (engine !== maplibre) { engine.hide(); engine = maplibre; maplibre.show(); }
    drone.setCamLimits(maplibre.maxCamTilt);
    drone.holdAGL();
    return true;
  } finally {
    switching = false;
  }
}

let mapReady = false;
maplibre.whenLoaded().then(async () => {
  const ok = await applyView(settings.style);
  if (!ok) { settings.style = 'satellite'; syncSeg(); await applyView('satellite'); }
  mapReady = true;
  if (!launched) autoLaunchFromHash();
});

// tile loading indicator
const loading = $('loading');
let loadingShown = false;
setInterval(() => {
  if (!flying) { if (loadingShown) { loading.classList.remove('on'); loadingShown = false; } return; }
  const show = !engine.tilesLoaded();
  if (show !== loadingShown) { loading.classList.toggle('on', show); loadingShown = show; }
}, 400);

// ---------- main loop ----------
let last = performance.now();
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!flying || !mapReady) return;

  const c = input.poll();
  const ground = switching ? null : engine.groundElevation(drone.s.lng, drone.s.lat);
  drone.step(dt, c, ground, now);
  engine.setCamera(drone.s);
  hud.update(drone.s, dt, now);
  if (settings.sound) audio.update(drone.s.motor, Math.min(1, Math.hypot(drone.s.vE, drone.s.vN) / 45), drone.s.boost);

  const moved = Math.hypot((drone.s.lng - lastReverse.lng) * 111_000 * Math.cos(drone.s.lat * Math.PI / 180), (drone.s.lat - lastReverse.lat) * 111_000);
  if (now - lastReverse.t > 9000 && moved > 600) {
    lastReverse = { t: now, lng: drone.s.lng, lat: drone.s.lat };
    reverse(drone.s.lng, drone.s.lat).then((n) => { if (n) hud.setLocation(n); });
  }
  if (now - lastHashWrite > 1500) { lastHashWrite = now; writeHash(); }
}
requestAnimationFrame(frame);

// ---------- hash (shareable links) ----------
function writeHash() {
  const s = drone.s;
  const h = `#${s.lng.toFixed(5)},${s.lat.toFixed(5)},${Math.round(s.alt - s.ground)},${Math.round(s.heading)},${Math.round(s.camTilt)},${settings.style}`;
  if (location.hash !== h) history.replaceState(null, '', h);
}
function readHash(): { lng: number; lat: number; agl: number; heading: number; pitch: number; style?: ViewId } | null {
  const m = location.hash.slice(1).split(',');
  if (m.length < 3) return null;
  const [lng, lat, agl, heading = '0', pitch = '84', style] = m;
  const o = { lng: +lng, lat: +lat, agl: +agl, heading: +heading, pitch: +pitch, style: VIEW_IDS.includes(style as ViewId) ? (style as ViewId) : undefined };
  return Number.isFinite(o.lng) && Number.isFinite(o.lat) && Number.isFinite(o.agl) ? o : null;
}
function autoLaunchFromHash() {
  const h = readHash();
  if (!h) return;
  if (h.style && h.style !== settings.style) setView(h.style);
  flyTo({ name: 'Shared location', sub: '', lng: h.lng, lat: h.lat, heading: h.heading, agl: Math.max(5, h.agl), pitch: h.pitch, grad: '' }, true);
}

// ---------- flying ----------
const fade = $('fade');
const menu = $('menu');
const resumeBtn = $('resume');

async function flyTo(p: Place, instant = false) {
  launched = true;
  if (!instant) { fade.classList.add('on'); await wait(420); }
  drone.teleport(p.lng, p.lat, p.heading, p.agl, p.pitch ?? 84);
  currentPlaceName = p.sub ? `${p.name} · ${p.sub}` : p.name;
  hud.setLocation(currentPlaceName);
  lastReverse = { t: performance.now(), lng: p.lng, lat: p.lat };
  engine.setCamera(drone.s);
  closeMenu();
  flying = true;
  writeHash();
  if (settings.sound) audio.start();
  await wait(instant ? 100 : 350);
  fade.classList.remove('on');
  hud.toast(p.name.toUpperCase(), 2200);
  reverse(p.lng, p.lat).then((n) => { if (n && !p.sub) hud.setLocation(n); });
}

function openMenu() {
  flying = false;
  input.clear();
  audio.suspend();
  menu.classList.remove('closing', 'hidden');
  resumeBtn.classList.toggle('hidden', !launched);
  $('hud').classList.add('hidden');
  $('sticks').classList.add('hidden');
}
function closeMenu() {
  menu.classList.add('closing');
  setTimeout(() => menu.classList.add('hidden'), 380);
  hud.toggle(true);
  if (input.isTouch) $('sticks').classList.remove('hidden');
  audio.resume();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
function resume() { if (!launched) return; closeMenu(); flying = true; last = performance.now(); }

// ---------- menu UI ----------
const presetsEl = $('presets');
PRESETS.forEach((p) => {
  const b = document.createElement('button');
  b.className = 'preset';
  b.style.setProperty('--grad', p.grad);
  b.innerHTML = `<b>${p.name}</b><small>${p.sub}</small><i>${p.lat.toFixed(2)}, ${p.lng.toFixed(2)}</i>`;
  b.addEventListener('click', () => flyTo(p));
  presetsEl.appendChild(b);
});

$('random').addEventListener('click', () => {
  const [name, lng, lat] = RANDOM_POOL[Math.floor(Math.random() * RANDOM_POOL.length)];
  flyTo({ name, sub: '', lng, lat, heading: Math.random() * 360, agl: 260, grad: GRADS[0] });
});
resumeBtn.addEventListener('click', resume);

// search
const searchEl = $('search') as HTMLInputElement;
const resultsEl = $('results') as HTMLUListElement;
let results: GeoResult[] = [];
let sel = -1;
let searchCtl: AbortController | null = null;
let searchTimer = 0;

function renderResults() {
  resultsEl.innerHTML = '';
  if (!results.length) { resultsEl.classList.add('hidden'); return; }
  results.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = i === sel ? 'sel' : '';
    li.innerHTML = `<span>${esc(r.name)}</span><small>${esc(r.detail)}</small>`;
    li.addEventListener('click', () => pick(r));
    resultsEl.appendChild(li);
  });
  resultsEl.classList.remove('hidden');
}
function pick(r: GeoResult) {
  results = []; renderResults(); searchEl.value = r.name;
  const isCity = /city|town|village|suburb|administrative|country|state/.test(r.kind);
  flyTo({ name: r.name, sub: r.detail, lng: r.lng, lat: r.lat, heading: 0, agl: isCity ? 320 : 180, grad: '' });
}
async function runSearch(q: string) {
  searchCtl?.abort();
  if (q.trim().length < 2) { results = []; renderResults(); return; }
  searchCtl = new AbortController();
  try {
    results = await search(q, searchCtl.signal);
    sel = results.length ? 0 : -1;
    renderResults();
    if (!results.length) { resultsEl.innerHTML = '<li class="empty">No results</li>'; resultsEl.classList.remove('hidden'); }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') { resultsEl.innerHTML = '<li class="empty">Geocoder unavailable</li>'; resultsEl.classList.remove('hidden'); }
  }
}
searchEl.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(() => runSearch(searchEl.value), 280); });
searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderResults(); e.preventDefault(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (results[sel]) pick(results[sel]); else runSearch(searchEl.value).then(() => results[0] && pick(results[0])); }
  else if (e.key === 'Escape') { results = []; renderResults(); searchEl.blur(); }
  e.stopPropagation();
});
$('search-go').addEventListener('click', () => { if (results[sel]) pick(results[sel]); else runSearch(searchEl.value).then(() => results[0] && pick(results[0])); });
document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.search-wrap')) { results = []; renderResults(); } });

// segmented controls
function seg(id: string, attr: string, cb: (v: string) => void) {
  const el = $(id);
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => cb(b.dataset[attr]!)));
}
function syncSeg() {
  $('style-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.style === settings.style));
  $('sound-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b.dataset.sound === 'on') === settings.sound));
  $('quality-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.q === settings.quality));
  $('key-row').classList.toggle('hidden', !(keyRowOpen || settings.style === 'photoreal'));
  $('key-badge').textContent = googleKey() ? (settings.googleKey ? 'key saved locally' : 'key provided by build') : 'key required';
}
seg('style-seg', 'style', (v) => setView(v as ViewId));
seg('sound-seg', 'sound', (v) => setSound(v === 'on'));
seg('quality-seg', 'q', (v) => { settings.quality = v as 'high' | 'low'; saveSettings(); syncSeg(); if (mapReady && engine === maplibre) applyView(settings.style); hud.toast('RELOAD FOR FULL EFFECT', 2500); });

const volEl = $('volume') as HTMLInputElement;
volEl.value = String(Math.round(settings.volume * 100));
volEl.addEventListener('input', () => { settings.volume = +volEl.value / 100; saveSettings(); audio.setVolume(settings.volume); if (settings.sound) audio.start(); });
function setSound(on: boolean) {
  settings.sound = on; saveSettings(); syncSeg();
  audio.setMuted(!on);
  if (on) audio.start();
  $('volume-wrap').classList.toggle('disabled', !on);
}
audio.setMuted(!settings.sound);
audio.setVolume(settings.volume);
$('volume-wrap').classList.toggle('disabled', !settings.sound);

// Google key input
const keyEl = $('gkey') as HTMLInputElement;
keyEl.value = settings.googleKey;
$('key-save').addEventListener('click', async () => {
  settings.googleKey = keyEl.value.trim(); saveSettings();
  $('key-error').textContent = '';
  if (cesium) { // a different key means a fresh engine
    cesium = null;
    $('cesium').innerHTML = '';
  }
  if (settings.googleKey) setView('photoreal');
  else syncSeg();
});
$('key-toggle').addEventListener('click', () => { keyRowOpen = !keyRowOpen || settings.style === 'photoreal'; syncSeg(); });

function setView(v: ViewId) {
  const prev = settings.style;
  settings.style = v; saveSettings(); syncSeg();
  if (!mapReady) return;
  applyView(v).then((ok) => {
    if (ok) { keyRowOpen = false; syncSeg(); writeHash(); hud.toast((v as string) === 'photoreal' ? 'PHOTOREAL 3D' : v.toUpperCase()); }
    else { settings.style = prev === 'photoreal' ? 'satellite' : prev; saveSettings(); syncSeg(); }
  });
}
syncSeg();

// ---------- keys ----------
input.onKey = (code, ev) => {
  if (code === 'Escape') { if (menu.classList.contains('hidden')) openMenu(); else resume(); return; }
  if (!flying) return;
  switch (code) {
    case 'KeyM': setView(VIEW_IDS[(VIEW_IDS.indexOf(settings.style) + 1) % (googleKey() ? VIEW_IDS.length : STYLE_IDS.length)]); break;
    case 'KeyH': hud.toggle(); break;
    case 'KeyR': drone.levelCamera(); hud.toast('CAMERA RESET'); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyP': screenshot(); break;
    case 'KeyN': { setSound(!settings.sound); hud.toast(settings.sound ? 'SOUND ON' : 'SOUND OFF'); break; }
    case 'Slash': case 'Tab': if (!ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); openMenu(); document.querySelector('details.controls')?.setAttribute('open', ''); } break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8': case 'Digit9': {
      const p = PRESETS[+code.slice(5) - 1]; if (p) flyTo(p); break;
    }
  }
};
// Start audio on first gesture if a hash-launch skipped the menu.
window.addEventListener('pointerdown', () => { if (launched && settings.sound) audio.start(); }, { once: true });
window.addEventListener('keydown', () => { if (launched && settings.sound) audio.start(); }, { once: true });

// touch buttons
$('btn-menu').addEventListener('click', () => openMenu());
const boostBtn = $('btn-boost');
boostBtn.addEventListener('click', () => { input.touchBoost = !input.touchBoost; boostBtn.classList.toggle('active', input.touchBoost); });
if (input.isTouch) {
  input.attachSticks($('stick-l'), $('stick-r'));
  $('hud-hint').textContent = 'LEFT STICK throttle / yaw · RIGHT STICK pitch / roll · DRAG to look';
}

// ---------- misc ----------
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}
function screenshot() {
  const mc = engine.snapshot();
  if (!mc) return;
  const out = document.createElement('canvas');
  out.width = mc.width; out.height = mc.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(mc, 0, 0);
  const osd = $('osd') as HTMLCanvasElement;
  if (hud.visible) ctx.drawImage(osd, 0, 0, osd.width, osd.height, 0, 0, out.width, out.height);
  out.toBlob((b) => {
    if (!b) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `drone-${currentPlaceName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'shot'}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
  hud.toast('SNAPSHOT SAVED');
}
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!); }

document.addEventListener('visibilitychange', () => { if (document.hidden) { input.clear(); last = performance.now(); } });
window.addEventListener('resize', () => { hud.resize(); engine.resize(); });

if (import.meta.env.DEV) (window as any).__dbg = { get map() { return maplibre.map; }, get engine() { return engine; }, drone, settings };
