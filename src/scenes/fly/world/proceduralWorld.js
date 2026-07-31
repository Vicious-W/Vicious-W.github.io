export const CHUNK_SIZE_M = 128;
export const ORIGIN_SHIFT_THRESHOLD_M = 96;
export const ACTIVE_CHUNK_RADIUS = 2;
export const LANDING_CELL_SIZE_M = 160;

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
  const obstacleCache = new Map();
  const origin = { x: 0, y: 0, z: 0 };
  let originShiftCount = 0;
  const shiftEvents = [];

  const heightAt = (x, z) => baseHeight(x, z, seed) - originHeight;

  const surfaceAt = (x, z) => {
    const height = heightAt(x, z);
    const eps = 1.5;
    const dx = (heightAt(x + eps, z) - heightAt(x - eps, z)) / (eps * 2);
    const dz = (heightAt(x, z + eps) - heightAt(x, z - eps)) / (eps * 2);
    const slope = Math.atan(Math.hypot(dx, dz));
    // A landing-region cell is deliberately wider than one chunk so a balloon descending at
    // normal wind speed has time to complete contact before crossing into different metadata.
    const cellX = Math.floor(x / LANDING_CELL_SIZE_M), cellZ = Math.floor(z / LANDING_CELL_SIZE_M);
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
    return {
      height,
      slope,
      normal: normalize({ x: -dx, y: 1, z: -dz }),
      surface,
      obstacleDensity,
      cellX,
      cellZ,
      landingRegionId: `${cellX},${cellZ}`
    };
  };

  const obstaclesForChunk = (cx, cz) => {
    const cacheKey = `${cx},${cz}`;
    const cached = obstacleCache.get(cacheKey);
    if (cached) {
      obstacleCache.delete(cacheKey);
      obstacleCache.set(cacheKey, cached);
      return cached;
    }
    const centerX = (cx + 0.5) * CHUNK_SIZE_M;
    const centerZ = (cz + 0.5) * CHUNK_SIZE_M;
    const generation = hash2(cx, cz, seed);
    const obstacles = [];
    for (let index = 0; index < 8; index++) {
      const fx = ((index * 0.618033 + generation) % 1 - 0.5) * CHUNK_SIZE_M;
      const fz = ((index * 0.381966 + generation * 1.7) % 1 - 0.5) * CHUNK_SIZE_M;
      const x = centerX + fx, z = centerZ + fz;
      const terrain = surfaceAt(x, z);
      if (terrain.surface !== "FOREST" || Math.hypot(x, z) < 70) continue;
      const scale = 0.75 + (index % 4) * 0.12;
      obstacles.push(Object.freeze({
        id: `TREE:${cx}:${cz}:${index}`,
        type: "TREE",
        x, z,
        baseY: terrain.height,
        radius: 0.62 * scale,
        height: 9.4 * scale,
        scale
      }));
    }

    const centerTerrain = surfaceAt(centerX, centerZ);
    if (generation > 0.46 && generation < 0.505 && centerTerrain.surface === "FIELD" && Math.hypot(centerX, centerZ) > 90) {
      const x = centerX + (generation - 0.48) * 210;
      const z = centerZ + (hash2(cz, cx, seed) - 0.5) * 24;
      const terrain = surfaceAt(x, z);
      obstacles.push(Object.freeze({
        id: `BUILDING:${cx}:${cz}`,
        type: "BUILDING",
        x, z,
        baseY: terrain.height,
        halfX: 5.2,
        halfZ: 4.1,
        height: 6.2
      }));
    }

    const roadPhase = centerX * 0.18 + centerZ + 320;
    const roadBand = Math.round((roadPhase - 115) / 230);
    const poleXs = [centerX - 42, centerX + 42];
    const poles = poleXs.map((x, index) => {
      const roadZ = 115 + roadBand * 230 - 320 - x * 0.18;
      const z = roadZ + 8;
      if (z < cz * CHUNK_SIZE_M || z >= (cz + 1) * CHUNK_SIZE_M || Math.hypot(x, z) < 70) return null;
      return Object.freeze({
        id: `POWER_POLE:${cx}:${cz}:${index}`,
        type: "POWER_POLE",
        x, z,
        baseY: heightAt(x, z),
        radius: 0.34,
        height: 10.5
      });
    }).filter(Boolean);
    obstacles.push(...poles);
    if (poles.length === 2) {
      obstacles.push(Object.freeze({
        id: `POWER_LINE:${cx}:${cz}`,
        type: "POWER_LINE",
        ax: poles[0].x,
        ay: poles[0].baseY + poles[0].height,
        az: poles[0].z,
        bx: poles[1].x,
        by: poles[1].baseY + poles[1].height,
        bz: poles[1].z,
        radius: 0.13
      }));
    }
    const result = Object.freeze(obstacles);
    obstacleCache.set(cacheKey, result);
    while (obstacleCache.size > 192) obstacleCache.delete(obstacleCache.keys().next().value);
    return result;
  };

  const obstaclesNear = (x, z, radius = 0) => {
    const reach = Math.max(14, radius + 10);
    const minCx = Math.floor((x - reach) / CHUNK_SIZE_M), maxCx = Math.floor((x + reach) / CHUNK_SIZE_M);
    const minCz = Math.floor((z - reach) / CHUNK_SIZE_M), maxCz = Math.floor((z + reach) / CHUNK_SIZE_M);
    const result = [];
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (const obstacle of obstaclesForChunk(cx, cz)) {
          const distance = obstacleDistanceXZ(obstacle, x, z);
          if (distance <= reach) result.push(obstacle);
        }
      }
    }
    return result;
  };

  const terrainAt = (x, z) => {
    const terrain = surfaceAt(x, z);
    let obstacleClearanceM = Infinity;
    let nearestObstacleId = null;
    for (const obstacle of obstaclesNear(x, z, 16)) {
      const clearance = obstacleDistanceXZ(obstacle, x, z);
      if (clearance < obstacleClearanceM) {
        obstacleClearanceM = clearance;
        nearestObstacleId = obstacle.id;
      }
    }
    const obstacleDensity = Math.max(terrain.obstacleDensity,
      Number.isFinite(obstacleClearanceM) ? clamp01((16 - obstacleClearanceM) / 12) : 0);
    const safe = terrain.surface === "FIELD" && terrain.slope < 0.105
      && obstacleDensity < 0.24 && obstacleClearanceM > 13;
    return { ...terrain, obstacleDensity, obstacleClearanceM, nearestObstacleId, safe };
  };

  const landingZoneAt = (x, z, radius = 18) => {
    const probes = [{ x, z }];
    for (let index = 0; index < 12; index++) {
      const angle = index / 12 * Math.PI * 2;
      probes.push({ x: x + Math.cos(angle) * radius, z: z + Math.sin(angle) * radius });
    }
    const samples = probes.map(point => terrainAt(point.x, point.z));
    const center = samples[0];
    return {
      safe: samples.every(sample => sample.safe && sample.surface === "FIELD"),
      regionId: center.landingRegionId,
      radius,
      minObstacleClearanceM: Math.min(...samples.map(sample => sample.obstacleClearanceM)),
      samples
    };
  };

  const obstacleContacts = ({ position, radius = 1, halfHeight = 0.7 }) => {
    const contacts = [];
    for (const obstacle of obstaclesNear(position.x, position.z, radius + 8)) {
      const contact = obstacleContact(obstacle, position, radius, halfHeight);
      if (contact) contacts.push(contact);
    }
    return contacts;
  };

  const makeChunk = (cx, cz) => {
    const key = `${cx},${cz}`;
    if (chunks.has(key)) return chunks.get(key);
    const centerX = (cx + 0.5) * CHUNK_SIZE_M;
    const centerZ = (cz + 0.5) * CHUNK_SIZE_M;
    const center = terrainAt(centerX, centerZ);
    const chunk = {
      key, cx, cz, centerX, centerZ,
      surface: center.surface,
      safe: center.safe,
      generation: hash2(cx, cz, seed),
      obstacles: obstaclesForChunk(cx, cz)
    };
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
    surfaceAt,
    landingZoneAt,
    obstaclesForChunk,
    obstaclesNear,
    obstacleContacts,
    heightAt,
    updateChunks,
    maybeShiftOrigin,
    localOf,
    get originShiftCount() { return originShiftCount; },
    get shiftEvents() { return shiftEvents.slice(); },
    snapshot() {
      return {
        seed,
        origin: { ...origin },
        originShiftCount,
        activeChunkCount: chunks.size,
        obstacleCacheCount: obstacleCache.size,
        chunkKeys: [...chunks.keys()].sort()
      };
    }
  };
}

