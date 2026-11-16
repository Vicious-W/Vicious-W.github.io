import * as THREE from "three";
import { mulberry32 } from "../sky/cumulus.js";
import { createPath } from "./journey.js";

/**
 * The thunderstorm of the night journey, baked once into a 3D signed-distance volume (metres,
 * positive inside). The shader adds the billowy noise on top, as for the day clouds.
 * Storm frame: x (east) and z (south) in metres around the storm, y is altitude.
 *
 * It is a cluster of towers under one anvil. The towers stand around a hall several kilometres
 * across, roofed by the anvil and floored by a low deck of cloud with wells down to the sea.
 * The journey comes in from the south through a canyon between two towers, crosses the hall
 * beside the main updraft, flies into the rear tower (a cave inside it), and leaves northwards.
 */
export const STORM = Object.freeze({
  min: [-22000, -24000], // x, z of the volume's corner
  size: [54000, 14000, 48000], // x, y, z extent (m)
  grid: [216, 96, 192],
  range: 1500, // distances are stored clamped to +-range
  base: 1300, // flat cloud base (m)
  // Fair-weather clouds keep away: centre x, z, and the radii between which they fade in.
  calm: [-1000, 1500, 21000, 27000]
});

// Towers: foot x, z (m), radius at the foot, top altitude. flare > 0: the top spreads into the
// anvil instead of ending in a head.
export const TOWERS = [
  { name: "main", x: 6600, z: -1200, r: 4300, top: 11900, flare: 0.75, lean: 0.04 },
  // West wall of the hall and of the canyon.
  { name: "west1", x: -5600, z: 2000, r: 3300, top: 10200, flare: 0.2 },
  { name: "west2", x: -5400, z: -4200, r: 3000, top: 8500 },
  { name: "gateWest", x: -4800, z: 7800, r: 2900, top: 8100 },
  { name: "gateEast", x: 3400, z: 8200, r: 2800, top: 9000 },
  // The rear tower closes the hall to the north; the journey flies into it.
  { name: "rear", x: -1300, z: -10400, r: 3100, top: 10700 },
  // Between the rear tower and this one the hall is open to the north-east, where the moon is.
  { name: "northEast", x: 11000, z: -8000, r: 2900, top: 9200 },
  { name: "east", x: 11500, z: 4500, r: 2900, top: 8300 },
  // Flanking line of younger towers to the south-west, stepping down.
  { name: "flank1", x: -10500, z: 10500, r: 2400, top: 6900 },
  { name: "flank2", x: -14000, z: 13500, r: 1900, top: 5300 },
  { name: "flank3", x: -17000, z: 16500, r: 1500, top: 4000 },
  // Lesser towers on the outside of the cluster, so its outline is not a ring of equals.
  { x: -9000, z: 4500, r: 1900, top: 6500 },
  { x: -8600, z: -1500, r: 1700, top: 5800 },
  { x: -8200, z: -7500, r: 1600, top: 5200 },
  { x: 7500, z: 11000, r: 1800, top: 6200 },
  { x: 13000, z: -3500, r: 2300, top: 7400 },
  { x: 3800, z: -13200, r: 1900, top: 6600 },
  { x: -6600, z: -12000, r: 1800, top: 6000 }
];

// Anvil: rooted in the main updraft, spreading far downwind (east), less upwind, and less to
// the north than to the south, so the low moon in the north-east shows under its edge.
const ANVIL = { x: 6600, z: -1200, down: 21000, up: 11500, north: 9000, south: 12000, top: 12300, bottom: 9200 };

// Wells through the low deck of the hall, down to the sea: x, z, radius. The journey passes
// over the first.
export const WELLS = [
  { x: -100, z: -3000, r: 1250 },
  { x: 2300, z: 2400, r: 850 },
  { x: -2100, z: 5600, r: 750 }
];

// The cave inside the rear tower, around this point of the path.
export const CAVE = { x: -1650, y: 4540, z: -10600 };

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.max(a, b) + (h * h * 0.25) / k;
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.min(a, b) - (h * h * 0.25) / k;
}

