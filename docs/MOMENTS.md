# Fast5 — Big Moments Plan

The film's vault chase is a string of set pieces. The game should give the player each of those
"hell yes" beats through something they *do*, then pay it off with a cinematic beat (slow motion,
a cut to a dramatic camera, debris, sound). The aim isn't to copy the film shot for shot. Each moment
should be easy to understand, quick to pull off, and should feel great every time.

Every moment follows the same shape:

1. **Telegraph**: Mia calls it on the radio, the HUD shows a prompt or meter, and the world shows it
   (a strip of spikes across the road, a glass bank facade on the corner).
2. **Action window**: a short, readable input, such as holding the throttle, picking a lane,
   flicking the handbrake, or firing nitrous.
3. **Payoff**: slow motion, a camera cut, particles, a sound stinger, then a banner with a style bonus.
4. **Consequence**: momentum, nitrous refill or damage on success; a setback on failure, never a dead end.

## The moments, in order

| # | Moment | Film beat | What the player does | Payoff | Failure |
|---|---|---|---|---|---|
| 1 | **The Pull** | Chargers strain to rip the vault out | Hold throttle to fill a STRAIN meter while tires smoke and the wall cracks | Vault tears out through the bricks in slow motion, street-level cam, burst of momentum | Let go and the meter drains; no hard fail |
| 2 | **Pillar Slam** | Vault slams the pillars leaving the station | Nothing; it's the momentum from #1 | Vault clips a pillar and tumbles, debris | — |
| 3 | **Spike Strip** | Cops lay spikes; the cars dodge | Mia: "Spikes! Stay left!" Pick the gap in slow motion | Near-miss bonus, nitrous refill | Blown tire: less grip and speed, sparks from the rim for a while |
| 4 | **Bank Job** | Vault guts a bank lobby | Handbrake-swing through the corner to throw the vault into the glass bank | Slow-mo crash cam, shattering glass, banknotes in the air, alarm, $2.5M damage | You miss the bank; small "missed" note, no penalty |
| 4b | **Roadblock** | Police wall off the avenue | Mia: "Roadblock dead ahead!" Ram it, or swing the vault through it | Two-shot slow-mo replay (low at the impact, then high over the wreckage) as the cruisers go flying; every one counts as a takedown | — |
| 5 | **The Alley** | Cops follow into an alley and get crushed | Take the alley shortcut Mia offers | Rear cam: the vault scrapes both walls and flattens the cruisers behind | — |
| 6 | **Bike Cops** | Motorcycle police flank the cars | Swing the vault to sweep bikes off | Bikes and riders tumble; combo counter | Bikes shoot, heat rises |
| 7 | **Roman & Han** | Two "cop" cars turn on the police | Survive to the checkpoint; then they take out the pursuit | Allied cruisers ram cops; banter | — |
| 8 | **The Swap** | Vault moved into a garbage truck, decoy hooked up | Drive into the garbage-truck convoy's gap under an overpass, matching speed | Quick cut and fade; Mia: "Swap's done. You're dragging an empty box." | Too fast or slow: they wave you around for another pass |
| 9 | **Cut Loose** | Dom unhooks Brian on the bridge | As Dom: you're alone with the vault. As Brian: you're cut free and must turn back | Cable snaps (sparks, recoil), music drop | — |
| 10 | **Solo NOS Drag** | One car hauling four tonnes alone | Fire NOS to keep the vault moving; NOS meter fed by wrecks and near misses | Exhaust flames, FOV punch, engine scream | Out of NOS: crawling speed, cops close in |
| 11 | **Wrecking Ball** | Dom spins and smashes Reyes's convoy | Handbrake 180° to swing the vault through the convoy | Chain wrecks in slow motion; final slam launches the Charger onto Reyes's car (cutscene) | — |
| 12 | **Brian's Return** | Brian comes back and stops Zizi | (If playing Brian) race back to Dom before the timer runs out | Cutscene | — |
| 13 | **24 Hours** | Hobbs's deal; empty vault reveal | Cutscene | Score screen, medals per moment | — |

## Shared systems

| System | Used by | Notes |
|---|---|---|
| **Slow motion** | 1, 3, 4, 9, 11 | Global time scale with smooth ramp in and out; audio and particles follow it |
| **Camera director** | all | Short cinematic shots that override the chase cam and blend back: vault cam, low side cam, interior cam |
| **NOS** | 3, 10, 11 | Meter, boost force, blue exhaust flames, FOV punch, whoosh sound. Refilled by wrecks, near misses and moments |
| **Tire smoke and skid marks** | 1, 10, drifting | Wheelspin and lateral slip emit smoke and lay dark marks on the road |
| **Destructibles** | 4, 5, 6 | Glass panels, pillars, counters, banknotes, bikes |
| **Moment banner and style score** | all | Big animated callout ("BANK JOB +$2,500,000"); style total on the end screen |
| **Mia callouts** | 3–8 | Radio line and voice before each moment, with the direction to take |
| **Music intensity** | all (later) | Layers that rise with heat and peak during moments |
| **Video cutscenes** | 1, 8, 11, 13 (later) | AI-generated clips through the existing video slot, with in-engine fallback |

## Build order

1. **Foundation**: slow motion, camera director, NOS, tire smoke and skid marks, banners. ✅ done
2. **The Pull**, **Spike Strip** and **Bank Job**. ✅ done (the bank swing pays out cable and flings the
   vault at the lobby so a well-timed handbrake reliably connects)
3. Roadblocks mid-chase and the bridge finale. ✅ done: partway across the bridge you tell your partner
   to unhook (slow-mo side shot, radio exchange) and take the vault on alone on one cable, then smash
   the police blockade at the far end (the roadblock's replay, bigger). Still to come: The Swap,
   Wrecking Ball, Brian's Return, 24 Hours (the swap should happen *before* the bridge).
4. The Alley, Bike Cops, Roman & Han, Pillar Slam.
5. Polish: music layers, medals, AI video cutscenes, tuning from playtests.
