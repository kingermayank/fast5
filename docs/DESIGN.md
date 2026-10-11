# Fast5 — Game Design

A browser game that recreates the *feel* of the vault-heist finale from the 2011 film *Fast Five*:
two muscle cars chained to a multi-ton bank vault, ripping it out of a police station and
dragging it through a city with the whole police force in pursuit.

The game is **"inspired by"**, not a licensed adaptation. It's meant to be shared publicly, so it
uses original names, unbranded cars and original/royalty-free audio. Everything the player sees
comes from our own code and assets.

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

## 2. Our version (names are placeholders, easy to change)

| Film role | In-game | Notes |
| --- | --- | --- |
| Rio de Janeiro | **Porto Sol** | Coastal city, downtown grid, bridge over the lagoon |
| The bald, muscular crew leader | **Rico "The Wall" Santos** | Heavier car, stronger pull, wider swing |
| The ex-cop driver | **Cole Mercer** | Lighter car, quicker steering, better acceleration |
| Navigator on the radio | **Lena** | Radio callouts + nav arrow |
| Federal agent | **Agent Holloway** | Breaches the wall in the intro cutscene |
| Drug lord | **Victor Salazar** | Final-bridge enemies |
| Crew members in stolen police cruisers | **"Deuce" & "Kong"** | Mid-chase assist event |

The player picks **Rico** or **Cole**. The other one is the **AI partner** chained to the same vault.

## 3. Mission: "The Vault"

| Phase | What happens | Win / fail |
| --- | --- | --- |
| 0. Intro cutscene | Camera fly-through of Porto Sol → police HQ; title cards set up the job | — |
| 1. Breach | The armored truck has already breached the wall. Player floors it; both cars strain on the cables; the vault rips through a brick wall and out into the street | Vault leaves the building |
| 2. City chase | Follow Lena's route through downtown. Cops spawn ahead, behind and from side streets. The vault wrecks anything it hits. Heat rises over time and with destruction | Reach the bridge. **BUSTED** if the player car is boxed in and stopped for too long |
| 3. Bridge | Long straight bridge, Salazar's armed SUVs, cops everywhere. Use the vault as a wrecking ball | Reach the swap point |
| 4. Outro | Text/cutscene: the decoy vault swap is revealed. Score screen | — |

## 4. Core mechanics

- **Real physics (Rapier):** cars and the vault are rigid bodies. Each car connects to the vault
  with a **rope joint** (slack under the max length, rigid at it), so the vault really swings
  through corners and drags behind you.
- **Two-car coordination:** the vault goes where the combined pull sends it. Turning hard swings it
  wide like a wrecking ball, which is useful for hitting cop cars. Both cars pull, so if the AI partner
  falls behind, the vault slows you down.
- **Arcade car handling on top of physics:** drive force, lateral grip and yaw control are applied
  as impulses, so collisions, ropes and pushes from cops all interact naturally.
- **Police AI:** pursue and ram the player cars. Cruisers hit hard by the vault, or flipped,
  are wrecked.
- **Destruction:** light posts, palm trees, kiosks and parked cars are dynamic bodies that go flying.
  Destruction feeds into the score ("property damage") and into heat.
- **Heat:** 1–5 stars. More cops, faster spawns, roadblocks at high heat.
- **Busted meter:** fills while the player is boxed in at low speed with cops close; empties
  when you get free.

## 5. Roadmap

1. ✅ Racing prototype: rendering, car, HUD
2. 🚧 **Vault physics prototype**: two cars + rope joints + vault, city blocks, police pursuit, route to the bridge
3. Breach set piece (breakable wall, station interior, intro/outro cutscenes)
4. Character select with distinct handling; AI partner improvements
5. Spike strips, motorcycle cops, the stolen-cruiser assist event, roadblocks, bank set piece
6. Bridge finale with Salazar's men
7. Audio: engine, sirens, crashes, radio voice lines (TTS), original soundtrack
8. Better art: GLB car models (licensed), textures, particles (sparks under the vault, dust, glass)
9. Mobile/touch controls, gamepad
