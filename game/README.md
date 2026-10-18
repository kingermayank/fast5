# Fast5 in Rive

The game rebuilt as a single Rive file: the city, the cars, the vault and its
cables are drawn by AnimaScript (`src/*.as`, compiled to wasm) through Rive's
GPU API (`shaders/*.wgsl`), under the original game's Rive screens and HUD.

- `ui.rml`: the `UI` artboard, from the original game's UI (`../ui/`): crew select, the
  intro and cutscene cards, the driving HUD (heat, stats, objective, route arrow, meters,
  speedometer, minimap bezel, cables), banners, Mia's radio, end screens. The game runs
  under all of it as a scripted layout.
- `data.rml`: the `Game` view model the script drives (the original UI's contract, plus the
  cables, tuning, sound cues and test switches). `main.rml`: the assets.
- `src/game.as`: the loop, the story (select, intro, drive), input, camera.
- `src/hud.as`: the view model's properties, written only when they change; banner and radio timing.
- `src/minimap.as`: the minimap in the bezel, drawn as vectors.
- `src/physics.as`: rigid bodies on the ground plane, substepped XPBD.
- `src/car.as`: tyre forces, load transfer (including the cable's pull at the hitch), traction control.
- `src/partner.as`: Brian's driver: holds formation and takes his share of the pull.
- `src/vault.as`: the vault's corner friction, rocking and mesh.
- `src/cable.as`: the tow cables: elastic tether, winch with slip clutch, fraying and snapping, the strand's shape.
- `src/citymesh.as`, `src/map.as`, `src/world.as`: the city from the OpenStreetMap data, and its collision.
- `src/render.as`: shadow map, lit pass with MSAA, particles.

`assets/` is generated: `node tools/rive/pack-map.mjs` and `node tools/rive/pack-models.mjs`
(from the repo root) rebuild the map and the car meshes: Dom's Charger, Brian's blue
Skyline and the police cruiser.

## Playing it

```bash
curl -fsSL https://releases.rive.app/cli/install.sh | sh   # the Rive CLI, into ~/.rive/bin
export PATH="$HOME/.rive/bin:$PATH"
git clone https://github.com/kingermayank/fast5.git
cd fast5
rive game
```

A window opens on the crew select while the city loads behind it. Pick Dom or
Brian (A / D or the mouse) and press Enter; Enter again skips the intro. Click
into the window if the keys do nothing.

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
rive game --screenshot --viewport=1600x900 --advance=420 --key=enter --advance=30 --key=enter --key=w:down --advance=300   # start, hold W 5 s
rive game --data=autopilot=1 --data=headless=1 --data-dump=build/run.jsonl --data-dump-every=30 --advance=1500
rive game --bench=600           # frame times with the scripts a publish ships
rive game --publish             # signed build for the web (needs `rive login`)
```

- `--data=autopilot=1` drives a scripted run up the avenue (swerves, a firm
  stop, pull away again); `--data=autopilot=2` is the yank test on the Expreso
  Piñero. Either one skips the crew select and the intro (`--data=crew=1` to
  drive Brian), and logs the cars, the vault and the cables twice a second.
- Driving by key: `--advance=420 --key=enter --advance=30 --key=enter` gets
  past the select (once the city's loaded) and the intro.
- `--data-dump` runs have no GPU: pass `--data=headless=1` so the game skips
  its uploads. They can't take `--key` either (the CLI crashes); use
  `--screenshot` runs for driving by key.
- Native runtimes stop any script call over 200 ms, so loading is spread over
  frames: the map is read, the city built and its buffers uploaded a slice at
  a time.

Web runtimes only play files built with `--publish`: scripts must be signed.
