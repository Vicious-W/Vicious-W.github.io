import * as THREE from "three";

/**
 * Giant towering cumulus. A height field cannot make them: their sides bulge and overhang.
 * So four cloud shapes are built from packed bubbles (a broad heap, leaning towers, and two
 * generations of cauliflower bubbles), baked into one RGBA volume, and placed rarely across
 * the cloud field, each rotated and scaled differently.
 */

// Shape volume: x and z span [-extent, extent] in units of the footprint radius (the cloud
// itself fits in the unit disc; the margin leaves room for noise to push the surface out),
// y spans [0, ySpan] from the flat base. Voxels are cubes of 1/40. Each texel stores a signed
// distance to the cloud surface (positive inside) in [-range, range], one cloud per channel.
export const SHAPE = Object.freeze({ nx: 96, ny: 64, nz: 96, extent: 1.2, ySpan: 1.6, range: 0.2 });

// Giants stand on a coarse grid in cloud-map space, at most one per cell and fully inside it.
export const GIANTS = Object.freeze({ cell: 16384, grid: 5 });

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tower radii are in shape units (the footprint radius is 1); heights are relative to the top.
const STYLES = [
  // Congestus: one massive tower stepping down into a few lower ones.
  { towers: [3, 4], mainOffset: 0.2, mainR: [0.36, 0.44], otherR: [0.22, 0.32], second: [0.45, 0.8], heap: 10, top: [1.25, 1.5] },
  // A crowd of towers of similar height.
  { towers: [4, 6], mainOffset: 0.3, mainR: [0.3, 0.36], otherR: [0.24, 0.32], second: [0.62, 0.92], heap: 8, top: [1.05, 1.3] },
  // Broad heap with a tower rising off-centre.
  { towers: [2, 3], mainOffset: 0.4, mainR: [0.32, 0.4], otherR: [0.2, 0.3], second: [0.35, 0.6], heap: 14, top: [1.1, 1.4] },
  // Tall chimney on a wide skirt.
  { towers: [2, 3], mainOffset: 0.12, mainR: [0.28, 0.34], otherR: [0.18, 0.26], second: [0.3, 0.55], heap: 12, top: [1.35, 1.52] }
];

// Signed distance to the union of spheres (positive inside). Inside, it never exceeds the true
// distance to the surface, so it can be used as a safe step when walking outwards.
function fieldOf(spheres, x, y, z) {
  let best = -Infinity;
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const dz = z - s.z;
    const d = s.r - Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > best) best = d;
  }
  return best;
}

