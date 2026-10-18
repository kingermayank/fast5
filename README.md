# Fast5 — The Vault

A browser fan game recreating the vault-heist finale of *Fast Five*: Dom's black Charger and
Brian's blue Skyline chained to a ten-ton vault, ripping it out of a Rio police station and dragging it through the
city with every cop on Reyes's payroll in pursuit.

The city is real: the film shot its "Rio" vault chase in San Juan, Puerto Rico, on Avenida Ponce
de León through Hato Rey's Golden Mile, and ended it on the Teodoro Moscoso Bridge. The map is those
streets and buildings (with their real heights) from OpenStreetMap, dressed as Rio, with Christ the
Redeemer on Corcovado at the end of the avenue and Sugarloaf out in the bay.

You play it from above, at dusk: a 2.5D camera at a steep slant rides behind the convoy like a
diorama (forward is always up the screen), looking ahead as you speed up, with tilt-shift blur, wet streets that mirror the street
lamps, headlights and police strobes, and civilian traffic in the lanes. Buildings between the
camera and your car dissolve so you never lose it. C switches to the chase camera behind the car.

A made-up TV channel, RIO 24H, covers the chase live: its helicopter holds a searchlight on the
vault, and breaking-news headlines roll in the corner of the screen as the heat rises. The big
beats get the camera's attention: a pull-out as the vault escapes, slow-motion takedowns from the
street, a side-on shot as you hit the bridge. Every finished run gets a rank, a score and three
challenges (which favour ones you haven't done yet), and your best is remembered.

Built with [Three.js](https://threejs.org/), [Rapier](https://rapier.rs/) physics, TypeScript and Vite.
Uses the film's character names; all models, dialogue, sound and cutscenes are made for this
project (no footage, music, logos or likenesses from the film). See [`docs/DESIGN.md`](docs/DESIGN.md)
for the research notes and design, and [`docs/FIDELITY.md`](docs/FIDELITY.md) for what the best
open-world and racing games do and the plan to get Fast5 there.

## Run it

You need [Node.js](https://nodejs.org/) 22 (or 20.19+; check with `node -v`; on a Mac: `brew install node`,
or the LTS installer from nodejs.org) and git.

```bash
git clone https://github.com/kingermayank/fast5.git   # or, if you already have it: git pull
cd fast5
npm install
npm run dev      # then open http://localhost:5173 in Chrome or Safari
npm run build    # production build in dist/ (npm run preview serves it)
```

Run the npm commands inside the `fast5` folder (an `ENOENT ... package.json` error means you're in
the wrong folder). Everything the game needs is in the repo, including the built map; you only
need the map tools below to change or rebuild it.

### The UI

The HUD and every screen on top of the game (crew select, cutscene letterbox and captions, moment
banners, radio calls, end screens) are drawn by [Rive](https://rive.app), from the scene files in `ui/`
(Rive Markup Language, plain text). `npm run ui:build` compiles them into `public/ui/fast5.riv` with the
[Rive CLI](https://rive.app/docs/cli/overview), which you only need to change the UI: the built file
is in the repo. `rive ui` opens a live preview that rebuilds as you edit. `ui/CONTRACT.md` lists the
values the game sends it. Without the file (or with `?htmlhud`) the game falls back to its HTML HUD.

### The Rive build (in progress)

`game/` is the game being rebuilt entirely in Rive: the city, Dom's Charger and Brian's Skyline, the vault and its cables
(elastic, fraying, snapping) run as AnimaScript inside one Rive file, drawn through Rive's GPU API.
So far it's the tow: drag the vault up Avenida Ponce de León without snapping the cables. With the
[Rive CLI](https://rive.app/docs/cli/overview) installed, `rive game` from the repo root opens it in
a window. See [`game/README.md`](game/README.md) for the keys and the test runs.

### The map

`src/map/sanjuan.json` is built from OpenStreetMap by `tools/map/`:

```bash
npm run map:fetch   # download the OSM data for the area (assets-src/osm/, ~35 MB, a few minutes)
npm run map:build   # turn it into src/map/sanjuan.json
```

`tools/map/config.mjs` sets the area (Hato Rey, plus the bridge approach slid over to meet it,
cutting out 1.2 km of plain expressway), where the police HQ stands on Ponce de León, Mia's route,
and where the spike strip and the swap point go. The build makes every crossing an intersection,
merges the expressway's two carriageways into one road, cuts buildings back to the sidewalk where
our streets are wider than the real ones, and places the bank on the corner where the route turns.

## How to play

Pick **Dom Toretto** (heavy, powerful) or **Brian O'Conner** (light, sharp). Your partner drives
the other car, chained to the same vault, as your wingman: it holds its place beside you and goes
wherever you go, tucking in behind you where there's no room. Anything that ends up between your
cars and the vault (a car you overtake, a cruiser that cuts in) is crushed and thrown clear, so it
can't jam the rig. Nosed into a wall? Hold the gas and steer: the car spins round on the spot in a
burnout. If the crew still gets nowhere for a few seconds, it's lined back up on the street.

0. **Cutscene:** Hobbs and Elena ram the station wall in an armored truck; you back in and hook up.
1. **The Pull:** hold the throttle to fill the STRAIN meter until the vault tears out through the wall.
   Watch for the spike strip (take the gap Mia calls) and the bank on the corner (handbrake through the
   turn to throw the vault into the lobby). See [`docs/MOMENTS.md`](docs/MOMENTS.md) for all set pieces.
2. **Chase:** get to the bridge by any road. The GPS (arrow, minimap line and gold chevrons on
   the road) shows Mia's route, which passes the set pieces, and reroutes the moment you take
   another street; columns of light mark the bank, the tunnel and the swap point. Swing the vault into cop
   cars to wreck them (handbrake, then let the vault fly wide): a swing that connects is worth
   extra and now and then gets a slow-motion replay, wrecks in quick succession are streaks worth
   more, and every wreck refills nitrous. Watch for civilian traffic. Heat rises with time and destruction, and the news follows.
   Once the heat is up, the police throw a roadblock across your route, and another a while after
   each one: ram it or swing the vault through it.
   **The swap:** past the bank, the expressway dives into a tunnel where Han and Roman wait with a
   box truck and a decoy. Drive in: Han drops the gate behind you, the real vault is winched up into
   the truck and your cables go onto the decoy (a cutscene; Enter skips it). From there you're
   dragging an empty safe, and the cops come through the gate after it.
3. **Don't get boxed in:** if cops pin you at low speed, the BUSTED meter fills (a tip tells you
   how to break out).
4. **Bridge:** Mia's route runs down Ponce de León, left onto the Piñero expressway, through the
   tunnel and the toll plaza and onto the Moscoso bridge. The police have walled off the far end with
   two rows of cruisers, and more are coming up behind. Partway across your partner calls it: too
   many, you have to split up. They unhook, spin round and lead the pack away, and you're left with
   the vault stopped dead on one cable: hold **Shift** for nitrous to fill the SOLO PULL meter and get
   it rolling (gas alone won't do it). Then it swings like a wrecking ball: break the wall and reach
   the yellow gantry out over the lagoon.
5. **Rank:** the end screen grades the run (S, A, B or C) on style, takedowns, damage, time and
   challenges, and shows your best. The first runs coach you through the controls; every run starts
   by listing its three challenges.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake (and swings the vault wide) |
| Shift / N | Nitrous: refills from wrecks, dodges and big moments |
| R | Reset the convoy to the middle of the street (if stuck) |
| C | Camera: overhead (the default), behind the vault, or close behind the car |
| Enter | Start / skip cutscene / retry |

**Gamepad** (standard mapping): left stick steers, right trigger accelerates, left trigger brakes
and reverses, A or RB is the handbrake, B, X or LB fire nitrous, Y cycles the camera, View/Back
resets the convoy, Start skips and retries. It rumbles on hits.

Sound and voiceover start after your first key press (browser rule). Voices use your
browser's built-in text-to-speech.

Models are credited in [`assets-src/README.md`](assets-src/README.md) (CC BY and CC BY-NC-SA, via
Sketchfab). `?procedural` runs with the old code-built cars instead. Map data © OpenStreetMap
contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). The UI
uses the Barlow Condensed and Inter typefaces (SIL Open Font License, in `ui/fonts/`).

Debug URL flags: `?crew=dom|brian` skips the menu and cutscene (add `&intro` to watch it),
`?view=chase` starts behind the car instead of overhead,
`?autopilot` follows the GPS (`?autopilot=detour` disobeys it at random intersections to test
rerouting, `?autopilot=wander` turns at random), `?nocops` disables police, `?at=bank`, `?at=tunnel`,
`?at=bridge` and `?at=split` start the chase short of the bank, short of the tunnel, at the foot of
the bridge, and just short of where the crew splits up (the last two with the swap done), `?roadblock`
sets up a roadblock as soon as there's a straight for it,
`?timescale=4&renderEvery=8` runs the simulation faster for automated tests, `?cam=x,y,z,lookX,lookY,lookZ`
holds the title-screen camera at a point (for looking round the map), and `?capture` steps the
game only when `window.fast5Frame(n)` is called (fixed 1/30 s frames) for recording smooth clips
headlessly. `window.fast5()` in the
console returns a state snapshot, including partner-quality stats (`partnerQuality`) and what the
partner is currently doing (`partnerThinks`), hard hits on the player's car (`impacts`), time spent
stuck (`stuck`: the player pushing but not moving, the vault wedged, the partner out of place), cars
thrown out of the rig (`rigThrows`), automatic resets after getting stuck (`resets`), the set pieces'
state (`bank`, `roadblock`, `swap`, `finale` with the solo pull's strain, `policeHeld`) and the GPS
reroute log (`rerouteLog`).

## Code layout

- `src/main.ts`: game setup, mission state machine, camera, effects and sound hookup
- `src/overhead.ts`: the bird's-eye camera (fixed along the street grid, look-ahead, speed zoom)
- `src/graphics.ts`: renderer, sky, environment lighting, bloom, tilt-shift and color grade, Rio's mountains
- `src/cutaway.ts`: dissolves buildings that would hide the player from the overhead camera
- `src/groundfx.ts`: light and shade painted on the road (lamp pools, headlights, strobes, contact shadows)
- `src/breach.ts`: the opening set piece (armored truck, station cops, cutscene shots)
- `src/cutscene.ts`, `src/voice.ts`, `src/videos.ts`: cutscene player, voiceover, optional video cutscenes
- `src/partner.ts`: the partner as a wingman: holds a place beside you (in from walls, single file where it's tight or a spike strip is in its lane), catches up along your trail, and is put back if wedged
- `src/rig.ts`: keeps the inside of the rig clear: a car caught between the hero cars and the vault is thrown out of the side
- `src/roadmap.ts`: the map (`src/map/sanjuan.json`): street graph, "where am I on the road" queries, set-piece frames
- `src/roads.ts`: the street network as the AI sees it (lanes along curved streets, intersections, route turns, bend speeds)
- `src/gps.ts`: GTA-style navigation: shortest route over the street graph, live rerouting
- `src/moments.ts`: the set pieces (The Pull, Spike Strip, Bank Job, roadblocks, the bridge finale: the split and the solo pull)
- `src/tunnel.ts`: the swap in the tunnel (Han and Roman's truck, the decoy, the gate, the cutscene)
- `src/director.ts`: slow motion and cinematic camera shots for big moments
- `src/broadcast.ts`, `src/chopper.ts`: RIO 24H's news breaks, and its helicopter and searchlight
- `src/traffic.ts`: civilian cars driving the lanes round the chase
- `src/coach.ts`: tips on the first runs, the run's challenges, nudges when boxed in or stuck
- `src/run.ts`: score, rank, challenges and the records kept in the browser
- `src/fx.ts`, `src/audio.ts`: sparks, dust, tire smoke, skid marks, glass, banknotes, nitrous flames;
  synthesized engine, sirens, crashes, screech, alarm
- `src/vehicle.ts`: rigid-body car with arcade handling
- `src/assets.ts`, `src/carModel.ts`: downloaded car models (Dom's Charger, Brian's Skyline, the cruisers) with
  spinning/steering wheels, brake lights and light bars; procedural fallbacks; Hobbs's armored truck
- `tools/assets/`: the model pipeline (Blender clean-up, then meshopt/WebP compression) that builds
  `public/models/` from the downloads listed in [`assets-src/README.md`](assets-src/README.md)
- `src/vault.ts`: the vault and the winch cables (damped springs with a slip clutch and a rope-joint hard stop)
- `src/city.ts`: the city from the map: streets with Rio wave-mosaic sidewalks, lane lines, stop lines,
  turn arrows and working traffic lights; real buildings (tiled pitched roofs on the houses, balconies,
  shop awnings, rooftop tanks, penthouses, pools and masts), parks, police HQ with breakable wall, the bank,
  props (palms, lamps, benches, bins, kiosks, parked cars), the expressway tunnel, the bridge and toll plaza,
  seawalls, the distant city
- `src/architecture.ts`: building parts from footprints (pitched roofs, parapets, balconies, awnings)
- `src/vegetation.ts`: soft rounded trees in Rio's colours, shrubs and palms
- `tools/map/`: fetches OpenStreetMap data and builds the map (see "The map" above)
- `ui/`: the Rive UI scenes (RML) and fonts; `src/riveui.ts` loads the built file over the game and `src/hud.ts` feeds it
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
