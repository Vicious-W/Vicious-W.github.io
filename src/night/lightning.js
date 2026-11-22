import { mulberry32 } from "../sky/cumulus.js";
import { SECOND_CENTRE, STORM, WELLS } from "./storm.js";
import { CREATURE, STRIKE, SPIDERS, FUNNEL, TWIN } from "./moments.js";
import { DECKS } from "./abyss.js";

/**
 * Lightning of the night journey. Two lights at any time:
 * - the flash: the big discharges, a few seconds apart, close to the aircraft once it is inside
 *   the storm; inside a cloud, or a bolt from the cloud base to the sea whose channel is seen;
 * - the flicker: lesser lightning that never stops, somewhere else in the storm, so that its
 *   towers keep showing against one another between the flashes.
 * Each has a few return strokes (sharp peaks with short decays, sometimes a glowing continuing
 * current between them). Positions are in the storm frame (metres; y is altitude).
 */

const COLOR_IC = [0.72, 0.82, 1.0]; // inside cloud: scattered, bluish
const COLOR_CG = [0.86, 0.9, 1.0]; // channel in clear air: bluish white
const CENTRE = [2000, -1500]; // middle of the cluster of towers
// Near the second storm (storm.js) the lightning's colour is wrong (PLAN.md 5.2), more so the
// closer: one of these, mixed into its usual colour.
const WRONG = [[0.45, 1.0, 0.5], [1.0, 0.35, 0.85], [1.0, 0.6, 0.25], [0.35, 1.0, 0.95], [0.75, 0.3, 1.0]];

/** A jagged channel from a to b by midpoint displacement, with branches. */
export function makeChannel(rand, a, b, { depth = 6, rough = 0.3, branches = 4 } = {}) {
  const segments = [];
  const split = (p, q, level, width, glow) => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dz = q[2] - p[2];
    const len = Math.hypot(dx, dy, dz);
    if (level === 0 || len < 40) {
      segments.push({ a: p, b: q, width, glow });
      return;
    }
    const m = [p[0] + dx * 0.5, p[1] + dy * 0.5, p[2] + dz * 0.5];
    const off = len * rough;
    m[0] += (rand() - 0.5) * off;
    m[1] += (rand() - 0.5) * off * 0.6;
    m[2] += (rand() - 0.5) * off;
    split(p, m, level - 1, width, glow);
    split(m, q, level - 1, width, glow);
  };
  split(a, b, depth, 1, 1);
  // Branches leave the main channel downwards and outwards, thinner and dimmer.
  const main = segments.slice();
  for (let k = 0; k < branches; k++) {
    const s = main[Math.floor(rand() * main.length * 0.8)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * (0.15 + 0.25 * rand());
    const angle = rand() * Math.PI * 2;
    const end = [
      s.b[0] + Math.cos(angle) * len * 0.8,
      s.b[1] - len * (0.3 + 0.5 * rand()) * Math.sign(a[1] - b[1] || 1),
      s.b[2] + Math.sin(angle) * len * 0.8
    ];
    split(s.b, end, depth - 2, 0.55, 0.5);
  }
  return segments;
}

/**
 * Stroke train: times (s from the start) and relative amplitudes. lingering: the lightning
 * mostly glows on between its strokes (a continuing current), as distant sheet lightning does.
 */
function makeStrokes(rand, count, lingering = false) {
  const strokes = [];
  let t = 0;
  let end = 0;
  for (let i = 0; i < count; i++) {
    const glows = rand() < (lingering ? 0.85 : 0.5);
    const s = {
      t,
      a: i === 0 ? 1 : 0.35 + 0.5 * rand(),
      tau: 0.02 + 0.03 * rand(),
      glow: glows ? (lingering ? 0.22 + 0.3 * rand() : 0.12 + 0.14 * rand()) : 0, // continuing current
      hold: lingering ? 0.15 + 0.4 * rand() : 0.06 + 0.2 * rand()
    };
    strokes.push(s);
    end = Math.max(end, t + (glows ? s.hold : 0.1));
    t += lingering ? 0.08 + 0.3 * rand() : 0.04 + 0.11 * rand();
  }
  return { strokes, duration: end + 0.1 };
}

// The leaders' light while a web of spider lightning spreads: dim, flickering.
function crawlLight(t, crawl) {
  if (t < 0 || t > crawl + 0.05) return 0;
  return 0.12 + 0.08 * Math.sin(t * 61) * Math.sin(t * 23 + 1);
}

