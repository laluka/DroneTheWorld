import type { DroneState } from '../drone';

/** What is under / around a point: ground level plus any solid volume above it (all heights MSL, meters). */
export interface Surface {
  ground: number;
  /** solid volume [base, top] above ground, e.g. a building; absent on open ground */
  solid?: { base: number; top: number };
}

export interface Engine {
  readonly id: 'maplibre' | 'cesium';
  /** Highest camera tilt the renderer can display without artifacts (MapLibre pitch convention). */
  readonly maxCamTilt: number;
  /** vertical field of view in degrees, for overlays drawn on top */
  readonly vfov: number;
  setCamera(s: DroneState): void;
  /** Ground and obstacles at a point. null while unknown (data still loading). */
  surface(lng: number, lat: number): Surface | null;
  tilesLoaded(): boolean;
  show(): void;
  hide(): void;
  resize(): void;
  /** Composite the current frame onto a canvas (for screenshots). */
  snapshot(): HTMLCanvasElement | null;
}
