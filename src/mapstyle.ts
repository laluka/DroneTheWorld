import type { StyleSpecification, LayerSpecification, SkySpecification, LightSpecification } from 'maplibre-gl';

export type StyleId = 'satellite' | 'streets' | 'night';
export const STYLE_IDS: StyleId[] = ['satellite', 'streets', 'night'];

const OFM_PLANET = 'https://tiles.openfreemap.org/planet';
const OFM_STYLE = (id: string) => `https://tiles.openfreemap.org/styles/${id}`;
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const terrainSource = {
  type: 'raster-dem' as const,
  tiles: [TERRARIUM],
  encoding: 'terrarium' as const,
  tileSize: 256,
  maxzoom: 15,
  attribution: 'Terrain: Mapzen / AWS Open Data',
};

const SKIES: Record<StyleId, SkySpecification> = {
  satellite: {
    'sky-color': '#5e9ed6',
    'horizon-color': '#dbe6ee',
    'fog-color': '#d2dde6',
    'fog-ground-blend': 0.72,
    'horizon-fog-blend': 0.8,
    'sky-horizon-blend': 0.55,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 1, 12, 0] as any,
  },
  streets: {
    'sky-color': '#79b4e8',
    'horizon-color': '#e8f0f6',
    'fog-color': '#e6edf3',
    'fog-ground-blend': 0.75,
    'horizon-fog-blend': 0.8,
    'sky-horizon-blend': 0.6,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 9, 1, 12, 0] as any,
  },
  night: {
    'sky-color': '#05070f',
    'horizon-color': '#1a2238',
    'fog-color': '#0d1322',
    'fog-ground-blend': 0.8,
    'horizon-fog-blend': 0.85,
    'sky-horizon-blend': 0.7,
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 9, 0.6, 12, 0] as any,
  },
};

const LIGHTS: Record<StyleId, LightSpecification> = {
  satellite: { anchor: 'viewport', color: '#fff6e5', intensity: 0.45, position: [1.15, 215, 35] },
  streets: { anchor: 'viewport', color: '#ffffff', intensity: 0.5, position: [1.15, 215, 35] },
  night: { anchor: 'viewport', color: '#8fb4ff', intensity: 0.35, position: [1.15, 150, 45] },
};

function buildingsLayer(id: StyleId): LayerSpecification {
  const color =
    id === 'night'
      ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#1b2238', 60, '#2b3a63', 200, '#4a63a8']
      : id === 'satellite'
        ? ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#cfd3d8', 80, '#dfe3e8', 250, '#f3f5f7']
        : ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, '#d9d4cc', 80, '#e7e2da', 250, '#f4f1ec'];
  return {
    id: 'drone-buildings',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    minzoom: 13,
    paint: {
      'fill-extrusion-color': color as any,
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': id === 'satellite' ? 0.92 : 0.96,
      'fill-extrusion-vertical-gradient': true,
    },
  };
}

function placeLabels(id: StyleId): LayerSpecification {
  const dark = id === 'night';
  return {
    id: 'drone-place-labels',
    type: 'symbol',
    source: 'openmaptiles',
    'source-layer': 'place',
    maxzoom: 12,
    filter: ['any', ['==', ['get', 'class'], 'city'], ['all', ['==', ['get', 'class'], 'town'], ['<=', ['zoom'], 11]], ['==', ['get', 'class'], 'country']],
    layout: {
      'text-field': ['get', 'name:latin'],
      'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11, 8, 13, 12, 15],
      'text-letter-spacing': 0.08,
      'text-transform': 'uppercase',
      'text-max-width': 8,
      'symbol-sort-key': ['coalesce', ['get', 'rank'], 100],
    },
    paint: {
      'text-color': dark ? '#dbe7ff' : '#ffffff',
      'text-halo-color': dark ? 'rgba(5,7,15,0.9)' : 'rgba(0,0,0,0.75)',
      'text-halo-width': 1.4,
      'text-opacity': 0.85,
    },
  };
}

async function fetchStyle(id: string): Promise<StyleSpecification> {
  const r = await fetch(OFM_STYLE(id));
  if (!r.ok) throw new Error(`style ${id}: ${r.status}`);
  return (await r.json()) as StyleSpecification;
}

/** Build a complete style (sources + layers + terrain + sky) for the requested look. */
export async function buildStyle(id: StyleId, quality: 'high' | 'low'): Promise<StyleSpecification> {
  const exaggeration = 1.0;
  const terrain = quality === 'low' ? undefined : { source: 'terrain-dem', exaggeration };

  if (id === 'satellite') {
    return {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        'esri-imagery': {
          type: 'raster',
          tiles: [ESRI_IMAGERY],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        },
        openmaptiles: { type: 'vector', url: OFM_PLANET, attribution: '© OpenStreetMap contributors · OpenFreeMap' },
        'terrain-dem': terrainSource,
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0a1a2a' } },
        {
          id: 'imagery',
          type: 'raster',
          source: 'esri-imagery',
          paint: { 'raster-saturation': -0.08, 'raster-contrast': 0.06, 'raster-brightness-min': 0.02, 'raster-fade-duration': 200 },
        },
        buildingsLayer(id),
        placeLabels(id),
      ],
      sky: SKIES[id],
      light: LIGHTS[id],
      terrain,
    } as StyleSpecification;
  }

  const base = await fetchStyle(id === 'streets' ? 'liberty' : 'dark');
  const layers = base.layers.filter((l) => !(l['source-layer' as keyof typeof l] === 'building' || l.id.startsWith('building')));
  // Insert buildings right before the first symbol layer so labels stay on top.
  const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
  const idx = firstSymbol < 0 ? layers.length : firstSymbol;
  layers.splice(idx, 0, buildingsLayer(id));
  if (id === 'night') {
    // Slightly lift road brightness for the glowing-city feel.
    for (const l of layers) {
      if (l.type === 'line' && /road|motorway|highway|primary|secondary|tertiary|minor|street/.test(l.id)) {
        (l.paint as any) = { ...(l.paint ?? {}), 'line-color': '#52618a' };
      }
    }
  }
  return {
    ...base,
    sources: { ...base.sources, 'terrain-dem': terrainSource },
    layers,
    sky: SKIES[id],
    light: LIGHTS[id],
    terrain,
  } as StyleSpecification;
}
