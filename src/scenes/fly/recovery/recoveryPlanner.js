export function planBalloonRecovery({ vehicle, world, atmosphere, simTime = 0 }) {
  const position = vehicle.basket.position;
  const air = atmosphere.sample(vehicle.envelope.position, simTime);
  const wind = air.windVelocityMps;
  const horizontalSpeed = Math.max(1.2, Math.hypot(wind.x, wind.z));
  const ux = wind.x / horizontalSpeed, uz = wind.z / horizontalSpeed;
  const candidates = [];
  const vehicleState = vehicle.snapshot();
  const storedHeatK = Math.max(0, vehicleState.internalTemperatureK - air.temperatureK - 45);
  const predictedPeakAgl = Math.max(vehicle.heightAgl,
    vehicle.heightAgl + Math.max(0, vehicle.basket.velocity.y) * 12 + storedHeatK * 1.5);
  const descentTime = Math.max(32, predictedPeakAgl / (predictedPeakAgl > 80 ? 1.7 : 0.9));
  const preferredDistance = clamp(horizontalSpeed * descentTime, 90, 1200);

  for (let ring = -4; ring <= 6; ring++) {
    const distance = Math.max(70, preferredDistance + ring * 45);
    for (const lateral of [0, -18, 18, -36, 36]) {
      const x = position.x + ux * distance - uz * lateral;
      const z = position.z + uz * distance + ux * lateral;
      const terrain = world.terrainAt(x, z);
      const eta = distance / horizontalSpeed;
      const obstaclePenalty = terrain.obstacleDensity * 140;
      const slopePenalty = terrain.slope * 900;
      const surfacePenalty = terrain.surface === "WATER" ? 10000
        : terrain.surface === "FOREST" ? 6000
          : terrain.surface === "ROAD" ? 1200 : 0;
      const reachPenalty = Math.abs(eta - Math.max(20, vehicle.heightAgl / 0.8)) * 0.4;
      candidates.push({
        x, z, height: terrain.height, terrain,
        eta,
        reachable: terrain.safe && distance <= 1250,
        score: Math.abs(distance - preferredDistance) * 0.12 + Math.abs(lateral) * 0.5 + obstaclePenalty + slopePenalty + surfacePenalty + reachPenalty
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const selected = candidates.find(candidate => candidate.reachable) || candidates[0] || null;
  const alongDistance = selected
    ? Math.max(1, (selected.x - position.x) * ux + (selected.z - position.z) * uz)
    : 1;
  return {
    selected,
    evaluated: candidates.length,
    rejectedUnsafe: candidates.filter(candidate => !candidate.terrain.safe).length,
    writesPose: false,
    sampledWind: { ...wind },
    predictedPeakAgl,
    alongDistance,
    plannedAt: simTime
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function recoveryControls({ vehicle, plan, world }) {
  if (!plan?.selected) return { burner: 0, vent: 0.4 };
  const position = vehicle.basket.position;
  const terrain = world.terrainAt(position.x, position.z);
  const agl = position.y - vehicle.constants.basketHalfHeightM - terrain.height;
  const descentRate = agl > 80 ? -2 : agl > 18 ? -1.2 : -0.55;
  const desiredVy = descentRate;
  const vy = vehicle.basket.velocity.y;
  const belowIsSafe = terrain.safe;

  if (!belowIsSafe && agl < 14) return { burner: vy < 0.9 ? 1 : 0, vent: 0 };
  if (agl < 4.5) {
    if (vy < -0.85) return { burner: 1, vent: 0 };
    return { burner: 0, vent: vy > -0.25 ? 0.75 : 0.2 };
  }
  if (vy < desiredVy - 0.28) return { burner: 1, vent: 0 };
  if (vy > desiredVy + 0.16) return { burner: 0, vent: Math.min(1, 0.55 + (vy - desiredVy) * 0.34) };
  return { burner: 0, vent: 0.15 };
}