/** Smooth 2D value noise in [0, 1] for irregular outlines. */
function makeNoise2(seed) {
  const hash = (i, j) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * ux;
    const b = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * ux;
    return a + (b - a) * uy;
  };
}

/**
 * Shapes of the storm: spheres {x, y, z, r} and upright rounded discs {x, y, z, r, h, round}
 * (radius r, half-height h). A tower is a column of discs that follows a radius profile, with
 * bubbles bulging from its flanks, and a domed, cauliflower head unless it feeds the anvil.
 */
function buildShapes(rand, clearOfPath) {
  const shapes = [];
  const range = (lo, hi) => lo + (hi - lo) * rand();
  for (const t of TOWERS) {
    const height = t.top - STORM.base;
    const lean = t.lean ?? range(0.05, 0.11);
    // Wide foot, narrower waist; then a head, or a flare into the anvil.
    const profile = f =>
      t.flare
        ? 1 - 0.24 * Math.sin(Math.PI * Math.min(f / 0.8, 1)) + t.flare * smoothstep(0.7, 1, f) ** 2
        : 1 - 0.3 * smoothstep(0, 0.6, f) + 0.2 * smoothstep(0.5, 0.85, f);
    const headR = t.r * profile(0.85) * 0.98;
    const columnTop = t.flare ? t.top : t.top - headR * 0.9;
    const step = 850;
    let ox = 0;
    let oz = 0;
    for (let y = STORM.base + 200; y <= columnTop; y += step) {
      const f = (y - STORM.base) / height;
      ox += (rand() - 0.5) * 0.09 * t.r;
      oz += (rand() - 0.5) * 0.09 * t.r;
      const r = t.r * profile(f) * range(0.94, 1.06);
      const cx = t.x + ox + lean * (y - STORM.base);
      const cz = t.z + oz;
      shapes.push({ x: cx, y, z: cz, r, h: step * 0.75, round: Math.min(450, r * 0.3) });
      // Bubbles on the flanks: a few large buttresses, more small turrets.
      const n = rand() < 0.45 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const a = rand() * Math.PI * 2;
        const br = r * (rand() < 0.3 ? range(0.32, 0.46) : range(0.16, 0.3));
        const d = r - br * range(0.15, 0.6);
        const bubble = { x: cx + Math.cos(a) * d, y: y + range(-0.3, 0.5) * step, z: cz + Math.sin(a) * d, r: br };
        // None reaches into the way of the journey: there it would be cut through, leaving a ring.
        if (clearOfPath(bubble)) shapes.push(bubble);
      }
    }
    if (!t.flare) {
      // Head: a dome with a crown of bubbles.
      const hx = t.x + ox + lean * (t.top - headR - STORM.base);
      const hz = t.z + oz;
      const hy = t.top - headR;
      shapes.push({ x: hx, y: hy, z: hz, r: headR });
      const crown = 7 + Math.floor(rand() * 4);
      for (let k = 0; k < crown; k++) {
        const a = rand() * Math.PI * 2;
        const e = range(0.1, 1.1); // elevation on the dome
        const br = headR * range(0.28, 0.45);
        const d = headR - br * 0.45;
        shapes.push({
          x: hx + Math.cos(a) * Math.cos(e) * d,
          y: hy + Math.sin(e) * d,
          z: hz + Math.sin(a) * Math.cos(e) * d,
          r: br
        });
      }
    }
  }
  // Overshooting top above the main updraft.
  const main = TOWERS[0];
  shapes.push({ x: main.x + 500, y: 11900, z: main.z, r: 1500 });
  shapes.push({ x: main.x - 300, y: 11700, z: main.z + 900, r: 1100 });

  // The low deck: heaps of cloud between the feet of the towers, except over the wells.
  const inWell = (x, z, margin) => WELLS.some(w => Math.hypot(x - w.x, z - w.z) < w.r + margin);
  for (let n = 0; n < 230; n++) {
    const x = range(-4200, 5200);
    const z = range(-8200, 9800);
    const r = range(900, 1500);
    if (inWell(x, z, r * 0.8)) continue;
    shapes.push({ x, y: STORM.base + range(200, 1100), z, r });
  }
  return shapes;
}

