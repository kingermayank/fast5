# Fast5 — The Vault

A browser fan game recreating the vault-heist finale of *Fast Five*: Dom and Brian's Chargers
chained to a four-ton vault, ripping it out of a Rio police station and dragging it through the
city with every cop on Reyes's payroll in pursuit.

The city is real: the film shot its "Rio" vault chase in San Juan, Puerto Rico, on Avenida Ponce
de León through Hato Rey's Golden Mile, and ended it on the Teodoro Moscoso Bridge. The map is those
streets and buildings (with their real heights) from OpenStreetMap, dressed as Rio, with Christ the
Redeemer on Corcovado at the end of the avenue and Sugarloaf out in the bay.

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

Pick **Dom Toretto** (heavy, powerful) or **Brian O'Conner** (light, sharp). Your AI partner drives
the other car, chained to the same vault.

0. **Cutscene:** Hobbs and Elena ram the station wall in an armored truck; you back in and hook up.
1. **The Pull:** hold the throttle to fill the STRAIN meter until the vault tears out through the wall.
   Watch for the spike strip (take the gap Mia calls) and the bank on the corner (handbrake through the
   turn to throw the vault into the lobby). See [`docs/MOMENTS.md`](docs/MOMENTS.md) for all set pieces.
2. **Chase:** get to the bridge by any road. The GPS (yellow arrow and minimap line) shows Mia's
   route, which passes the set pieces, and reroutes the moment you take another street. Swing the
   vault into cop cars to wreck them. Heat rises with time and destruction.
3. **Don't get boxed in:** if cops pin you at low speed, the BUSTED meter fills.
4. **Bridge:** Mia's route runs down Ponce de León, left onto the Piñero expressway, through the toll
   plaza and onto the Moscoso bridge: reach the yellow gantry out over the lagoon.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake (and swings the vault wide) |
| Shift / N | Nitrous: refills from wrecks, dodges and big moments |
| R | Reset the convoy to the middle of the street (if stuck) |
| C | Camera: far (see the vault swing) or close |
| Enter | Start / skip cutscene / retry |

**Gamepad** (standard mapping): left stick steers, right trigger accelerates, left trigger brakes
and reverses, A or RB is the handbrake, B, X or LB fire nitrous, Y switches the camera, View/Back
resets the convoy, Start skips and retries. It rumbles on hits.

Sound and voiceover start after your first key press (browser rule). Voices use your
browser's built-in text-to-speech.

Models are credited in [`assets-src/README.md`](assets-src/README.md) (CC BY and CC BY-NC-SA, via
Sketchfab). `?procedural` runs with the old code-built cars instead. Map data © OpenStreetMap
contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright).

Debug URL flags: `?crew=dom|brian` skips the menu and cutscene (add `&intro` to watch it),
`?autopilot` follows the GPS (`?autopilot=detour` disobeys it at random intersections to test
rerouting, `?autopilot=wander` turns at random), `?nocops` disables police,
`?timescale=4&renderEvery=8` runs the simulation faster for automated tests, `?cam=x,y,z,lookX,lookY,lookZ`
holds the title-screen camera at a point (for looking round the map), and `?capture` steps the
game only when `window.fast5Frame(n)` is called (fixed 1/30 s frames) for recording smooth clips
headlessly. `window.fast5()` in the
console returns a state snapshot, including partner-quality stats (`partnerQuality`) and what the
partner is currently thinking (`partnerThinks`), hard hits on the player's car (`impacts`) and
the GPS reroute log (`rerouteLog`).

## Code layout

- `src/main.ts`: game setup, mission state machine, camera, effects and sound hookup
- `src/graphics.ts`: renderer, sky, environment lighting, bloom and color grade, Rio's mountains
- `src/breach.ts`: the opening set piece (armored truck, station cops, cutscene shots)
- `src/cutscene.ts`, `src/voice.ts`, `src/videos.ts`: cutscene player, voiceover, optional video cutscenes
- `src/partner.ts`: the AI partner: reads the streets and the live GPS route, predicts your turns, plans its own lane, slows for bends, steers around cops/props/the vault, steadies the vault's swing
- `src/roadmap.ts`: the map (`src/map/sanjuan.json`): street graph, "where am I on the road" queries, set-piece frames
- `src/roads.ts`: the street network as the AI sees it (lanes along curved streets, intersections, route turns, bend speeds)
- `src/gps.ts`: GTA-style navigation: shortest route over the street graph, live rerouting
- `src/moments.ts`: the set pieces (The Pull, Spike Strip, Bank Job)
- `src/director.ts`: slow motion and cinematic camera shots for big moments
- `src/fx.ts`, `src/audio.ts`: sparks, dust, tire smoke, skid marks, glass, banknotes, nitrous flames;
  synthesized engine, sirens, crashes, screech, alarm
- `src/vehicle.ts`: rigid-body car with arcade handling
- `src/assets.ts`, `src/carModel.ts`: downloaded car models (Dom's Charger, Brian's Skyline, the cruisers) with
  spinning/steering wheels, brake lights and light bars; procedural fallbacks; Hobbs's armored truck
- `tools/assets/`: the model pipeline (Blender clean-up, then meshopt/WebP compression) that builds
  `public/models/` from the downloads listed in [`assets-src/README.md`](assets-src/README.md)
- `src/vault.ts`: the vault and the winch cables (damped springs with a slip clutch and a rope-joint hard stop)
- `src/city.ts`: the city from the map: streets with Rio wave-mosaic sidewalks, real buildings with
  rooftop water tanks, parks and trees, police HQ with breakable wall, the bank, props, the bridge and
  toll plaza, seawalls, the distant city
- `tools/map/`: fetches OpenStreetMap data and builds the map (see "The map" above)
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
