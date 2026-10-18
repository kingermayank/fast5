# Fast5 in Rive

The game rebuilt as a single Rive file: the city, the cars, the vault and its
cables are drawn by AnimaScript (`src/*.as`, compiled to wasm) through Rive's
GPU API (`shaders/*.wgsl`), under a HUD authored in RML (`main.rml`).

- `src/game.as`: the loop, input, camera, HUD state.
- `src/physics.as`: rigid bodies on the ground plane, substepped XPBD.
- `src/car.as`: tyre forces, load transfer (including the cable's pull at the hitch), traction control.
- `src/partner.as`: Brian's driver: holds formation and takes his share of the pull.
- `src/vault.as`: the vault's corner friction, rocking and mesh.
- `src/cable.as`: the tow cables: elastic tether, winch with slip clutch, fraying and snapping, the strand's shape.
- `src/citymesh.as`, `src/map.as`, `src/world.as`: the city from the OpenStreetMap data, and its collision.
- `src/render.as`: shadow map, lit pass with MSAA, particles.

`assets/` is generated: `node tools/rive/pack-map.mjs` and `node tools/rive/pack-models.mjs`
(from the repo root) rebuild the map and the car meshes.

## Playing it

```bash
curl -fsSL https://releases.rive.app/cli/install.sh | sh   # the Rive CLI, into ~/.rive/bin
export PATH="$HOME/.rive/bin:$PATH"
git clone https://github.com/kingermayank/fast5.git
cd fast5
rive game
```

A window opens and the city loads in a few seconds. Click into it if the keys
do nothing.

| Key | |
|---|---|
| W / S | throttle / brake and reverse |
| A / D | steer |
| Space | handbrake |
| Shift | nitrous |
| R | line the convoy up again where you are |
| Tab | the tuning panel: `[` `]` pick a setting, `-` `=` change it |

The run starts on Avenida Juan Ponce de León with the vault in tow. Keep the
cables out of the red: big snatches fray them (the thin bar under each), and
past their strength they snap. The preview has no sound; the page in
`rive.html` adds it, from the view model.

## Working on it

```bash
rive game --verify              # compile check
rive game --screenshot --viewport=1600x900 --advance=2 --key=w:down --advance=300   # hold W for 5 s, then a frame
rive game --data=autopilot=1 --data=headless=1 --data-dump=build/run.jsonl --data-dump-every=30 --advance=1500
rive game --bench=600           # frame times with the scripts a publish ships
rive game --publish             # signed build for the web (needs `rive login`)
```

- `--data=autopilot=1` drives a scripted run up the avenue (swerves, a firm
  stop, pull away again); `--data=autopilot=2` is the yank test on the Expreso
  Piñero. Either one also logs the cars, the vault and the cables twice a second.
- `--data-dump` runs have no GPU: pass `--data=headless=1` so the game skips
  its uploads. They can't take `--key` either (the CLI crashes); use
  `--screenshot` runs for driving by key.
- Native runtimes stop any script call over 200 ms, so loading is spread over
  frames: the map is read, the city built and its buffers uploaded a slice at
  a time.

Web runtimes only play files built with `--publish`: scripts must be signed.