/** Bakes the storm and returns its texture, its field and a sampler of the baked distance. */
export function bakeStorm(seed = 77) {
  const [nx, ny, nz] = STORM.grid;
  const [sx, sy, sz] = STORM.size;
  const vx = sx / nx;
  const vy = sy / ny;
  const vz = sz / nz;
  const R = STORM.range;
  const field = new Float32Array(nx * ny * nz).fill(-R);
  const rand = mulberry32(seed);
  const noise = makeNoise2(seed * 31 + 7);
  const cx = i => STORM.min[0] + (i + 0.5) * vx;
  const cy = j => (j + 0.5) * vy;
  const cz = k => STORM.min[1] + (k + 0.5) * vz;
  const index = (i, j, k) => i + nx * (j + ny * k);
  const clampI = (v, n) => Math.max(0, Math.min(n - 1, v));

  // Applies fn(x, y, z, idx) to every voxel within reach of the box around a shape.
  const within = (x, y, z, rx, ry, fn) => {
    const i0 = clampI(Math.floor((x - rx - STORM.min[0]) / vx), nx);
    const i1 = clampI(Math.ceil((x + rx - STORM.min[0]) / vx), nx);
    const j0 = clampI(Math.floor((y - ry) / vy), ny);
    const j1 = clampI(Math.ceil((y + ry) / vy), ny);
    const k0 = clampI(Math.floor((z - rx - STORM.min[1]) / vz), nz);
    const k1 = clampI(Math.ceil((z + rx - STORM.min[1]) / vz), nz);
    for (let k = k0; k <= k1; k++) {
      const pz = cz(k);
      for (let j = j0; j <= j1; j++) {
        const py = cy(j);
        let idx = index(i0, j, k);
        for (let i = i0; i <= i1; i++, idx++) fn(cx(i), py, pz, idx);
      }
    }
  };

  // Towers and deck: smooth union of the shapes.
  const blend = 700;
  // The journey's way: flank bubbles keep clear of it.
  const path = createPath();
  const route = [];
  for (let s = 0; s <= path.length; s += 150) route.push(path.position(s));
  const clearOfPath = b => {
    for (const p of route) {
      if (Math.abs(p[1] - b.y) > b.r + 1200) continue;
      if (Math.hypot(p[0] - b.x, p[2] - b.z) - b.r < 900) return false;
    }
    return true;
  };
  for (const s of buildShapes(rand, clearOfPath)) {
    if (s.h === undefined) {
      within(s.x, s.y, s.z, s.r + R, s.r + R, (x, y, z, idx) => {
        const d = s.r - Math.hypot(x - s.x, y - s.y, z - s.z);
        if (d > -R) field[idx] = smax(field[idx], d, blend);
      });
    } else {
      within(s.x, s.y, s.z, s.r + R, s.h + R, (x, y, z, idx) => {
        // Rounded upright disc.
        const qx = Math.hypot(x - s.x, z - s.z) - s.r + s.round;
        const qy = Math.abs(y - s.y) - s.h + s.round;
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const d = s.round - outside - Math.min(Math.max(qx, qy), 0);
        if (d > -R) field[idx] = smax(field[idx], d, blend);
      });
    }
  }

  // Anvil: a wide slab under the tropopause with a ragged outline; thick near the updraft,
  // thinning to its edges, its underside lowest over the trunk and rising outwards.
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const x = cx(i);
      const z = cz(k);
      const dx = x - ANVIL.x;
      const arx = dx > 0 ? ANVIL.down : ANVIL.up;
      const arz = (z < ANVIL.z ? ANVIL.north : ANVIL.south) + Math.max(dx, 0) * 0.12; // fans out downwind
      const ex = dx / arx;
      const ez = (z - ANVIL.z) / arz;
      const ragged = 0.8 + 0.4 * noise(x / 6500, z / 6500) + 0.12 * (noise(x / 2300 + 9, z / 2300) - 0.5);
      const r1 = Math.sqrt(ex * ex + ez * ez) / ragged;
      const edge = (1 - r1) * Math.min(arx, arz); // horizontal distance to the rim
      if (edge < -R) continue;
      const r2 = Math.min(r1 * r1, 1.3);
      const top = ANVIL.top - 500 * r2 + 250 * (noise(x / 3000 + 40, z / 3000) - 0.5);
      const bottom = Math.min(ANVIL.bottom + 2300 * Math.sqrt(r2), top - 300);
      for (let j = Math.floor(7500 / vy); j < ny; j++) {
        const y = cy(j);
        const d = Math.min(top - y, y - bottom, edge);
        if (d > -R) {
          const idx = index(i, j, k);
          field[idx] = smax(field[idx], d, 1100);
        }
      }
    }
  }

  // Clear air where the journey needs it. Along the path through the canyon and the hall only a
  // narrow corridor is guaranteed (the towers leave far more room than that); the wells are cut
  // down through the deck; the cave in the rear tower is a cluster of bubbles.
  const carve = (px, py, pz, r, squash, k) => {
    within(px, py, pz, r + R, (r + R) / squash, (x, y, z, idx) => {
      const inside = r - Math.hypot(x - px, (y - py) * squash, z - pz);
      if (inside > -R) field[idx] = smin(field[idx], -inside, k);
    });
  };
  for (let s = 0; s <= path.length; s += 200) {
    const p = path.position(s);
    if (p[2] < 9500 && p[2] > -6000) carve(p[0], p[1], p[2], 800, 1.0, 600);
  }
  for (const w of WELLS) {
    for (let y = 300; y <= 3600; y += 300) {
      const wobble = noise(y / 900 + w.x, w.z) - 0.5;
      carve(w.x + wobble * 500, y, w.z + (noise(w.x, y / 900 + w.z) - 0.5) * 500, w.r * (0.75 + 0.3 * noise(y / 700, w.x + w.z)), 0.55, 500);
    }
  }
  for (const [ox, oy, oz, r] of [[0, 0, 0, 760], [330, 120, 560, 560], [-300, -80, -540, 600], [520, -150, -200, 480], [-560, 200, 250, 460]]) {
    carve(CAVE.x + ox, CAVE.y + oy, CAVE.z + oz, r, 1.15, 450);
  }

  const data = new Uint8Array(field.length);
  for (let n = 0; n < field.length; n++) {
    data[n] = Math.round((Math.min(Math.max(field[n] / R, -1), 1) * 0.5 + 0.5) * 255);
  }
  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  // Trilinear look-up of the baked distance (m), for placing lightning and timing the cabin.
  const sample = (x, y, z) => {
    const gx = (x - STORM.min[0]) / vx - 0.5;
    const gy = y / vy - 0.5;
    const gz = (z - STORM.min[1]) / vz - 0.5;
    if (gx < 0 || gy < 0 || gz < 0 || gx > nx - 1 || gy > ny - 1 || gz > nz - 1) return -R;
    const i = Math.min(Math.floor(gx), nx - 2);
    const j = Math.min(Math.floor(gy), ny - 2);
    const k = Math.min(Math.floor(gz), nz - 2);
    const fx = gx - i;
    const fy = gy - j;
    const fz = gz - k;
    const at = (a, b, c) => field[index(i + a, j + b, k + c)];
    const x00 = at(0, 0, 0) + (at(1, 0, 0) - at(0, 0, 0)) * fx;
    const x10 = at(0, 1, 0) + (at(1, 1, 0) - at(0, 1, 0)) * fx;
    const x01 = at(0, 0, 1) + (at(1, 0, 1) - at(0, 0, 1)) * fx;
    const x11 = at(0, 1, 1) + (at(1, 1, 1) - at(0, 1, 1)) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  };
  return { texture, field, sample };
}
