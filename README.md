# Fast5 — The Vault

A browser fan game recreating the vault-heist finale of *Fast Five*: Dom and Brian's Chargers
chained to a four-ton vault, ripping it out of a Rio police station and dragging it through the
city with every cop on Reyes's payroll in pursuit.

Built with [Three.js](https://threejs.org/), [Rapier](https://rapier.rs/) physics, TypeScript and Vite.
Uses the film's character names; all models, dialogue, sound and cutscenes are made for this
project (no footage, music, logos or likenesses from the film). See [`docs/DESIGN.md`](docs/DESIGN.md)
for the research notes, design and roadmap.

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
1. **Breach:** floor it and rip the vault out through the hole while the cops open fire.
2. **Chase:** follow Mia's route (yellow arrow + minimap) to the bridge. Swing the vault into cop
   cars to wreck them. Heat rises with time and destruction.
3. **Don't get boxed in:** if cops pin you at low speed, the BUSTED meter fills.
4. **Bridge:** reach the yellow gantry at the far end.

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake |
| R | Reset the convoy to the middle of the street (if stuck) |
| Enter | Start / skip cutscene / retry |

Sound and voiceover start after your first key press (browser rule). Voices use your
browser's built-in text-to-speech.

Debug URL flags: `?crew=dom|brian` skips the menu and cutscene (add `&intro` to watch it),
`?autopilot` drives Mia's route (`?autopilot=wander` takes random turns), `?nocops` disables police,
`?timescale=4&renderEvery=8` runs the simulation faster for automated tests. `window.fast5()` in the
console returns a state snapshot, including partner-quality stats (`partnerQuality`) and what the
partner is currently thinking (`partnerThinks`).

## Code layout

- `src/main.ts`: game setup, mission state machine, camera, effects and sound hookup
- `src/graphics.ts`: renderer, sky, environment lighting, bloom and color grade, Rio's mountains
- `src/breach.ts`: the opening set piece (armored truck, station cops, cutscene shots)
- `src/cutscene.ts`, `src/voice.ts`, `src/videos.ts`: cutscene player, voiceover, optional video cutscenes
- `src/partner.ts`: the AI partner: reads the street grid and Mia's route, predicts your turns, plans its own lane, steers around cops/props/the vault, steadies the vault's swing
- `src/roads.ts`: the street network as the AI sees it (lanes, intersections, route turns)
- `src/fx.ts`, `src/audio.ts`: sparks, dust, muzzle flashes; synthesized engine, sirens, crashes
- `src/vehicle.ts`: rigid-body car with arcade handling
- `src/carModel.ts`: Charger-style hero cars, police cruisers, Hobbs's armored truck
- `src/vault.ts`: the vault and the winch cables (Rapier rope joints)
- `src/city.ts`: Rio: street grid, buildings, police HQ with breakable wall, props, bridge, route
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
