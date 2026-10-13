// What part of real San Juan becomes the game map, and where the set pieces go.
// Shared by fetch.mjs (which tiles to download) and build.mjs (how to turn them into the map).

/** ENU origin: Avenida Ponce de León at Calle Betances, Hato Rey. */
export const ORIGIN = { lon: -66.0557, lat: 18.4174 };

/**
 * The two pieces of the city we use. The chase runs through Hato Rey; the
 * bridge piece (the PR-17 approach, the toll plaza and the Teodoro Moscoso
 * Bridge over the San José lagoon) is slid west by `shift` degrees so the
 * expressway runs straight from one into the other, cutting out about 1.2 km of
 * plain expressway between them.
 */
export const REGIONS = [
  { name: 'hatorey', lon: [-66.062, -66.044], lat: [18.4055, 18.4265], shift: 0 },
  { name: 'bridge', lon: [-66.033, -66.021], lat: [18.4055, 18.4370], shift: -0.011 },
];

/** Tiles to download (OSM API map calls are limited in size, so these are small). */
export const TILES = { lonStep: 0.005, latStep: 0.0055 };

/**
 * The police HQ stands on the west side of Ponce de León this far (m) north of
 * Calle Betances. The game frame puts the avenue there on x = 200 running +z
 * (south-south-east, toward the bridge), with the station centered on z = 150,
 * which is where the breach cutscene was authored.
 */
export const STATION_NORTH = 200;
export const STATION_GAME = { x: 200, z: 150 };

/**
 * Mia's route, as the intersections it turns at (streets meeting there): down
 * Ponce de León through the Golden Mile, left onto the Piñero expressway, and
 * out to the bridge. (The blocks between Avenida Mayagüez and the expressway
 * are a school and its sports fields, so there's no shortcut east.) The bank
 * stands on the first of these corners.
 */
export const PLAN = [['Ponce de León', 'Piñero']];

/** The swap point, this far (m) along the bridge from its south end. */
export const SWAP_ALONG_BRIDGE = 900;
/** The spike strip, this far (m) along Mia's route from the station. */
export const SPIKES_ALONG_ROUTE = 300;
