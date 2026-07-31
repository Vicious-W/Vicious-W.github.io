import { ATMOSPHERE_CONSTANTS } from "../atmosphere/standardAtmosphere.js";
import { C100_MANIFEST } from "./c100Manifest.js";

const G = ATMOSPHERE_CONSTANTS.gravityMps2;
const R_AIR = ATMOSPHERE_CONSTANTS.dryAirGasConstantJKgK;
const CV_AIR = 718;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const cloneVec = value => ({ x: value.x, y: value.y, z: value.z });
const addScaled = (target, value, scale) => { target.x += value.x * scale; target.y += value.y * scale; target.z += value.z * scale; };

export function aerodynamicDragForce(velocity, wind, density, cd, area) {
  const rx = velocity.x - wind.x, ry = velocity.y - wind.y, rz = velocity.z - wind.z;
  const speed = Math.hypot(rx, ry, rz);
  if (speed < 1e-9) return vec();
  const scale = -0.5 * density * cd * area * speed;
  return vec(rx * scale, ry * scale, rz * scale);
}

export function createHotAirBalloon({ atmosphere, world }) {
  const manifest = C100_MANIFEST;
  const volume = manifest.geometry.volume.value;
  const envelopeArea = Math.PI * Math.pow(manifest.geometry.diameter.value * 0.5, 2);
  const restLength = manifest.dynamics.suspensionRestLengthM.value;
  const basketHalfHeightM = 0.68;
  const initialTerrain = world.terrainAt(0, 0);
  const outside = atmosphere.sample({ x: 0, y: initialTerrain.height + 12, z: 0 }, 0);
  const nonEnvelopeMass = manifest.masses.basket.value
    + manifest.masses.frameAndTwinBurners.value
    + manifest.masses.twoTanksEmpty.value
    + manifest.masses.pilot.value;

  const state = {
    internalTemperatureK: outside.temperatureK + 4,
    internalDensityKgM3: 0,
    internalAirMassKg: 0,
    fuelKg: manifest.masses.initialFuel.value,
    fuelBurnedKg: 0,
    heatInputW: 0,
    heatLossW: 0,
    buoyancyN: 0,
    weightN: 0,
    netVerticalForceN: 0,
    temperatureLimited: false,
    burnerValve: 0,
    ventValve: 0,
    contact: true,
    contactImpulseNs: 0,
    stableContactSeconds: 0,
    suspensionTensionN: 0,
    swingRadians: { x: 0, z: 0 },
    stage: "READY_ON_FIELD",
    maxHeightAgl: 0,
    distanceTravelledM: 0,
    previousBasketPosition: vec(0, initialTerrain.height + basketHalfHeightM, 0)
  };
  const envelope = {
    position: vec(0, initialTerrain.height + basketHalfHeightM + restLength, 0),
    velocity: vec(),
    acceleration: vec()
  };
  const basket = {
    position: vec(0, initialTerrain.height + basketHalfHeightM, 0),
    velocity: vec(),
    acceleration: vec(),
    tilt: vec()
  };

  const updateAirState = outsideAir => {
    state.internalDensityKgM3 = outsideAir.pressurePa / (R_AIR * state.internalTemperatureK);
    state.internalAirMassKg = state.internalDensityKgM3 * volume;
  };
  updateAirState(outside);

  const step = (dt, simTime, controls = { burner: 0, vent: 0 }) => {
    const envelopeAir = atmosphere.sample(envelope.position, simTime);
    const basketAir = atmosphere.sample(basket.position, simTime);
    const requestedBurner = clamp(Number(controls.burner) || 0, 0, 1);
    state.ventValve = clamp(Number(controls.vent) || 0, 0, 1);
    state.temperatureLimited = state.internalTemperatureK >= manifest.thermal.maximumTemperatureK.value;
    state.burnerValve = state.fuelKg > 1e-8 && !state.temperatureLimited ? requestedBurner : 0;

    const fuelRateKgS = manifest.thermal.burnerHeatPowerW.value
      / (manifest.thermal.propaneLowerHeatingValueJKg.value * manifest.thermal.burnerEfficiency.value);
    const fuelUsed = Math.min(state.fuelKg, fuelRateKgS * state.burnerValve * dt);
    state.fuelKg -= fuelUsed;
    state.fuelBurnedKg += fuelUsed;
    state.heatInputW = dt > 0 ? fuelUsed / dt * manifest.thermal.propaneLowerHeatingValueJKg.value
      * manifest.thermal.burnerEfficiency.value : 0;
    const deltaT = Math.max(0, state.internalTemperatureK - envelopeAir.temperatureK);
    state.heatLossW = deltaT * (manifest.thermal.heatLossWK.value
      + manifest.thermal.openMouthLossWK.value
      + manifest.thermal.ventLossWK.value * state.ventValve);
    const heatCapacity = Math.max(900000, state.internalAirMassKg * CV_AIR);
    state.internalTemperatureK += (state.heatInputW - state.heatLossW) / heatCapacity * dt;
    state.internalTemperatureK = clamp(state.internalTemperatureK, envelopeAir.temperatureK, manifest.thermal.maximumTemperatureK.value + 0.2);
    updateAirState(envelopeAir);

    const envelopeMass = manifest.masses.envelope.value + state.internalAirMassKg;
    const basketMass = nonEnvelopeMass + state.fuelKg;
    const totalMass = envelopeMass + basketMass;
    state.buoyancyN = envelopeAir.densityKgM3 * volume * G;
    state.weightN = totalMass * G;

    const fEnvelope = aerodynamicDragForce(envelope.velocity, envelopeAir.windVelocityMps,
      envelopeAir.densityKgM3, manifest.dynamics.envelopeCd.value, envelopeArea);
    const fBasket = aerodynamicDragForce(basket.velocity, basketAir.windVelocityMps,
      basketAir.densityKgM3, manifest.dynamics.basketCd.value, 3.1);
    fEnvelope.y += state.buoyancyN - envelopeMass * G;
    fBasket.y -= basketMass * G;

    const sx = envelope.position.x - basket.position.x;
    const sy = envelope.position.y - basket.position.y;
    const sz = envelope.position.z - basket.position.z;
    const length = Math.max(1e-6, Math.hypot(sx, sy, sz));
    const direction = vec(sx / length, sy / length, sz / length);
    const relativeSpeed = (envelope.velocity.x - basket.velocity.x) * direction.x
      + (envelope.velocity.y - basket.velocity.y) * direction.y
      + (envelope.velocity.z - basket.velocity.z) * direction.z;
    state.suspensionTensionN = Math.max(0, manifest.dynamics.suspensionStiffnessNm.value * (length - restLength)
      + manifest.dynamics.suspensionDampingNsM.value * relativeSpeed);
    addScaled(fEnvelope, direction, -state.suspensionTensionN);
    addScaled(fBasket, direction, state.suspensionTensionN);
    state.netVerticalForceN = fEnvelope.y + fBasket.y;

    envelope.acceleration = vec(fEnvelope.x / envelopeMass, fEnvelope.y / envelopeMass, fEnvelope.z / envelopeMass);
    basket.acceleration = vec(fBasket.x / basketMass, fBasket.y / basketMass, fBasket.z / basketMass);
    addScaled(envelope.velocity, envelope.acceleration, dt);
    addScaled(basket.velocity, basket.acceleration, dt);
    addScaled(envelope.position, envelope.velocity, dt);
    addScaled(basket.position, basket.velocity, dt);

    const terrain = world.terrainAt(basket.position.x, basket.position.z);
    const floorY = terrain.height + basketHalfHeightM;
    state.contactImpulseNs = 0;
    if (basket.position.y < floorY) {
      const impactSpeed = Math.max(0, -basket.velocity.y);
      basket.position.y = floorY;
      if (basket.velocity.y < 0) basket.velocity.y *= -0.08;
      const groundGrip = Math.exp(-dt * (terrain.surface === "FIELD" ? 3.8 : 1.8));
      basket.velocity.x *= groundGrip;
      basket.velocity.z *= groundGrip;
      state.contactImpulseNs = impactSpeed * basketMass;
      state.contact = true;
      const safeAndSlow = terrain.safe && Math.hypot(basket.velocity.x, basket.velocity.z) < 1.6 && Math.abs(basket.velocity.y) < 0.45;
      state.stableContactSeconds = safeAndSlow ? state.stableContactSeconds + dt : 0;
    } else {
      state.contact = false;
      state.stableContactSeconds = 0;
    }

    const travel = Math.hypot(
      basket.position.x - state.previousBasketPosition.x,
      basket.position.z - state.previousBasketPosition.z
    );
    state.distanceTravelledM += travel;
    state.previousBasketPosition = cloneVec(basket.position);
    const horizontalOffsetX = basket.position.x - envelope.position.x;
    const horizontalOffsetZ = basket.position.z - envelope.position.z;
    state.swingRadians.x = Math.atan2(horizontalOffsetZ, Math.max(1, envelope.position.y - basket.position.y));
    state.swingRadians.z = -Math.atan2(horizontalOffsetX, Math.max(1, envelope.position.y - basket.position.y));
    basket.tilt.x += (state.swingRadians.x - basket.tilt.x) * Math.min(1, dt * 5);
    basket.tilt.z += (state.swingRadians.z - basket.tilt.z) * Math.min(1, dt * 5);

    const agl = basket.position.y - basketHalfHeightM - terrain.height;
    state.maxHeightAgl = Math.max(state.maxHeightAgl, agl);
    if (state.stage === "READY_ON_FIELD" && (state.burnerValve > 0 || state.internalTemperatureK > envelopeAir.temperatureK + 6)) state.stage = "HEATING";
    if (!state.contact && agl > 0.12 && (state.stage === "HEATING" || state.stage === "READY_ON_FIELD")) state.stage = "LIFTOFF";
    if (!state.contact && agl > 2 && state.stage !== "LANDING") state.stage = "FREE_FLIGHT";
    return snapshot();
  };

  const snapshot = () => {
    const terrain = world.terrainAt(basket.position.x, basket.position.z);
    const hardwareMassKg = manifest.masses.envelope.value + nonEnvelopeMass + state.fuelKg;
    return {
      id: manifest.id,
      configurationLabel: manifest.configurationLabel,
      envelope: { position: cloneVec(envelope.position), velocity: cloneVec(envelope.velocity), acceleration: cloneVec(envelope.acceleration) },
      basket: { position: cloneVec(basket.position), velocity: cloneVec(basket.velocity), acceleration: cloneVec(basket.acceleration), tilt: cloneVec(basket.tilt) },
      stage: state.stage,
      contact: state.contact,
      contactImpulseNs: state.contactImpulseNs,
      stableContactSeconds: state.stableContactSeconds,
      heightAgl: basket.position.y - basketHalfHeightM - terrain.height,
      terrain,
      internalTemperatureK: state.internalTemperatureK,
      internalDensityKgM3: state.internalDensityKgM3,
      internalAirMassKg: state.internalAirMassKg,
      hardwareMassKg,
      actualTotalMassKg: hardwareMassKg + state.internalAirMassKg,
      certifiedWeightKg: manifest.certifiedWeight.value,
      fuelKg: state.fuelKg,
      fuelBurnedKg: state.fuelBurnedKg,
      heatInputW: state.heatInputW,
      heatLossW: state.heatLossW,
      buoyancyN: state.buoyancyN,
      weightN: state.weightN,
      netVerticalForceN: state.netVerticalForceN,
      burnerValve: state.burnerValve,
      ventValve: state.ventValve,
      temperatureLimited: state.temperatureLimited,
      suspensionTensionN: state.suspensionTensionN,
      swingRadians: { ...state.swingRadians },
      maxHeightAgl: state.maxHeightAgl,
      distanceTravelledM: state.distanceTravelledM
    };
  };

  return {
    manifest,
    state,
    envelope,
    basket,
    step,
    snapshot,
    constants: { basketHalfHeightM, restLengthM: restLength, volumeM3: volume },
    get heightAgl() { return snapshot().heightAgl; }
  };
}
