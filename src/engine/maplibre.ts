import { Map as MLMap, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Engine, Surface } from './types';
import { BuildingField } from '../buildings';
import type { RenderCam } from '../camera';
import type { SkyColors } from '../post';
import { buildStyle, skyColors, type StyleId } from '../mapstyle';

setWorkerUrl(workerUrl);

/** Free, keyless engine: OpenFreeMap vectors + Esri imagery + AWS terrain, buildings extruded from OSM heights. */
export class MapLibreEngine implements Engine {
  readonly id = 'maplibre' as const;
  /** Above ~80° the map's centre runs off to the horizon and tiny pitch changes reload tiles; the lens pass rotates higher looks into place. */
  readonly maxCamTilt = 79;
  get vfov() { return this.quality === 'low' ? 62 : 75; }
  readonly map: MLMap;
  private styleLoading = false;
  private quality: 'high' | 'low';
  private _ready = false;
  private skyId: StyleId = 'satellite';
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
      this.skyId = id;
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

  setCamera(c: RenderCam) {
    if (!this._ready) return;
    try {
      this.map.jumpTo(this.map.calculateCameraOptionsFromCameraLngLatAltRotation([c.lng, c.lat], c.alt, c.heading, c.pitch, c.roll));
      // draw now (cancels the pending frame), so the lens pass warps exactly the view it was told about
      this.map.redraw();
    } catch { /* transient during style swap */ }
  }

  sky(): SkyColors {
    return { ...skyColors(this.skyId), sun: this.skyId === 'night' ? 0 : 1 };
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
