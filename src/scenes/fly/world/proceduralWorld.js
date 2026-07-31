export const CHUNK_SIZE_M = 128;
export const ORIGIN_SHIFT_THRESHOLD_M = 96;
export const ACTIVE_CHUNK_RADIUS = 2;

const fract = x => x - Math.floor(x);
const hash2 = (x, z, seed) => fract(Math.sin(x * 91.7 + z * 263.3 + seed * 0.000013) * 43758.5453);

function baseHeight(x, z, seed) {
  return 2.1 * Math.sin((x + seed % 71) / 145)
    + 1.35 * Math.sin((z - seed % 53) / 97)
    + 0.72 * Math.sin((x + z) / 43);
}

export function createProceduralWorld(seed = 0xc1002026) {
  const originHeight = baseHeight(0, 0, seed);
  const chunks = new Map();
  const origin = { x: 0, y: 0, z: 0 };
  let originShiftCount = 0;
  const shiftEvents = [];

  const heightAt = (x, z) => baseHeight(x, z, seed) - originHeight;

  const terrainAt = (x, z) => {
    const height = heightAt(x, z);
    const eps = 1.5;
    const dx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (eps * 2);
    const dz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (eps * 2);
    const slope = Math.atan(Math.hypot(dx, dz));
    // A landing-region cell is deliberately wider than one chunk so a balloon descending at
    // normal wind speed has time to complete contact before crossing into different metadata.
    const cellX = Math.floor(x / 160), cellZ = Math.floor(z / 160);
    const n = hash2(cellX, cellZ, seed);
    const roadDistance = Math.abs(((x * 0.18 + z + 320) % 230 + 230) % 230 - 115);
    let surface = "FIELD";
    if (Math.hypot(x, z) < 70) surface = "FIELD";
    else if (n < 0.13) surface = "WATER";
    else if (n > 0.82) surface = "FOREST";
    else if (roadDistance < 5) surface = "ROAD";
    const obstacleDensity = Math.hypot(x, z) < 70 ? 0.04
      : surface === "FOREST" ? 0.8 + n * 0.15
        : surface === "ROAD" ? 0.25 : 0.04 + n * 0.16;
    const safe = surface === "FIELD" && slope < 0.105 && obstacleDensity < 0.24;
    return { height, slope, surface, obstacleDensity, safe };
  };

  const makeChunk = (cx, cz) => {
    const key = `${cx},${cz}`;
    if (chunks.has(key)) return chunks.get(key);
    const centerX = (cx + 0.5) * CHUNK_SIZE_M;
    const centerZ = (cz + 0.5) * CHUNK_SIZE_M;
    const center = terrainAt(centerX, centerZ);
    const chunk = { key, cx, cz, centerX, centerZ, surface: center.surface, safe: center.safe, generation: hash2(cx, cz, seed) };
    chunks.set(key, chunk);
    return chunk;
  };

  const updateChunks = position => {
    const cx = Math.floor(position.x / CHUNK_SIZE_M);
    const cz = Math.floor(position.z / CHUNK_SIZE_M);
    const keep = new Set();
    for (let dz = -ACTIVE_CHUNK_RADIUS; dz <= ACTIVE_CHUNK_RADIUS; dz++) {
      for (let dx = -ACTIVE_CHUNK_RADIUS; dx <= ACTIVE_CHUNK_RADIUS; dx++) {
        const key = `${cx + dx},${cz + dz}`;
        keep.add(key);
        makeChunk(cx + dx, cz + dz);
      }
    }
    for (const key of chunks.keys()) if (!keep.has(key)) chunks.delete(key);
    return chunks;
  };

  const maybeShiftOrigin = (position, simTime = 0) => {
    const lx = position.x - origin.x, lz = position.z - origin.z;
    if (Math.hypot(lx, lz) < ORIGIN_SHIFT_THRESHOLD_M) return null;
    const previous = { ...origin };
    origin.x = Math.round(position.x / CHUNK_SIZE_M) * CHUNK_SIZE_M;
    origin.z = Math.round(position.z / CHUNK_SIZE_M) * CHUNK_SIZE_M;
    originShiftCount++;
    const event = { simTime, previous, next: { ...origin }, delta: { x: origin.x - previous.x, y: 0, z: origin.z - previous.z } };
    shiftEvents.push(event);
    return event;
  };

  const localOf = position => ({ x: position.x - origin.x, y: position.y - origin.y, z: position.z - origin.z });

  updateChunks({ x: 0, z: 0 });
  return {
    seed,
    origin,
    chunks,
    terrainAt,
    heightAt,
    updateChunks,
    maybeShiftOrigin,
    localOf,
    get originShiftCount() { return originShiftCount; },
    get shiftEvents() { return shiftEvents.slice(); },
    snapshot() {
      return { seed, origin: { ...origin }, originShiftCount, activeChunkCount: chunks.size, chunkKeys: [...chunks.keys()].sort() };
    }
  };
}
