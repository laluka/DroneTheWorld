import type { RenderCam } from '../camera';
import type { SkyColors } from '../post';

/** What is under / around a point: ground level plus any solid volume above it (all heights MSL, meters). */
export interface Surface {
  ground: number;
  /** solid volumes [base, top] (MSL) stacked at this point, e.g. building parts; absent on open ground */
  solids?: { base: number; top: number }[];
}

export interface Engine {
  readonly id: 'maplibre' | 'cesium' | 'world';
  /** Highest camera pitch the renderer can display without artifacts (MapLibre convention); the lens pass covers the rest. */
  readonly maxCamTilt: number;
  /** vertical field of view of the rendered image, degrees */
  readonly vfov: number;
  /** Point the renderer's camera and, when possible, draw the frame right away so the lens pass sees this exact view. */
  setCamera(c: RenderCam): void;
  /** Sky the lens pass paints behind a transparent render, or null when the renderer draws its own sky. */
  sky(): SkyColors | null;
  /** Ground and obstacles at a point. null while unknown (data still loading). */
  surface(lng: number, lat: number): Surface | null;
  tilesLoaded(): boolean;
  show(): void;
  hide(): void;
  resize(): void;
  /** The canvas holding the rendered frame (input of the lens pass). */
  snapshot(): HTMLCanvasElement | null;
}