function strokePower(strokes, t) {
  let p = 0;
  for (const s of strokes) {
    if (t < s.t) continue;
    const dt = t - s.t;
    // The continuing current fades out over its last third rather than snapping off.
    p += s.a * Math.exp(-dt / s.tau) + s.glow * Math.min(Math.max((s.hold - dt) / (0.35 * s.hold), 0), 1);
  }
  return p;
}

// Lightning is set up a little before it strikes: the renderer builds up the image of its
// light over a few frames (the power is still zero), so the first stroke is already clean.
const LEAD = 0.14;

// A vector of the airframe (x right, y up, -z ahead) in the world, for its attitude q.
function airframe(q, [x, y, z]) {
  const tx = 2 * (q.y * z - q.z * y);
  const ty = 2 * (q.z * x - q.x * z);
  const tz = 2 * (q.x * y - q.y * x);
  return [x + q.w * tx + (q.y * tz - q.z * ty), y + q.w * ty + (q.z * tx - q.x * tz), z + q.w * tz + (q.x * ty - q.y * tx)];
}

/**
 * stormSD(x, y, z): the baked storm distance (m, positive inside), to seat lightning inside
 * the cloud near its surface: lit from within, a cloud glows; lit from the open air, it would
 * look like the walls of a cave.
 */
