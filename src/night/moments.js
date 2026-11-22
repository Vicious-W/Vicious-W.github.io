/**
 * The scripted moments of the first storm, in journey time (s). Everything else in the storm is
 * left to chance (lightning.js); these happen once, where the journey is right for them.
 *
 * The strike: deep in the rear tower, after the St. Elmo's fire has built up on the canopy,
 * lightning takes the aircraft as part of its channel: it comes down to the nose and leaves
 * from the tail. A blinding flash and a bang; the power fails, the instruments, the lamps and
 * the fan die; a few seconds later the power comes back, flickering, and the screens start up.
 */
export const STRIKE = Object.freeze({
  t: 431.5, // the first return stroke
  dark: 3.4, // seconds without power
  flicker: 1.3 // then it catches, falters and holds
});

// After the dark: on (1) or off (0) in steps of a tenth of a second, as relays catch.
const CATCH = [1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1];

/**
 * The aircraft's electrical power at journey time t: 1 on, 0 off. booting: the screens are lit
 * but have not drawn anything yet (they show their backlight), as after a restart.
 */
export function powerAt(t) {
  const dt = t - STRIKE.t;
  if (dt < 0 || dt >= STRIKE.dark + STRIKE.flicker + 0.9) return { on: 1, booting: false };
  if (dt < STRIKE.dark) return { on: 0, booting: false };
  const k = Math.floor((dt - STRIKE.dark) / 0.1);
  if (k < CATCH.length) return { on: CATCH[k], booting: true };
  return { on: 1, booting: dt < STRIKE.dark + STRIKE.flicker + 0.6 };
}

/** The moments (journey time) at which the power catches again, for the relays' clicks. */
export function catchTimes() {
  const out = [];
  CATCH.forEach((v, k) => {
    if (v && !CATCH[k - 1]) out.push(STRIKE.t + STRIKE.dark + k * 0.1);
  });
  return out;
}

/**
 * The corona before and after the strike: it builds up over the last seconds (1 at the
 * strike), and is gone for a while once the charge has gone through the aircraft.
 */
export function coronaAround(t) {
  const dt = t - STRIKE.t;
  if (dt < -6 || dt > 40) return 1;
  if (dt < 0) return 1 + 0.8 * Math.pow((dt + 6) / 6, 2);
  return Math.min(1, Math.max(0, (dt - 12) / 25));
}

/**
 * A tornado under the storm's southern base, ahead and to the right as the aircraft comes in:
 * a funnel from the base to the sea, seen only when lightning lights it. Its foot (storm frame,
 * m), the height of the base it hangs from, until when it is drawn (s; behind the aircraft
 * after that), how fast its surface turns (rad/s), and the strikes beside it that show it: when
 * (s) and where they hit the sea, from its foot (m).
 */
export const FUNNEL = Object.freeze({
  x: 2750,
  z: 10500,
  top: 1340, // the storm's base (storm.js: STORM.base) and a little
  until: 150,
  spin: 1.3,
  // (Most on the near side, which they light; one behind, which shows it black against its glow.)
  strikes: [
    { t: 12, at: [-600, 900] },
    { t: 23, at: [700, 800] },
    { t: 33, at: [-1100, 500] },
    { t: 42, at: [500, -1000] }
  ]
});

/**
 * Lightning that crawls along the underside of the anvil (an "anvil crawler", spider
 * lightning): under the anvil as it closes over the aircraft, and over the hall. Times of the
 * first leader (s); the web spreads for crawl seconds before its return strokes.
 */
export const SPIDERS = Object.freeze([
  { t: 162, crawl: 1.0 },
  { t: 253, crawl: 1.1 }
]);

/**
 * Red sprites, once the aircraft has left the storm well behind (until then the tower it came
 * out of fills the sky behind): high over the storm system (50 to 90 km up, above its trailing
 * anvil far beyond the core), clusters of red columns with blue
 * tendrils hanging from them, each there for a fifth of a second. Seen looking back, above the
 * storm's top. When (s), how far beyond the aircraft towards the storm's centre (km), how far
 * to the side (km), how many columns, and a seed for their shapes.
 */
export const SPRITES = Object.freeze([
  { t: 548, along: 46, side: -6, count: 5, seed: 3.1 },
  { t: 566, along: 50, side: 8, count: 3, seed: 7.7 },
  { t: 583, along: 47, side: -9, count: 7, seed: 12.4 },
  { t: 604, along: 52, side: 5, count: 4, seed: 18.9 },
  { t: 627, along: 48, side: -4, count: 6, seed: 25.3 },
  { t: 655, along: 51, side: 9, count: 5, seed: 31.7 },
  { t: 688, along: 49, side: -7, count: 8, seed: 38.2 },
  { t: 724, along: 52, side: 6, count: 4, seed: 44.9 }
]);
// The storm's centre (storm frame), which the sprites stand beyond.
export const STORM_CENTRE = Object.freeze([2000, -1500]);

/** How bright a sprite is dt seconds after it begins: a flash and a short glow. */
export function spritePower(dt) {
  if (dt < 0 || dt > 0.45) return 0;
  return dt < 0.008 ? dt / 0.008 : Math.exp(-(dt - 0.008) / 0.07);
}

/**
 * Another aircraft in the storm: as the aircraft breaks out of the cloud into the cave in the
 * rear tower, the lamps of another come rushing out of the cave's right wall, cross a stone's
 * throw ahead (about 80 m) and are swallowed by the left wall. A straight line at its speed,
 * crossing the path at height up (m), lead seconds before the aircraft gets there; angle (deg):
 * how much it heads back towards the aircraft.
 */
export const TRAFFIC = Object.freeze({ cross: 409, lead: 1.5, angle: 10, speed: 110, up: 20 });

/** Its lamps (cd-like, scene units) at time t of their own: position lights, strobes, beacon. */
export function trafficLamps(t) {
  // Wing-tip strobes flash in pairs, every 1.2 s; the beacon on its back every second.
  const flash = x => (x >= 0 && x < 0.12 ? Math.exp(-x / 0.03) : 0);
  const p = ((t % 1.2) + 1.2) % 1.2;
  const strobe = flash(p) + 0.8 * flash(p - 0.14);
  const b = ((t + 0.37) % 1.0 + 1.0) % 1.0;
  const beacon = b < 0.012 ? b / 0.012 : Math.exp(-(b - 0.012) / 0.08);
  return { steady: 0.6, strobe: 30 * strobe, beacon: 3 * beacon };
}
