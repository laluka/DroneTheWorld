# Drone The World — FPV drone simulator for the whole planet

Fly an FPV quad over any city on Earth, straight from the browser, and discover the places around you.
Pure frontend, no backend, no account: a static site that runs on GitHub Pages.

- **Free mode (no keys)** — a full 3D world: imagery on real terrain streamed to the horizon, OpenStreetMap buildings
  with windows, floors, pitched roofs and rooftop clutter, sun shadows, trees in woods, parks, gardens and along
  avenues (solid, you can crash into them), rivers and lakes with moving reflective water, clouds and haze, and a far
  skyline. Night mode lights the windows and the streets under the stars. A Streets map too. Works worldwide.
- **Photoreal 3D (optional)** — Google Photorealistic 3D Tiles rendered with CesiumJS:
  true textured cities, trees, bridges. Needs a Google Maps Platform API key (see below).
- FPV feel: body-fixed camera that follows every attitude (flips, rolls, loops, inverted), FPV lens look
  (wide-angle distortion, vignette, speed blur, optional analog video), turbo mode, Betaflight-style OSD
  (compass, speed and altitude ladders, artificial horizon, throttle, battery).
- Keyboard + mouse, gamepad (mode 2) and touch sticks. Procedural sound (each motor's prop tone follows the motor mix, so flips and punches are audible), off by default.
- **Discoveries**: golden beacons mark notable places near you (from Wikipedia). Fly within ~140 m below 500 m
  altitude to discover one: a card shows its photo and summary, and it goes into your **passport** (menu), where
  any stamp flies you back there. A guide arrow under the compass points to the nearest undiscovered place.
- Search any place (Photon geocoder), 16 curated presets, random mode, shareable URLs
  (`#lng,lat,agl,heading,camTilt,style`), screenshots with the OSD baked in.

## Flight modes (`V` to cycle)

- **Angle**: sticks tilt the quad, it levels itself when released. Real thrust, gravity and momentum;
  centred throttle holds altitude. Best on keyboard.
- **Acro** (default, with turbo on; `T` toggles turbo, holding `Shift` or the pad's turbo button flips it): sticks command rotation rates (Betaflight "BF" rates: RC rate 1.0, super rate 0.7, ~670°/s); the quad keeps its attitude.
  Bank and pull to carve turns. Flips, rolls, loops, split-S and inverted flight all work.
- **Cine**: smooth assisted flight for sightseeing.

The FPV camera is tilted up on the frame (20° by default, mouse drag up/down to change). Crashes shake the image briefly.

**Throttle** (menu → Controller): *Centred* means mid-stick hovers, for spring-centred sticks (DJI remotes in N/S mode,
keyboard, touch). *Absolute* is like a real quad: bottom is motor idle, top is full power, and you set the stick position
that hovers (35% by default). Absolute applies to a connected controller only.

**Camera** (menu): *FPV lens* (default) adds wide-angle barrel distortion, vignette, a little chromatic aberration and
speed blur. *Analog* adds video noise and scanlines. *Clean* turns it all off.

Physics runs at a fixed 240 Hz whatever the frame rate, so the quad feels the same on every machine. The altitude
speed boost only starts above 400 m in Angle/Acro (and scales all axes equally), so loops near the ground keep their shape.

### Satellite 3D world (`src/engine/world/`)

A three.js engine, keyless like the rest:
- **Ground**: Esri World Imagery draped on AWS Terrarium terrain, as a distance-driven quadtree (down to 0.3 m pixels
  near you, coarse tiles out to the horizon), with skirts between detail levels and procedural grain up close.
  The DEM is smoothed at high zoom because SRTM-based data has buildings and canopy baked in as bumps.
- **Buildings**: OpenFreeMap vector tiles (OSM `render_height` / `render_min_height` / `colour`), built in a worker.
  Walls get floors and windows in the shader (shopfronts at street level, curtain walls on some towers, glass that
  reflects the sky), roofs get colour and grain, and everything casts and receives sun shadows.
- **Trees**: placed from landcover (woods dense, parks and gardens sparse, scrub as bushes) and along some main
  streets, never inside buildings. Two levels of detail; nearby trees cast shadows and are collision obstacles.
- **Roofs**: small, roughly rectangular buildings get gable or hipped roofs; big flat roofs get plant rooms and HVAC
  boxes. Lattice towers (four legs, over 200 m, like the Eiffel Tower) are built as open steel lattices.
- **Water**: OSM water polygons draped on the terrain, with moving ripples, Fresnel sky reflection and sun glints.
- **Far skyline**: a lighter second ring of z13 tiles (tall buildings only) out to about 15 km, hidden where the
  detailed ring is so the two never overlap.
- **Sky and haze**: a sky dome with the sun and a drifting cloud layer at 1.8 km, and distance fog matched to the
  horizon colour. The haze thins as you climb.
- **Night**: moonlight, stars, imagery dimmed, random lit windows, and street lights along roads.

Satellite and Night use this engine. Streets keeps the MapLibre renderer (with labels), Photoreal 3D keeps Cesium.

### How looping works on a map renderer

MapLibre can't draw the ground with its camera above the horizon. So the renderer draws the closest view it can
(at most 79° pitch, unrolled as you look up), and a WebGL lens pass (`src/post.ts`) re-projects that frame into the
true camera orientation. A pure camera rotation is an exact image warp, so nothing is approximated. The same pass
paints the sky around it and applies the lens look. Cesium (Photoreal 3D) renders any orientation natively and goes
through the same pass for the lens look.

## Controls

| Input | Action |
| --- | --- |
| `W` `S` / `↑` `↓` | pitch forward / back |
| `A` `D` / `←` `→` | roll (strafe) |
| `Q` `E` | yaw |
| `Space` / `C` | throttle up / down |
| `T` / `Shift` (hold) | turbo on / off (on by default) / flip it while held |
| mouse drag | yaw + camera tilt · wheel: altitude |
| `I` `K` / `R` | camera tilt / reset |
| `Backspace` | back to the launch point |
| `M` `H` `N` `P` `F` | cycle map · toggle HUD · sound · screenshot · fullscreen |
| `1`–`9` | jump to preset · `Esc` menu |

**Radio controller first.** Any controller the browser sees as a gamepad works, including DJI remotes over USB
(DJI FPV Remote Controller 2 / 3 and other HID-joystick radios). From the menu (Controller → Calibrate sticks), an optional
wizard maps it: leave the sticks at rest, push throttle up, yaw right, pitch forward, roll right, then optionally press
a turbo button. Flight modes are picked in the menu (or `V`); a mode switch saved by an older calibration only acts when flipped.
Axis order, direction and rest position are saved per controller; deadzone and expo are adjustable in the menu.
DJI remotes start from a DJI layout guess; run the wizard if the sticks feel off (layouts differ between firmwares).
The OSD shows `RC` when the controller is flying, and a DVR-style stick overlay so you can see your inputs.

Keyboard is the fallback: keys ramp in and out like a stick, and the **Rates** slider scales yaw and throttle.
Buildings are solid: the drone bounces off walls (with a shake and a red flash), slides along them, and can land on roofs.
In Photoreal 3D the sampled surface acts as the floor, so the drone climbs over buildings instead of bouncing.
The higher you fly, the faster you go (altitude speed scaling), so crossing a continent stays fun.

## Run it

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
npm test         # flight model + camera math tests (vitest)
```

## Deploy to GitHub Pages

One-time setup in the GitHub UI: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
After that, every push to `main` runs `.github/workflows/deploy.yml`, which builds and publishes `dist/` to
`https://<user>.github.io/<repo>/`. The build uses a relative base, so it works from that sub-path.
You can also re-run it by hand from the **Actions** tab (workflow "Deploy to GitHub Pages" → *Run workflow*).

## Photoreal 3D (optional, bring your own Google key)

**No key is needed to play.** Satellite, Streets and Night, the buildings, collision and discoveries all work
out of the box. A key only unlocks the extra *Photoreal 3D* view (Google Photorealistic 3D Tiles via CesiumJS).

The public site ships without a key. Players who want Photoreal 3D paste their own in the menu
(Map → Photoreal 3D). It is kept in that browser's local storage and only sent to Google.

Getting a key takes about 10 minutes:

1. Create a project in [Google Cloud](https://console.cloud.google.com/projectcreate).
2. Attach a [billing account](https://console.cloud.google.com/billing). A card is required even though light use
   stays within Google's monthly free allowance.
3. Enable the [Map Tiles API](https://console.cloud.google.com/apis/library/tile.googleapis.com).
4. Create an API key in [Keys & Credentials](https://console.cloud.google.com/google/maps-apis/credentials).
5. Restrict it: *Websites* → the site's origin (for example `https://laluka.github.io/*`, or
   `http://localhost:5173/*` for local dev), and *API restrictions* → Map Tiles API only.
6. Optional but wise: cap daily requests in [Quotas](https://console.cloud.google.com/apis/api/tile.googleapis.com/quotas)
   and add a budget alert.
7. Paste it in the menu and press **Use key**.

Usage beyond the free allowance is billed by Google per session; see their current
[pricing](https://developers.google.com/maps/billing-and-pricing/pricing).

Self-hosting a fork for others? You can bake a key in at build time with the repository secret
`VITE_GOOGLE_MAPS_KEY` (read by the Pages workflow). Anyone can read a key shipped in a public site,
so only do this with strict referrer and quota limits.

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
  camera.ts        camera bases, renderer camera choice, lens projection (shared by renderer, lens pass, OSD)
  post.ts          WebGL lens pass: re-projection to the true FPV camera, sky, distortion, blur, analog look
  audio.ts         procedural sound: per-motor prop spectra driven by the motor mix, punch, prop wash, wind
  geocode.ts       Photon search / reverse
  discover.ts      Wikipedia places nearby, discovery + passport
  buildings.ts     building footprints/heights from vector tiles, for collision
  gamepad.ts       controller mapping + calibration
  mapstyle.ts      MapLibre styles (satellite / streets / night) with terrain, sky, buildings
  engine/          renderers behind one interface: world/ (three.js Satellite 3D), MapLibre (Streets, Night),
                   Cesium (Google Photorealistic 3D Tiles)
```
