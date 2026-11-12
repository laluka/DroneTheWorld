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

## Flight modes (`V` to cycle)

- **Angle**: sticks tilt the quad, it levels itself when released. Real thrust, gravity and momentum;
  centred throttle holds altitude. Best on keyboard.
- **Acro** (default): sticks command rotation rates (Betaflight "BF" rates: RC rate 1.0, super rate 0.7, ~670°/s); the quad keeps its attitude.
  Bank and pull to carve turns, barrel rolls work. Centred throttle = hover thrust, so it suits spring-centred
  RC sticks (DJI remotes). The map renderer can't look above the horizon, so forward/back flips are not possible.
- **Cine**: smooth assisted flight for sightseeing.

The FPV camera is tilted up on the frame (20° by default, mouse drag up/down to change). The map renderer can't pitch
above the horizon, so looking higher (hovering with uptilt) is rendered as a lens shift. Frame vibration grows with
motor load, and dropping through your own prop wash makes the quad wobble.

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

**Radio controller first.** Any controller the browser sees as a gamepad works, including DJI remotes over USB
(DJI FPV Remote Controller 2 / 3 and other HID-joystick radios). The first time a controller connects, a short
wizard opens: leave the sticks at rest, push throttle up, yaw right, pitch forward, roll right, then optionally press
a turbo button and flip a flight-mode switch (positions select Angle / Cine / Acro, a button cycles them).
Axis order, direction and rest position are saved per controller; deadzone and expo are adjustable in the menu.
DJI remotes start from a DJI layout guess, but run the wizard anyway: stick layouts differ between firmwares.
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
  audio.ts         procedural motor + wind
  geocode.ts       Photon search / reverse
  discover.ts      Wikipedia places nearby, discovery + passport
  buildings.ts     building footprints/heights from vector tiles, for collision
  gamepad.ts       controller mapping + calibration
  mapstyle.ts      MapLibre styles (satellite / streets / night) with terrain, sky, buildings
  engine/          MapLibre (free) and Cesium (Google 3D Tiles) renderers behind one interface
```
