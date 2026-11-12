import './style.css';
import { PRESETS, RANDOM_POOL, GRADS, type Place } from './config';
import { STYLE_IDS, type StyleId } from './mapstyle';
import { Drone, FLIGHT_MODES, type FlightMode } from './drone';
import { Input } from './input';
import { Hud } from './hud';
import { DroneAudio } from './audio';
import { search, reverse, type GeoResult } from './geocode';
import { MapLibreEngine } from './engine/maplibre';
import type { Engine } from './engine/types';
import { Discoveries, summary, type Poi } from './discover';
import { Calibrator, STEP_TEXT, AXIS_NAMES, clearMap, saveMap, type GamepadMap } from './gamepad';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export type ViewId = StyleId | 'photoreal';
const VIEW_IDS: ViewId[] = [...STYLE_IDS, 'photoreal'];

// ---------- settings (persisted) ----------
interface Settings { v: number; flightMode: FlightMode; style: ViewId; sound: boolean; volume: number; quality: 'high' | 'low'; googleKey: string; keyRates: number; }
const SETTINGS_VERSION = 2;
const DEFAULTS: Settings = { v: SETTINGS_VERSION, flightMode: 'angle', style: 'satellite', sound: false, volume: 0.6, quality: 'high', googleKey: '', keyRates: 1 };
const settings: Settings = (() => {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(localStorage.getItem('drone.settings') || '{}'); } catch { /* ignore */ }
  // v2: everyone starts again on the sunny satellite view
  if ((saved.v ?? 0) < SETTINGS_VERSION) { delete saved.style; saved.v = SETTINGS_VERSION; }
  return { ...DEFAULTS, ...saved };
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
let lastSource: 'keyboard' | 'gamepad' | 'touch' | 'none' = 'keyboard';
let lastSrcUpdate = 0;
let lastImpacts = 0;
const probe = (lng: number, lat: number) => engine.surface(lng, lat);
const discoveries = new Discoveries();
let lastDiscoverTick = 0;

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

  const c = input.poll(dt, now);
  lastSource = c.source !== 'none' ? c.source : lastSource;
  if (now - lastSrcUpdate > 300) { lastSrcUpdate = now; hud.setSource(input.padId && now - input.padLastActive < 3000 ? 'gamepad' : lastSource); }
  drone.step(dt, c, switching ? null : probe, now);
  if (drone.s.impacts !== lastImpacts) {
    lastImpacts = drone.s.impacts;
    hud.impact(drone.s.impact);
    if (settings.sound) audio.thump(drone.s.impact);
  }
  engine.setCamera(drone.s);
  hud.update(drone.s, dt, now);
  if (settings.sound) audio.update(drone.s, Math.min(1, Math.hypot(drone.s.vE, drone.s.vN, drone.s.vU) / 45));

  const moved = Math.hypot((drone.s.lng - lastReverse.lng) * 111_000 * Math.cos(drone.s.lat * Math.PI / 180), (drone.s.lat - lastReverse.lat) * 111_000);
  if (now - lastReverse.t > 9000 && moved > 600) {
    lastReverse = { t: now, lng: drone.s.lng, lat: drone.s.lat };
    reverse(drone.s.lng, drone.s.lat).then((n) => { if (n) hud.setLocation(n); });
  }
  if (now - lastHashWrite > 1500) { lastHashWrite = now; writeHash(); }
  if (now - lastDiscoverTick > 250) {
    lastDiscoverTick = now;
    discoveries.update(drone.s.lat, drone.s.lng, drone.s.alt - drone.s.floor);
    for (const p of discoveries.pois) {
      if (p.ground !== null) continue;
      const sf = engine.surface(p.lng, p.lat);
      if (sf) p.ground = sf.ground;
    }
    const target = discoveries.nearest(drone.s.lat, drone.s.lng);
    hud.world = { pois: discoveries.pois, isFound: (id) => discoveries.isFound(id), target, vfov: engine.vfov };
    $('hud-found').textContent = String(discoveries.passport.length);
  }
}
requestAnimationFrame(frame);

