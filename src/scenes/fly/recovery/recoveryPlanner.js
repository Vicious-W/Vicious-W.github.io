const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function forecastLanding({ vehicle, atmosphere, world, simTime, duration, cruiseAgl }) {
  const state = vehicle.snapshot();
  let x = state.basket.position.x;
  let z = state.basket.position.z;
  let vx = state.basket.velocity.x;
  let vz = state.basket.velocity.z;
  const startAgl = Math.max(0, state.heightAgl);
  const step = 2;
  let elapsed = 0;
  while (elapsed < duration - 1e-9) {
    const dt = Math.min(step, duration - elapsed);
    const progress = (elapsed + dt * 0.5) / Math.max(duration, 1);
    const terrain = world.terrainAt(x, z);
    const agl = progress < 0.32
      ? startAgl + (cruiseAgl - startAgl) * progress / 0.32
      : cruiseAgl * (1 - (progress - 0.32) / 0.68);
    const air = atmosphere.sample({ x, y: terrain.height + Math.max(3, agl), z }, simTime + elapsed);
    const response = 1 - Math.exp(-dt / 6.5);
    vx += (air.windVelocityMps.x - vx) * response;
    vz += (air.windVelocityMps.z - vz) * response;
    x += vx * dt;
    z += vz * dt;
    elapsed += dt;
  }
  return { x, z, duration, cruiseAgl, finalVelocity: { x: vx, z: vz } };
}

function candidateOffsets() {
  const offsets = [{ x: 0, z: 0 }];
  for (const radius of [12, 24, 36, 45]) {
    for (let index = 0; index < 8; index++) {
      const angle = index / 8 * Math.PI * 2;
      offsets.push({ x: Math.cos(angle) * radius, z: Math.sin(angle) * radius });
    }
  }
  return offsets;
}

