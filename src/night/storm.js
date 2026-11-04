import * as THREE from "three";
import { mulberry32 } from "../sky/cumulus.js";
import { createPath, VOIDS } from "./journey.js";

/**
 * The thunderstorm of the night journey, baked once into a 3D signed-distance volume (metres,
 * positive inside). The shader adds the billowy noise on top, as for the day clouds.
 * Storm frame: x and z in metres around the storm at the origin, y is altitude.
 */
export const STORM = Object.freeze({
  min: [-24000, -24000], // x, z of the volume's corner
  size: [48000, 14000, 48000], // x, y, z extent (m)
  grid: [160, 80, 160],
  range: 1500, // distances are stored clamped to +-range
  base: 1300 // flat cloud base (m)
});

// Cells of the storm: centre x, z (m), base radius, top altitude (m).
const CELLS = [
  { x: 1500, z: -1500, r: 4500, top: 11800 }, // mature core, feeds the anvil
  { x: -4500, z: 2500, r: 3500, top: 9000 },
  { x: 4500, z: 3500, r: 3000, top: 8200 },
  { x: -2000, z: -6000, r: 3500, top: 10000 }, // decaying rear cell
  { x: 5500, z: -5500, r: 3200, top: 9500 },
  // Flanking line of younger towers to the south-west, stepping down.
  { x: -9000, z: 6500, r: 2500, top: 7200 },
  { x: -12000, z: 9000, r: 2000, top: 5600 },
  { x: -14500, z: 11500, r: 1600, top: 4200 }
];

function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.max(a, b) + (h * h * 0.25) / k;
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0);
  return Math.min(a, b) - (h * h * 0.25) / k;
}

/** Bubbles of every cell: a leaning, wandering stack with bulges on its flanks. */
function buildSpheres(rand) {
  const spheres = [];
  for (const c of CELLS) {
    let ox = 0;
    let oz = 0;
    let y = STORM.base + c.r * 0.35;
    const lean = 0.08 + 0.06 * rand();
    while (y < c.top) {
      const f = (y - STORM.base) / (c.top - STORM.base);
      const r = c.r * (1 - 0.35 * f) * (0.85 + 0.25 * rand());
      ox += (rand() - 0.5) * 0.18 * c.r;
      oz += (rand() - 0.5) * 0.18 * c.r;
      const cy = Math.min(y, c.top - r * 0.8);
      spheres.push({ x: c.x + ox + lean * (cy - STORM.base), y: cy, z: c.z + oz, r });
      // Bulges on the flanks.
      for (let k = 0; k < 3; k++) {
        const a = rand() * Math.PI * 2;
        const br = r * (0.35 + 0.25 * rand());
        const d = r * (0.75 + 0.2 * rand());
        spheres.push({
          x: c.x + ox + Math.cos(a) * d,
          y: cy + (rand() - 0.3) * r * 0.6,
          z: c.z + oz + Math.sin(a) * d,
          r: br
        });
      }
      y += r * 0.7;
    }
  }
  // The main updraft: one broad trunk from the base into the anvil, narrowing a little at
  // mid levels and flaring out where it spreads into the anvil.
  for (let y = STORM.base + 2500; y <= 11200; y += 900) {
    const f = (y - STORM.base) / (11200 - STORM.base);
    const r = 4300 * (1 - 0.25 * Math.sin(f * Math.PI)) + 2600 * Math.pow(f, 3);
    spheres.push({ x: 1500 + (rand() - 0.5) * 600 + 400 * f, y, z: -1500 + (rand() - 0.5) * 600, r });
  }
  // Overshooting top above the core.
  spheres.push({ x: 1800, y: 12700, z: -1500, r: 2200 });
  return spheres;
}

