import { createSimulationClock } from "../../core/simulationClock.js";
import { createProceduralWorld } from "./world/proceduralWorld.js";
import { vehicleRegistry, weatherRegistry, DEFAULT_FLY_SELECTION } from "./registry.js";
import { planBalloonRecovery, recoveryControls } from "./recovery/recoveryPlanner.js";

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
    trajectory: [],
    originEvents: [],
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
          score: state.recoveryPlan.selected.score
        } : null,
        evaluated: state.recoveryPlan.evaluated,
        rejectedUnsafe: state.recoveryPlan.rejectedUnsafe,
        writesPose: state.recoveryPlan.writesPose,
        plannedAt: state.recoveryPlan.plannedAt
      } : null,
      trajectorySamples: state.trajectory.length,
      failed: state.failed
    };
  };

  let clock;
  const physicsStep = (dt, simTime) => {
    try {
      let controls = state.manualControls;
      if (state.controlOwner === "AUTO_RECOVERY") {
        const selected = state.recoveryPlan?.selected;
        const current = vehicle.snapshot();
        const targetDistance = selected ? Math.hypot(selected.x - current.basket.position.x, selected.z - current.basket.position.z) : Infinity;
        const terrainBelow = current.terrain;
        if (!selected || targetDistance > 1300 || !selected.terrain.safe
          || (simTime - state.lastPlanTime >= 4 && current.heightAgl < 12 && !terrainBelow.safe)) {
          state.recoveryPlan = planBalloonRecovery({ vehicle, world, atmosphere, simTime });
          state.recoveryPlans.push({
            simTime,
            selected: state.recoveryPlan.selected ? { x: state.recoveryPlan.selected.x, z: state.recoveryPlan.selected.z, safe: state.recoveryPlan.selected.terrain.safe } : null,
            writesPose: state.recoveryPlan.writesPose
          });
          if (state.recoveryPlans.length > 64) state.recoveryPlans.shift();
          state.lastPlanTime = simTime;
        }
        controls = recoveryControls({ vehicle, plan: state.recoveryPlan, world });
      } else if (state.controlOwner === "RECOVERED") {
        controls = { burner: 0, vent: 1 };
      }
      state.appliedControls = { burner: controls.burner, vent: controls.vent };
      const current = vehicle.step(dt, simTime, state.appliedControls);
      state.stage = current.stage;
      if (state.controlOwner === "AUTO_RECOVERY") {
        state.stage = current.heightAgl < 7 && current.basket.velocity.y < 0.5
          ? "LANDING" : "AUTO_RECOVERY";
        if (current.contact && current.terrain.safe && current.stableContactSeconds >= 3) {
          state.controlOwner = "RECOVERED";
          state.stage = "RECOVERED";
          vehicle.state.stage = "RECOVERED";
          state.manualControls.burner = 0;
          state.manualControls.vent = 0;
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
    state.recoveryPlan = planBalloonRecovery({ vehicle, world, atmosphere, simTime: clock.simTime });
    state.lastPlanTime = clock.simTime;
    state.recoveryPlans.push({
      simTime: clock.simTime,
      selected: state.recoveryPlan.selected ? { x: state.recoveryPlan.selected.x, z: state.recoveryPlan.selected.z, safe: state.recoveryPlan.selected.terrain.safe } : null,
      writesPose: state.recoveryPlan.writesPose
    });
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
