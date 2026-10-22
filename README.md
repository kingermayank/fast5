# Fast5 — The Vault

A browser fan game recreating the vault-heist finale of *Fast Five*: Dom's black Charger and
Brian's blue Skyline chained to a ten-ton vault, ripping it out of a Rio police station and dragging it through the
city with every cop on Reyes's payroll in pursuit.

The city is real: the film shot its "Rio" vault chase in San Juan, Puerto Rico, on Avenida Ponce
de León through Hato Rey's Golden Mile, and ended it on the Teodoro Moscoso Bridge. The map is those
streets and buildings (with their real heights) from OpenStreetMap, dressed as Rio, with Christ the
Redeemer on Corcovado at the end of the avenue and Sugarloaf out in the bay.

You play it from above, on a rainy night: a 2.5D camera at a steep slant rides behind the convoy
(forward is always up the screen), looking ahead as you speed up. The city is lit by its own lights:
rows of street lamps down every street throw warm pools across wet, cracked asphalt and the mosaic
sidewalks, the puddles mirror the lamps, headlights cut beams through the rain, police strobes wash
red and blue over everything near them, and civilian traffic fills the lanes. Buildings between the
camera and your car dissolve so you never lose it. C switches to the chase camera behind the car.
`?dusk` brings back the golden-hour look the game first had.

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

0. **Cutscene:** Hobbs and Elena smash through the barrier and ram the station wall in an armored
   truck, then hold the cops off while you back in and hook up.
1. **The Pull:** hold the throttle to fill the STRAIN meter until the vault tears out through the wall.
   Watch for the spike strip (take the gap Mia calls) and the bank on the corner (handbrake through the
   turn to throw the vault into the lobby). See [`docs/MOMENTS.md`](docs/MOMENTS.md) for all set pieces.
2. **Chase:** get to the bridge by any road. The GPS (arrow, minimap line and gold chevrons on
   the road) shows Mia's route, which passes the set pieces, and reroutes the moment you take
   another street; columns of light mark the bank, the swap under the overpass and the far end of the bridge. Swing the vault into cop
   cars to wreck them (handbrake, then let the vault fly wide): a swing that connects is worth
   extra and now and then gets a slow-motion replay, wrecks in quick succession are streaks worth
   more, and every wreck refills nitrous. Watch for civilian traffic. Heat rises with time and destruction, and the news follows.
   Once the heat is up, the police throw a roadblock across your route, and another a while after
   each one: ram it or swing the vault through it.
   Halfway across town, two police cars that aren't come up behind you (green markers): Roman and
   Han, ramming real cruisers off the road for half a minute before they go on ahead.
   Once the heat's up, police motorbikes come in pairs: quick, weaving up either side of you, and
   one touch of the vault throws the rider clear (BIKE DOWN). At one crossing a city bus pulls out
   across your path: go round its tail for a NEAR MISS. People on the corners scatter as you come
   through, café tables and parasols go flying, and bus shelters lose their glass.
   **The swap:** past the bank, the expressway runs under the Barbosa overpass (the real one, where
   Avenida Barbosa crosses the Piñero expressway on a bridge). Gisele's garbage truck is parked under
   the deck with its hopper up and its ramp down: in slow motion, line the vault up with the ramp (the
   LINE UP meter and the line on the road). Then the cars straddle the truck, the vault rides up into
   it, Tej pulls the pins and the hopper comes down; Han and Roman clip the dragged hooks onto the
   decoy waiting under a tarp in front of the truck, and you pull it out into the rain (a cutscene;
   Enter skips it). From there you're dragging an empty safe, and the cops come under the overpass
   after it and race straight past the garbage truck.
3. **Don't get boxed in:** if cops pin you at low speed, the BUSTED meter fills (a tip tells you
   how to break out).
