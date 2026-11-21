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
 * Lightning that crawls along the underside of the anvil (an "anvil crawler", spider
 * lightning): under the anvil as it closes over the aircraft, and over the hall. Times of the
 * first leader (s); the web spreads for crawl seconds before its return strokes.
 */
export const SPIDERS = Object.freeze([
  { t: 162, crawl: 1.0 },
  { t: 253, crawl: 1.1 }
]);

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
