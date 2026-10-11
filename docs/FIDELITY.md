# Fast5: Getting to "GTA-level" fidelity

Playtest feedback: the game was hard to play. The car kept getting into crashes. The partner couldn't
follow the route. It also forced you down Mia's exact streets: take another road and meet up later,
and the arrow, Mia and the partner all kept insisting on the turn you'd missed.

"Fidelity" in the games we're comparing against comes less from polygons than from systems that
respect what the player means to do. This doc covers three things:

- what the best open-world and racing games do;
- where Fast5 fell short of that;
- what this pass changed, how it measures, and the roadmap for the rest.

## 1. What the best games do

### Navigation: go anywhere, the GPS keeps up (GTA)

- **Objectives are places, not checkpoint chains.** You're told *where* to go. The GPS draws the
  shortest route on the road graph from wherever you are, and **recalculates the moment you leave
  it**. Any road that gets you there counts.
- **The radar rotates with you**, so a turn on the minimap is the same turn on the road. The route is
  a bright line on it, and points of interest are blips.
- **Set pieces trigger by location.** A scripted moment happens when you arrive at it, from whichever
  street you took. It never depends on having passed checkpoint *n*.

### Handling: generous, readable, assisted

- **GTA's `handling.meta`** describes each car with a few numbers: mass, drive force, brake force,
  steering lock, and traction curve max/min. The traction curve is the tyre grip in g, about 2.0–2.6
  for sports cars, which is far more than a real road car (~1 g). Push past the peak slip angle and
  grip falls away: the car understeers, scrubs speed and runs wide rather than turning any tighter.
- **Marco Monster, "Car Physics for Games"**, the standard primer. Lateral tyre force comes from the
  slip angle and peaks at a few degrees. Weight shifts forward under braking (more front grip, so
  brake to turn in) and backward under power. Front versus rear grip decides understeer or oversteer.
- **Criterion (Burnout/NFS), GDC "Vehicle Feel Masterclass".** Feel comes from physics, camera,
  audio and effects working together. Tune for what the player *meant*, not for realism. The camera
  matters as much as the tyres.
- **Assists are universal.** Racing games give keyboard and pad steering an ease-in and
  speed-sensitive lock. They also add stability, traction and braking assists, and they tune all of
  it per input device.

### Collisions: simplified in the player's favour

- **Teammates are ghosted or bias-weighted**, so your partner can't punt you off the road.
- **The player's car "wins" contacts** with AI cars (mass bias). A hit is a shove with a crunch and a
  camera kick, not a spin you can't recover from.
- **Burnout's takedown magnetism**: when you commit to a big moment, the game quietly helps it land.

### AI drivers

- They follow the road graph's lanes, predict where the player is going, and adapt to the player's
  skill.
- *Pure* used "Dynamic Competition Balancing" instead of blatant rubber-banding.
- Teammate AI gets catch-up help and off-screen recovery.

### Police: escalating tactics, fair rules (GTA V, NFS Most Wanted)

- **Wanted levels escalate tactics**, not just numbers:
  - chasers, then ramming and PIT manoeuvres, then box-ins;
  - roadblocks and spike strips (GTA V from 3★), helicopters, heavy units.
  - NFS adds heavy SUVs ("Rhinos"), pursuit breakers and a cool-down phase.
- **Cops perceive the world.** They have line of sight, a last known position, and search when they
  lose you.
- **Arrest only when you stop.** You're never busted while moving. Fast5's BUSTED meter already
  works this way.
- **Threats ahead are telegraphed.** Roadblocks are visible from far away and the radio warns you.
  Cops don't pop out of the side street you're about to drive past.

### Camera

- **The chase cam follows travel direction with smoothing.** It doesn't track the car's exact
  heading, so slides and impacts don't whip it.
- **It pulls in when geometry blocks the view** and eases back out. It has several distances, toggled
  with GTA's V key.
- **Framing scales with the vehicle.** Towing a trailer pulls the camera back so you can see the
  trailer, as in GTA and the truck sims.

### World life

- Ambient traffic and pedestrians run on the same path-node graph the GPS uses, and they react: they
  flee and honk.
- Lots of smashable props, plus time of day and weather.
- Density is managed around the player so it stays cheap.

## 2. Where Fast5 fell short (before this pass)

