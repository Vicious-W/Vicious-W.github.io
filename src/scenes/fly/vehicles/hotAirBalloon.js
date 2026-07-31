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
  const basketHalfWidthM = 0.875;
  const basketHalfDepthM = 0.675;
  const basketCollisionRadiusM = Math.hypot(basketHalfWidthM, basketHalfDepthM);
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
    angularAcceleration: { x: 0, z: 0 },
    groundContactPoints: 0,
    obstacleContacts: [],
    dragging: false,
    tipped: false,
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
    tilt: vec(),
    angularVelocity: vec()
  };

  const basketGroundContacts = () => {
    const contacts = [];
    for (const x of [-basketHalfWidthM, basketHalfWidthM]) {
      for (const z of [-basketHalfDepthM, basketHalfDepthM]) {
        const offset = rotateBasketOffset({ x, y: -basketHalfHeightM, z }, basket.tilt);
        const point = {
          x: basket.position.x + offset.x,
          y: basket.position.y + offset.y,
          z: basket.position.z + offset.z
        };
        const terrain = world.terrainAt(point.x, point.z);
        const penetration = terrain.height - point.y;
        const pointVelocity = {
          x: basket.velocity.x - basket.angularVelocity.z * offset.y,
          y: basket.velocity.y + basket.angularVelocity.z * offset.x - basket.angularVelocity.x * offset.z,
          z: basket.velocity.z + basket.angularVelocity.x * offset.y
        };
        contacts.push({ offset, point, terrain, penetration, pointVelocity });
      }
    }
    return contacts;
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
    const inertiaX = basketMass * (Math.pow(basketHalfHeightM * 2, 2) + Math.pow(basketHalfDepthM * 2, 2)) / 12;
    const inertiaZ = basketMass * (Math.pow(basketHalfHeightM * 2, 2) + Math.pow(basketHalfWidthM * 2, 2)) / 12;
    const torque = { x: 0, z: 0 };
    const preContacts = basketGroundContacts();
    let activeGroundContacts = 0;
    for (const contact of preContacts) {
      if (contact.penetration < -0.025) continue;
      const normalSpeed = contact.pointVelocity.x * contact.terrain.normal.x
        + contact.pointVelocity.y * contact.terrain.normal.y
        + contact.pointVelocity.z * contact.terrain.normal.z;
      const normalForce = Math.max(0, 78000 * Math.max(0, contact.penetration + 0.006) - 14800 * Math.min(0, normalSpeed));
      if (normalForce <= 0) continue;
      activeGroundContacts++;
      const normal = contact.terrain.normal;
      const normalVector = { x: normal.x * normalForce, y: normal.y * normalForce, z: normal.z * normalForce };
      addScaled(fBasket, normalVector, 1);
      torque.x += contact.offset.y * normalVector.z - contact.offset.z * normalVector.y;
      torque.z += contact.offset.x * normalVector.y - contact.offset.y * normalVector.x;

      const tangentX = contact.pointVelocity.x - normal.x * normalSpeed;
      const tangentZ = contact.pointVelocity.z - normal.z * normalSpeed;
      const tangentSpeed = Math.hypot(tangentX, tangentZ);
      if (tangentSpeed > 1e-6) {
        const frictionCoefficient = contact.terrain.surface === "FIELD" ? 0.68 : 0.42;
        const frictionMagnitude = Math.min(frictionCoefficient * normalForce, tangentSpeed * basketMass * 3.2);
        const friction = { x: -tangentX / tangentSpeed * frictionMagnitude, y: 0, z: -tangentZ / tangentSpeed * frictionMagnitude };
        addScaled(fBasket, friction, 1);
        torque.x += contact.offset.y * friction.z;
        torque.z -= contact.offset.y * friction.x;
      }
    }
    // The suspension load is applied above the basket centre, so horizontal load creates a
    // measurable roll/pitch moment. A dimensioned torsional spring represents the four load lines.
    torque.x += 0.82 * state.suspensionTensionN * direction.z;
    torque.z -= 0.82 * state.suspensionTensionN * direction.x;
    const angularStiffnessNmRad = 1850;
    const angularDampingNmsRad = 920;
    torque.x += (state.swingRadians.x - basket.tilt.x) * angularStiffnessNmRad - basket.angularVelocity.x * angularDampingNmsRad;
    torque.z += (state.swingRadians.z - basket.tilt.z) * angularStiffnessNmRad - basket.angularVelocity.z * angularDampingNmsRad;
    state.netVerticalForceN = fEnvelope.y + fBasket.y;

    envelope.acceleration = vec(fEnvelope.x / envelopeMass, fEnvelope.y / envelopeMass, fEnvelope.z / envelopeMass);
    basket.acceleration = vec(fBasket.x / basketMass, fBasket.y / basketMass, fBasket.z / basketMass);
    addScaled(envelope.velocity, envelope.acceleration, dt);
    addScaled(basket.velocity, basket.acceleration, dt);
    addScaled(envelope.position, envelope.velocity, dt);
    addScaled(basket.position, basket.velocity, dt);

    state.angularAcceleration.x = torque.x / inertiaX;
    state.angularAcceleration.z = torque.z / inertiaZ;
    basket.angularVelocity.x += state.angularAcceleration.x * dt;
    basket.angularVelocity.z += state.angularAcceleration.z * dt;
    basket.tilt.x = clamp(basket.tilt.x + basket.angularVelocity.x * dt, -1.35, 1.35);
    basket.tilt.z = clamp(basket.tilt.z + basket.angularVelocity.z * dt, -1.35, 1.35);

    const terrain = world.terrainAt(basket.position.x, basket.position.z);
    state.contactImpulseNs = 0;
    const postContacts = basketGroundContacts();
    const deepestPenetration = Math.max(0, ...postContacts.map(contact => contact.penetration));
    const touchingContacts = postContacts.filter(contact => contact.penetration >= -0.018);
    if (deepestPenetration > 0) basket.position.y += deepestPenetration * 0.82;
    if (touchingContacts.length && basket.velocity.y < 0) {
      const impactSpeed = -basket.velocity.y;
      basket.velocity.y *= -0.08;
      state.contactImpulseNs += impactSpeed * basketMass;
    }
    if (touchingContacts.length) {
      // Dynamic ground friction is integrated as a contact impulse after positional stabilization;
      // this prevents alternating penalty-contact frames from leaving a residual wind-driven slide.
      const contactDamping = Math.exp(-dt * (terrain.surface === "FIELD" ? 8.5 : 3.2));
      basket.velocity.x *= contactDamping;
      basket.velocity.z *= contactDamping;
    }

    const obstacleContacts = world.obstacleContacts({
      position: basket.position,
      radius: basketCollisionRadiusM,
      halfHeight: basketHalfHeightM
    });
    for (const contact of obstacleContacts) {
      basket.position.x += contact.normal.x * contact.penetration;
      basket.position.y += contact.normal.y * contact.penetration;
      basket.position.z += contact.normal.z * contact.penetration;
      const closingSpeed = basket.velocity.x * contact.normal.x
        + basket.velocity.y * contact.normal.y
        + basket.velocity.z * contact.normal.z;
      if (closingSpeed < 0) {
        const impulseSpeed = -(1.12 * closingSpeed);
        basket.velocity.x += contact.normal.x * impulseSpeed;
        basket.velocity.y += contact.normal.y * impulseSpeed;
        basket.velocity.z += contact.normal.z * impulseSpeed;
        basket.angularVelocity.x += contact.normal.z * impulseSpeed * 0.28;
        basket.angularVelocity.z -= contact.normal.x * impulseSpeed * 0.28;
        state.contactImpulseNs += -closingSpeed * basketMass;
      }
    }
    state.groundContactPoints = Math.max(activeGroundContacts, touchingContacts.length);
    state.obstacleContacts = obstacleContacts.map(contact => ({
      id: contact.obstacleId,
      type: contact.obstacleType,
      penetrationM: contact.penetration
    }));
    state.contact = touchingContacts.length > 0;
    const horizontalSpeed = Math.hypot(basket.velocity.x, basket.velocity.z);
    state.dragging = state.contact && horizontalSpeed >= 1.6;
    state.tipped = Math.max(Math.abs(basket.tilt.x), Math.abs(basket.tilt.z)) > 0.62;
    const safeAndSlow = state.contact && terrain.safe && !state.dragging && !state.tipped
      && obstacleContacts.length === 0 && Math.abs(basket.velocity.y) < 0.45
      && Math.hypot(basket.angularVelocity.x, basket.angularVelocity.z) < 0.22;
    state.stableContactSeconds = safeAndSlow ? state.stableContactSeconds + dt : 0;

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
    const currentBasketMassKg = nonEnvelopeMass + state.fuelKg;
    return {
      id: manifest.id,
      configurationLabel: manifest.configurationLabel,
      envelope: { position: cloneVec(envelope.position), velocity: cloneVec(envelope.velocity), acceleration: cloneVec(envelope.acceleration) },
      basket: {
        position: cloneVec(basket.position),
        velocity: cloneVec(basket.velocity),
        acceleration: cloneVec(basket.acceleration),
        tilt: cloneVec(basket.tilt),
        orientation: { roll: basket.tilt.x, pitch: basket.tilt.z },
        angularVelocity: cloneVec(basket.angularVelocity),
        angularAcceleration: { ...state.angularAcceleration },
        inertiaKgM2: { x: currentBasketMassKg * (Math.pow(basketHalfHeightM * 2, 2) + Math.pow(basketHalfDepthM * 2, 2)) / 12,
          z: currentBasketMassKg * (Math.pow(basketHalfHeightM * 2, 2) + Math.pow(basketHalfWidthM * 2, 2)) / 12 }
      },
      stage: state.stage,
      contact: state.contact,
      contactImpulseNs: state.contactImpulseNs,
      groundContactPoints: state.groundContactPoints,
      obstacleContacts: state.obstacleContacts.map(contact => ({ ...contact })),
      dragging: state.dragging,
      tipped: state.tipped,
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
    constants: {
      basketHalfHeightM,
      basketHalfWidthM,
      basketHalfDepthM,
      basketCollisionRadiusM,
      restLengthM: restLength,
      volumeM3: volume
    },
    get heightAgl() { return snapshot().heightAgl; }
  };
}

function rotateBasketOffset(offset, tilt) {
  const cosX = Math.cos(tilt.x), sinX = Math.sin(tilt.x);
  const cosZ = Math.cos(tilt.z), sinZ = Math.sin(tilt.z);
  const x1 = offset.x;
  const y1 = offset.y * cosX - offset.z * sinX;
  const z1 = offset.y * sinX + offset.z * cosX;
  return {
    x: x1 * cosZ - y1 * sinZ,
    y: x1 * sinZ + y1 * cosZ,
    z: z1
  };
}