export function planBalloonRecovery({ vehicle, world, atmosphere, simTime = 0, timeBudget = null }) {
  const state = vehicle.snapshot();
  const position = state.basket.position;
  const air = atmosphere.sample(state.envelope.position, simTime);
  const storedHeatK = Math.max(0, state.internalTemperatureK - air.temperatureK - 42);
  const predictedPeakAgl = Math.max(state.heightAgl,
    state.heightAgl + Math.max(0, state.basket.velocity.y) * 11 + storedHeatK * 1.2);
  const lowApproach = predictedPeakAgl < 28;
  const baseDuration = lowApproach
    ? clamp(predictedPeakAgl / 0.65 + 8, 12, 52)
    : clamp(Math.max(48, predictedPeakAgl / 0.72 + 28), 48, 190);
  const layerChoices = lowApproach
    ? [clamp(predictedPeakAgl, 8, 34), 18, 30]
    : [clamp(predictedPeakAgl, 24, 210), 45, 80, 130, 180];
  const cruiseLayers = [...new Set(layerChoices.map(value => Math.round(value)))];
  let durations = lowApproach
    ? [baseDuration, baseDuration + 10, baseDuration + 20]
    : [baseDuration, baseDuration + 24, baseDuration + 52, baseDuration + 86];
  if (Number.isFinite(timeBudget)) {
    const budget = clamp(timeBudget, 12, 230);
    durations = [...new Set([budget, clamp(budget - 12, 12, 230), clamp(budget + 12, 12, 230)])];
  }
  const candidates = [];

  for (const cruiseAgl of cruiseLayers) {
    for (const duration of durations) {
      const prediction = forecastLanding({ vehicle, atmosphere, world, simTime, duration, cruiseAgl });
      for (const offset of candidateOffsets()) {
        const x = prediction.x + offset.x;
        const z = prediction.z + offset.z;
        const terrain = world.terrainAt(x, z);
        const zone = world.landingZoneAt(x, z, 32);
        const predictionErrorM = Math.hypot(offset.x, offset.z);
        const climbM = Math.max(0, cruiseAgl - predictedPeakAgl);
        const fuelPenalty = climbM * 1.25 + cruiseAgl * 0.16 + climbM * 2 / Math.max(4, state.fuelKg);
        const surfacePenalty = terrain.surface === "WATER" ? 10000
          : terrain.surface === "FOREST" ? 8000
            : terrain.surface === "ROAD" ? 5000 : 0;
        candidates.push({
          x, z,
          height: terrain.height,
          terrain,
          zone,
          landingRegionId: terrain.landingRegionId,
          eta: duration,
          cruiseAgl,
          predictedLanding: { x: prediction.x, z: prediction.z },
          predictionErrorM,
          arrivalToleranceM: 48,
          reachable: zone.safe && predictionErrorM <= 45 && duration <= 300,
          score: predictionErrorM * 2.4 + duration * 0.08 + fuelPenalty
            + terrain.slope * 950 + terrain.obstacleDensity * 320 + surfacePenalty
        });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  const selected = candidates.find(candidate => candidate.reachable) || candidates[0] || null;
  const targetVector = selected
    ? { x: selected.x - position.x, z: selected.z - position.z }
    : { x: 0, z: 0 };
  const windSpeed = Math.max(0.5, Math.hypot(air.windVelocityMps.x, air.windVelocityMps.z));
  const windUnit = { x: air.windVelocityMps.x / windSpeed, z: air.windVelocityMps.z / windSpeed };
  return {
    selected,
    evaluated: candidates.length,
    rejectedUnsafe: candidates.filter(candidate => !candidate.zone.safe).length,
    writesPose: false,
    sampledWind: { ...air.windVelocityMps },
    predictedPeakAgl,
    alongDistance: targetVector.x * windUnit.x + targetVector.z * windUnit.z,
    plannedAt: simTime,
    forecastModel: "layered-wind-forward-v2"
  };
}

export function assessRecoveryPlan({ vehicle, plan, world, atmosphere, simTime }) {
  if (!plan?.selected) return { needsReplan: true, reason: "NO_CANDIDATE", predictionErrorM: Infinity };
  const state = vehicle.snapshot();
  const selected = plan.selected;
  const elapsed = Math.max(0, simTime - plan.plannedAt);
  const physicalTimeToGround = state.heightAgl / Math.max(0.5, -state.basket.velocity.y || 0) + 8;
  const remainingEta = Math.max(8, Math.min(selected.eta - elapsed, physicalTimeToGround));
  const prediction = forecastLanding({
    vehicle,
    atmosphere,
    world,
    simTime,
    duration: remainingEta,
    cruiseAgl: Math.min(selected.cruiseAgl, Math.max(state.heightAgl, 18))
  });
  const predictionErrorM = Math.hypot(prediction.x - selected.x, prediction.z - selected.z);
  const dx = selected.x - state.basket.position.x;
  const dz = selected.z - state.basket.position.z;
  const air = atmosphere.sample(state.envelope.position, simTime);
  const targetDistanceM = Math.hypot(dx, dz);
  const directionalProgress = targetDistanceM > 1e-6
    ? (dx * air.windVelocityMps.x + dz * air.windVelocityMps.z) / targetDistanceM
    : 0;
  const zone = world.landingZoneAt(selected.x, selected.z, selected.zone.radius);
  const reason = !zone.safe ? "ZONE_UNSAFE"
    : directionalProgress < -0.35 && targetDistanceM > selected.arrivalToleranceM ? "TARGET_PASSED"
      : predictionErrorM > selected.arrivalToleranceM * 1.6 ? "FORECAST_DIVERGED"
        : null;
  return {
    needsReplan: !!reason,
    reason,
    prediction,
    predictionErrorM,
    remainingEta,
    targetDistanceM,
    targetPassed: reason === "TARGET_PASSED",
    zoneSafe: zone.safe
  };
}

export function recoveryControls({ vehicle, plan, world, atmosphere, simTime = 0 }) {
  if (!plan?.selected) return { burner: 0, vent: 0.4, desiredVy: -0.8, targetDistanceM: Infinity };
  const state = vehicle.snapshot();
  const position = state.basket.position;
  const terrain = world.terrainAt(position.x, position.z);
  const agl = state.heightAgl;
  const selected = plan.selected;
  const dx = selected.x - position.x;
  const dz = selected.z - position.z;
  const targetDistanceM = Math.hypot(dx, dz);
  const targetUnit = targetDistanceM > 1e-6 ? { x: dx / targetDistanceM, z: dz / targetDistanceM } : { x: 0, z: 0 };
  // Include the envelope's thermal response lag, not just ballistic time to
  // contact. At normal wind speeds an eight-second lead is the difference
  // between clearing a cell boundary and discovering water after touchdown.
  const projectedContactSeconds = clamp(agl / Math.max(0.55, -state.basket.velocity.y) + 8, 10, 70);
  const projectedPathSafe = [0.2, 0.4, 0.6, 0.8, 1].every(fraction => world.terrainAt(
    position.x + state.basket.velocity.x * projectedContactSeconds * fraction,
    position.z + state.basket.velocity.z * projectedContactSeconds * fraction
  ).safe);
  const planTimeRemainingForSafety = Math.max(0, selected.eta - (simTime - plan.plannedAt));
  const descendingTowardContact = state.basket.velocity.y < -0.32
    || planTimeRemainingForSafety < agl / 0.72 + 18;
  const currentLandingZoneSafe = world.landingZoneAt(position.x, position.z, 16).safe;
  const currentUnsafeHold = agl < 85 && !terrain.safe && state.basket.velocity.y < 0.75;
  const projectedUnsafeHold = agl < 70 && descendingTowardContact && !projectedPathSafe
    && (!currentLandingZoneSafe || !state.contact);
  if (currentUnsafeHold || projectedUnsafeHold) {
    return {
      // A contact point already over unsafe terrain needs an authoritative
      // climb command because the envelope has several seconds of thermal
      // lag. The projected-path guard is intentionally gentler so it does not
      // create repeated 50-130 m oscillations while skirting an obstacle.
      burner: currentUnsafeHold ? 0.58 : projectedUnsafeHold && agl < 35 ? 0.55 : 0.3,
      vent: 0,
      desiredVy: 1.15,
      desiredLayerAgl: selected.cruiseAgl,
      targetDistanceM,
      timeToTarget: Infinity,
      planTimeRemaining: planTimeRemainingForSafety,
      approach: false,
      landingRegionId: selected.landingRegionId,
      safetyHold: true
    };
  }
  const layers = [24, 45, 80, 130, 200, 270].map(layerAgl => {
    const sample = atmosphere.sample({ x: position.x, y: terrain.height + layerAgl, z: position.z }, simTime);
    const along = sample.windVelocityMps.x * targetUnit.x + sample.windVelocityMps.z * targetUnit.z;
    const cross = Math.abs(sample.windVelocityMps.x * targetUnit.z - sample.windVelocityMps.z * targetUnit.x);
    return { layerAgl, along, cross, score: along - cross * 0.45 - Math.abs(layerAgl - selected.cruiseAgl) * 0.004 };
  }).sort((a, b) => b.score - a.score);
  const bestLayer = layers[0];
  const groundProgress = state.basket.velocity.x * targetUnit.x + state.basket.velocity.z * targetUnit.z;
  const progressSpeed = Math.max(0.65, groundProgress, bestLayer.along);
  const timeToTarget = targetDistanceM / progressSpeed;
  const requiredDescentTime = agl / 0.82 + 13;
  const planTimeRemaining = Math.max(0, selected.eta - (simTime - plan.plannedAt));
  const approach = timeToTarget <= requiredDescentTime || planTimeRemaining <= requiredDescentTime
    || targetDistanceM <= selected.arrivalToleranceM * 1.25;
  let desiredVy;
  const commandedLayerAgl = clamp(selected.cruiseAgl, 18, 210);
  if (!terrain.safe && agl < 16) desiredVy = 1.15;
  else if (!approach && agl < commandedLayerAgl - 7) desiredVy = 0.85;
  else if (!approach && agl > commandedLayerAgl + 9) desiredVy = -0.82;
  else if (!approach) desiredVy = clamp((commandedLayerAgl - agl) * 0.04, -0.58, 0.48);
  else desiredVy = clamp(-agl / Math.max(10, timeToTarget - 2), -1.85, agl < 6 ? -0.42 : -0.32);

  const vy = state.basket.velocity.y;
  let burner = 0, vent = 0.12;
  if (agl < 4.5 && terrain.safe) {
    if (vy < -0.78) burner = 0.32;
    else vent = vy > -0.24 ? 0.72 : 0.22;
  } else if (vy < desiredVy - 0.3) {
    burner = clamp(0.14 + (desiredVy - vy) * 0.08, 0, 0.42);
    vent = 0;
  } else if (vy > desiredVy + 0.2) {
    vent = clamp(0.42 + (vy - desiredVy) * 0.28, 0, 1);
  }
  return {
    burner,
    vent,
    desiredVy,
    desiredLayerAgl: commandedLayerAgl,
    targetDistanceM,
    timeToTarget,
    planTimeRemaining,
    approach,
    landingRegionId: selected.landingRegionId
  };
}

export const __recoveryTest = Object.freeze({ forecastLanding });
