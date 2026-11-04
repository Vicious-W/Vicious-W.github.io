import * as THREE from "three";

/**
 * The night journey: the aircraft flies itself along a fixed path through the thunderstorm.
 * Coordinates are metres in the storm's frame (the storm stands at x = z = 0); y is altitude.
 * From the south it approaches past the flanking towers, enters through a canyon between two
 * cells, crosses the vault beside the main updraft, passes over a shaft that drops to the sea,
 * is swallowed by the dense rear cell, and comes out into calm moonlight to the north.
 */
export const PATH = [
  [-2000, 4300, 18000],
  [-1500, 4350, 12500],
  [-800, 4500, 8000],
  [0, 4700, 4000],
  [600, 5000, 0],
  [0, 4900, -3500],
  [-1500, 4700, -7000],
  [-2500, 4500, -11000],
  [-4500, 4400, -18000],
  [-8000, 4400, -26000],
  [-13000, 4400, -34000]
];

// Clear spaces inside the storm along the path, radius in metres at each point (0 = none).
export const VOIDS = [0, 0, 1300, 1800, 3200, 2000, 650, 900, 0, 0, 0];

const SPEED = 68;
const MOON_ELEVATION = THREE.MathUtils.degToRad(25);
const MOON_AZIMUTH = THREE.MathUtils.degToRad(38); // clockwise from north (-z)

function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  return p1.map((_, k) =>
    0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 +
      (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3)
  );
}

/** A smooth curve through the path points, sampled by distance along it. */
export function createPath(points = PATH) {
  const at = i => points[Math.max(0, Math.min(points.length - 1, i))];
  const raw = u => {
    const i = Math.min(Math.floor(u), points.length - 2);
    return catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), u - i);
  };
  // Arc length table.
  const N = (points.length - 1) * 64;
  const us = new Float64Array(N + 1);
  const ss = new Float64Array(N + 1);
  let prev = raw(0);
  for (let k = 1; k <= N; k++) {
    const u = (k / N) * (points.length - 1);
    const p = raw(u);
    ss[k] = ss[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    us[k] = u;
    prev = p;
  }
  const length = ss[N];
  const uAt = s => {
    s = Math.max(0, Math.min(length, s));
    let lo = 0;
    let hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (ss[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - ss[lo]) / Math.max(ss[hi] - ss[lo], 1e-9);
    return us[lo] + (us[hi] - us[lo]) * f;
  };
  return {
    length,
    /** Position at distance s along the path (past the end it continues straight on). */
    position(s) {
      if (s <= length) return raw(uAt(s));
      const end = raw(uAt(length));
      const before = raw(uAt(length - 50));
      const k = (s - length) / 50;
      return end.map((v, i) => v + (v - before[i]) * k);
    },
    /** Point index (fractional) at distance s, to look up per-point values such as VOIDS. */
    index(s) {
      return uAt(s);
    }
  };
}

/** Same interface as createFlight in flight.js, driven by the path. */
export function createJourney(options = {}) {
  const path = createPath();
  const state = {
    time: options.time ?? 0,
    x: 0,
    z: 0,
    alt: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: SPEED
  };
  const look = {
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? -0.02,
    targetYaw: options.yaw ?? 0,
    targetPitch: options.pitch ?? -0.02
  };

  // The moon stands in for the sun: low, in the north-east, ahead and to the right.
  const sunDir = new THREE.Vector3(
    Math.cos(MOON_ELEVATION) * Math.sin(MOON_AZIMUTH),
    Math.sin(MOON_ELEVATION),
    -Math.cos(MOON_ELEVATION) * Math.cos(MOON_AZIMUTH)
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

  function place() {
    const s = state.time * SPEED;
    const p = path.position(s);
    const a = path.position(s + 120);
    const b = path.position(s - 120);
    state.x = p[0];
    state.alt = p[1];
    state.z = p[2];
    const dx = a[0] - b[0];
    const dz = a[2] - b[2];
    state.heading = Math.atan2(dx, -dz);
    state.pitch = Math.atan2(a[1] - b[1], Math.hypot(dx, dz));
    // Coordinated turn: bank from the rate of heading change.
    const a2 = path.position(s + 360);
    const b2 = path.position(s - 360);
    const h1 = Math.atan2(a2[0] - p[0], -(a2[2] - p[2]));
    const h0 = Math.atan2(p[0] - b2[0], -(p[2] - b2[2]));
    let dh = h1 - h0;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    const turnRate = dh / (720 / SPEED);
    state.roll = Math.atan((turnRate * SPEED) / 9.81);
  }
  place();

  // Rain and haze inside the storm: from where the path's clear spaces begin to where they end.
  const inside = [];
  for (let s = 0; s <= path.length; s += 100) {
    const u = path.index(s);
    if (VOIDS[Math.floor(u)] > 0 || VOIDS[Math.ceil(u)] > 0) inside.push(s);
  }
  const fogIn = inside.length ? inside[0] : Infinity;
  const fogOut = inside.length ? inside[inside.length - 1] : -Infinity;
  const fogAt = s => {
    const ramp = 1200;
    return Math.min(
      THREE.MathUtils.smoothstep(s, fogIn - ramp, fogIn + ramp),
      1 - THREE.MathUtils.smoothstep(s, fogOut - ramp, fogOut + ramp)
    );
  };

  function smoothLook(dt) {
    const k = 1 - Math.exp(-dt * 9);
    look.yaw += (look.targetYaw - look.yaw) * k;
    look.pitch += (look.targetPitch - look.pitch) * k;
  }

  return {
    state,
    look,
    path,

    update(dt) {
      state.time += dt;
      place();
      smoothLook(dt);
    },

    lookBy(dx, dy) {
      look.targetYaw -= dx * 0.0034;
      look.targetPitch = THREE.MathUtils.clamp(look.targetPitch + dy * 0.0034, -1.35, 1.25);
    },

    snapLook() {
      look.yaw = look.targetYaw;
      look.pitch = look.targetPitch;
    },

    view(aspect) {
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
      view.fog = fogAt(state.time * SPEED);
      return view;
    }
  };
}
