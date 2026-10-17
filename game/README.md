# Fast5 in Rive

The game rebuilt as a single Rive file: the city, the cars, the vault and its
cables are drawn by AnimaScript (`src/*.as`, compiled to wasm) through Rive's
GPU API (`shaders/*.wgsl`), under a HUD authored in RML (`main.rml`).

- `src/game.as`: the loop, input, camera, HUD state.
- `src/physics.as`: rigid bodies on the ground plane, substepped XPBD.
- `src/car.as`: tyre forces, load transfer (including the cable's pull at the hitch), traction control.
- `src/vault.as`: the vault's corner friction, rocking and mesh.
- `src/cable.as`: the tow cables: elastic tether, winch with slip clutch, fraying and snapping, the strand's shape.
- `src/citymesh.as`, `src/map.as`, `src/world.as`: the city from the OpenStreetMap data, and its collision.
- `src/render.as`: shadow map, lit pass with MSAA, particles.

`assets/` is generated: `node tools/rive/pack-map.mjs` and `node tools/rive/pack-models.mjs`
(from the repo root) rebuild the map and the car meshes.

## Working on it

```bash
rive game                       # live preview window
rive game --verify              # compile check
rive game --screenshot --advance=200 --data=autopilot=1   # headless frame of a scripted drive
rive game --publish             # signed build for the web (needs `rive login`)
```

`--data=autopilot=2` runs the yank test on the Expreso Piñero (launch from slack cables),
and `--data-dump=out.jsonl --data-dump-every=15` records the HUD values over a run.
Web runtimes only play files built with `--publish`: scripts must be signed.