| Area | How it worked | What the player felt |
| --- | --- | --- |
| Navigation | Fixed list of 9 waypoints; the next one only advanced within 30 m of it. The partner predicted turns from that list | Any detour broke everything: the arrow pointed back at the missed corner, Mia kept calling it, and the partner predicted the wrong turns. "It's not letting me take another way" |
| Bank set piece | Triggered only if `waypoint === 2` | Reach the bank from another street and it never happened |
| Camera | 14 m behind, 6 m up, locked to the car's heading | The vault trails ~14 m behind the car, so the camera sat **right on top of it**: you couldn't see the vault you're meant to swing. Every yank whipped the view |
| Cables | Rapier rope joints: slack, then perfectly rigid | Each time a cable snapped taut, the whole yank landed in one 1/60 s physics step |
| Cops | Spawned at intersections 110–260 m away in *any* direction (including straight ahead) and rammed the lead point; mass close to the heroes' | Head-on surprises and spin-outs; the most common hard hit by far |
| Partner | A normal rigid body | Could shunt the player in tight corners |
| Handling | Yaw rate set straight from steering, with no grip limit (over 3 g of cornering at 100 km/h); keyboard steering went to full lock instantly | Twitchy at speed, then into a wall |

## 3. What this pass changed (Phase 1: playability)

**Navigation**

- **GPS with live rerouting** (`src/gps.ts`). The street grid and bridge form a graph, and Dijkstra
  runs over (intersection, arrival direction) states.
  - No U-turns, a turn penalty (straighter is better with a vault in tow), and a discount on Mia's
    planned streets, so her route is the default but never mandatory.
  - The route recalculates 0.5 s after you leave it. Mia then says "Rerouting" plus the new
    instruction.
- **Heading-up minimap** with the GPS line, the swap point and a **$ blip** for the bank. The HUD
  arrow points 40 m down the route, and the readout says "LEFT IN 80 m".
- **The partner and the test autopilot follow the live GPS route**, so the partner predicts the right
  turn even after a detour.
- **The Bank Job is position-based.** Arrive northbound on the bank's street with the GPS turning
  east, from any direction, and it fires.

**Collisions**

- **The partner is ghosted to the player** (collision groups) but still hits cops, props and the
  vault.
- **Dominance groups.** The hero cars, the vault and parked cars outrank cruisers and street
  furniture. A cop that rams you gives you a shove, a crunch and a camera kick, not a spin. Cops that
  ram a parked car stop dead.
- **Elastic cables.** A stiff, damped spring that only pulls (60 kN/m, about half critical damping)
  takes the edge off yanks; a rope joint 1.6 m further out stays as a hard stop. The winch reels in at
  4 m/s and stalls under load instead of jerking, and it free-spools while the vault is flung at the
  bank.
- **Cops spawn behind you or in side streets, out of sight.** None come straight at you down the
  street ahead.

**Handling**

- **Grip-limited cornering.** The yaw rate is capped at about 1.9 g, and the handbrake allows more,
  for drifts.
- **Understeer scrub.** Asking for more turn than the tyres can give scrubs speed instead, which
  tightens the line, as in GTA and most racers.
- **Keyboard steering eases in** over about 0.2 s and snaps back to centre faster.
- **Body pitch.** The car squats under power and dives under braking.

**Input**

- **Gamepad support** (standard mapping): analog stick steering with a dead zone and response curve,
  analog triggers, and rumble on hits and wrecks. Analog steering skips the keyboard ease-in.

**Camera**

- **Truck-and-trailer chase cam.** The default sits high and behind the vault, so you see the car,
  the vault's swing and the cops around it. **C** toggles a close cam.
- **Yaw follows the travel direction**, smoothed at about 3.5/s.
- **It pulls in instantly when a building blocks the view** (a ray cast against fixed geometry), then
  eases back out.

**Bank Job reliability**

- The handbrake fling now aims at a speed that carries the vault into the lobby from wherever the
  swing started.
- For 1.4 s, the vault ghosts the hero cars and gets a little homing, so a committed swing lands.

## 4. Results

Automated play-tests: the same autopilot driving the same build pairs, with cops on, 4× speed. A
"hard hit" is a velocity jolt over 4 m/s in one physics step (about 25 g) on the player's car.

| Per run (average of 6, Dom ×3 and Brian ×3) | Before | After |
| --- | --- | --- |
| Hard hits on the player per minute | 22.9 | **4.7** (−80%) |
| ...of which from cops (per run) | 47 | **0.3** |
| Runs that reached the swap point | 6 / 6 | 6 / 6 |
| Time from the station to the swap point | 168 s | **113 s** |
| Partner in formation (beside you, 2.5–11 m) | 58% | **66%** |
| Partner off-screen recoveries | 6.0 | 4.3 |
| Bank Job pulled off by the autopilot | 5 / 6 | 5 / 6 |
| Cops wrecked | 60 | 19 |

