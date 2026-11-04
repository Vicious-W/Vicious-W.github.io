import * as THREE from "three";

const SUN_ELEVATION = THREE.MathUtils.degToRad(38);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(40); // clockwise from north (-z)

/**
 * The aircraft flies itself: slow heading changes with coordinated bank, gentle altitude
 * changes between cloud layers. The viewer only turns their head.
 */
export function createFlight(options = {}) {
  const state = {
    x: options.x ?? 0,
    z: options.z ?? 0,
    alt: options.alt ?? 3150,
    heading: options.heading ?? 0.35,
    pitch: 0,
    roll: 0,
    speed: 68,
    time: options.time ?? 0
  };
  const look = {
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? -0.04,
    targetYaw: options.yaw ?? 0,
    targetPitch: options.pitch ?? -0.04
  };

  const sunDir = new THREE.Vector3(
    Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
    Math.sin(SUN_ELEVATION),
    -Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH)
  ).normalize();

  const euler = new THREE.Euler();
  const qAircraft = new THREE.Quaternion();
  const qHead = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const view = {
    right: new THREE.Vector3(),
    up: new THREE.Vector3(),
    forward: new THREE.Vector3(),
    tanHalf: new THREE.Vector2(),
    alt: 0,
    x: 0,
    z: 0,
    time: 0,
    sunDir
  };

  function smoothLook(dt) {
    const k = 1 - Math.exp(-dt * 9);
    look.yaw += (look.targetYaw - look.yaw) * k;
    look.pitch += (look.targetPitch - look.pitch) * k;
  }

  return {
    state,
    look,

    update(dt) {
      state.time += dt;
      const t = state.time;
      const turnRate = 0.010 * Math.sin(t * 0.017 + 0.4) + 0.005 * Math.sin(t * 0.0061 + 2.1);
      state.heading += turnRate * dt;
      const bank = Math.atan((turnRate * state.speed) / 9.81);
      state.roll += (bank - state.roll) * Math.min(1, dt * 0.7);
      const targetAlt = 3150 + 420 * Math.sin(t * 0.011 + 1.0) + 180 * Math.sin(t * 0.029);
      const climb = THREE.MathUtils.clamp((targetAlt - state.alt) * 0.06, -4, 4);
      state.alt += climb * dt;
      state.pitch += (Math.atan2(climb, state.speed) - state.pitch) * Math.min(1, dt * 0.8);
      state.x += Math.sin(state.heading) * state.speed * dt;
      state.z -= Math.cos(state.heading) * state.speed * dt;
      smoothLook(dt);
    },

    /** Drag in CSS pixels: the scene follows the finger. */
    lookBy(dx, dy) {
      look.targetYaw -= dx * 0.0034;
      look.targetPitch = THREE.MathUtils.clamp(look.targetPitch + dy * 0.0034, -1.35, 1.25);
    },

    snapLook() {
      look.yaw = look.targetYaw;
      look.pitch = look.targetPitch;
    },

    view(aspect) {
      // About 62 degrees vertically on landscape screens; keep a wide horizontal view on portrait.
      let tanY = Math.tan(THREE.MathUtils.degToRad(31));
      let tanX = tanY * aspect;
      const minTanX = Math.tan(THREE.MathUtils.degToRad(36));
      if (tanX < minTanX) {
        tanX = minTanX;
        tanY = tanX / aspect;
      }
      euler.set(state.pitch, -state.heading, -state.roll, "YXZ");
      qAircraft.setFromEuler(euler);
      euler.set(look.pitch, -look.yaw, 0, "YXZ");
      qHead.setFromEuler(euler);
      q.copy(qAircraft).multiply(qHead);
      view.forward.set(0, 0, -1).applyQuaternion(q);
      view.right.set(1, 0, 0).applyQuaternion(q);
      view.up.set(0, 1, 0).applyQuaternion(q);
      view.tanHalf.set(tanX, tanY);
      view.alt = state.alt;
      view.x = state.x;
      view.z = state.z;
      view.time = state.time;
      return view;
    }
  };
}
