/**
 * The abyss (PLAN.md 5.2): from under the second storm on there is no sea. Decks of cloud lie
 * one under another, kilometres apart, down into the dark, and one more over the aircraft;
 * holed a few kilometres across and swirled by vortices tens of kilometres wide (storm.glsl draws
 * them). Lightning lives in them: deep down it lights the decks from below.
 *
 * DECKS: each deck's middle (m: most far below sea level) and half its thickness. SWIRLS: each
 * vortex's centre (world x, z), radius and turn at its middle (radians). DECK_LOW: under the last
 * deck there is only the dark.
 */
export const DECKS = Object.freeze([
  [3700, 380],
  [-700, 330],
  [-4600, 480],
  [-9500, 650],
  [-16000, 900]
]);
export const SWIRLS = Object.freeze([
  [-95000, -30000, 26000, 2.6],
  [-140000, -44000, 34000, -3.1],
  [-185000, -24000, 30000, 2.8]
]);
export const DECK_LOW = -17500;
// The vortices come round again every SWIRL_REPEAT metres each way (storm.glsl's swirlCentre).
export const SWIRL_REPEAT = 150000;

/** How far world (x, z) is from the nearest vortex's eye, in radii of that eye. */
export function eyeDistance(x, z) {
  let best = Infinity;
  for (const [cx, cz, r] of SWIRLS) {
    const ox = cx + SWIRL_REPEAT * Math.floor((x - cx) / SWIRL_REPEAT + 0.5);
    const oz = cz + SWIRL_REPEAT * Math.floor((z - cz) / SWIRL_REPEAT + 0.5);
    best = Math.min(best, Math.hypot(x - ox, z - oz) / (0.15 * r));
  }
  return best;
}
// The march goes through the top three decks; deeper ones are drawn as their tops alone
// (clouds.frag), seen only through the holes above them.
export const DECK_MARCHED_LOW = -5300;

/** How far inside the nearest deck's slab y is (m; holes not counted). */
export function deckSlab(y) {
  let best = -1e5;
  for (const [mid, half] of DECKS) best = Math.max(best, half - Math.abs(y - mid));
  return best;
}

/**
 * The light of the deep (storm.glsl's deepLight): violet, from under the last deck; each deck
 * lets through a share of it (THROUGH, as in storm.glsl). swell: how it swells with the
 * discharges down there (lightning.js's deep). Irradiance (rgb) under the decks at y, or at the
 * bottom with y = -Infinity. HAZE: the abyss's air glows with it (lit from below, it lights the
 * view's far end): its radiance far off, against the light at its height.
 */
export const DEEP = Object.freeze({ color: [0.73, 0.32, 1.0], power: 0.8, through: 0.6, haze: 0.05 });
export function deepLight(y, swell = 0, out = [0, 0, 0]) {
  let k = DEEP.power * (0.55 + 0.6 * swell);
  for (const [mid, half] of DECKS) if (mid + half < y) k *= DEEP.through;
  for (let c = 0; c < 3; c++) out[c] = DEEP.color[c] * k;
  return out;
}
