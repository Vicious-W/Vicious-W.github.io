import { createSimulationClock } from "../../core/simulationClock.js";
import { createProceduralWorld } from "./world/proceduralWorld.js";
import { vehicleRegistry, weatherRegistry, DEFAULT_FLY_SELECTION } from "./registry.js";
import { assessRecoveryPlan, planBalloonRecovery, recoveryControls } from "./recovery/recoveryPlanner.js";

export const FLY_CONTROL_OWNERS = Object.freeze(["NONE", "MANUAL", "AUTO_RECOVERY", "RECOVERED"]);

export function createFlySession({ seed = 0xc1002026, selection = DEFAULT_FLY_SELECTION } = {}) {
  const weatherDefinition = weatherRegistry[selection.weatherId];
  const vehicleDefinition = vehicleRegistry[selection.vehicleId];
  if (!weatherDefinition || !vehicleDefinition) throw new Error("Invalid FLY registry selection");
  if (!vehicleDefinition.compatibleWeather.includes(weatherDefinition.id)) throw new Error("Incompatible FLY selection");
  const atmosphere = weatherDefinition.weatherFactory(seed);
  const world = createProceduralWorld(seed);
  const vehicle = vehicleDefinition.vehicleFactory({ atmosphere, world });
  const state = {
    seed,
    stage: "READY_ON_FIELD",
    controlOwner: "MANUAL",
    manualControls: { burner: 0, vent: 0 },
    appliedControls: { burner: 0, vent: 0 },
    recoveryPlan: null,
    recoveryPlans: [],
    recoveryDiagnostics: null,
    recoveryDeadline: null,
    trajectory: [],
    originEvents: [],
    unsafeContactEvents: [],
    lastPlanTime: -Infinity,
    lastTrajectoryTime: -Infinity,
    pausedReason: null,
    failed: null
  };

  const snapshot = () => {
    const vehicleState = vehicle.snapshot();
    return {
      seed,
      simTime: clock?.simTime || 0,
      stage: state.stage,
      controlOwner: state.controlOwner,
      controls: { ...state.appliedControls },
      manualControls: { ...state.manualControls },
      atmosphere: atmosphere.sample(vehicle.envelope.position, clock?.simTime || 0),
      vehicle: vehicleState,
      world: world.snapshot(),
      recovery: state.recoveryPlan ? {
        selected: state.recoveryPlan.selected ? {
          x: state.recoveryPlan.selected.x,
          z: state.recoveryPlan.selected.z,
          height: state.recoveryPlan.selected.height,
          surface: state.recoveryPlan.selected.terrain.surface,
          safe: state.recoveryPlan.selected.terrain.safe,
          score: state.recoveryPlan.selected.score,
          landingRegionId: state.recoveryPlan.selected.landingRegionId,
          eta: state.recoveryPlan.selected.eta,
          cruiseAgl: state.recoveryPlan.selected.cruiseAgl,
          arrivalToleranceM: state.recoveryPlan.selected.arrivalToleranceM,
          predictedLanding: { ...state.recoveryPlan.selected.predictedLanding }
        } : null,
        evaluated: state.recoveryPlan.evaluated,
        rejectedUnsafe: state.recoveryPlan.rejectedUnsafe,
        writesPose: state.recoveryPlan.writesPose,
        plannedAt: state.recoveryPlan.plannedAt,
        diagnostics: state.recoveryDiagnostics ? { ...state.recoveryDiagnostics } : null
      } : null,
      trajectorySamples: state.trajectory.length,
      unsafeContactCount: state.unsafeContactEvents.length,
      failed: state.failed
    };
  };

  const installRecoveryPlan = (simTime, reason, preserveDeadline = true) => {
    const timeBudget = preserveDeadline && Number.isFinite(state.recoveryDeadline)
      ? Math.max(12, state.recoveryDeadline - simTime)
      : null;
    state.recoveryPlan = planBalloonRecovery({ vehicle, world, atmosphere, simTime, timeBudget });
    if (state.recoveryPlan.selected && !state.recoveryPlan.selected.reachable) {
      const extendedBudget = Math.max(46, (timeBudget || 24) + 34);
      state.recoveryPlan = planBalloonRecovery({ vehicle, world, atmosphere, simTime, timeBudget: extendedBudget });
      state.recoveryDeadline = simTime + (state.recoveryPlan.selected?.eta || extendedBudget);
    }
    if (!Number.isFinite(state.recoveryDeadline)) {
      state.recoveryDeadline = simTime + (state.recoveryPlan.selected?.eta || 120);
    }
    state.lastPlanTime = simTime;
    state.recoveryDiagnostics = null;
    const selected = state.recoveryPlan.selected;
    state.recoveryPlans.push({
      simTime,
      reason,
      selected: selected ? {
        x: selected.x,
        z: selected.z,
        safe: selected.zone.safe,
        landingRegionId: selected.landingRegionId,
        eta: selected.eta,
        cruiseAgl: selected.cruiseAgl,
        arrivalToleranceM: selected.arrivalToleranceM,
        predictedLanding: { ...selected.predictedLanding }
      } : null,
      evaluated: state.recoveryPlan.evaluated,
      rejectedUnsafe: state.recoveryPlan.rejectedUnsafe,
      forecastModel: state.recoveryPlan.forecastModel,
      writesPose: state.recoveryPlan.writesPose
    });
    if (state.recoveryPlans.length > 64) state.recoveryPlans.shift();
  };

  const lockRecoveryToSafeContact = (simTime, current, zone) => {
    const selected = {
      x: current.basket.position.x,
      z: current.basket.position.z,
      height: current.terrain.height,
      terrain: current.terrain,
      zone,
      landingRegionId: current.terrain.landingRegionId,
      eta: 0,
      cruiseAgl: 0,
      predictedLanding: { x: current.basket.position.x, z: current.basket.position.z },
      predictionErrorM: 0,
      arrivalToleranceM: zone.radius,
      reachable: true,
      score: 0
    };
    state.recoveryPlan = {
      selected,
      evaluated: 1,
      rejectedUnsafe: 0,
      writesPose: false,
      sampledWind: { ...atmosphere.sample(current.envelope.position, simTime).windVelocityMps },
      predictedPeakAgl: current.heightAgl,
      alongDistance: 0,
      plannedAt: simTime,
      forecastModel: "safe-contact-lock-v1"
    };
    state.lastPlanTime = simTime;
    state.recoveryPlans.push({
      simTime,
      reason: "SAFE_CONTACT_LOCK",
      selected: {
        x: selected.x,
        z: selected.z,
        safe: true,
        landingRegionId: selected.landingRegionId,
        eta: 0,
        cruiseAgl: 0,
        arrivalToleranceM: selected.arrivalToleranceM,
        predictedLanding: { ...selected.predictedLanding }
      },
      evaluated: 1,
      rejectedUnsafe: 0,
      forecastModel: state.recoveryPlan.forecastModel,
      writesPose: false
    });
    if (state.recoveryPlans.length > 64) state.recoveryPlans.shift();
  };

  let clock;
  const physicsStep = (dt, simTime) => {
    try {
      let controls = state.manualControls;
      if (state.controlOwner === "AUTO_RECOVERY") {
        const selected = state.recoveryPlan?.selected;
        const current = vehicle.snapshot();
        const terrainBelow = current.terrain;
        if (!selected) installRecoveryPlan(simTime, "NO_CANDIDATE");
        else if (simTime - state.lastPlanTime >= 8) {
          const assessment = assessRecoveryPlan({ vehicle, plan: state.recoveryPlan, world, atmosphere, simTime });
          state.recoveryDiagnostics = {
            reason: assessment.reason,
            predictionErrorM: assessment.predictionErrorM,
            targetDistanceM: assessment.targetDistanceM,
            remainingEta: assessment.remainingEta,
            zoneSafe: assessment.zoneSafe
          };
          const lowUnsafe = current.heightAgl < 70 && !terrainBelow.safe;
          if (assessment.needsReplan || lowUnsafe) {
            if (lowUnsafe && state.recoveryDeadline - simTime < 24) state.recoveryDeadline = simTime + 34;
            installRecoveryPlan(simTime, lowUnsafe ? "LOW_UNSAFE" : assessment.reason);
          }
        }
        controls = recoveryControls({ vehicle, plan: state.recoveryPlan, world, atmosphere, simTime });
      } else if (state.controlOwner === "RECOVERED") {
        controls = { burner: 0, vent: 1 };
      }
      state.appliedControls = { burner: controls.burner, vent: controls.vent };
      const current = vehicle.step(dt, simTime, state.appliedControls);
      if (current.contact && !current.terrain.safe) {
        const previousUnsafe = state.unsafeContactEvents[state.unsafeContactEvents.length - 1];
        if (!previousUnsafe || simTime - previousUnsafe.simTime > 0.5) {
          state.unsafeContactEvents.push({
            simTime,
            x: current.basket.position.x,
            z: current.basket.position.z,
            surface: current.terrain.surface,
            obstacleId: current.terrain.nearestObstacleId
          });
          if (state.unsafeContactEvents.length > 64) state.unsafeContactEvents.shift();
        }
      }
      state.stage = current.stage;
      if (state.controlOwner === "AUTO_RECOVERY") {
        state.stage = current.heightAgl < 7 && current.basket.velocity.y < 0.5
          ? "LANDING" : "AUTO_RECOVERY";
        let selected = state.recoveryPlan?.selected;
        let landingErrorM = selected
          ? Math.hypot(selected.x - current.basket.position.x, selected.z - current.basket.position.z)
          : Infinity;
        let matchesPlan = !!selected && (current.terrain.landingRegionId === selected.landingRegionId
          || landingErrorM <= selected.arrivalToleranceM);
        if (current.contact && current.terrain.safe && current.stableContactSeconds >= 3 && !matchesPlan) {
          const contactZone = world.landingZoneAt(current.basket.position.x, current.basket.position.z, 16);
          if (contactZone.safe) {
            lockRecoveryToSafeContact(simTime, current, contactZone);
            selected = state.recoveryPlan.selected;
            landingErrorM = 0;
            matchesPlan = true;
          }
        }
        if (current.contact && current.terrain.safe && current.stableContactSeconds >= 3 && matchesPlan) {
          state.controlOwner = "RECOVERED";
          state.stage = "RECOVERED";
          vehicle.state.stage = "RECOVERED";
          state.manualControls.burner = 0;
          state.manualControls.vent = 0;
          const history = state.recoveryPlans[state.recoveryPlans.length - 1];
          if (history) history.actualLanding = {
            x: current.basket.position.x,
            z: current.basket.position.z,
            landingRegionId: current.terrain.landingRegionId,
            errorM: landingErrorM,
            landedAt: simTime
          };
        }
      }
      world.updateChunks(current.basket.position);
      const shift = world.maybeShiftOrigin(current.basket.position, simTime);
      if (shift) state.originEvents.push(shift);
      if (simTime - state.lastTrajectoryTime >= 1) {
        state.trajectory.push({
          t: simTime,
          x: current.basket.position.x,
          y: current.basket.position.y,
          z: current.basket.position.z,
          vy: current.basket.velocity.y,
          fuelKg: current.fuelKg,
          temperatureK: current.internalTemperatureK,
          stage: state.stage,
          owner: state.controlOwner
        });
        if (state.trajectory.length > 900) state.trajectory.shift();
        state.lastTrajectoryTime = simTime;
      }
      const finite = [current.basket.position.x, current.basket.position.y, current.basket.position.z,
        current.internalTemperatureK, current.fuelKg].every(Number.isFinite);
      if (!finite) {
        state.failed = "NON_FINITE_PHYSICS_STATE";
        clock.pause();
      }
    } catch (error) {
      state.failed = error instanceof Error ? error.message : String(error);
      clock.pause();
      throw error;
    }
  };

  clock = createSimulationClock({ step: 1 / 120, maxSubsteps: 12, onStep: physicsStep, getSnapshot: snapshot });

  const clearControls = () => {
    state.manualControls.burner = 0;
    state.manualControls.vent = 0;
  };

  const setControl = (name, active) => {
    if (state.controlOwner !== "MANUAL" || !(name in state.manualControls)) return false;
    state.manualControls[name] = active ? 1 : 0;
    return true;
  };

  const requestRecovery = () => {
    if (state.controlOwner !== "MANUAL") return false;
    clearControls();
    state.controlOwner = "AUTO_RECOVERY";
    state.stage = "AUTO_RECOVERY";
    state.recoveryDeadline = null;
    installRecoveryPlan(clock.simTime, "USER_REQUEST", false);
    return true;
  };

  return {
    state,
    atmosphere,
    world,
    vehicle,
    clock,
    setControl,
    clearControls,
    requestRecovery,
    pause(reason = "pause") { clearControls(); state.pausedReason = reason; clock.pause(); },
    resume() { state.pausedReason = null; clock.resetAccumulator(); clock.resume(); },
    update(realDelta) { return clock.update(realDelta); },
    advance(seconds) { return clock.advance(seconds); },
    snapshot,
    dispose() { clearControls(); clock.dispose(); }
  };
}