4. **Bridge:** Mia's route runs down Ponce de León, left onto the Piñero expressway, under the
   Barbosa overpass, through the toll plaza and onto the Moscoso bridge, with every cop in the city
   behind you. The bridge never ends: past where the real one lands it runs straight on across the
   bay into the haze. A kilometre out it's too many to drag ten tons through, and (as in the film)
   your character makes the call: a remote release pops the latch on your partner's cable in a spray
   of sparks, and your partner, cut loose, goes on across the bridge alone. You throw the car round
   through 180 degrees past the vault to face the pack, which pulls up in a line across the deck.
   The vault's stopped dead on one cable: hold **Shift** for nitrous to fill the SOLO PULL meter and
   get it rolling (gas alone won't do it). Then the line comes at you head-on, and Reyes's black SUVs
   come through it with gunmen in the sunroofs. **Space** is a flail now: it throws the vault at
   whatever's nearest (Reyes first). Cruisers you hit near the rail go into the bay. Swing it into
   Reyes's SUV (the red marker) for the last scene: your partner back, Hobbs, a day's head start, and
   what's really in that safe.
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

Sound and voiceover start after your first key press (browser rule). The dialogue is recorded in
original voices designed for each character with ElevenLabs (not the film cast's voices), clean for
people on screen and through a radio filter for calls; the police radio chatters in Portuguese under
the chase (stock voices from the ElevenLabs library). A line that has no recording yet falls back to
the browser's text-to-speech. `tools/voice/script.json` is the script; `node tools/voice/build.mjs plan`
lists the takes and `build <dir>` turns recordings into `public/voice/` and its `lines.json`.

Models are credited in [`assets-src/README.md`](assets-src/README.md) (CC BY and CC BY-NC-SA, via
Sketchfab). `?procedural` runs with the old code-built cars instead. Map data © OpenStreetMap
contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). The UI
uses the Barlow Condensed and Inter typefaces (SIL Open Font License, in `ui/fonts/`).

Debug URL flags: `?crew=dom|brian` skips the menu and cutscene (add `&intro` to watch it),
`?view=chase` starts behind the car instead of overhead, `?dusk` plays it at golden hour instead of a rainy night,
`?autopilot` follows the GPS (`?autopilot=detour` disobeys it at random intersections to test
rerouting, `?autopilot=wander` turns at random), `?nocops` disables police, `?at=bank`, `?at=tunnel`,
`?at=bridge` and `?at=split` start the chase short of the bank, short of the overpass (the swap), at the foot of
the bridge, and just short of where the crew splits up (the last two with the swap done), `?at=fight` drops you into the fight on the
bridge as the vault rolls free (the swap done, the partner gone), `?at=finale` straight to the last
swing and the closing scene, `?bikes` makes the first police a pair of motorbikes, `?roadblock`
sets up a roadblock as soon as there's a straight for it,
`?timescale=4&renderEvery=8` runs the simulation faster for automated tests, `?cam=x,y,z,lookX,lookY,lookZ`
holds the title-screen camera at a point (for looking round the map), and `?capture` steps the
game only when `window.fast5Frame(n)` is called (fixed 1/30 s frames) for recording smooth clips
headlessly. `window.fast5()` in the
console returns a state snapshot, including partner-quality stats (`partnerQuality`) and what the
partner is currently doing (`partnerThinks`), hard hits on the player's car (`impacts`), time spent
stuck (`stuck`: the player pushing but not moving, the vault wedged, the partner out of place), cars
thrown out of the rig (`rigThrows`), automatic resets after getting stuck (`resets`), the set pieces'
state (`bank`, `roadblock`, `swap` and `lineup`, `finale` with the solo pull's strain and the cars
sent into the bay, `reyes`, `allies`, `lastScene`, `policeHeld`), the street life (`cafes` knocked over,
`bikes` and how far off they are, `people` scattered, the `bus`) and the GPS reroute log (`rerouteLog`).

## Code layout

- `src/main.ts`: game setup, mission state machine, camera, effects and sound hookup
- `src/overhead.ts`: the bird's-eye camera (fixed along the street grid, look-ahead, speed zoom)
- `src/graphics.ts`: renderer, sky, environment lighting, bloom, tilt-shift and color grade, Rio's mountains
- `src/look.ts`: the time of day (a rainy night, or `?dusk`)
- `src/streetlight.ts`: the street light map: the city's lights drawn top-down each frame and read by every lit surface; the wet road's lamp reflections
- `src/rain.ts`: rain streaks and splashes, lit by whatever light they fall through
- `src/cutaway.ts`: dissolves buildings that would hide the player from the overhead camera
- `src/groundfx.ts`: the city's lights for the street light map (lamp pools, headlights, strobes, the searchlight), headlight beams in the rain, contact shadows and the route on the road
- `src/breach.ts`: the opening set piece (armored truck, station cops, cutscene shots)
- `src/cutscene.ts`, `src/voice.ts`, `src/videos.ts`: cutscene player, voiceover (recorded lines, queued, over the radio or clean), optional video cutscenes
- `src/policeradio.ts`: the police band under the chase, in Portuguese
- `src/partner.ts`: the partner as a wingman: holds a place beside you (in from walls, single file where it's tight or a spike strip is in its lane), catches up along your trail, and is put back if wedged
- `src/rig.ts`: keeps the inside of the rig clear: a car caught between the hero cars and the vault is thrown out of the side
- `src/roadmap.ts`: the map (`src/map/sanjuan.json`): street graph, "where am I on the road" queries, set-piece frames
- `src/roads.ts`: the street network as the AI sees it (lanes along curved streets, intersections, route turns, bend speeds)
- `src/gps.ts`: GTA-style navigation: shortest route over the street graph, live rerouting
- `src/moments.ts`: the set pieces (The Pull, Spike Strip, Bank Job, roadblocks, the bridge finale: the split (the latch, the turn to face the pack), the solo pull, the head-on fight and the flail)
- `src/swap.ts`: the swap under the Barbosa overpass (the line-up, the parked garbage truck, the pins, the decoy under its tarp, the cutscene and the drive-by)
- `src/garbageTruck.ts`: the swap truck (hopper on rams, ramp, beacons; a made-up city livery)
- `src/reyes.ts`: Reyes's SUVs on the bridge (driving alongside, the gunmen and their fire, being hit by the vault)
- `src/finale.ts`: the last scene (the last swing, Hobbs, the head start, the empty vault, payday in the hideout)
- `src/allies.ts`: Roman and Han's fake police cars that ram real ones mid-chase
- `src/overboard.ts`: cars thrown over the bridge rail into the bay
- `src/people.ts`: the little crew figures (overalls, poses: wave, beckon, cheer, reach)
- `src/bikes.ts`: the police motorbikes (model, rider, the rider thrown clear and sitting up)
- `src/pedestrians.ts`: people on the route's corners who stare, scatter and dive (drawn instanced)
- `src/bus.ts`: the city bus that pulls across a crossing on the route, passengers watching
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
  props (palms, lamps, benches, bins, kiosks, parked cars), the Barbosa overpass and its ramps, the bridge and toll plaza,
  seawalls, the distant city
- `src/architecture.ts`: building parts from footprints (pitched roofs, parapets, balconies, awnings)
- `src/vegetation.ts`: soft rounded trees in Rio's colours, shrubs and palms
- `tools/map/`: fetches OpenStreetMap data and builds the map (see "The map" above)
- `ui/`: the Rive UI scenes (RML) and fonts; `src/riveui.ts` loads the built file over the game and `src/hud.ts` feeds it
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