function normalize(value) {
  const length = Math.max(1e-9, Math.hypot(value.x, value.y, value.z));
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function obstacleDistanceXZ(obstacle, x, z) {
  if (obstacle.type === "BUILDING") {
    const dx = Math.max(Math.abs(x - obstacle.x) - obstacle.halfX, 0);
    const dz = Math.max(Math.abs(z - obstacle.z) - obstacle.halfZ, 0);
    return Math.hypot(dx, dz);
  }
  if (obstacle.type === "POWER_LINE") {
    return distanceToSegment2(x, z, obstacle.ax, obstacle.az, obstacle.bx, obstacle.bz) - obstacle.radius;
  }
  return Math.hypot(x - obstacle.x, z - obstacle.z) - obstacle.radius;
}

function obstacleContact(obstacle, position, radius, halfHeight) {
  const bottom = position.y - halfHeight, top = position.y + halfHeight;
  if (obstacle.type === "POWER_LINE") {
    const closest = closestPointSegment3(position, obstacle);
    const dx = position.x - closest.x, dy = position.y - closest.y, dz = position.z - closest.z;
    const distance = Math.max(1e-9, Math.hypot(dx, dy, dz));
    const penetration = radius + obstacle.radius - distance;
    if (penetration <= 0) return null;
    return {
      obstacleId: obstacle.id,
      obstacleType: obstacle.type,
      penetration,
      normal: { x: dx / distance, y: dy / distance, z: dz / distance },
      point: closest
    };
  }
  if (top <= obstacle.baseY || bottom >= obstacle.baseY + obstacle.height) return null;
  if (obstacle.type === "BUILDING") {
    const dx = position.x - obstacle.x, dz = position.z - obstacle.z;
    const overlapX = obstacle.halfX + radius - Math.abs(dx);
    const overlapZ = obstacle.halfZ + radius - Math.abs(dz);
    if (overlapX <= 0 || overlapZ <= 0) return null;
    if (overlapX < overlapZ) {
      const sign = dx === 0 ? 1 : Math.sign(dx);
      return {
        obstacleId: obstacle.id, obstacleType: obstacle.type, penetration: overlapX,
        normal: { x: sign, y: 0, z: 0 },
        point: { x: obstacle.x + sign * obstacle.halfX, y: clamp(position.y, obstacle.baseY, obstacle.baseY + obstacle.height), z: position.z }
      };
    }
    const sign = dz === 0 ? 1 : Math.sign(dz);
    return {
      obstacleId: obstacle.id, obstacleType: obstacle.type, penetration: overlapZ,
      normal: { x: 0, y: 0, z: sign },
      point: { x: position.x, y: clamp(position.y, obstacle.baseY, obstacle.baseY + obstacle.height), z: obstacle.z + sign * obstacle.halfZ }
    };
  }
  const dx = position.x - obstacle.x, dz = position.z - obstacle.z;
  const distance = Math.max(1e-9, Math.hypot(dx, dz));
  const penetration = radius + obstacle.radius - distance;
  if (penetration <= 0) return null;
  return {
    obstacleId: obstacle.id,
    obstacleType: obstacle.type,
    penetration,
    normal: { x: dx / distance, y: 0, z: dz / distance },
    point: { x: obstacle.x + dx / distance * obstacle.radius, y: clamp(position.y, obstacle.baseY, obstacle.baseY + obstacle.height), z: obstacle.z + dz / distance * obstacle.radius }
  };
}

function distanceToSegment2(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const denominator = abx * abx + abz * abz;
  const t = denominator > 0 ? clamp(((px - ax) * abx + (pz - az) * abz) / denominator, 0, 1) : 0;
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t));
}

function closestPointSegment3(position, line) {
  const abx = line.bx - line.ax, aby = line.by - line.ay, abz = line.bz - line.az;
  const denominator = abx * abx + aby * aby + abz * abz;
  const t = denominator > 0 ? clamp(
    ((position.x - line.ax) * abx + (position.y - line.ay) * aby + (position.z - line.az) * abz) / denominator,
    0, 1
  ) : 0;
  return { x: line.ax + abx * t, y: line.ay + aby * t, z: line.az + abz * t };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