The last row is a trade-off. Most wrecks used to come from cops charging head-on into the convoy;
now they come from behind and meet the vault. Phase 3's telegraphed roadblocks will put targets back
in front of the player, but as a choice rather than an ambush.

The "hard hits" that remain are walls and kerbs on corners: the autopilot is a fairly clumsy driver.
A hit near the partner counts in this measure too, but the partner is ghosted, so those are walls and
props as well.

Detour test: an autopilot that disobeys the GPS at about a third of intersections. Two runs recorded
11 and 6 reroutes. Both reached the swap point with the partner in formation 65–70% of the time. In
the run with the reroute log on, all 6 reroutes were genuine wrong turns, with no false alarms.

## 4b. Art pipeline (started)

- **Decisions:** golden-hour Rio; runs well on a MacBook Air/Pro; no paid assets (models come from
  free Sketchfab downloads you provide).
- **Pipeline** (`tools/assets/`): Blender as a Python module cleans each download (strips rigs and
  helpers, fixes scale, faces +z, ground origin, one body mesh per material plus four pivoted wheels,
  optional simplification), then glTF Transform compresses it (meshopt geometry, WebP textures).
  The four models went from 34 MB to 4.8 MB.
- **In the game:** Dom's 1970 Charger, Brian's R34 Skyline and Crown Victoria cruisers (simplified to
  45k triangles for up to ten on screen), with spinning and steering wheels, brake lights, a flashing
  light bar, clear-coat paint and cheap tinted glass; Christ the Redeemer on the peak.
- **Budget check** (1280×720): about 0.7–0.8M triangles and 600–1,200 draw calls in the chase. The
  breach peaks near 2,200 draw calls because every station brick is its own object; instancing them
  is the next performance fix.
- **Map (proposed):** the film's chase was shot in San Juan, Puerto Rico (Avenida Ponce de León at
  Calle Betances through Hato Rey, then the Teodoro Moscoso Bridge). Rebuild those streets from
  OpenStreetMap, dressed as Rio.

## 5. Roadmap to the rest of the way

Each phase has a measurable "done when", checked with the same automated play-tests.

### Phase 2: handling depth

- Tyre model with slip angles per axle and a traction curve (handling.meta-style data per car).
- Weight transfer, so brake-to-turn-in works.
- Traction and stability assists with an **Assists: Full / Light / Off** setting.
- Gamepad polish: steering sensitivity and dead-zone options, and rumble from road surface and kerbs
  (basic gamepad support is in).
- Drift tuning for the handbrake swing.
- *Done when:* the autopilot is under 2 hard hits per minute (4.7 now), and a human on Light assists
  can take the route at speed without clipping walls on most corners.

### Phase 3: police with tactics

- Perception: line of sight, last known position, search.
- Roles: chaser, blocker, PIT attempt (telegraphed by a wobble and siren whoop).
- **Roadblocks placed on the GPS route ahead**, seen from 200 m and called by Mia, with a gap or a
  side street to take.
- Spike-strip teams, a helicopter at 4★, heavy SUVs at 5★.
- The busted rules stay as they are: only when stopped.
- *Done when:* in play-tests every hard hit from a cop comes from a threat that was on screen or
  called on the radio first.

### Phase 4: world life

- Ambient traffic on the lane graph that `roads.ts` already has, plus pedestrians who dive clear.
- More smashables and pursuit breakers (scaffolding, fruit stands, bus shelters) that wreck pursuing
  cops.
- **Damage model** for the hero cars: dents, smoke, a wobbling wheel, and an "engine" health bar that
  NOS strains.
- Performance budget: instancing, LOD, a physics sleep radius.
- *Done when:* 60 fps on a mid-range laptop with traffic on.

### Phase 5: presentation

- Licensed or modeled glTF cars, Rio landmarks, better materials and lighting (SSAO, reflections).
- Engine audio driven by RPM and gear, layered tyre squeal, a Doppler shift on sirens, an
  intensity-layered score.
- Crash cams and an end-of-run replay.

### Phase 6: the rest of the story

- The remaining moments in [`MOMENTS.md`](MOMENTS.md): the Swap, Cut Loose, the solo NOS drag, the
  Wrecking Ball and Brian's return.
