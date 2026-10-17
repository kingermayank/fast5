# Rive UI contract

The game's screens and HUD are drawn by the Rive file built from this folder
(`public/ui/fast5.riv`). The game talks to it through the main artboard's view
model only: `src/hud.ts` sets these properties, and the file decides how they
look and animate. Rename one here and in `src/hud.ts` together.

The main artboard is `UI` and its state machine must be named `UI` (the web
runtime plays it by name; data binds only apply while it runs). The view model
is `Game`, declared in `data.rml`.

Each part of the HTML UI hides only when the file has the property that marks
it (in brackets below), so parts can move to Rive one at a time. The file has
them all now.

## Screens

| Property | Type | Meaning |
| --- | --- | --- |
| `screen` | enum `off`, `select`, `drive`, `cinematic`, `result` | What's showing |

## Crew select [`crew`]

| Property | Type | Meaning |
| --- | --- | --- |
| `crew` | number | Highlighted card: 0 Dom, 1 Brian. The game sets it from the keyboard; the file sets it on hover |
| `confirm` | trigger | The file fires it on a click to start with the highlighted crew |

The game makes the Rive canvas take the mouse only on this screen. The HTML credits and build label
stay on top of it (they carry the asset licences).

## Driving HUD [`speed`]

| Property | Type | Meaning |
| --- | --- | --- |
| `speed` | number | km/h, rounded |
| `speedText` | string | The same, as text |
| `nos` | number | Nitrous left, 0..1 |
| `heat` | number | Wanted level, 0..5 |
| `busted` | number | Busted meter, 0..1 (hide below 0.01) |
| `style` | string | Style points, formatted (`3,800`) |
| `damage` | string | Property damage, formatted (`$2,664,300`) |
| `wrecked` | string | Cops wrecked |
| `objective` | string | Current objective (`Drag the vault to the bridge`) |
| `guidance` | string | Under the arrow (`LEFT IN 80 m`, `2442 m TO GO`) |
| `arrowOn` | boolean | Show the route arrow |
| `arrowAngle` | number | Route arrow rotation, radians, clockwise on screen (0 = straight up) |

The minimap stays an HTML canvas, 200 px round, 20 px from the bottom-left
corner; leave that space clear (a bezel around it is fine).

## Moment meter [`meterLabel`]

| Property | Type | Meaning |
| --- | --- | --- |
| `meterOn` | boolean | Show the centre meter |
| `meterLabel` | string | `STRAIN`, ... |
| `meterValue` | number | 0..1 |
| `meterPrompt` | string | `HOLD W TO PULL`, ... |

## Hint [`hint`]

| Property | Type | Meaning |
| --- | --- | --- |
| `hint` | string | One-line hint under the objective; empty hides it |

## Banner [`bannerTitle`]

| Property | Type | Meaning |
| --- | --- | --- |
| `bannerTitle` | string | `BANK JOB` |
| `bannerSub` | string | `+$2,500,000` |
| `bannerOn` | boolean | True while it should show (the game times it) |
| `banner` | trigger | Fired for each new banner (replay the entrance) |

## Radio [`radioText`]

| Property | Type | Meaning |
| --- | --- | --- |
| `radioWho` | string | `MIA`, `BRIAN`, ... |
| `radioText` | string | The line |
| `radioOn` | boolean | True while it should show |
| `radio` | trigger | Fired for each new line |

## Cutscenes [`subtitleText`]

| Property | Type | Meaning |
| --- | --- | --- |
| `subtitleWho` | string | Speaker, or empty |
| `subtitleText` | string | The line, or empty |
| `titleCard` | string | Big title text, or empty |

## End screens [`resultTitle`]

| Property | Type | Meaning |
| --- | --- | --- |
| `resultTitle` | string | `THE SWAP`, `BUSTED` |
| `resultBody` | string | Stats, may contain line breaks |
| `resultPrompt` | string | `Press Enter to try again` |
