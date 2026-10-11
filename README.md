# Fast5 — The Vault

A browser game inspired by the vault-heist finale of *Fast Five*: two muscle cars chained to a
four-ton bank vault, ripping it out of a police station and dragging it through the city with
every cop in Porto Sol in pursuit.

Built with [Three.js](https://threejs.org/), [Rapier](https://rapier.rs/) physics, TypeScript and Vite.
All names, characters and places are original; see [`docs/DESIGN.md`](docs/DESIGN.md) for the
research notes, design and roadmap.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## How to play

Pick **Rico Santos** (heavy, powerful) or **Cole Mercer** (light, sharp). Your AI partner drives the
other car, chained to the same vault.

1. **Breach:** floor it and rip the vault out through the station wall.
2. **Chase:** follow Lena's route (yellow arrow + minimap) to the bridge. Swing the vault into cop
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

Debug URL flags: `?crew=rico|cole` skips the menu and intro, `?autopilot` drives the route
automatically, `?nocops` disables police. `window.fast5()` in the console returns a state snapshot.

## Code layout

- `src/main.ts`: game setup, mission state machine, partner AI, camera
- `src/vehicle.ts`: rigid-body car with arcade handling
- `src/carModel.ts`: car meshes (hero cars, police cruisers)
- `src/vault.ts`: the vault and the winch cables (Rapier rope joints)
- `src/city.ts`: Porto Sol: street grid, buildings, police HQ with breakable wall, props, bridge, route
- `src/police.ts`: police spawning, pursuit and wrecks
- `src/ai.ts`: shared steering helpers (seek, obstacle avoidance)
- `src/hud.ts`: HUD, minimap, radio, cutscene cards, character select
- `src/physics.ts`, `src/input.ts`, `src/textures.ts`: plumbing
