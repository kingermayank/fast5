# Fast5

A 3D arcade racing game that runs in the browser, built with [Three.js](https://threejs.org/), TypeScript and Vite.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake / reverse |
| A D / ← → | Steer |
| Space | Handbrake (drift) |
| R | Reset car onto the track |
| C | Switch camera (chase / bumper) |
| Enter | Start / restart race |

## Code layout

- `src/main.ts` — renderer, scene, game loop, race state (countdown, laps, finish), camera
- `src/car.ts` — car model and arcade driving physics
- `src/track.ts` — circuit layout, road/curb/barrier geometry, scenery, track-position lookup
- `src/hud.ts` — speed, lap, timers, minimap
- `src/input.ts` — keyboard input
- `src/textures.ts` — procedurally drawn textures (no image assets needed)

The track is a closed Catmull-Rom spline defined by `LAYOUT` in `src/track.ts` — edit those points to reshape the circuit.
