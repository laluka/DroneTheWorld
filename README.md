# Drone The World — FPV drone simulator for the whole planet

Fly an FPV quad over any city on Earth, straight from the browser, and discover the places around you.
Pure frontend, no backend, no account: a static site that runs on GitHub Pages.

- **Free mode (no keys)** — satellite imagery, streets or a night map, real terrain and 3D buildings
  extruded from OpenStreetMap heights. Works out of the box, worldwide.
- **Photoreal 3D (optional)** — Google Photorealistic 3D Tiles rendered with CesiumJS:
  true textured cities, trees, bridges. Needs a Google Maps Platform API key (see below).
- FPV feel: wide lens, body-fixed camera that pitches and banks with your inputs, turbo mode,
  Betaflight-style OSD (compass, speed and altitude ladders, artificial horizon, throttle, battery).
- Keyboard + mouse, gamepad (mode 2) and touch sticks. Procedural motor/wind sound, off by default.
- **Discoveries**: golden beacons mark notable places near you (from Wikipedia). Fly within ~140 m below 500 m
  altitude to discover one: a card shows its photo and summary, and it goes into your **passport** (menu), where
  any stamp flies you back there. A guide arrow under the compass points to the nearest undiscovered place.
- Search any place (Photon geocoder), 16 curated presets, random mode, shareable URLs
  (`#lng,lat,agl,heading,camTilt,style`), screenshots with the OSD baked in.

## Controls

| Input | Action |
| --- | --- |
| `W` `S` / `↑` `↓` | pitch forward / back |
| `A` `D` / `←` `→` | roll (strafe) |
| `Q` `E` | yaw |
| `Space` / `C` | throttle up / down |
| `Shift` | turbo |
| mouse drag | yaw + camera tilt · wheel: altitude |
| `I` `K` / `R` | camera tilt / reset |
| `Backspace` | back to the launch point |
| `M` `H` `N` `P` `F` | cycle map · toggle HUD · sound · screenshot · fullscreen |
| `1`–`9` | jump to preset · `Esc` menu |

**Radio controller first.** Any controller the browser sees as a gamepad works, including DJI remotes
plugged in over USB (RC-N1/N2 in simulator/joystick mode, DJI FPV Remote Controller 2, RC Motion-style HID devices).
Open the menu, then **Controller → Calibrate sticks**: leave sticks at rest, then push throttle up, yaw right,
pitch forward, roll right, and press a turbo button. Axis order and direction are learned and saved per controller,
with adjustable deadzone and expo. The OSD shows `RC` when the controller is driving.

Keyboard is the fallback: keys ramp in and out like a stick, and the **Rates** slider scales yaw and throttle.
Buildings are solid: the drone bounces off walls (with a shake and a red flash), slides along them, and can land on roofs.
In Photoreal 3D the sampled surface acts as the floor, so the drone climbs over buildings instead of bouncing.
The higher you fly, the faster you go (altitude speed scaling), so crossing a continent stays fun.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
```

## Deploy to GitHub Pages

Hosting is optional and nothing is published by default. When you want it:

1. Push to `main` of a GitHub repo. The workflow in `.github/workflows/deploy.yml` builds and publishes `dist/`.
2. In the repo settings, set **Pages → Source** to **GitHub Actions** (first time only).
3. The site is served from `https://<user>.github.io/<repo>/` (the build uses a relative base, so any path works).

## Photoreal 3D (Google key)

Google's photorealistic tiles are the only way to get precise, textured 3D worldwide, and they require an API key.
Two ways to provide one:

- **Per visitor** — paste a key in the menu (Map → Photoreal 3D). It is stored only in that browser's `localStorage`.
- **Baked into the site** — add a repository secret `VITE_GOOGLE_MAPS_KEY`; the workflow injects it at build time
  so every visitor gets Photoreal 3D directly.

Create the key in [Google Cloud → Maps Platform](https://console.cloud.google.com/google/maps-apis), enable the
**Map Tiles API**, and restrict the key by HTTP referrer to your Pages URL (and by API to Map Tiles only).
Google offers a monthly free credit; 3D Tiles usage is billed per root-tile request beyond it, so keep the referrer restriction.

## Data & credits

- Vector tiles and styles: [OpenFreeMap](https://openfreemap.org) · © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics, and the GIS User Community)
- Terrain: Mapzen / AWS Open Data terrain tiles (Terrarium)
- Geocoding: [Photon](https://photon.komoot.io) by komoot
- Places and summaries: [Wikipedia](https://en.wikipedia.org) (CC BY-SA)
- Rendering: [MapLibre GL JS](https://maplibre.org) · [CesiumJS](https://cesium.com/platform/cesiumjs/) for Google 3D Tiles

All of the free-mode services are public, keyless endpoints with fair-use policies; please be gentle with them.

## Layout

```
src/
  main.ts          app wiring: menu, loop, engines, hash, keys
  drone.ts         FPV flight model (velocity-based with body attitude)
  input.ts         keyboard / mouse / touch sticks / gamepad → control frame
  hud.ts           DOM telemetry + canvas OSD (compass, ladders, horizon)
  audio.ts         procedural motor + wind
  geocode.ts       Photon search / reverse
  discover.ts      Wikipedia places nearby, discovery + passport
  buildings.ts     building footprints/heights from vector tiles, for collision
  gamepad.ts       controller mapping + calibration
  mapstyle.ts      MapLibre styles (satellite / streets / night) with terrain, sky, buildings
  engine/          MapLibre (free) and Cesium (Google 3D Tiles) renderers behind one interface
```