export function createLightning({ seed = 9, stormSD = () => 1000 } = {}) {
  const rand = mulberry32(seed);
  const range = (lo, hi) => lo + (hi - lo) * rand();
  let flash = null;
  let flick = null;
  let nextFlash = 1.5;
  let nextFlick = 0.2;
  const spidersDone = SPIDERS.map(() => false);
  const funnelDone = FUNNEL.strikes.map(() => false);
  const creatureDone = new Set();
  const twinDone = new Set();
  let id = 0;
  const state = {
    flash: { on: false, id: -1, power: 0, pos: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], weight: [1, 0, 0], color: COLOR_IC, depth: 0, bolt: null, boltPower: 0 },
    flick: { on: false, id: -1, power: 0, pos: [0, 0, 0], color: COLOR_IC, depth: 0 },
    glow: 0,
    // The abyss's light from the deep: it swells with each discharge down there and dies away
    // slowly (0 = its calm level).
    deep: 0
  };

  // The storm's own glow around the aircraft: strongest inside, a slow uneven shimmer.
  const glowAt = (view, t) => {
    const near = 1 - Math.min(Math.max((centreDistance(view) - 9000) / 9000, 0), 1);
    return near * (0.7 + 0.2 * Math.sin(t * 2.3) * Math.sin(t * 0.7 + 1.3) + 0.1 * Math.sin(t * 5.1 + Math.sin(t * 1.7) * 2));
  };

  // The storm whose centre is nearer: its centre, and whether it is the second one.
  let centre = CENTRE;
  let second = false;
  const placeAt = view => {
    second = Math.hypot(view.x - SECOND_CENTRE[0], view.z - SECOND_CENTRE[1]) < Math.hypot(view.x - CENTRE[0], view.z - CENTRE[1]);
    centre = second ? SECOND_CENTRE : CENTRE;
  };
  const centreDistance = view => Math.hypot(view.x - centre[0], view.z - centre[1]);
  // In the abyss (the journey's view.alien) the lightning lives in its decks.
  let abyss = false;
  // A colour for lightning: as it should be, or, near the second storm and in the abyss, gone
  // wrong.
  const tinted = (view, base) => {
    if (!second && !abyss) return base;
    const near = abyss ? 1 : 1 - Math.min(Math.max((centreDistance(view) - 9000) / 17000, 0), 1);
    const w = near * range(0.45, 1);
    const odd = WRONG[Math.floor(rand() * WRONG.length)];
    return base.map((v, i) => v + (odd[i] - v) * w);
  };

  /**
   * A seat for lightning among candidates from pick(): inside the cloud, a few hundred metres
   * below its surface, preferably where that surface faces the aircraft.
   */
  function seat(view, pick, tries = 16) {
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < tries; i++) {
      const c = pick();
      const sd = stormSD(c[0], c[1], c[2]);
      if (sd < 200) continue;
      const dx = view.x - c[0];
      const dy = view.alt - c[1];
      const dz = view.z - c[2];
      const d = Math.hypot(dx, dy, dz) || 1;
      const probe = Math.min(1400, d * 0.5);
      const facing = stormSD(c[0] + (dx / d) * probe, c[1] + (dy / d) * probe, c[2] + (dz / d) * probe) < -100;
      // More often than not it is where the viewer is looking, and in plain sight.
      const ahead = view.forward ? -(dx * view.forward.x + dy * view.forward.y + dz * view.forward.z) / d > 0.45 : false;
      let inSight = facing;
      for (let k = 1; inSight && k < 8; k++) {
        const f = k / 8;
        inSight = stormSD(view.x - dx * f * 0.85, view.alt - dy * f * 0.85, view.z - dz * f * 0.85) < -100;
      }
      const score = -Math.abs(sd - 450) / 450 + (facing ? 0.8 : 0) + (inSight ? 0.9 : 0) + (ahead ? 0.7 : 0) + rand() * 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = { pos: c, depth: Math.min(sd, 1400) };
      }
    }
    return best;
  }

  const anywhere = () => {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 11000;
    return [centre[0] + Math.cos(a) * r, range(3000, 10500), centre[1] + Math.sin(a) * r];
  };
  const around = (view, rMin, rMax, below = 1500, above = 4200) => () => {
    const a = rand() * Math.PI * 2;
    const r = range(rMin, rMax);
    return [view.x + Math.cos(a) * r, view.alt + range(-below, above), view.z + Math.sin(a) * r];
  };

  // at: for a strike to the sea, where it hits ([x, z]); otherwise chosen here.
  function createFlash(view, kind, near, at = null) {
    let sources;
    let bolt = null;
    let depth = 0;
    // The aircraft itself in or against cloud: lightning is close by, all around.
    const tight = stormSD(view.x, view.alt, view.z) > -1000;
    if (kind === "cg") {
      // Cloud to sea, under the storm. Over the hall it is often below a well, where the bolt
      // shows from above; otherwise where the aircraft can see the channel under the cloud base,
      // and away from the wells (from outside, a lit well is only a ring of bright rims).
      let x;
      let z;
      const underCloud = (px, pz) => stormSD(px, STORM.base + 400, pz) > 0;
      const farFromWells = (px, pz) => WELLS.every(w => Math.hypot(px - w.x, pz - w.z) > w.r + 1800);
      const seen = (px, pz) => {
        for (let k = 1; k < 12; k++) {
          const f = k / 12;
          if (stormSD(view.x + (px - view.x) * f, view.alt + (650 - view.alt) * f, view.z + (pz - view.z) * f) > -150) return false;
        }
        return true;
      };
      if (at) {
        x = at[0];
        z = at[1];
      } else if (!second && (near === "well" || (near && rand() < 0.7))) {
        // The nearest well most of the time.
        const byDistance = WELLS.slice().sort((a, b) => Math.hypot(a.x - view.x, a.z - view.z) - Math.hypot(b.x - view.x, b.z - view.z));
        const w = byDistance[near === "well" || rand() < 0.7 ? 0 : 1 + Math.floor(rand() * (WELLS.length - 1))];
        x = w.x + range(-900, 900);
        z = w.z + range(-900, 900);
      } else {
        let score = -1;
        for (let i = 0; i < 24; i++) {
          const a = rand() * Math.PI * 2;
          const r = range(1500, 12000);
          const px = centre[0] + Math.cos(a) * r;
          const pz = centre[1] + Math.sin(a) * r;
          if (!farFromWells(px, pz)) continue;
          const s = (underCloud(px, pz) ? 1 : 0) + (seen(px, pz) ? 2 : 0) + rand() * 0.5;
          if (s > score) {
            score = s;
            x = px;
            z = pz;
          }
        }
        if (score < 0) {
          x = centre[0] + 9000;
          z = centre[1] + 6000;
        }
      }
      const top = [x + range(-1000, 1000), STORM.base + range(900, 2600), z + range(-1000, 1000)];
      const ground = [x + range(-800, 800), 0, z + range(-800, 800)];
      sources = [[x, STORM.base - 150, z], [(x + ground[0]) / 2, 650, (z + ground[2]) / 2], [ground[0], 250, ground[2]]];
      bolt = makeChannel(rand, [x, STORM.base + 150, z], ground, { depth: 7, rough: 0.32, branches: 3 + Math.floor(rand() * 4) });
      bolt.unshift(...makeChannel(rand, top, [x, STORM.base + 150, z], { depth: 5, rough: 0.35, branches: 1 }));
    } else {
      // Inside the cloud: a discharge a kilometre or more long, its light at three places.
      // Now and then one strikes in the cloud right next to the aircraft (in the hall, that is
      // the deck below it or a wall): blinding, and its thunder a crack a few seconds later.
      const close = near && !tight && rand() < 0.3;
      const pick = near ? (tight ? around(view, 500, 2200, 900, 1800) : close ? around(view, 300, 2400, 2200, 1400) : around(view, 1500, 6000)) : anywhere;
      const at = seat(view, pick, near ? 32 : 16) || { pos: [centre[0], 6000, centre[1]], depth: 800 };
      depth = at.depth;
      const a = rand() * Math.PI * 2;
      const len = range(900, 2600);
      sources = [];
      for (let k = 0; k < 3; k++) {
        const f = k / 2 - 0.5;
        const q = [at.pos[0] + Math.cos(a) * len * f, at.pos[1] + range(-500, 500), at.pos[2] + Math.sin(a) * len * f];
        sources.push(stormSD(q[0], q[1], q[2]) < 150 ? at.pos.slice() : q);
      }
    }
    const { strokes, duration } = makeStrokes(rand, kind === "cg" ? 2 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 4));
    const w = [range(0.45, 0.65), range(0.3, 0.5), range(0.25, 0.45)];
    const sum = w[0] + w[1] + w[2];
    // Power: irradiance at 1 km in clear air (the cloud shader's unit). Close flashes are
    // blinding; distant ones light part of the storm. strength: how strong this one is among its
    // kind (0.6..1.4), for its thunder.
    const [lo, hi] = kind === "cg" ? [3.5, 8] : near ? (tight ? [7, 14] : [26, 46]) : [12, 24];
    const scale = range(lo, hi);
    const strength = 0.6 + (0.8 * (scale - lo)) / (hi - lo);
    return { id: id++, kind, start: 0, strokes, duration, sources, weight: w.map(v => v / sum), scale, strength, bolt, depth, color: tinted(view, kind === "cg" ? COLOR_CG : COLOR_IC) };
  }

  /**
   * The strike (moments.js): the aircraft becomes part of a channel that comes down out of the
   * cloud ahead and above to its nose and leaves from its tail towards the sea. The channel is
   * drawn where the aircraft was when it struck (anchor): in the half second of its strokes the
   * aircraft drags it along, as a struck aircraft does.
   */
  function createStrike(view) {
    const q = view.qAircraft;
    const at = v => {
      const w = airframe(q, v);
      return [view.x + w[0], view.alt + w[1], view.z + w[2]];
    };
    const nose = at([0, -0.75, -2.6]);
    const tail = at([0, 0.35, 6.8]);
    const eye = [view.x, view.alt, view.z];
    // Crooked at every scale: near the eye it is split down to a metre or two.
    const bolt = [];
    const split = (p, q, width) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
      const near = Math.hypot(mid[0] - eye[0], mid[1] - eye[1], mid[2] - eye[2]);
      if (len < Math.max(1.2, near * 0.06)) {
        bolt.push({ a: p, b: q, width, glow: 1 });
        return;
      }
      const off = len * 0.28;
      mid[0] += (rand() - 0.5) * off;
      mid[1] += (rand() - 0.5) * off * 0.6;
      mid[2] += (rand() - 0.5) * off;
      split(p, mid, width);
      split(mid, q, width);
    };
    split(at([-90, 430, -180]), nose, 1);
    split(tail, at([120, -980, 240]), 1);
    // A few branches off the upper channel, away from the aircraft.
    const main = bolt.slice();
    for (let k = 0; k < 4; k++) {
      const s = main[Math.floor(rand() * main.length * 0.6)];
      const len = 60 + 140 * rand();
      const a = rand() * Math.PI * 2;
      bolt.push(...makeChannel(rand, s.b, [s.b[0] + Math.cos(a) * len, s.b[1] - len * (0.3 + 0.4 * rand()), s.b[2] + Math.sin(a) * len], { depth: 3, rough: 0.35, branches: 0 }).map(b => ({ ...b, width: 0.5, glow: 0.5 })));
    }
    // Four strokes a few hundredths of a second apart, each a blinding peak with little glow
    // between: the flicker of a strike seen from inside it.
    const strokes = [0, 0.07, 0.16, 0.29].map((t, i) => ({ t: t + 0.02 * rand(), a: [1.4, 0.8, 0.65, 0.5][i], tau: 0.025, glow: 0.06 + 0.04 * rand(), hold: 0.05 }));
    const duration = 0.6;
    return {
      id: id++,
      kind: "strike",
      start: STRIKE.t,
      strokes,
      duration: Math.max(duration, 0.6),
      sources: [nose, at([0, 70, -50]), at([0, -90, 70])],
      weight: [0.5, 0.25, 0.25],
      scale: 10,
      strength: 1.4,
      bolt,
      anchor: [view.x, view.alt, view.z],
      depth: 0,
      color: COLOR_CG
    };
  }

  /**
   * Spider lightning (moments.js): a web of channels that crawls along the underside of the
   * anvil, from far ahead towards and over the aircraft, a few hundred metres under the cloud
   * (keeping to the cloud's base where it rises and falls), branching as it goes; when it has
   * spread, its return strokes light the whole web. Each segment knows when the leader reached
   * it (at, s from the start), so the web is drawn as it grows.
   */
  function createSpider(view, crawl) {
    // The underside of the anvil above (x, z): open air from the aircraft's height up to it
    // (not a tower's flank), and high.
    const ceiling = (x, z) => {
      for (let y = view.alt + 300; y < 14000; y += 100) if (stormSD(x, y, z) > 0) return y >= 8500 ? y : null;
      return null;
    };
    const fx = view.forward.x;
    const fz = view.forward.z;
    const fl = Math.hypot(fx, fz) || 1;
    const ahead = [fx / fl, fz / fl];
    const side = range(-1, 1);
    let start = null;
    for (let i = 0; i < 12 && !start; i++) {
      const d = range(6000, 12000);
      const x = view.x + ahead[0] * d - ahead[1] * side * 2000;
      const z = view.z + ahead[1] * d + ahead[0] * side * 2000;
      const c = ceiling(x, z);
      if (c) start = [x, c - range(400, 700), z];
    }
    if (!start) return null;
    const speed = 11000 / crawl; // the web spreads about 11 km in crawl seconds
    const bolt = [];
    const grow = (p, heading, length, at, width, depth) => {
      let q = p;
      let h = heading;
      let t = at;
      for (let walked = 0; walked < length; ) {
        const step = range(200, 380);
        h += range(-0.35, 0.35);
        const x = q[0] + Math.cos(h) * step;
        const z = q[2] + Math.sin(h) * step;
        const c = ceiling(x, z);
        if (!c) return;
        // Under the cloud, rising and falling with it, but gently.
        const next = [x, Math.min(c - 300, Math.max(q[1] - 50, Math.min(q[1] + 50, c - range(400, 700)))), z];
        const seg = Math.hypot(next[0] - q[0], next[1] - q[1], next[2] - q[2]);
        bolt.push({ a: q, b: next, width, glow: 1, at: t, main: depth === 0 });
        t += seg / speed;
        walked += seg;
        q = next;
        if (depth < 2 && rand() < (depth === 0 ? 0.16 : 0.08)) {
          grow(q, h + (rand() < 0.5 ? -1 : 1) * range(0.5, 1.3), length * range(0.25, 0.5), t, width * 0.6, depth + 1);
        }
        if (bolt.length > 700) return;
      }
    };
    // Towards the aircraft and past it, spreading to both sides.
    const back = Math.atan2(view.z - start[2], view.x - start[0]);
    grow(start, back + range(-0.4, 0.4), range(9000, 13000), 0, 0.6, 0);
    grow(start, back + range(1.2, 2.0) * (rand() < 0.5 ? -1 : 1), range(3000, 6000), 0.05, 0.45, 1);
    if (bolt.length < 10) return null;
    // The light: in the cloud just above the channel, where the leader is and has been.
    const main = bolt.filter(s => s.main);
    const pick = f => main[Math.min(main.length - 1, Math.floor(f * main.length))].b;
    const lift = p => [p[0], p[1] + 250, p[2]];
    const { strokes, duration } = makeStrokes(rand, 2 + Math.floor(rand() * 2));
    for (const s of strokes) s.t += crawl;
    return {
      id: id++,
      kind: "spider",
      start: 0,
      crawl,
      strokes,
      duration: duration + crawl,
      sources: [lift(pick(0.15)), lift(pick(0.5)), lift(pick(0.85))],
      weight: [0.34, 0.33, 0.33],
      scale: range(10, 18),
      strength: 1,
      bolt,
      depth: 120,
      color: COLOR_IC
    };
  }

  /**
   * A place for lightning in the abyss's decks: mostly deep below (deep: only there), a little in
   * the deck overhead; rMin..rMax metres away across. depth: how far inside its deck.
   */
  function deckSeat(view, deep, rMin, rMax) {
    const below = [];
    let above = -1;
    DECKS.forEach(([mid], i) => {
      if (mid < view.alt - 600) below.push(i);
      else if (mid > view.alt + 600 && above < 0) above = i;
    });
    let i = below.length ? below[Math.min(below.length - 1, Math.floor(Math.pow(rand(), deep ? 0.55 : 1.3) * below.length))] : 0;
    if (!deep && above >= 0 && rand() < 0.2) i = above;
    const [mid, half] = DECKS[i];
    // Mostly where the aircraft is looking, ahead and to the sides: there they are seen.
    const look = Math.atan2(view.forward.z, view.forward.x);
    const a = rand() < 0.7 ? look + range(-1.9, 1.9) : rand() * Math.PI * 2;
    const r = range(rMin, rMax);
    const y = mid + range(-0.6, 0.6) * half;
    return { pos: [view.x + Math.cos(a) * r, y, view.z + Math.sin(a) * r], depth: Math.max(80, half - Math.abs(y - mid)) };
  }

  /**
   * A great flash in the deck beyond what is at `at` (world), as seen from the aircraft: it
   * lights the cloud behind it far and wide (the creature, moments.js, shows against it).
   */
  function createBehind(view, at) {
    const dx = at[0] - view.x;
    const dz = at[2] - view.z;
    const d = Math.hypot(dx, dz) || 1;
    const ux = dx / d;
    const uz = dz / d;
    const cx = view.x + ux * d * 1.9;
    const cz = view.z + uz * d * 1.9;
    const sources = [-1, 0, 1].map(k => [cx - uz * k * 2400 + range(-300, 300), -650 + range(-150, 150), cz + ux * k * 2400 + range(-300, 300)]);
    const { strokes, duration } = makeStrokes(rand, 3 + Math.floor(rand() * 3));
    const scale = range(50, 70);
    return { id: id++, kind: "ic", start: 0, strokes, duration, sources, weight: [0.36, 0.34, 0.3], scale, strength: 1.4, bolt: null, depth: 220, color: tinted(view, COLOR_IC) };
  }

  /** A flash in the deck overhead, a couple of kilometres from what is at `at` (world): it lights it from above. */
  function createAbove(view, at) {
    const a = rand() * Math.PI * 2;
    const r = range(1200, 2400);
    const [mid] = DECKS[0];
    const c = [at[0] + Math.cos(a) * r, mid - 120, at[2] + Math.sin(a) * r];
    const b = rand() * Math.PI * 2;
    const sources = [-0.5, 0, 0.5].map(f => [c[0] + Math.cos(b) * 1800 * f, c[1] + range(-100, 100), c[2] + Math.sin(b) * 1800 * f]);
    const { strokes, duration } = makeStrokes(rand, 2 + Math.floor(rand() * 3));
    const scale = range(30, 45);
    return { id: id++, kind: "ic", start: 0, strokes, duration, sources, weight: [0.3, 0.4, 0.3], scale, strength: 1.2, bolt: null, depth: 220, color: tinted(view, COLOR_IC) };
  }

  /** Lightning in a deck of the abyss: a discharge a kilometre or two long within it. */
  function createDeep(view) {
    const at = deckSeat(view, false, 1500, 14000);
    const a = rand() * Math.PI * 2;
    const len = range(900, 2600);
    const sources = [-0.5, 0, 0.5].map(f => [at.pos[0] + Math.cos(a) * len * f, at.pos[1] + range(-120, 120), at.pos[2] + Math.sin(a) * len * f]);
    const { strokes, duration } = makeStrokes(rand, 1 + Math.floor(rand() * 4));
    // (The abyss's discharges are greater than any on Earth.)
    const scale = range(18, 42);
    const w = [range(0.45, 0.65), range(0.3, 0.5), range(0.25, 0.45)];
    const sum = w[0] + w[1] + w[2];
    return { id: id++, kind: "ic", start: 0, strokes, duration, sources, weight: w.map(v => v / sum), scale, strength: 0.6 + (0.8 * (scale - 18)) / 24, bolt: null, depth: at.depth, color: tinted(view, COLOR_IC) };
  }

  function createFlick(view) {
    // The abyss: its flicker never stops, deep down.
    if (abyss) {
      const at = deckSeat(view, true, 4000, 25000);
      const { strokes, duration } = makeStrokes(rand, 1 + Math.floor(rand() * 3), true);
      const scale = range(14, 36);
      return { id: id++, start: 0, strokes, duration, pos: at.pos, depth: at.depth, scale, strength: 0.6 + (0.8 * (scale - 14)) / 22, color: tinted(view, COLOR_IC) };
    }
    // Away from the aircraft, so it shows the storm in depth rather than lighting what is near.
    const inside = centreDistance(view) < 11000;
    const pick = () => {
      for (let i = 0; i < 6; i++) {
        const c = anywhere();
        if (!inside || Math.hypot(c[0] - view.x, c[2] - view.z) > 3500) return c;
      }
      return anywhere();
    };
    const at = seat(view, pick, 10) || { pos: [centre[0], 7000, centre[1]], depth: 900 };
    const { strokes, duration } = makeStrokes(rand, 1 + Math.floor(rand() * 3), true);
    const scale = range(6, 15);
    return { id: id++, start: 0, strokes, duration, pos: at.pos, depth: at.depth, scale, strength: 0.6 + (0.8 * (scale - 6)) / 9, color: tinted(view, COLOR_IC) };
  }

  function flashRate(view) {
    // Flashes per second: a distant storm flickers, inside it is relentless; the abyss is alive
    // with it.
    // (Down there it comes and goes: stretches of a few minutes when it never stops, others
    // nearly still.)
    if (abyss) {
      const t = view.time ?? 0;
      const activity = 0.5 + 0.5 * Math.sin(t / 61 + 1.3 * Math.sin(t / 37));
      return Math.max(0.2 + 0.85 * activity, centreDistance(view) < 9500 ? 0.75 : 0);
    }
    const d = centreDistance(view);
    if (d < 9500) return 0.75;
    if (d < 16000) return 0.5;
    return 0.5 * Math.exp(-(d - 16000) / 12000);
  }

  // Average of a stroke train over the frame, so short peaks are never missed.
  const framePower = (strokes, ft, dt) => {
    let p = 0;
    for (let k = 0; k < 4; k++) p += strokePower(strokes, ft - (dt * (k + 0.5)) / 4);
    return p / 4;
  };

  function writeFlash(p) {
    const f = state.flash;
    if (!flash) {
      f.on = false;
      f.power = 0;
      f.boltPower = 0;
      return;
    }
    f.on = true;
    f.id = flash.id;
    f.power = p * flash.scale;
    f.pos = flash.sources;
    f.weight = flash.weight;
    f.color = flash.color;
    f.depth = flash.depth;
    f.bolt = flash.bolt;
    f.boltPower = flash.bolt ? Math.min(p, 1.5) : 0;
    f.kind = flash.kind;
    f.anchor = flash.anchor ?? null;
    // For the sound: the whole flash (when it starts, its strokes, its channel).
    f.event = flash;
  }

  function writeFlick(p) {
    const f = state.flick;
    if (!flick) {
      f.on = false;
      f.power = 0;
      return;
    }
    f.on = true;
    f.id = flick.id;
    f.power = p * flick.scale;
    f.pos = flick.pos;
    f.depth = flick.depth;
    f.color = flick.color;
    f.event = flick;
  }

  return {
    state,

    /** Advance to time t (s) of the journey; dt is the frame length. */
    update(view, t, dt) {
      placeAt(view);
      abyss = (view.alien ?? 0) > 0.5;
      // The strike happens when it is due, whatever else is lit.
      if (t >= STRIKE.t - LEAD && t < STRIKE.t + 0.5 && (!flash || flash.kind !== "strike")) {
        flash = createStrike(view);
      }
      // Strikes that light the tornado as the aircraft comes in.
      FUNNEL.strikes.forEach((s, i) => {
        if (!flash && !funnelDone[i] && t >= s.t - LEAD && t < s.t + 3) {
          funnelDone[i] = true;
          flash = createFlash(view, "cg", false, [FUNNEL.x + s.at[0], FUNNEL.z + s.at[1]]);
          flash.scale = range(10, 16);
          flash.sources[0] = [flash.sources[0][0], STORM.base + 450, flash.sources[0][2]];
          flash.weight = [0.55, 0.25, 0.2];
          flash.depth = 220;
          flash.start = Math.max(s.t, t + LEAD * 0.5);
        }
      });
      SPIDERS.forEach((sp, i) => {
        if (!flash && !spidersDone[i] && t >= sp.t - LEAD && t < sp.t + 4) {
          spidersDone[i] = true;
          const web = createSpider(view, sp.crawl);
          if (web) {
            flash = web;
            flash.start = Math.max(sp.t, t + LEAD * 0.5);
          }
        }
      });
      // The flashes that light the twin (moments.js).
      TWIN.flashes.forEach((ft, j) => {
        if (!flash && !twinDone.has(j) && t >= ft - LEAD && t < ft + 2 && view.twin && view.twin.on) {
          twinDone.add(j);
          flash = createAbove(view, [view.x + view.twin.pos.x, view.alt + view.twin.pos.y, view.z + view.twin.pos.z]);
          flash.start = Math.max(ft, t + LEAD * 0.5);
        }
      });
      // The flashes that show the creature (moments.js).
      CREATURE.forEach((c, i) =>
        c.flashes.forEach((ft, j) => {
          const key = i * 8 + j;
          if (!flash && !creatureDone.has(key) && t >= ft - LEAD && t < ft + 2 && view.creature && view.creature.world) {
            creatureDone.add(key);
            flash = createBehind(view, view.creature.world);
            flash.start = Math.max(ft, t + LEAD * 0.5);
          }
        })
      );
      if (!flash && t >= nextFlash - LEAD) {
        // In the abyss, in its decks (under the second storm, half of them still in the storm).
        if (abyss && (stormSD(view.x, view.alt + 900, view.z) < 0 || rand() < 0.5)) {
          flash = createDeep(view);
        } else {
          // Inside the storm: among its towers, or in its cloud.
          const inside = centreDistance(view) < 9500 || stormSD(view.x, view.alt, view.z) > -1000;
          const kind = rand() < (inside ? 0.3 : 0.4) ? "cg" : "ic";
          flash = createFlash(view, kind, inside && rand() < 0.75);
        }
        flash.start = Math.max(nextFlash, t + LEAD * 0.5);
      }
      if (flash && t - flash.start > flash.duration) {
        flash = null;
        nextFlash = t + (0.4 + rand() * 2.2) / Math.max(flashRate(view), 0.02);
      }
      if (!flick && t >= nextFlick - LEAD) {
        flick = createFlick(view);
        flick.start = Math.max(nextFlick, t + LEAD * 0.5);
      }
      if (flick && t - flick.start > flick.duration) {
        flick = null;
        nextFlick = t + LEAD + range(0, 0.3);
      }
      writeFlash(flash ? framePower(flash.strokes, t - flash.start, dt) + (flash.kind === "spider" ? crawlLight(t - flash.start, flash.crawl) : 0) : 0);
      if (flash) state.flash.age = t - flash.start;
      writeFlick(flick ? framePower(flick.strokes, t - flick.start, dt) : 0);
      state.glow = glowAt(view, t);
      const swell = abyss && flick ? Math.min(state.flick.power / 14, 2.5) : 0;
      state.deep += (swell - state.deep) * (1 - Math.exp(-dt / (swell > state.deep ? 0.06 : 1.4)));
      return state;
    },

    /**
     * For captures: hold lightning still. kind: "ic" (far), "near", "cg", "well" (a bolt under
     * the nearest well), "deep" (in the abyss's decks) or "none" for the flash, ms after its
     * first stroke; flick: whether the flicker is lit.
     */
    force(view, kind, ms, flickOn) {
      placeAt(view);
      abyss = (view.alien ?? 0) > 0.5;
      const make = { ic: ["ic", false], near: ["ic", true], cg: ["cg", true], well: ["cg", "well"] }[kind];
      const heldFlash = kind === "deep" ? createDeep(view) : make ? createFlash(view, make[0], make[1]) : null;
      const heldFlick = flickOn ? createFlick(view) : null;
      nextFlash = Infinity;
      nextFlick = Infinity;
      return {
        update(v, t) {
          flash = heldFlash;
          flick = heldFlick;
          writeFlash(flash ? strokePower(flash.strokes, ms / 1000) : 0);
          writeFlick(flick ? 1 : 0);
          state.glow = glowAt(v, t);
          state.deep = abyss && flick ? 1 : 0;
          return state;
        }
      };
    }
  };
}
