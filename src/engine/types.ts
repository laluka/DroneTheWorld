import type { DroneState } from '../drone';

export interface Engine {
  readonly id: 'maplibre' | 'cesium';
  /** Highest camera tilt the renderer can display without artifacts (MapLibre pitch convention). */
  readonly maxCamTilt: number;
  setCamera(s: DroneState): void;
  /** Height of the ground/roof under a point, in the engine's vertical datum. null while unknown. */
  groundElevation(lng: number, lat: number): number | null;
  tilesLoaded(): boolean;
  show(): void;
  hide(): void;
  resize(): void;
  /** Composite the current frame onto a canvas (for screenshots). */
  snapshot(): HTMLCanvasElement | null;
}
