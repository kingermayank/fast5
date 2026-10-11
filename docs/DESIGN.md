# Fast5 — Game Design

A browser game that recreates the vault-heist finale of the 2011 film *Fast Five*: two muscle
cars chained to a multi-ton bank vault, ripping it out of a police station and dragging it through
Rio with the whole police force in pursuit.

This is a fan game. It uses the film's character names and recreates its sequence of events in
our own engine, with original 3D models, original dialogue, synthesized sound and AI-generated or
in-engine cutscenes. It does **not** include footage, music, logos or likenesses from the film.

## 1. Reference: the film sequence (research notes)

Sources: Fast & Furious wiki "Vault Heist" article, IMDb/Wikipedia plot summaries, and
behind-the-scenes coverage of stunt coordinator Jack Gill's breakdown (Motor Authority,
PowerNation, Garrett On The Road). Not yet checked against the footage. Revisit if we get video frames.

**Story beats, in order**
1. **Setup.** A drug lord stores ~$100M in the vault of Rio's police headquarters, guarded by
   cops he's paid off. The crew decides to steal the whole vault.
2. **Breach.** An armored vehicle (driven by the federal agent and his partner, who have joined
   forces with the crew) smashes into the station and breaks down the wall of the vault room.
   The two hero cars back in, crew members chain the cars' rear winches to the vault, and they pull it
   out of the building while the agents hold off station cops. The vault slams into concrete
   pillars on the way out.
3. **City chase.** A navigator in a van guides the drivers by radio. Police chase from every
   direction. The vault, swinging behind the cars, wrecks parked cars, cop cars, trees, bus kiosks
   and light posts, and guts the lobby of a bank. Police throw down spike strips. A cut-through
   alley crushes the cops who follow. Motorcycle cops join. Two crew members in stolen police cruisers
   blend into the pursuit and take cops out from inside it.
4. **The bridge.** On a long bridge out of the city, the boss's own men join the chase. One driver
   cuts loose and gets away. The other keeps going alone, using the vault as a wrecking ball: he swings it
   into the gunmen's cars, sends his own car flying, and the vault crushes the boss's car.
5. **Resolution.** The agent arrives and lets the crew walk with a 24-hour head start, as long as they
   leave the vault. Later it's revealed the crew **swapped the vault for an empty decoy** during
   the chase, so the real money was already gone.

**Physical facts (great for tuning)**
- Hero cars: 2010 full-size four-door muscle sedans (6.1 L V8, ~425 hp), matte black, roll cages,
  heavy-duty winch at rear-center under the trunk, big drag radials on the rear.
- Vault: a real ~9,000 lb (~4 t) steel safe; "crasher" versions weighed 5–6 t.
- What the vault did: careened, slid, tipped up, caught an edge and tumbled. It flattened parked
  cars, trees, bus kiosks and light posts, and ran through a bank lobby.
- Filming locations: downtown San Juan, Puerto Rico (standing in for Rio), and the Teodoro Moscoso
  Bridge, a long, low causeway bridge over a lagoon. Our city should feel like that: dense
  colonial-and-modern downtown, palm trees, wide avenues, then a long flat bridge over water.

## 2. Cast and setting

| Character | Role in the game |
| --- | --- |
| **Dom Toretto** | Playable. Heavier Charger, strongest pull, widest vault swing |
| **Brian O'Conner** | Playable. Lighter Charger, sharper steering, quicker acceleration |
| **Mia Toretto** | Navigator on the radio: route callouts and the nav arrow |
| **Luke Hobbs** and **Elena Neves** | Ram the station wall with the armored truck in the opening cutscene |
| **Hernan Reyes** | The drug lord whose money is in the vault; his men join on the bridge (planned) |
| **Roman Pearce** and **Han** | Stolen-cruiser assist mid-chase (planned); pull the vault swap |

Setting: Rio de Janeiro, with a police headquarters downtown, a long bridge over the bay and the
mountains around the city on the horizon.

## 3. Mission: "The Vault"

| Phase | What happens | Win / fail |
| --- | --- | --- |
| 0. Breach cutscene | Aerial of Rio → Hobbs's armored truck charges the station under fire, rams the vault-room wall, backs out; Dom and Brian reverse up and hook the cables | — |
| 1. Breach | Cops keep firing. Player floors it; both cars strain on the cables; the vault drags out over the rubble into the street | Vault leaves the building |
| 2. City chase | Get to the bridge by any road: the GPS draws Mia's route by default and reroutes the moment you take another street. Cops come from behind and from side streets. The vault wrecks anything it hits. Heat rises over time and with destruction | Reach the bridge. **BUSTED** if the player car is boxed in and stopped for too long |
| 3. Bridge | Long straight bridge, Reyes's armed SUVs, cops everywhere. Use the vault as a wrecking ball | Reach the swap point |
| 4. Outro | Text/cutscene: the decoy vault swap is revealed. Score screen | — |

## 4. Core mechanics

- **Real physics (Rapier):** cars and the vault are rigid bodies. Each car connects to the vault
  with a **cable**: a stiff, damped spring that only pulls, with a rope joint just beyond as a hard
  stop. The vault really swings through corners and drags behind you, without one-frame yanks.
- **Two-car coordination:** the vault goes where the combined pull sends it. Turning hard swings it
  wide like a wrecking ball, which is useful for hitting cop cars. Both cars pull, so if the AI partner
  falls behind, the vault slows you down.
- **Arcade car handling on top of physics:** drive force, lateral grip and yaw control are applied
  as impulses, so collisions, ropes and pushes from cops all interact naturally. Cornering is
  limited to about 1.9 g (more with the handbrake); asking for more scrubs speed (understeer).
- **Fair collisions:** the partner is ghosted to the player; hero cars, the vault and parked cars
  outrank cruisers in contacts (Rapier dominance groups), so a ramming cop shoves you instead of
  spinning you out.
- **GPS:** Dijkstra over the street graph from wherever you are, recomputed when you leave the
  route. Mia's planned streets (with the set pieces) are preferred but never required.
- **Police AI:** pursue and ram the player cars, spawning behind and in side streets, out of
  sight. Cruisers hit hard by the vault, or flipped, are wrecked.
- **Destruction:** light posts, palm trees, kiosks and parked cars are dynamic bodies that go flying.
  Destruction feeds into the score ("property damage") and into heat.
- **Heat:** 1–5 stars. More cops, faster spawns, roadblocks at high heat.
- **Busted meter:** fills while the player is boxed in at low speed with cops close; empties
  when you get free.

## 5. Roadmap

See [`FIDELITY.md`](FIDELITY.md) for the research on GTA and the best racing games, the gap analysis
and the phased plan toward that level of fidelity. The original prototype roadmap:

1. ✅ Racing prototype: rendering, car, HUD
2. 🚧 **Vault physics prototype**: two cars + rope joints + vault, city blocks, police pursuit, route to the bridge
3. Breach set piece (breakable wall, station interior, intro/outro cutscenes)
4. Character select with distinct handling; AI partner improvements
5. Spike strips, motorcycle cops, the stolen-cruiser assist event, roadblocks, bank set piece
6. Bridge finale with Reyes's men
7. Audio: engine, sirens, crashes, radio voice lines (TTS), original soundtrack
8. Better art: GLB car models (licensed), textures, particles (sparks under the vault, dust, glass)
9. Mobile/touch controls, gamepad
