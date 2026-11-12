import { Map as MLMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Engine, Surface } from './types';
import { BuildingField } from '../buildings';
import type { DroneState } from '../drone';
import { buildStyle, skyColors, type StyleId } from '../mapstyle';

setWorkerUrl(workerUrl);

/** Screen offset (px) that emulates tilting the camera up by `deg` beyond the renderer's pitch limit. */
export const lensShiftPx = (deg: number, height: number, vfov: number) =>
  deg > 0 ? (height / 2 / Math.tan((vfov * Math.PI) / 360)) * Math.tan((deg * Math.PI) / 180) : 0;

/** Free, keyless engine: OpenFreeMap vectors + Esri imagery + AWS terrain, buildings extruded from OSM heights. */
export class MapLibreEngine implements Engine {
  readonly id = 'maplibre' as const;
  /** Above ~80° the map's centre runs off to the horizon and tiny pitch changes reload tiles; higher looks use a lens shift. */
  readonly maxCamTilt = 79;
  get vfov() { return this.quality === 'low' ? 62 : 75; }
  readonly map: MLMap;
  private styleLoading = false;
  private quality: 'high' | 'low';
  private _ready = false;
  private sky = skyColors('satellite');
  private lastSkyCss = '';
  readonly buildings = new BuildingField();

  constructor(private container: HTMLElement, quality: 'high' | 'low', center: [number, number]) {
    this.quality = quality;
    this.map = new MLMap({
      container,
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#070b10' } }] },
      center,
      zoom: 15,
      pitch: 75,
      maxPitch: 88,
      minZoom: 1,
      interactive: false,
      attributionControl: false,
      maplibreLogo: false,
      renderWorldCopies: true,
      fadeDuration: 250,
      pixelRatio: Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1 : 2),
      canvasContextAttributes: { antialias: quality !== 'low', preserveDrawingBuffer: true, powerPreference: 'high-performance' },
      cancelPendingTileRequestsWhileZooming: false,
      maxTileCacheZoomLevels: 6,
    });
  }

  get ready() { return this._ready; }

  whenLoaded(): Promise<void> {
    return new Promise((res) => (this.map.loaded() ? res() : this.map.once('load', () => res())));
  }

  async setStyle(id: StyleId, quality: 'high' | 'low') {
    this.quality = quality;
    this.styleLoading = true;
    try {
      const style = await buildStyle(id, quality);
      this.sky = skyColors(id);
      this.map.setStyle(style, { diff: false });
      await new Promise<void>((res) => this.map.once('style.load', () => res()));
      this.applyCameraTuning();
      this.buildings.setTemplate(await this.vectorTemplate());
      this._ready = true;
    } finally {
      this.styleLoading = false;
    }
  }

  /** Wide FPV lens + aggressive near-field tile detail so buildings reach the horizon. */
  private applyCameraTuning() {
    const low = this.quality === 'low';
    this.map.setVerticalFieldOfView(low ? 62 : 75);
    try { this.map.setSourceTileLodParams(low ? 9.314 : 6, 3); } catch { /* sources not ready */ }
  }

  setCamera(s: DroneState) {
    if (!this._ready) return;
    try {
      const opts = this.map.calculateCameraOptionsFromCameraLngLatAltRotation([s.lng, s.lat], s.alt, s.heading, s.camPitch, s.roll);
      // MapLibre can't pitch above the horizon; looking higher is rendered as a lens shift along the camera's down axis.
      const shift = lensShiftPx(s.lookUp, this.container.clientHeight, this.vfov);
      const dx = shift * Math.sin(s.roll * Math.PI / 180), dy = shift * Math.cos(s.roll * Math.PI / 180);
      const padding = { left: Math.max(0, 2 * dx), right: Math.max(0, -2 * dx), top: Math.max(0, 2 * dy), bottom: Math.max(0, -2 * dy) };
      this.map.jumpTo({ ...opts, padding });
      this.paintSky(s.camPitch, s.roll, shift);
    } catch { /* transient during style swap */ }
  }

  /** Sky gradient behind the (transparent-sky) canvas, with the horizon where the camera really sees it. */
  private paintSky(camPitch: number, roll: number, shift: number) {
    const W = this.container.clientWidth, H = this.container.clientHeight;
    const F = H / 2 / Math.tan((this.vfov * Math.PI) / 360);
    const horizonOffset = -F * Math.tan(((90 - camPitch) * Math.PI) / 180) + shift; // along the camera's down axis
    const theta = 180 - roll; // CSS gradient angle pointing from sky to ground
    const t = (theta * Math.PI) / 180;
    const L = Math.abs(W * Math.sin(t)) + Math.abs(H * Math.cos(t));
    const stop = 50 + (horizonOffset / L) * 100;
    const { sky, horizon, fog } = this.sky;
    const css = `linear-gradient(${theta.toFixed(1)}deg, ${sky} ${(stop - 45).toFixed(1)}%, ${horizon} ${(stop - 1).toFixed(1)}%, ${fog} ${(stop + 2).toFixed(1)}%, ${fog} 100%)`;
    if (css !== this.lastSkyCss) { this.container.style.background = css; this.lastSkyCss = css; }
  }

  private async vectorTemplate(): Promise<string | null> {
    const src = this.map.getSource('openmaptiles') as any;
    if (src?.tiles?.[0]) return src.tiles[0];
    const url = src?.url ?? 'https://tiles.openfreemap.org/planet';
    try { const j = await (await fetch(url)).json(); return j.tiles?.[0] ?? null; } catch { return null; }
  }

  surface(lng: number, lat: number): Surface | null {
    if (this.styleLoading || !this._ready) return null;
    const t = this.quality === 'low' ? 0 : this.map.queryTerrainElevation([lng, lat]);
    if (t === null || !Number.isFinite(t)) return null;
    this.buildings.prefetch(lng, lat);
    const b = this.buildings.at(lng, lat);
    return b ? { ground: t, solids: b.map((v) => ({ base: t + v.base, top: t + v.top })) } : { ground: t };
  }

  tilesLoaded() { return this.map.areTilesLoaded(); }
  show() { this.container.style.display = ''; this.map.resize(); }
  hide() { this.container.style.display = 'none'; }
  resize() { this.map.resize(); }
  snapshot() { return this.map.getCanvas(); }
}
