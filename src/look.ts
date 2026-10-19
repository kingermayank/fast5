/**
 * The time of day. By default it's a wet night: the city is lit by its own
 * lamps, headlights, windows and strobes, which from above read as pools of
 * light on wet asphalt. ?dusk brings back the golden hour the game first had.
 */
export const NIGHT = !new URLSearchParams(location.search).has('dusk');