/** Bakes the storm and returns its texture and frame. */
export function bakeStorm(seed = 77) {
  const [nx, ny, nz] = STORM.grid;
  const [sx, sy, sz] = STORM.size;
  const vx = sx / nx;
  const vy = sy / ny;
  const vz = sz / nz;
  const R = STORM.range;
  const field = new Float32Array(nx * ny * nz).fill(-R);
  const rand = mulberry32(seed);
  const cx = i => STORM.min[0] + (i + 0.5) * vx;
  const cy = j => (j + 0.5) * vy;
  const cz = k => STORM.min[1] + (k + 0.5) * vz;
  const index = (i, j, k) => i + nx * (j + ny * k);

  // Cells: smooth union of the bubbles, rasterised within reach of each one.
  const blend = 900;
  for (const s of buildSpheres(rand)) {
    const reach = s.r + R;
    const i0 = Math.max(0, Math.floor((s.x - reach - STORM.min[0]) / vx));
    const i1 = Math.min(nx - 1, Math.ceil((s.x + reach - STORM.min[0]) / vx));
    const j0 = Math.max(0, Math.floor((s.y - reach) / vy));
    const j1 = Math.min(ny - 1, Math.ceil((s.y + reach) / vy));
    const k0 = Math.max(0, Math.floor((s.z - reach - STORM.min[1]) / vz));
    const k1 = Math.min(nz - 1, Math.ceil((s.z + reach - STORM.min[1]) / vz));
    for (let k = k0; k <= k1; k++) {
      const dz = cz(k) - s.z;
      for (let j = j0; j <= j1; j++) {
        const dy = cy(j) - s.y;
        let idx = index(i0, j, k);
        for (let i = i0; i <= i1; i++, idx++) {
          const dx = cx(i) - s.x;
          const d = s.r - Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > -R) field[idx] = smax(field[idx], d, blend);
        }
      }
    }
  }

  // Anvil: a wide slab under the tropopause, rooted in the core and spreading far downwind
  // (east), little upwind; thick near the core, thinning to its edges.
  const ax = 1500;
  const az = -1500;
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const dx = cx(i) - ax;
      const arx = dx > 0 ? 26000 : 8000;
      const arz = 12000 + Math.max(dx, 0) * 0.15; // fans out downwind
      const ex = dx / arx;
      const ez = (cz(k) - az) / arz;
      const r2 = ex * ex + ez * ez;
      const edge = (1 - Math.sqrt(r2)) * Math.min(arx, arz); // horizontal distance to the rim
      // The underside is lowest over the trunk and rises towards the thin edges.
      const top = 12300 - 500 * r2;
      const bottom = Math.min(9200 + 2300 * Math.sqrt(r2), top - 250);
      for (let j = Math.floor(8000 / vy); j < ny; j++) {
        const y = cy(j);
        const d = Math.min(top - y, y - bottom, edge);
        if (d > -R) {
          const idx = index(i, j, k);
          field[idx] = smax(field[idx], d, 1200);
        }
      }
    }
  }

  // Clear spaces along the path: a canyon, a vault, a passage through the rear cell; plus a
  // shaft from the path down through the cloud base, so the sea shows far below.
  const path = createPath();
  const carve = (p, r) => {
    const reach = r + R;
    const i0 = Math.max(0, Math.floor((p[0] - reach - STORM.min[0]) / vx));
    const i1 = Math.min(nx - 1, Math.ceil((p[0] + reach - STORM.min[0]) / vx));
    const j0 = Math.max(0, Math.floor((p[1] - reach) / vy));
    const j1 = Math.min(ny - 1, Math.ceil((p[1] + reach) / vy));
    const k0 = Math.max(0, Math.floor((p[2] - reach - STORM.min[1]) / vz));
    const k1 = Math.min(nz - 1, Math.ceil((p[2] + reach - STORM.min[1]) / vz));
    for (let k = k0; k <= k1; k++) {
      const dz = cz(k) - p[2];
      for (let j = j0; j <= j1; j++) {
        // Voids are a little flattened: wider than tall.
        const dy = (cy(j) - p[1]) * 1.3;
        let idx = index(i0, j, k);
        for (let i = i0; i <= i1; i++, idx++) {
          const dx = cx(i) - p[0];
          const inside = r - Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (inside > -R) field[idx] = smin(field[idx], -inside, 500);
        }
      }
    }
  };
  for (let s = 0; s <= path.length; s += 150) {
    const u = path.index(s);
    const i = Math.floor(u);
    const f = u - i;
    const r = VOIDS[i] * (1 - f) + (VOIDS[Math.min(i + 1, VOIDS.length - 1)] ?? 0) * f;
    if (r > 0) carve(path.position(s), r);
  }
  for (let y = 600; y <= 4900; y += 150) carve([0, y, -3500], 950);

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
  // Nearest-voxel look-up of the baked distance (m), for placing lightning.
  const sample = (x, y, z) => {
    const i = Math.floor((x - STORM.min[0]) / vx);
    const j = Math.floor(y / vy);
    const k = Math.floor((z - STORM.min[1]) / vz);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return -R;
    return field[index(i, j, k)];
  };
  return { texture, field, sample };
}
