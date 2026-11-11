export interface Place {
  name: string;
  sub: string;
  lng: number;
  lat: number;
  heading: number;
  /** start altitude above ground, meters */
  agl: number;
  /** camera tilt in MapLibre convention (0 = down, 90 = horizon) */
  pitch?: number;
  grad: string;
}

export const PRESETS: Place[] = [
  { name: 'Paris', sub: 'Eiffel Tower', lng: 2.3015, lat: 48.8515, heading: 325, agl: 220, grad: 'linear-gradient(135deg,#3a6ea5,#c17c74)' },
  { name: 'New York', sub: 'Manhattan', lng: -74.0205, lat: 40.6990, heading: 25, agl: 260, grad: 'linear-gradient(135deg,#2b2d42,#8d99ae)' },
  { name: 'Tokyo', sub: 'Shinjuku', lng: 139.6935, lat: 35.6835, heading: 60, agl: 220, grad: 'linear-gradient(135deg,#9b2335,#f7c9d5)' },
  { name: 'Dubai', sub: 'Burj Khalifa', lng: 55.2850, lat: 25.1890, heading: 310, agl: 420, grad: 'linear-gradient(135deg,#d4a017,#5c4a1c)' },
  { name: 'Hong Kong', sub: 'Victoria Harbour', lng: 114.1720, lat: 22.2900, heading: 180, agl: 300, grad: 'linear-gradient(135deg,#0f4c75,#f08a5d)' },
  { name: 'San Francisco', sub: 'Golden Gate', lng: -122.4720, lat: 37.8030, heading: 320, agl: 240, grad: 'linear-gradient(135deg,#d7263d,#f9a03f)' },
  { name: 'London', sub: 'Westminster', lng: -0.1135, lat: 51.5035, heading: 265, agl: 190, grad: 'linear-gradient(135deg,#3d405b,#81b29a)' },
  { name: 'Rio de Janeiro', sub: 'Corcovado', lng: -43.2030, lat: -22.9430, heading: 215, agl: 420, grad: 'linear-gradient(135deg,#1b998b,#ffd166)' },
  { name: 'Sydney', sub: 'Opera House', lng: 151.2240, lat: -33.8500, heading: 230, agl: 200, grad: 'linear-gradient(135deg,#118ab2,#ef476f)' },
  { name: 'Istanbul', sub: 'Bosphorus', lng: 28.9850, lat: 41.0150, heading: 185, agl: 260, grad: 'linear-gradient(135deg,#6a4c93,#f4a261)' },
  { name: 'Singapore', sub: 'Marina Bay', lng: 103.8640, lat: 1.2760, heading: 335, agl: 230, grad: 'linear-gradient(135deg,#06d6a0,#073b4c)' },
  { name: 'Chicago', sub: 'The Loop', lng: -87.6150, lat: 41.8730, heading: 300, agl: 280, grad: 'linear-gradient(135deg,#457b9d,#1d3557)' },
  { name: 'Cape Town', sub: 'Table Mountain', lng: 18.4300, lat: -33.9120, heading: 190, agl: 400, grad: 'linear-gradient(135deg,#2a9d8f,#e9c46a)' },
  { name: 'Matterhorn', sub: 'Swiss Alps', lng: 7.7100, lat: 46.0120, heading: 215, agl: 900, grad: 'linear-gradient(135deg,#8ecae6,#023047)' },
  { name: 'Grand Canyon', sub: 'Arizona', lng: -112.1200, lat: 36.0450, heading: 20, agl: 700, grad: 'linear-gradient(135deg,#bc6c25,#606c38)' },
  { name: 'Mount Fuji', sub: 'Japan', lng: 138.7600, lat: 35.3100, heading: 320, agl: 1200, grad: 'linear-gradient(135deg,#e63946,#f1faee)' },
];

/** Fallback pool for "random" (big cities, so there is something to see). */
export const RANDOM_POOL: [string, number, number][] = [
  ['Barcelona', 2.1734, 41.3851], ['Berlin', 13.4050, 52.5200], ['Rome', 12.4964, 41.9028], ['Amsterdam', 4.9041, 52.3676],
  ['Prague', 14.4378, 50.0755], ['Vienna', 16.3738, 48.2082], ['Lisbon', -9.1393, 38.7223], ['Moscow', 37.6173, 55.7558],
  ['Seoul', 126.9780, 37.5665], ['Shanghai', 121.4737, 31.2304], ['Bangkok', 100.5018, 13.7563], ['Mumbai', 72.8777, 19.0760],
  ['Kuala Lumpur', 101.6869, 3.1390], ['Taipei', 121.5654, 25.0330], ['Osaka', 135.5023, 34.6937], ['Toronto', -79.3832, 43.6532],
  ['Vancouver', -123.1207, 49.2827], ['Mexico City', -99.1332, 19.4326], ['Buenos Aires', -58.3816, -34.6037], ['São Paulo', -46.6333, -23.5505],
  ['Los Angeles', -118.2437, 34.0522], ['Seattle', -122.3321, 47.6062], ['Miami', -80.1918, 25.7617], ['Las Vegas', -115.1398, 36.1699],
  ['Cairo', 31.2357, 30.0444], ['Marrakech', -7.9811, 31.6295], ['Nairobi', 36.8219, -1.2921], ['Lagos', 3.3792, 6.5244],
  ['Doha', 51.5310, 25.2854], ['Tel Aviv', 34.7818, 32.0853], ['Athens', 23.7275, 37.9838], ['Edinburgh', -3.1883, 55.9533],
  ['Reykjavik', -21.8174, 64.1466], ['Oslo', 10.7522, 59.9139], ['Stockholm', 18.0686, 59.3293], ['Copenhagen', 12.5683, 55.6761],
  ['Venice', 12.3155, 45.4408], ['Santorini', 25.4615, 36.3932], ['Dubrovnik', 18.0944, 42.6507], ['Queenstown', 168.6626, -45.0312],
  ['Melbourne', 144.9631, -37.8136], ['Auckland', 174.7633, -36.8485], ['Honolulu', -157.8583, 21.3069], ['Machu Picchu', -72.5450, -13.1631],
];

export const GRADS = PRESETS.map((p) => p.grad);
