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

// ---- the second storm and the abyss (PLAN.md 5.2) ------------------------------------------------

/**
 * The orb: under the second storm's base, where the sea has gone, a glowing ball comes out of
 * the dark ahead and to the right, settles beside the aircraft a couple of dozen metres off and
 * keeps pace with it, wandering, once drifting closer as if to look in; then it climbs away into
 * the base and is lost in the cloud. Times (s): it shows, it is alongside, it leaves, it is gone.
 * radius (m); power: its intensity (scene units per steradian); its colour.
 */
export const ORB = Object.freeze({ t: 1197, settle: 1207, leave: 1231, rise: 18, gone: 1262, radius: 0.7, power: 24, color: [0.5, 0.72, 1.0], away: [160, 420] });

const ease = u => u * u * (3 - 2 * u);

/**
 * The orb at journey time t: where it is relative to the aircraft (m: x to the right, y up, z
 * back, in the path's level frame; it does not shake with the airframe) and how bright (0..1),
 * or null when it is not there. ceiling: how high above the aircraft it is a few dozen metres
 * into the cloud of the base, where it stops and goes out.
 */
export function orbAt(t, ceiling = 520) {
  if (t < ORB.t || t > ORB.gone) return null;
  // Its own small unrest: a wander of a few metres and a flicker.
  const wx = 2.4 * Math.sin(t * 0.23 + 1.1) + 1.1 * Math.sin(t * 0.61 + 0.3);
  const wy = 1.0 * Math.sin(t * 0.31 + 2.0) + 0.45 * Math.sin(t * 1.7);
  const wz = 3.5 * Math.sin(t * 0.17 + 0.7) + 1.2 * Math.sin(t * 0.47 + 2.4);
  const glow = 0.9 + 0.07 * Math.sin(t * 37.1) * Math.sin(t * 23.3 + 1) + 0.03 * Math.sin(t * 91.7);
  const side = [17 + wx, 1.5 + wy, -11 + wz];
  // Closer for a few seconds, as if to look in.
  const look = Math.max(0, Math.min(1, (t - 1218) / 2)) * (1 - Math.max(0, Math.min(1, (t - 1223) / 2.5)));
  side[0] -= 6 * ease(look);
  side[2] += 4 * ease(look);
  if (t < ORB.settle) {
    // Out of the dark ahead, lighting up as it comes.
    const u = ease((t - ORB.t) / (ORB.settle - ORB.t));
    const from = [55, -18, -170];
    return { at: from.map((v, i) => v + (side[i] - v) * u), light: glow * ease(Math.min(1, (t - ORB.t) / 3)) };
  }
  if (t < ORB.leave) return { at: side, light: glow };
  // Up and away ahead into the base above, about 50 degrees up from the cockpit all the way (the
  // head can look up only so far, and straight overhead is the canopy's frame); in the cloud it
  // slows, a glow spreading in the dark of it, and slowly goes out.
  const up = ease(Math.min(1, (t - ORB.leave) / ORB.rise));
  const out = Math.max(0, (t - ORB.leave - ORB.rise + 2) / (ORB.gone - ORB.leave - ORB.rise + 2));
  return { at: [side[0] + ORB.away[0] * up, side[1] + (ceiling - side[1]) * up, side[2] - ORB.away[1] * up], light: glow * (1 - ease(Math.min(1, out))) };
}

/**
 * The radio (audio/radio.js): it comes alive with static as the second storm comes over, and
 * calls come through it at these times (s); after the last, on and on, every minute or two.
 */
export const RADIO = Object.freeze({ on: 905, calls: [962, 1031, 1109, 1216, 1281, 1347, 1419, 1497, 1560] });

/** The radio's calls from journey time from to to. */
export function radioCalls(from, to) {
  const out = RADIO.calls.filter(c => c >= from && c < to);
  // Beyond the list: one in each stretch of 85 s, somewhere in its middle.
  const last = RADIO.calls[RADIO.calls.length - 1];
  for (let k = Math.max(1, Math.floor((from - last) / 85)); last + k * 85 - 40 < to; k++) {
    const h = Math.sin(k * 127.1 + 311.7) * 43758.5453;
    const c = last + k * 85 + (h - Math.floor(h) - 0.5) * 50;
    if (c >= from && c < to) out.push(c);
  }
  return out;
}