/** Packs bubbles into one towering cumulus. Returns spheres {x, y, z, r} in shape units. */
export function buildCloud(rand, style) {
  const spheres = [];
  const range = (lo, hi) => lo + (hi - lo) * rand();
  const inDisc = (x, z, r) => Math.sqrt(x * x + z * z) + r <= 0.96;
  const add = (x, y, z, r) => {
    // Keep the core inside the unit disc so the cloud never reaches its cell edge.
    const rr = Math.sqrt(x * x + z * z);
    const lim = Math.max(0.96 - r, 0);
    if (rr > lim) {
      x *= lim / rr;
      z *= lim / rr;
    }
    spheres.push({ x, y, z, r });
  };

  // Wind shear: the whole cloud leans one way with height.
  const leanAngle = rand() * Math.PI * 2;
  const lean = range(0.05, 0.14);
  const lx = Math.cos(leanAngle) * lean;
  const lz = Math.sin(leanAngle) * lean;

  const top = range(style.top[0], style.top[1]);
  const towerCount = style.towers[0] + Math.floor(rand() * (style.towers[1] - style.towers[0] + 1));
  const towers = [];
  for (let t = 0; t < towerCount; t++) {
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 30; tries++) {
      const a = rand() * Math.PI * 2;
      const rr = t === 0 ? style.mainOffset * Math.sqrt(rand()) : range(0.2, 0.62) * Math.sqrt(rand());
      x = Math.cos(a) * rr;
      z = Math.sin(a) * rr;
      if (towers.every(o => Math.hypot(o.x - x, o.z - z) > 0.3)) break;
    }
    const h = t === 0 ? top : top * range(style.second[0], style.second[1]);
    const r = t === 0 ? range(style.mainR[0], style.mainR[1]) : range(style.otherR[0], style.otherR[1]);
    towers.push({ x, z, h, r });
  }

  // Broad, lumpy heap at the base, denser towards the middle and under the towers; the flat
  // base cuts it at y = 0.
  const heapCount = 2 * style.heap + Math.floor(rand() * 8);
  for (let k = 0; k < heapCount; k++) {
    const a = rand() * Math.PI * 2;
    const rr = 0.74 * Math.pow(rand(), 0.7);
    const r = range(0.12, 0.24) * (1.15 - 0.4 * rr);
    add(Math.cos(a) * rr, range(0.0, 0.22) * (1 - rr) + r * 0.35, Math.sin(a) * rr, r);
  }

  // Towers: a wandering, leaning column of bubble clusters that tapers upwards and ends in a
  // cauliflower head.
  for (const t of towers) {
    let y = 0.1;
    let ox = 0;
    let oz = 0;
    for (let guard = 0; guard < 40 && y < t.h; guard++) {
      const f = Math.min(y / t.h, 1);
      const tr = t.r * (1 - 0.15 * f);
      ox += (rand() - 0.5) * 0.06;
      oz += (rand() - 0.5) * 0.06;
      const ax = t.x + lx * y + ox;
      const az = t.z + lz * y + oz;
      const head = y + tr * 0.9 >= t.h;
      const count = head ? 4 : 3;
      for (let c = 0; c < count; c++) {
        const a = rand() * Math.PI * 2;
        const off = tr * (head ? range(0.15, 0.4) : range(0.25, 0.5));
        const r = tr * (head ? range(0.45, 0.62) : range(0.5, 0.72));
        const cy = head ? t.h - r * range(0.9, 1.4) : y + range(-0.1, 0.1) * tr;
        add(ax + Math.cos(a) * off, Math.max(cy, r * 0.3), az + Math.sin(a) * off, r);
      }
      if (head) break;
      y += tr * 0.6;
    }
  }

  // Bulges: one generation of smaller bubbles of varied size on the exposed surface, mostly
  // facing up and outwards; some sit low on the flanks and overhang. Finer cauliflower comes
  // from the billowy noise in the shader, which is less regular than packed spheres.
  const generations = [{ count: 120, r: [0.06, 0.15] }];
  for (const g of generations) {
    const core = spheres.slice();
    let weight = 0;
    for (const s of core) weight += s.r * s.r;
    for (let n = 0; n < g.count; n++) {
      // Pick a bubble by surface area, then a direction from its centre.
      let pick = rand() * weight;
      let p = core[core.length - 1];
      for (const s of core) {
        pick -= s.r * s.r;
        if (pick <= 0) {
          p = s;
          break;
        }
      }
      const radial = Math.sqrt(p.x * p.x + p.z * p.z) || 1;
      let dx = rand() * 2 - 1 + (0.4 * p.x) / radial;
      let dy = rand() * 1.35 - 0.35;
      let dz = rand() * 2 - 1 + (0.4 * p.z) / radial;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      // Walk out to the surface of everything built so far.
      let s = 0;
      let x = p.x;
      let y = p.y;
      let z = p.z;
      for (let step = 0; step < 48; step++) {
        const f = fieldOf(spheres, x, y, z);
        if (f < 0.004) break;
        s += Math.max(f, 0.004);
        x = p.x + dx * s;
        y = p.y + dy * s;
        z = p.z + dz * s;
      }
      // Bigger bubbles high up, smaller ones on the lower flanks.
      // Mostly small, some large; bigger high up, smaller on the lower flanks.
      const r = (g.r[0] + (g.r[1] - g.r[0]) * Math.pow(rand(), 2)) * (0.75 + 0.35 * Math.min(y / top, 1));
      const cx = x - dx * r * 0.35;
      const cy = y - dy * r * 0.35;
      const cz = z - dz * r * 0.35;
      if (cy < 0.03 || cy + r > SHAPE.ySpan - 0.03 || !inDisc(cx, cz, r)) continue;
      spheres.push({ x: cx, y: cy, z: cz, r });
    }
  }
  return spheres;
}

