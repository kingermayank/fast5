import type { NewsBreak } from './hud';

/**
 * What RIO 24H, a made-up Rio news channel, says about the chase as it happens.
 * Its helicopter is in the sky over the convoy (chopper.ts); these are the
 * breaks in the corner of the screen. All original copy.
 */
export const NEWS = {
  breakout: [
    'BREAKING',
    'VAULT TORN OUT OF POLICE HQ',
    'Two cars are dragging a ten-ton safe out of police headquarters  •  The safe was seized from businessman Hernan Reyes  •  Live pictures from the RIO 24H helicopter',
  ],
  heat: [
    null,
    null,
    ['LIVE', 'CHASE SPILLS INTO DOWNTOWN', 'More patrol cars join the pursuit  •  Drivers are asked to stay off the main avenues  •  RIO 24H is following from the air'],
    ['LIVE', 'EVERY UNIT ORDERED AFTER THE SAFE', 'Police radio: “stop that vault at any cost”  •  Roadblocks going up across the city'],
    ['LIVE', 'GRIDLOCK AS THE CHASE ROLLS ON', 'Traffic at a standstill behind the convoy  •  Wrecked patrol cars line the route'],
    ['EXCLUSIVE', 'THE WHOLE FORCE IS ON ONE SAFE', 'Our helicopter counts police cars from every district  •  The safe shows no sign of slowing down'],
  ],
  bank: ['LIVE', 'SAFE SMASHES THROUGH A BANK', 'The vault has just gone through the front of a downtown bank  •  Staff had cleared the lobby  •  Damage estimated in the millions'],
  spikesDodged: ['LIVE', 'SPIKE STRIP FAILS TO STOP THE SAFE', 'Both cars threaded a gap in the police stinger  •  The convoy is still on the move'],
  tireBlown: ['LIVE', 'POLICE STINGER SHREDS A TIRE', 'One of the getaway cars is running on a rim  •  Sparks seen for blocks'],
  bridge: ['LIVE', 'THE CHASE REACHES THE BRIDGE', 'The convoy is crossing the water  •  Police are closing the far end'],
  roadblock: ['LIVE', 'SAFE SMASHES THROUGH A ROADBLOCK', 'Police cruisers scattered across the avenue  •  The convoy did not even slow down'],
  tunnel: ['LIVE', 'THE SAFE VANISHES INTO A TUNNEL', 'Gates came down behind the convoy on the expressway  •  For a minute nobody could see it  •  It is out again and still running'],
  split: ['LIVE', 'THE GETAWAY CARS SPLIT UP', 'One car has turned back into the pursuit  •  The other is dragging the safe on its own'],
  blockade: ['BREAKING', 'THE BRIDGE BLOCKADE IS DOWN', 'One car and a ten-ton safe just broke a wall of police cruisers  •  The second car has broken away'],
  finish: ['BREAKING', 'POLICE SURROUND THE SAFE ON THE BRIDGE', 'Officers have the vault  •  Both drivers still at large  •  More at the top of the hour'],
  empty: ['BREAKING', 'THE SAFE IS EMPTY', 'Police stopped the vault on the bridge and opened it: there is nothing inside  •  Both drivers still at large'],
} satisfies Record<string, NewsBreak | (NewsBreak | null)[]>;

/** A milestone in police cars wrecked, e.g. 10, 25, 50. */
export function wreckNews(count: number): NewsBreak {
  return ['LIVE', `${count} POLICE CARS WRECKED`, `The pursuit has cost the city ${count} patrol cars so far  •  Officers told to keep their distance from the safe`];
}
