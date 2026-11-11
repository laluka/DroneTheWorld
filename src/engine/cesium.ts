import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Engine } from './types';
import type { DroneState } from '../drone';

const rad = Cesium.Math.toRadians;

/** Google Photorealistic 3D Tiles through CesiumJS. Needs a Google Maps Platform key with the Map Tiles API enabled. */
export class CesiumEngine implements Engine {
  readonly id = 'cesium' as const;
  readonly maxCamTilt = 112;
  private viewer: Cesium.Viewer;
  private tileset: Cesium.Cesium3DTileset | null = null;
  private lastSample = { t: 0, lng: 0, lat: 0, h: null as number | null };
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

  groundElevation(lng: number, lat: number): number | null {
    const now = performance.now();
    const moved = Math.hypot(lng - this.lastSample.lng, lat - this.lastSample.lat) > 1e-6;
    if (now - this.lastSample.t < 100 && !moved) return this.lastSample.h;
    if (now - this.lastSample.t < 60) return this.lastSample.h;
    const scene = this.viewer.scene;
    let h: number | undefined;
    if (scene.sampleHeightSupported) h = scene.sampleHeight(Cesium.Cartographic.fromDegrees(lng, lat), undefined, 1);
    this.lastSample = { t: now, lng, lat, h: h === undefined || !Number.isFinite(h) ? this.lastSample.h : h };
    return this.lastSample.h;
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
