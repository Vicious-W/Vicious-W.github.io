import { mulberry32 } from "../sky/cumulus.js";
import { STORM, WELLS } from "./storm.js";

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
  let id = 0;
  const state = {
    flash: { on: false, id: -1, power: 0, pos: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], weight: [1, 0, 0], color: COLOR_IC, depth: 0, bolt: null, boltPower: 0 },
    flick: { on: false, id: -1, power: 0, pos: [0, 0, 0], color: COLOR_IC, depth: 0 },
    glow: 0
  };

  // The storm's own glow around the aircraft: strongest inside, a slow uneven shimmer.
  const glowAt = (view, t) => {
    const near = 1 - Math.min(Math.max((centreDistance(view) - 9000) / 9000, 0), 1);
    return near * (0.7 + 0.2 * Math.sin(t * 2.3) * Math.sin(t * 0.7 + 1.3) + 0.1 * Math.sin(t * 5.1 + Math.sin(t * 1.7) * 2));
  };

  const centreDistance = view => Math.hypot(view.x - CENTRE[0], view.z - CENTRE[1]);

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
    return [CENTRE[0] + Math.cos(a) * r, range(3000, 10500), CENTRE[1] + Math.sin(a) * r];
  };
  const around = (view, rMin, rMax, below = 1500, above = 4200) => () => {
    const a = rand() * Math.PI * 2;
    const r = range(rMin, rMax);
    return [view.x + Math.cos(a) * r, view.alt + range(-below, above), view.z + Math.sin(a) * r];
  };

  function createFlash(view, kind, near) {
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
      if (near === "well" || (near && rand() < 0.7)) {
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
          const px = CENTRE[0] + Math.cos(a) * r;
          const pz = CENTRE[1] + Math.sin(a) * r;
          if (!farFromWells(px, pz)) continue;
          const s = (underCloud(px, pz) ? 1 : 0) + (seen(px, pz) ? 2 : 0) + rand() * 0.5;
          if (s > score) {
            score = s;
            x = px;
            z = pz;
          }
        }
        if (score < 0) {
          x = CENTRE[0] + 9000;
          z = CENTRE[1] + 6000;
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
      const at = seat(view, pick, near ? 32 : 16) || { pos: [CENTRE[0], 6000, CENTRE[1]], depth: 800 };
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
    // blinding; distant ones light part of the storm.
    const scale = kind === "cg" ? range(3.5, 8) : near ? (tight ? range(7, 14) : range(26, 46)) : range(12, 24);
    return { id: id++, kind, start: 0, strokes, duration, sources, weight: w.map(v => v / sum), scale, bolt, depth, color: kind === "cg" ? COLOR_CG : COLOR_IC };
  }

  function createFlick(view) {
    // Away from the aircraft, so it shows the storm in depth rather than lighting what is near.
    const inside = centreDistance(view) < 11000;
    const pick = () => {
      for (let i = 0; i < 6; i++) {
        const c = anywhere();
        if (!inside || Math.hypot(c[0] - view.x, c[2] - view.z) > 3500) return c;
      }
      return anywhere();
    };
    const at = seat(view, pick, 10) || { pos: [CENTRE[0], 7000, CENTRE[1]], depth: 900 };
    const { strokes, duration } = makeStrokes(rand, 1 + Math.floor(rand() * 3), true);
    return { id: id++, start: 0, strokes, duration, pos: at.pos, depth: at.depth, scale: range(6, 15) };
  }

  function flashRate(view) {
    // Flashes per second: a distant storm flickers, inside it is relentless.
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
    f.event = flick;
  }

  return {
    state,

    /** Advance to time t (s) of the journey; dt is the frame length. */
    update(view, t, dt) {
      if (!flash && t >= nextFlash - LEAD) {
        // Inside the storm: among its towers, or in its cloud.
        const inside = centreDistance(view) < 9500 || stormSD(view.x, view.alt, view.z) > -1000;
        const kind = rand() < (inside ? 0.3 : 0.4) ? "cg" : "ic";
        flash = createFlash(view, kind, inside && rand() < 0.75);
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
      writeFlash(flash ? framePower(flash.strokes, t - flash.start, dt) : 0);
      writeFlick(flick ? framePower(flick.strokes, t - flick.start, dt) : 0);
      state.glow = glowAt(view, t);
      return state;
    },

    /**
     * For captures: hold lightning still. kind: "ic" (far), "near", "cg", "well" (a bolt under
     * the nearest well) or "none" for the flash, ms after its first stroke; flick: whether the
     * flicker is lit.
     */
    force(view, kind, ms, flickOn) {
      const make = { ic: ["ic", false], near: ["ic", true], cg: ["cg", true], well: ["cg", "well"] }[kind];
      const heldFlash = make ? createFlash(view, make[0], make[1]) : null;
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
          return state;
        }
      };
    }
  };
}