/** Signed distance to the smooth union of the spheres, sampled on the shape grid. */
export function rasterise(spheres) {
  const { nx, ny, nz, extent, range } = SHAPE;
  const vox = (2 * extent) / nx;
  const field = new Float32Array(nx * ny * nz).fill(-range);
  const k = 0.11; // blend radius: neighbouring bubbles flow into each other
  for (const s of spheres) {
    const reach = s.r + range;
    const reach2 = reach * reach;
    const j0 = Math.max(0, Math.floor((s.y - reach) / vox - 0.5));
    const j1 = Math.min(ny - 1, Math.ceil((s.y + reach) / vox - 0.5));
    const k0 = Math.max(0, Math.floor((s.z - reach + extent) / vox - 0.5));
    const k1 = Math.min(nz - 1, Math.ceil((s.z + reach + extent) / vox - 0.5));
    for (let kk = k0; kk <= k1; kk++) {
      const dz = -extent + (kk + 0.5) * vox - s.z;
      for (let j = j0; j <= j1; j++) {
        const dy = (j + 0.5) * vox - s.y;
        const dyz = dy * dy + dz * dz;
        if (dyz >= reach2) continue;
        const span = Math.sqrt(reach2 - dyz);
        const i0 = Math.max(0, Math.ceil((s.x - span + extent) / vox - 0.5));
        const i1 = Math.min(nx - 1, Math.floor((s.x + span + extent) / vox - 0.5));
        let idx = i0 + nx * (j + ny * kk);
        for (let i = i0; i <= i1; i++, idx++) {
          const dx = -extent + (i + 0.5) * vox - s.x;
          const d = s.r - Math.sqrt(dx * dx + dyz);
          const v = field[idx];
          const h = k - Math.abs(v - d);
          field[idx] = h > 0 ? Math.max(v, d) + (h * h * 0.25) / k : Math.max(v, d);
        }
      }
    }
  }
  return field;
}

/** Bakes the four cloud shapes into one RGBA volume. */
export function bakeCumulusShapes(seed = 1201) {
  const { nx, ny, nz, range } = SHAPE;
  const data = new Uint8Array(nx * ny * nz * 4);
  for (let c = 0; c < 4; c++) {
    const field = rasterise(buildCloud(mulberry32(seed + c * 7717), STYLES[c]));
    for (let i = 0; i < field.length; i++) {
      const e = Math.min(Math.max(field[i] / range, -1), 1) * 0.5 + 0.5;
      data[i * 4 + c] = Math.round(e * 255);
    }
  }
  const texture = new THREE.Data3DTexture(data, nx, ny, nz);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Where the giants stand, one record per grid cell (a radius of 0 means no giant).
 * a = (centre x, centre z in cloud-map metres, footprint radius m, shape box height m),
 * b = (cos, sin of the rotation, shape channel, thickness).
 */
export function placeGiants({ tile, depth, seed = 29, chance = 0.34, hero = null }) {
  const { cell, grid } = GIANTS;
  if (Math.abs(tile / cell - grid) > 1e-9) throw new Error("giant grid must divide the cloud map");
  const a = new Float32Array(grid * grid * 4);
  const b = new Float32Array(grid * grid * 4);
  const rand = mulberry32(seed);
  const tallest = 1.5; // the highest tower head in shape units
  const put = (i, j, u) => {
    const radius = 2600 + 3000 * Math.pow(u[0], 1.3);
    // Noise pushes the surface out by up to 0.14 radii, the fine warp by up to 400 m.
    const margin = 1.15 * radius + 400;
    const room = cell - 2 * margin;
    const vertical = Math.min(radius * (0.6 + 0.5 * u[3]), depth / tallest);
    const angle = u[4] * Math.PI * 2;
    const k = (j * grid + i) * 4;
    a.set([i * cell + margin + room * u[1], j * cell + margin + room * u[2], radius, vertical * SHAPE.ySpan], k);
    b.set([Math.cos(angle), Math.sin(angle), Math.min(3, Math.floor(u[5] * 4)), 0.9 + 0.1 * u[6]], k);
  };
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const roll = rand();
      const u = Array.from({ length: 7 }, rand);
      if (roll < chance) put(i, j, u);
    }
  }
  if (hero) put(hero.i, hero.j, hero.u);
  // Also as a small float texture for the cloud shader: texel (2i, j) = a, (2i + 1, j) = b.
  const table = new Float32Array(grid * grid * 8);
  for (let k = 0; k < grid * grid; k++) {
    const row = Math.floor(k / grid);
    const col = k % grid;
    table.set(a.subarray(k * 4, k * 4 + 4), (row * grid * 2 + col * 2) * 4);
    table.set(b.subarray(k * 4, k * 4 + 4), (row * grid * 2 + col * 2 + 1) * 4);
  }
  const texture = new THREE.DataTexture(table, grid * 2, grid, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { a, b, texture };
}
