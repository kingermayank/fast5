# Fast5 — The Vault

A browser fan game recreating the vault-heist finale of *Fast Five*: Dom and Brian's Chargers
chained to a four-ton vault, ripping it out of a Rio police station and dragging it through the
city with every cop on Reyes's payroll in pursuit.

Built with [Three.js](https://threejs.org/), [Rapier](https://rapier.rs/) physics, TypeScript and Vite.
Uses the film's character names; all models, dialogue, sound and cutscenes are made for this
project (no footage, music, logos or likenesses from the film). See [`docs/DESIGN.md`](docs/DESIGN.md)
for the research notes and design, and [`docs/FIDELITY.md`](docs/FIDELITY.md) for what the best
open-world and racing games do and the plan to get Fast5 there.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

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
4. **Bridge:** reach the yellow gantry at the far end.

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
Sketchfab). `?procedural` runs with the old code-built cars instead.

Debug URL flags: `?crew=dom|brian` skips the menu and cutscene (add `&intro` to watch it),
`?autopilot` follows the GPS (`?autopilot=detour` disobeys it at random intersections to test
rerouting, `?autopilot=wander` turns at random), `?nocops` disables police,
`?timescale=4&renderEvery=8` runs the simulation faster for automated tests, and `?capture` steps the
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
- `src/partner.ts`: the AI partner: reads the street grid and the live GPS route, predicts your turns, plans its own lane, steers around cops/props/the vault, steadies the vault's swing
- `src/roads.ts`: the street network as the AI sees it (lanes, intersections, route turns)
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
- `src/vault.ts`: the vault and the winch cables (damped springs with a rope-joint hard stop)
- `src/city.ts`: Rio: street grid, buildings, police HQ with breakable wall, props, bridge, route
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
