import { mulberry32 } from "../sky/cumulus.js";
import { STORM } from "./storm.js";

/**
 * Lightning of the night journey. Flashes come at random, more often and closer once inside
 * the storm. Each flash has a few return strokes (sharp peaks with short decays, sometimes a
 * glowing continuing current between them), up to three light sources for the clouds, and a
 * branching channel for bolts that can be seen.
 * Positions are in the storm frame (metres; y is altitude).
 */

const COLOR_IC = [0.72, 0.82, 1.0]; // inside cloud: scattered, bluish
const COLOR_CG = [0.86, 0.9, 1.0]; // channel in clear air: bluish white

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

/** Stroke train: times (s from the start of the flash) and relative amplitudes. */
function makeStrokes(rand, kind) {
  const n = kind === "cg" ? 2 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 4);
  const strokes = [];
  let t = 0;
  for (let i = 0; i < n; i++) {
    strokes.push({
      t,
      a: i === 0 ? 1 : 0.35 + 0.5 * rand(),
      tau: 0.02 + 0.03 * rand(),
      glow: rand() < 0.35 ? 0.12 + 0.12 * rand() : 0, // continuing current
      hold: 0.04 + 0.1 * rand()
    });
    t += 0.04 + 0.11 * rand();
  }
  return { strokes, duration: t + 0.2 };
}

function strokePower(strokes, t) {
  let p = 0;
  for (const s of strokes) {
    if (t < s.t) continue;
    const dt = t - s.t;
    p += s.a * Math.exp(-dt / s.tau) + (dt < s.hold ? s.glow : 0);
  }
  return p;
}

/**
 * stormSD(x, y, z): the baked storm distance (m, positive inside), used to put the light of a
 * flash inside the cloud: lit from within, a cloud glows; lit from the open air, it would look
 * like the walls of a cave.
 */
export function createLightning({ seed = 9, stormSD = () => 1000 } = {}) {
  const rand = mulberry32(seed);
  let flash = null;
  let nextAt = 1.5;
  let id = 0;
  const state = { on: false, id: -1, power: 0, pos: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], weight: [0, 0, 0], color: COLOR_IC, bolt: null, boltPower: 0 };

  const coreDistance = view => Math.hypot(view.x - 1500, view.z + 1500);

  function create(view, kind, near) {
    const sources = [];
    let bolt = null;
    if (kind === "cg") {
      // Cloud-to-sea strike under one of the cores.
      const a = rand() * Math.PI * 2;
      const r = 1500 + rand() * 6000;
      const x = 1000 + Math.cos(a) * r;
      const z = -1500 + Math.sin(a) * r;
      const top = [x + (rand() - 0.5) * 2000, STORM.base + 1800 + rand() * 2500, z + (rand() - 0.5) * 2000];
      const ground = [x + (rand() - 0.5) * 1500, 0, z + (rand() - 0.5) * 1500];
      sources.push(top, [x, STORM.base, z], [ground[0], 600, ground[2]]);
      bolt = makeChannel(rand, [x, STORM.base + 150, z], ground, { depth: 7, rough: 0.32, branches: 3 + Math.floor(rand() * 4) });
      bolt.unshift(...makeChannel(rand, top, [x, STORM.base + 150, z], { depth: 5, rough: 0.35, branches: 1 }));
    } else {
      // Inside the cloud: a horizontal discharge at mid levels, near the aircraft when inside.
      // Its sources are placed within the cloud mass.
      const pick = () => {
        if (near) {
          const a = rand() * Math.PI * 2;
          const r = 1200 + rand() * 3800;
          return [view.x + Math.cos(a) * r, view.alt + (rand() - 0.35) * 3000, view.z + Math.sin(a) * r];
        }
        const a = rand() * Math.PI * 2;
        const r = rand() * 8000;
        return [1500 + Math.cos(a) * r, 4500 + rand() * 5000, -1500 + Math.sin(a) * r];
      };
      let c = pick();
      for (let tries = 0; tries < 40 && stormSD(...c) < 500; tries++) c = pick();
      const a = rand() * Math.PI * 2;
      const len = 1200 + rand() * 3000;
      for (let k = 0; k < 3; k++) {
        const f = k / 2 - 0.5;
        let q = [c[0] + Math.cos(a) * len * f, c[1] + (rand() - 0.5) * 900, c[2] + Math.sin(a) * len * f];
        if (stormSD(...q) < 300) q = c.slice();
        sources.push(q);
      }
    }
    const { strokes, duration } = makeStrokes(rand, kind);
    const w = [0.45 + 0.2 * rand(), 0.3 + 0.2 * rand(), 0.25 + 0.2 * rand()];
    const sum = w[0] + w[1] + w[2];
    // Power: irradiance at 1 km in clear air (the cloud shader's unit).
    // Close flashes are blinding; distant ones only light part of the storm.
    const scale = kind === "cg" ? 14 + rand() * 14 : near ? 20 + rand() * 16 : 8 + rand() * 9;
    return {
      id: id++,
      kind,
      start: 0,
      strokes,
      duration,
      sources,
      weight: w.map(v => v / sum),
      scale,
      bolt,
      color: kind === "cg" ? COLOR_CG : COLOR_IC
    };
  }

  function rate(view) {
    // Flashes per second: a distant storm flickers, inside it is relentless.
    const d = coreDistance(view);
    if (d < 9000) return 0.55;
    if (d < 16000) return 0.35;
    return 0.35 * Math.exp(-(d - 16000) / 12000);
  }

  return {
    state,

    /** Advance to time t (s) of the journey; dt is the frame length. */
    update(view, t, dt) {
      if (!flash && t >= nextAt) {
        const inside = coreDistance(view) < 9500;
        const kind = rand() < (inside ? 0.25 : 0.4) ? "cg" : "ic";
        flash = create(view, kind, inside && rand() < 0.7);
        flash.start = t;
      }
      if (flash && t - flash.start > flash.duration) {
        flash = null;
        nextAt = t + (0.3 + rand() * 2) / Math.max(rate(view), 0.02);
      }
      if (!flash) {
        state.on = false;
        state.power = 0;
        state.boltPower = 0;
        return state;
      }
      // Average the stroke train over the frame, so short peaks are never missed.
      const ft = t - flash.start;
      let p = 0;
      for (let k = 0; k < 4; k++) p += strokePower(flash.strokes, ft - dt * (k + 0.5) / 4);
      p /= 4;
      state.on = true;
      state.id = flash.id;
      state.power = p * flash.scale;
      state.pos = flash.sources;
      state.weight = flash.weight;
      state.color = flash.color;
      state.bolt = flash.bolt;
      state.boltPower = flash.bolt ? Math.min(p, 1.5) : 0;
      return state;
    },

    /** For captures: hold one flash of the given kind, ms after its first stroke. */
    force(view, kind, ms) {
      flash = create(view, kind, kind === "near");
      if (kind === "near") flash.kind = "ic";
      flash.start = 0;
      nextAt = Infinity;
      const hold = flash;
      return {
        update(v, t, dt) {
          flash = hold;
          const p = strokePower(hold.strokes, ms / 1000);
          state.on = true;
          state.id = hold.id;
          state.power = p * hold.scale;
          state.pos = hold.sources;
          state.weight = hold.weight;
          state.color = hold.color;
          state.bolt = hold.bolt;
          state.boltPower = hold.bolt ? Math.min(p, 1.5) : 0;
          return state;
        }
      };
    }
  };
}