// ---------- hash (shareable links) ----------
function writeHash() {
  const s = drone.s;
  const h = `#${s.lng.toFixed(5)},${s.lat.toFixed(5)},${Math.round(s.alt - s.floor)},${Math.round(s.heading)},${Math.round(s.camTilt)},${settings.style}`;
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

let lastPlace: Place | null = null;
async function flyTo(p: Place, instant = false) {
  launched = true;
  lastPlace = p;
  if (!instant) { fade.classList.add('on'); await wait(420); }
  drone.teleport(p.lng, p.lat, p.heading, p.agl, p.pitch ?? 84);
  discoveries.reset();
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
  // Start a little way out, facing the place, so you see it ahead and fly in to discover it.
  flyTo({ ...approach(r.lng, r.lat, isCity ? 1500 : 650, 200), name: r.name, sub: r.detail, agl: isCity ? 320 : 160, grad: '' });
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
$('key-origin').textContent = `${location.origin}/*`;
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

// ---------- flight mode ----------
const MODE_HINT: Record<FlightMode, string> = {
  angle: 'Sticks tilt the quad and it levels itself. Real momentum and gravity; centred throttle holds height.',
  acro: 'Sticks set rotation rates and the quad keeps its attitude. Bank and pull to turn. Centred throttle = hover thrust.',
  cine: 'Smooth, assisted flying for sightseeing.',
};
function setFlightMode(m: FlightMode, toast = true) {
  settings.flightMode = m; saveSettings();
  drone.setMode(m);
  $('mode-seg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('mode-hint').textContent = MODE_HINT[m];
  if (toast) hud.toast(`${m.toUpperCase()} MODE`);
}
$('mode-seg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setFlightMode(b.dataset.mode as FlightMode)));
setFlightMode(settings.flightMode, false);

// ---------- discoveries ----------
const card = $('discovery');
let cardTimer = 0;
discoveries.onDiscover = async (p: Poi, total: number) => {
  ($('disc-img') as HTMLImageElement).src = p.thumb ?? '';
  $('disc-img').classList.toggle('hidden', !p.thumb);
  $('disc-count').textContent = `DISCOVERY #${total}`;
  $('disc-title').textContent = p.title;
  $('disc-desc').textContent = p.description;
  $('disc-text').textContent = '';
  ($('disc-link') as HTMLAnchorElement).href = `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`;
  card.classList.add('show');
  if (settings.sound) audio.chime();
  clearTimeout(cardTimer);
  cardTimer = window.setTimeout(() => card.classList.remove('show'), 9000);
  renderPassport();
  const text = await summary(p.title);
  if ($('disc-title').textContent === p.title) $('disc-text').textContent = text;
};
$('disc-close').addEventListener('click', () => card.classList.remove('show'));

function renderPassport() {
  const list = discoveries.passport;
  $('passport-count').textContent = list.length ? `${list.length} place${list.length > 1 ? 's' : ''} discovered` : 'Fly near a golden beacon to discover a place';
  $('passport').innerHTML = list.slice(0, 24).map((d) => `
    <button class="stamp" data-lng="${d.lng}" data-lat="${d.lat}" data-title="${esc(d.title)}" title="Fly back to ${esc(d.title)}">
      ${d.thumb ? `<img src="${esc(d.thumb)}" alt="" loading="lazy" />` : '<i></i>'}
      <span>${esc(d.title)}</span>
    </button>`).join('');
}
$('passport').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.stamp');
  if (!b) return;
  flyTo({ ...approach(+b.dataset.lng!, +b.dataset.lat!, 500, 200), name: b.dataset.title!, sub: '', agl: 140, grad: '' });
});
renderPassport();

// ---------- controller (gamepad / DJI RC) ----------
input.keyRates = settings.keyRates;
const ratesEl = $('key-rates') as HTMLInputElement;
ratesEl.value = String(Math.round(settings.keyRates * 100));
$('key-rates-v').textContent = `${ratesEl.value}%`;
ratesEl.addEventListener('input', () => { settings.keyRates = +ratesEl.value / 100; input.keyRates = settings.keyRates; $('key-rates-v').textContent = `${ratesEl.value}%`; saveSettings(); });

const padStatus = $('pad-status');
const padMeters = Array.from($('pad-meters').querySelectorAll<HTMLElement>('i[data-axis]'));
const dzEl = $('pad-deadzone') as HTMLInputElement;
const expoEl = $('pad-expo') as HTMLInputElement;
let calib: Calibrator | null = null;
let padUiId: string | null = null;

function setMeter(el: HTMLElement, v: number) {
  const pct = Math.max(-1, Math.min(1, v)) * 50;
  el.style.left = `${50 + Math.min(0, pct)}%`;
  el.style.width = `${Math.abs(pct)}%`;
}
function currentMap(): GamepadMap | null { return input.padId ? input.mapFor(input.padId) : null; }
function syncPadUi() {
  const id = input.padId;
  const m = currentMap();
  ($('pad-calibrate') as HTMLButtonElement).disabled = !id;
  ($('pad-reset') as HTMLButtonElement).disabled = !id;
  if (id !== padUiId) {
    padUiId = id;
    if (id && m) {
      const learned = Object.keys(m.axes).length === 4 && localStorage.getItem('drone.gamepads')?.includes(id);
      padStatus.textContent = `${id.replace(/\s*\(.*$/, '').slice(0, 48)} · ${learned ? 'calibrated' : 'default mapping, calibrate if sticks feel wrong'}`;
      padStatus.classList.add('ok');
      dzEl.value = String(Math.round(m.deadzone * 100));
      expoEl.value = String(Math.round(m.expo * 100));
      $('pad-deadzone-v').textContent = `${dzEl.value}%`;
      $('pad-expo-v').textContent = `${expoEl.value}%`;
    } else {
      padStatus.textContent = 'No controller detected · plug it in over USB and press any button';
      padStatus.classList.remove('ok');
    }
  }
}
function padUiTick() {
  // Poll while the menu is open so meters move even when not flying.
  if (!menu.classList.contains('hidden') && !calib) {
    input.poll(1 / 30, performance.now());
    syncPadUi();
    for (const el of padMeters) setMeter(el, input.padLive[el.dataset.axis as keyof typeof input.padLive]);
  }
  requestAnimationFrame(padUiTick);
}
requestAnimationFrame(padUiTick);
window.addEventListener('gamepadconnected', () => { padUiId = null; syncPadUi(); hud.toast('CONTROLLER CONNECTED'); });
window.addEventListener('gamepaddisconnected', () => { padUiId = null; syncPadUi(); });

const tune = (el: HTMLInputElement, key: 'deadzone' | 'expo', out: string) => el.addEventListener('input', () => {
  const m = currentMap(); if (!m) return;
  m[key] = +el.value / 100; $(out).textContent = `${el.value}%`;
  input.setMap(m); saveMap(m);
});
tune(dzEl, 'deadzone', 'pad-deadzone-v');
tune(expoEl, 'expo', 'pad-expo-v');

$('pad-reset').addEventListener('click', () => { if (!input.padId) return; clearMap(input.padId); input.invalidateMap(input.padId); padUiId = null; syncPadUi(); hud.toast('MAPPING RESET'); });

const calibEl = $('calib');
const calibAxes = $('calib-axes');
function renderCalib(pad: Gamepad) {
  if (!calib) return;
  const steps = ['rest', 'throttle', 'yaw', 'pitch', 'roll', 'turbo'];
  const idx = steps.indexOf(calib.step);
  $('calib-step').textContent = calib.step === 'done' ? 'COMPLETE' : `STEP ${idx + 1} / ${steps.length}`;
  $('calib-title').textContent = STEP_TEXT[calib.step].title;
  $('calib-hint').textContent = STEP_TEXT[calib.step].hint;
  $('calib-done').classList.toggle('hidden', calib.step !== 'done');
  $('calib-skip').classList.toggle('hidden', calib.step === 'done' || calib.step === 'rest');
  if (calibAxes.children.length !== pad.axes.length) {
    calibAxes.innerHTML = pad.axes.map((_, i) => `<div>AX${i}<div class="meter"><i></i></div></div>`).join('');
  }
  pad.axes.forEach((v, i) => setMeter(calibAxes.children[i].querySelector('i')!, v));
}
function startCalibration() {
  const pad = input.pad();
  if (!pad) return;
  calib = new Calibrator(pad, null);
  calibEl.classList.remove('hidden');
  input.padPassthrough = (p) => { calib!.update(p, performance.now()); renderCalib(p); };
  const tick = () => { if (!calib) return; input.poll(1 / 60, performance.now()); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function endCalibration(save: boolean) {
  if (calib && save && calib.step === 'done') {
    const m = calib.map;
    for (const n of AXIS_NAMES) if (!m.axes[n]) hud.toast(`AXIS ${n.toUpperCase()} NOT MAPPED`, 2500);
    saveMap(m); input.setMap(m);
    hud.toast('CONTROLLER CALIBRATED');
  }
  calib = null;
  input.padPassthrough = null;
  calibEl.classList.add('hidden');
  padUiId = null; syncPadUi();
}
$('pad-calibrate').addEventListener('click', startCalibration);
$('calib-skip').addEventListener('click', () => calib?.skip());
$('calib-cancel').addEventListener('click', () => endCalibration(false));
$('calib-done').addEventListener('click', () => endCalibration(true));

// ---------- keys ----------
input.onKey = (code, ev) => {
  if (code === 'Escape') { if (calib) { endCalibration(false); return; } if (menu.classList.contains('hidden')) openMenu(); else resume(); return; }
  if (!flying) return;
  switch (code) {
    case 'KeyM': setView(VIEW_IDS[(VIEW_IDS.indexOf(settings.style) + 1) % (googleKey() ? VIEW_IDS.length : STYLE_IDS.length)]); break;
    case 'KeyH': hud.toggle(); break;
    case 'KeyV': setFlightMode(FLIGHT_MODES[(FLIGHT_MODES.indexOf(settings.flightMode) + 1) % FLIGHT_MODES.length]); break;
    case 'KeyR': drone.levelCamera(); hud.toast('CAMERA RESET'); break;
    case 'Backspace': if (lastPlace) { ev.preventDefault(); flyTo(lastPlace); } break;
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
/** Launch point `dist` meters from a target, coming from compass `fromBearing`, heading toward it. */
function approach(lng: number, lat: number, dist: number, fromBearing: number) {
  const b = (fromBearing * Math.PI) / 180;
  const dLat = (Math.cos(b) * dist) / 111_132;
  const dLng = (Math.sin(b) * dist) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lng: lng + dLng, lat: lat + dLat, heading: (fromBearing + 180) % 360 };
}
function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function esc(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!); }

document.addEventListener('visibilitychange', () => { if (document.hidden) { input.clear(); last = performance.now(); } });
window.addEventListener('resize', () => { hud.resize(); engine.resize(); });

if (import.meta.env.DEV) (window as any).__dbg = { get map() { return maplibre.map; }, get engine() { return engine; }, drone, settings };