/**
 * The creature (PLAN.md 5.2): deep in the abyss, when lightning lights the cloud beyond it, the
 * outline of something vast shows in it, a few kilometres off; at the next flash it is gone; at
 * the next but one it is back, much closer. It sends back no light: it shows only against the
 * flashes scripted to light the cloud behind it (lightning.js). Each sighting: from t to until
 * (s); where it is, from where the aircraft is at t (along: m ahead, side: m to the right; alt:
 * the height of its middle, m); how it is turned from the path's heading (rad); its size (0:
 * not there); the times of the flashes behind it.
 */
export const CREATURE = Object.freeze([
  { t: 1452, until: 1461, along: 6400, side: -2200, alt: 150, turn: 0.6, size: 1, flashes: [1455.6, 1459.1] },
  { t: 1461, until: 1468, along: 6400, side: -2200, alt: 150, turn: 0.6, size: 0, flashes: [1464.2] },
  { t: 1468, until: 1478, along: 3000, side: -800, alt: 280, turn: 1.2, size: 1, flashes: [1470.9, 1474.8] },
  ...onwardSightings()
]);

/**
 * Beyond the planned journey (journey.js's ONWARD) it shows again and again, every few minutes,
 * never twice the same: somewhere off to one side, then gone at the next flash, or back closer.
 */
function onwardSightings() {
  let a = 90173;
  const rand = () => {
    a = (a * 16807) % 2147483647;
    return a / 2147483647;
  };
  const out = [];
  let t = 1680;
  while (t < 60000) {
    const side = (rand() < 0.5 ? -1 : 1) * (1500 + 1800 * rand());
    const far = { t, until: t + 9, along: 5500 + 2500 * rand(), side, alt: 100 + 300 * rand(), turn: rand() * 6.28, size: 0.8 + 0.5 * rand() };
    out.push({ ...far, flashes: [t + 3 + rand(), t + 6.5 + rand()].slice(0, rand() < 0.5 ? 1 : 2) });
    out.push({ ...far, t: t + 9, until: t + 16, size: 0, flashes: [t + 12 + rand()] });
    if (rand() < 0.55) {
      out.push({ t: t + 16, until: t + 25, along: 2400 + 1200 * rand(), side: side * (0.3 + 0.3 * rand()), alt: 200 + 200 * rand(), turn: rand() * 6.28, size: far.size, flashes: [t + 18.5 + rand(), t + 22 + rand()] });
    }
    t += 200 + 220 * rand();
  }
  return out;
}

/**
 * The twin (PLAN.md 5.2): out in the abyss, a set of navigation lights again, far ahead and to
 * the right; they come nearer and nearer, and settle beside the aircraft, a few metres off its
 * wing tip: an aircraft just like this one, the same glass bubble, the same glowing
 * instruments, its seat empty. It flies as this one flies, its beacons flash with these, and it
 * makes no sound. Then its lights go out, and it falls away into the dark. Times (s): it shows,
 * it is alongside, its lights die, it is gone; and the flashes in the deck above that light it
 * (lightning.js).
 */
export const TWIN = Object.freeze({ t: 1503, near: 1527, dark: 1556, gone: 1566, flashes: [1533.4, 1540.9, 1548.6] });

/**
 * The twin at journey time t: where it is relative to the aircraft (m: x to the right, y up, z
 * back, in the path's level frame), how lit its lamps and screens are (0..1), or null.
 */
export function twinAt(t) {
  if (t < TWIN.t || t > TWIN.gone) return null;
  // Abreast, to the right and a little below: looking into its glass from the side.
  const close = [11 + 0.6 * Math.sin(t * 0.21), -2 + 0.4 * Math.sin(t * 0.33 + 1), 0.5 + 1.0 * Math.sin(t * 0.13 + 2)];
  if (t < TWIN.near) {
    const u = ease((t - TWIN.t) / (TWIN.near - TWIN.t));
    const from = [700, 120, -2600];
    return { at: from.map((v, i) => v + (close[i] - v) * u), lit: 1 };
  }
  if (t < TWIN.dark) return { at: close, lit: 1 };
  // Dark, and falling away below and behind.
  const v = (t - TWIN.dark) / (TWIN.gone - TWIN.dark);
  return { at: [close[0] + 30 * v * v, close[1] - 260 * v * v, close[2] + 160 * v * v], lit: 0 };
}
