import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Engine, Surface } from './types';
import type { DroneState } from '../drone';

const rad = Cesium.Math.toRadians;

/** Google Photorealistic 3D Tiles through CesiumJS. Needs a Google Maps Platform key with the Map Tiles API enabled. */
export class CesiumEngine implements Engine {
  readonly id = 'cesium' as const;
  readonly maxCamTilt = 112;
  private viewer: Cesium.Viewer;
  private tileset: Cesium.Cesium3DTileset | null = null;
  private cache = new Map<string, { t: number; h: number | null }>();
  private verticalFov = 75;

  private constructor(private container: HTMLElement, quality: 'high' | 'low') {
    this.viewer = new Cesium.Viewer(container, {
      baseLayer: false,
      terrain: undefined,
      animation: false, timeline: false, geocoder: false, homeButton: false, sceneModePicker: false,
      baseLayerPicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
      selectionIndicator: false, vrButton: false, shouldAnimate: true,
      useBrowserRecommendedResolution: quality === 'low',
      msaaSamples: quality === 'low' ? 1 : 4,
      contextOptions: { webgl: { preserveDrawingBuffer: true, powerPreference: 'high-performance' } },
    });
    const scene = this.viewer.scene;
    scene.globe.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.fog.density = 0.0004;
    scene.highDynamicRange = false;
    scene.postProcessStages.fxaa.enabled = quality !== 'low';
    scene.screenSpaceCameraController.enableInputs = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString('#070b10');
    this.resize();
  }

  static async create(container: HTMLElement, key: string, quality: 'high' | 'low'): Promise<CesiumEngine> {
    Cesium.GoogleMaps.defaultApiKey = key;
    const engine = new CesiumEngine(container, quality);
    try {
      engine.tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { key, onlyUsingWithGoogleGeocoder: true },
        {
          maximumScreenSpaceError: quality === 'low' ? 24 : 12,
          dynamicScreenSpaceError: true,
          dynamicScreenSpaceErrorDensity: 0.0002,
          dynamicScreenSpaceErrorFactor: 6,
          skipLevelOfDetail: true,
          preloadWhenHidden: false,
          enableCollision: false,
        },
      );
      engine.viewer.scene.primitives.add(engine.tileset);
    } catch (e) {
      engine.destroy();
      throw e;
    }
    return engine;
  }

  setCamera(s: DroneState) {
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(s.lng, s.lat, s.alt),
      orientation: { heading: rad(s.heading), pitch: rad(s.camPitch - 90), roll: rad(s.roll) },
    });
  }

  /** Google tiles have no separate ground: the sampled top surface (roofs included) is the floor, walls show as height jumps. */
  surface(lng: number, lat: number): Surface | null {
    const key = `${lng.toFixed(5)},${lat.toFixed(5)}`;
    const now = performance.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.t < 250) return hit.h === null ? null : { ground: hit.h };
    const scene = this.viewer.scene;
    let h: number | undefined;
    if (scene.sampleHeightSupported) h = scene.sampleHeight(Cesium.Cartographic.fromDegrees(lng, lat), undefined, 1);
    const v = h === undefined || !Number.isFinite(h) ? (hit?.h ?? null) : h;
    this.cache.set(key, { t: now, h: v });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return v === null ? null : { ground: v };
  }

  tilesLoaded() { return this.tileset ? this.tileset.tilesLoaded : false; }

  show() { this.container.style.display = ''; this.resize(); }
  hide() { this.container.style.display = 'none'; }

  resize() {
    const w = this.container.clientWidth || innerWidth, h = this.container.clientHeight || innerHeight;
    const f = this.viewer.camera.frustum as Cesium.PerspectiveFrustum;
    // Cesium's fov applies to the larger dimension; keep the vertical FOV constant like the MapLibre engine.
    const v = rad(this.verticalFov);
    f.fov = w >= h ? 2 * Math.atan(Math.tan(v / 2) * (w / h)) : v;
  }

  snapshot() { return this.viewer.scene.canvas; }

  destroy() {
    this.viewer.destroy();
  }
}
