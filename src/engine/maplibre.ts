import { Map as MLMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Engine, Surface } from './types';
import { BuildingField } from '../buildings';
import type { DroneState } from '../drone';
import { buildStyle, type StyleId } from '../mapstyle';

setWorkerUrl(workerUrl);

/** Free, keyless engine: OpenFreeMap vectors + Esri imagery + AWS terrain, buildings extruded from OSM heights. */
export class MapLibreEngine implements Engine {
  readonly id = 'maplibre' as const;
  readonly maxCamTilt = 86;
  readonly map: MLMap;
  private styleLoading = false;
  private quality: 'high' | 'low';
  private _ready = false;
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
      this.map.jumpTo(opts);
    } catch { /* transient during style swap */ }
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
    return b ? { ground: t, solid: { base: t + b.base, top: t + b.top } } : { ground: t };
  }

  tilesLoaded() { return this.map.areTilesLoaded(); }
  show() { this.container.style.display = ''; this.map.resize(); }
  hide() { this.container.style.display = 'none'; }
  resize() { this.map.resize(); }
  snapshot() { return this.map.getCanvas(); }
}
