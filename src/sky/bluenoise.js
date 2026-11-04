/**
 * Void-and-cluster blue noise (Ulichney 1993) on a size x size torus.
 * Returns one byte per texel with uniformly distributed ranks: no visible pattern, unlike
 * ordered dithers or interleaved gradient noise, so leftover sampling noise reads as fine grain.
 */
export function makeBlueNoise(size = 64, sigma = 1.6, seed = 7) {
  const n = size * size;
  const kernel = new Float32Array(n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - x);
      const dy = Math.min(y, size - y);
      kernel[y * size + x] = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
    }
  }
  const energy = new Float32Array(n);
  const ones = new Uint8Array(n);

  const splat = (index, sign) => {
    const px = index % size;
    const py = (index / size) | 0;
    for (let y = 0; y < size; y++) {
      const krow = ((y - py + size) % size) * size;
      const row = y * size;
      for (let x = 0; x < size; x++) {
        energy[row + x] += sign * kernel[krow + ((x - px + size) % size)];
      }
    }
  };
  const tightestCluster = () => {
    let best = -1;
    let value = -Infinity;
    for (let i = 0; i < n; i++) if (ones[i] && energy[i] > value) { value = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1;
    let value = Infinity;
    for (let i = 0; i < n; i++) if (!ones[i] && energy[i] < value) { value = energy[i]; best = i; }
    return best;
  };

  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // Initial pattern of about 10% minority pixels, relaxed until evenly spread.
  const initial = Math.floor(n * 0.1);
  for (let placed = 0; placed < initial;) {
    const i = Math.floor(random() * n);
    if (!ones[i]) { ones[i] = 1; splat(i, 1); placed++; }
  }
  for (let guard = 0; guard < n; guard++) {
    const cluster = tightestCluster();
    ones[cluster] = 0;
    splat(cluster, -1);
    const hole = largestVoid();
    ones[hole] = 1;
    splat(hole, 1);
    if (hole === cluster) break;
  }

  const rank = new Int32Array(n);
  const prototype = ones.slice();
  const prototypeEnergy = energy.slice();
  for (let count = initial; count > 0; count--) {
    const cluster = tightestCluster();
    ones[cluster] = 0;
    splat(cluster, -1);
    rank[cluster] = count - 1;
  }
  ones.set(prototype);
  energy.set(prototypeEnergy);
  for (let r = initial; r < n; r++) {
    const hole = largestVoid();
    ones[hole] = 1;
    splat(hole, 1);
    rank[hole] = r;
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(((rank[i] + 0.5) / n) * 256);
  return out;
}
