import * as THREE from "three";
import { coronaAround, FUNNEL, SPRITES, STORM_CENTRE, spritePower, TRAFFIC, trafficLamps } from "./moments.js";

/**
 * The night journey: the aircraft flies itself along a fixed path through the thunderstorm.
 * Coordinates are metres in the storm's frame (see storm.js); y is altitude.
 * From the south it approaches past the flanking towers, enters through the canyon between two
 * towers as the anvil closes overhead, crosses the hall beside the main updraft and over a well
 * that drops to the sea, flies into the rear tower (blind, but for a cave in its middle), and
 * comes out into moonlight to the north, turning west so the storm stays in sight.
 */
export const PATH = [
  [-1900, 4300, 17500],
  [-1500, 4350, 12500],
  [-700, 4500, 8500],
  [-200, 4700, 4800],
  [800, 4900, 800],
  [-100, 4900, -3000],
  [-900, 4700, -6200],
  [-1600, 4550, -10300],
  [-2600, 4450, -14500],
  [-5500, 4400, -20500],
  [-11500, 4400, -24500],
  [-18500, 4400, -25500]
];

const SPEED = 68;

// Pockets of thinner air inside the rear tower, so its blind stretch opens up twice. (Small
// fragments of scud and veils placed along the hall for the aircraft to fly through stood
// alone in the clear air like props; they were taken out.) t: when (s on the journey); off:
// offset from the path (m: right, up, ahead); r: radii (m: across, up, along the path); dense:
// how deep in mist its middle is, as a share of the storm's fringe (see storm.glsl); a pocket
// has dense < 0.
export const SCUD = [
  { t: 393, off: [0, 0, 0], r: [260, 200, 300], dense: -1 },
  { t: 447, off: [0, 0, 0], r: [220, 180, 260], dense: -1 }
];
const SCUD_MAX = 8;
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
    /** Position at distance s along the path (before the start and past the end it runs straight on). */
    position(s) {
      if (s >= 0 && s <= length) return raw(uAt(s));
      const edge = s < 0 ? 0 : length;
      const inward = s < 0 ? 50 : length - 50;
      const end = raw(uAt(edge));
      const before = raw(uAt(inward));
      const k = Math.abs(s - edge) / 50;
      return end.map((v, i) => v + (v - before[i]) * k);
    },
    /** Point index (fractional) at distance s. */
    index(s) {
      return uAt(s);
    }
  };
}

/** The scud in the storm frame: centre, radii, density, and the path's heading there (cos, sin). */
export function placeScud(path = createPath()) {
  return SCUD.map(b => {
    const s = b.t * SPEED;
    const p = path.position(s);
    const a = path.position(s + 50);
    const c = path.position(s - 50);
    const h = Math.atan2(a[0] - c[0], -(a[2] - c[2]));
    const right = [Math.cos(h), Math.sin(h)];
    const ahead = [Math.sin(h), -Math.cos(h)];
    const centre = [
      p[0] + right[0] * b.off[0] + ahead[0] * b.off[2],
      p[1] + b.off[1],
      p[2] + right[1] * b.off[0] + ahead[1] * b.off[2]
    ];
    return { centre, r: b.r, dense: b.dense, turn: right };
  });
}

/**
 * How the scud and pockets change the cloud at (x, y, z), without the noise: the storm's
 * baked distance sd (m, positive inside) in, the scud's share of mist (0..1) and the distance
 * the pockets leave out.
 */
export function scudAt(bodies, x, y, z, sd) {
  let mist = 0;
  let shape = sd;
  for (const b of bodies) {
    const dx = x - b.centre[0];
    const dy = y - b.centre[1];
    const dz = z - b.centre[2];
    const qa = (b.turn[0] * dx + b.turn[1] * dz) / b.r[0];
    const qb = (b.turn[1] * dx - b.turn[0] * dz) / b.r[2];
    const k = Math.hypot(qa, dy / b.r[1], qb);
    if (b.dense > 0) mist = Math.max(mist, Math.min(Math.max((1 - k) * b.dense / 0.3, 0), 1) * 0.45);
    else shape = Math.min(shape, (k - 1) * 320 * 1.2);
  }
  return { mist, shape };
}

// ---- deterministic noise of time, so a moment of the journey always looks the same ---------

function hash1(n) {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1]. */
function noise1(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash1(i + seed * 100003);
  const b = hash1(i + 1 + seed * 100003);
  return (a + (b - a) * u) * 2 - 1;
}

const smooth = (x, a, b) => THREE.MathUtils.smoothstep(x, a, b);
const bump = (s, centre, half) => {
  const x = Math.abs(s - centre) / half;
  return x >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x);
};

/**
 * Gusts: at random moments the air hits the aircraft, which answers with a sharp jolt and a
 * short damped swing. Returns the sum of the recent ones: heave, pitch and roll, each about
 * -1..1. rough (0..1) sets how often they come.
 */
function gusts(t, rough) {
  const slot = 0.7;
  const n = Math.floor(t / slot);
  let heave = 0;
  let pitch = 0;
  let roll = 0;
  for (let j = n - 3; j <= n; j++) {
    if (hash1(j * 8 + 1) > 0.18 + 0.62 * rough) continue;
    const tau = t - (j + hash1(j * 8 + 2) * 0.9) * slot;
    if (tau < 0) continue;
    const amp = 0.3 + 0.7 * hash1(j * 8 + 3) ** 2;
    const env = (1 - Math.exp(-tau / 0.03)) * Math.exp(-tau / 0.26);
    const drop = hash1(j * 8 + 4) < 0.7 ? -1 : 1; // mostly the bottom falls out
    heave += drop * amp * env * Math.cos(tau * 12);
    pitch += (hash1(j * 8 + 5) * 2 - 1) * amp * env * Math.cos(tau * 9 + 1);
    roll += (hash1(j * 8 + 6) * 2 - 1) * amp * env * Math.cos(tau * 10.5 + 2);
  }
  return { heave, pitch, roll };
}

/**
 * Same interface as createFlight in flight.js, driven by the path.
 * options.stormSD(x, y, z): baked distance into the storm cloud (m, positive inside).
 * options.cabin may hold fixed levels (0..1) of rain, hail, elmo, turb and cloud, for captures.
 */
export function createJourney(options = {}) {
  const path = createPath();
  const stormSD = options.stormSD || (() => -1500);
  const bodies = placeScud(path);
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
    pitch: options.pitch ?? -0.04,
    targetYaw: options.yaw ?? 0,
    targetPitch: options.pitch ?? -0.04
  };

  // The moon stands in for the sun: low, in the north-east, ahead and to the right.
  const sunDir = new THREE.Vector3(
    Math.cos(MOON_ELEVATION) * Math.sin(MOON_AZIMUTH),
    Math.sin(MOON_ELEVATION),
    -Math.cos(MOON_ELEVATION) * Math.cos(MOON_AZIMUTH)
  ).normalize();

  const euler = new THREE.Euler();
  const qSteady = new THREE.Quaternion();
  const qShake = new THREE.Quaternion();
  const qLook = new THREE.Quaternion();
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
    speed: SPEED,
    sunDir,
    qAircraft, // attitude of the airframe, shake included
    qHead, // the head in the airframe
    eye: new THREE.Vector3(), // the eye in the airframe (m)
    cabin: null,
    fog: 0,
    velocity: [0, 0, 0], // the aircraft's (world, m/s)
    air: [0, 0, 0], // how far the air has moved since the start (world, m)
    airVel: [0, 0, 0], // and how fast it moves now (m/s)
    // Another aircraft (moments.js): its lamps relative to the eye in world axes and their
    // light (position lights red and green at the wing tips with the strobes, a white one on
    // the tail, the red beacon on its back), and where it is and how fast it goes (world).
    traffic: {
      on: false,
      pos: Array.from({ length: 4 }, () => new THREE.Vector3()),
      light: Array.from({ length: 4 }, () => new THREE.Vector3()),
      at: [0, 0, 0],
      velocity: [0, 0, 0]
    },
    // The tornado (moments.js): its foot relative to the camera (x, z), on or not, the base it
    // hangs from, how far it has turned.
    funnel: { on: false, x: 0, z: 0, top: FUNNEL.top, spin: 0 },
    // A red sprite (moments.js): where it stands relative to the camera (x, z, m), how bright,
    // how many columns, its seed.
    sprite: { power: 0, x: 0, z: 0, count: 0, seed: 0 },
    // The scud nearest the aircraft, for the cloud shaders (see storm.glsl).
    scud: {
      count: 0,
      pos: Array.from({ length: SCUD_MAX }, () => new THREE.Vector4()),
      size: Array.from({ length: SCUD_MAX }, () => new THREE.Vector4()),
      turn: Array.from({ length: SCUD_MAX }, () => new THREE.Vector2())
    }
  };
  const order = bodies.map((b, i) => i);

  // The other aircraft's line: it crosses the path at TRAFFIC.cross, TRAFFIC.lead seconds before
  // the aircraft gets there, flying from right to left and a little back towards it.
  const trafficLine = (() => {
    const s = TRAFFIC.cross * SPEED;
    const x = path.position(s);
    x[1] += TRAFFIC.up;
    const a = path.position(s + 60);
    const b = path.position(s - 60);
    const h = Math.atan2(a[0] - b[0], -(a[2] - b[2]));
    const k = THREE.MathUtils.degToRad(TRAFFIC.angle);
    const d = [-Math.cos(h) * Math.cos(k) - Math.sin(h) * Math.sin(k), 0, -Math.sin(h) * Math.cos(k) + Math.cos(h) * Math.sin(k)];
    return { x, d, t: TRAFFIC.cross - TRAFFIC.lead };
  })();
  function trafficAt(t, out) {
    const dt = t - trafficLine.t;
    out.on = dt > -14 && dt < 8;
    if (!out.on) {
      for (const l of out.light) l.set(0, 0, 0);
      return;
    }
    const { x, d } = trafficLine;
    const v = TRAFFIC.speed;
    const at = [x[0] + d[0] * v * dt, x[1], x[2] + d[2] * v * dt];
    out.at = at;
    out.velocity = [d[0] * v, 0, d[2] * v];
    // Where it was at time u (for its sound, which takes a while to arrive).
    out.where = u => [x[0] + d[0] * v * (u - trafficLine.t), x[1], x[2] + d[2] * v * (u - trafficLine.t)];
    const right = [-d[2], 0, d[0]];
    const lamps = trafficLamps(t);
    const place = (i, r, u, f, colour, k) => {
      out.pos[i].set(at[0] + right[0] * r + d[0] * f - state.x, at[1] + u - state.alt, at[2] + right[2] * r + d[2] * f - state.z);
      out.light[i].set(colour[0] * k, colour[1] * k, colour[2] * k);
    };
    const white = [1, 1, 1];
    place(0, -7, 0.4, 0, [1, 0.05 + 0.95 * Math.min(1, lamps.strobe / 2), 0.035 + 0.965 * Math.min(1, lamps.strobe / 2)], lamps.steady + lamps.strobe);
    place(1, 7, 0.4, 0, [0.05 + 0.95 * Math.min(1, lamps.strobe / 2), 1, 0.3 + 0.7 * Math.min(1, lamps.strobe / 2)], lamps.steady + lamps.strobe);
    place(2, 0, 1.4, -9, white, lamps.steady * 0.6);
    place(3, 0, 1.6, 1, [1, 0.045, 0.03], lamps.beacon);
  }

  // Capture aid: options.hold keeps the aircraft where it was at that time while time runs on
  // (the air, the mist and the lightning go on), to see the mist move by itself.
  function place() {
    const s = (options.hold ?? state.time) * SPEED;
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

  // ---- where things happen along the path (distances in metres) -----------------------
  // Cloud right around the aircraft: the storm (less its pockets) and the scud.
  const cloudAt = s => {
    let sum = 0;
    let mist = 0;
    for (const d of [-80, 0, 80]) {
      const p = path.position(s + d);
      const at = scudAt(bodies, p[0], p[1], p[2], stormSD(...p));
      sum += at.shape;
      mist = Math.max(mist, at.mist);
    }
    return Math.max(smooth(sum / 3, -350, 150), mist);
  };
  // First distance at which the path has gone north of z0 (it flies north until the last turn).
  const whereZ = z0 => {
    for (let s = 0; s < path.length; s += 25) if (path.position(s)[2] <= z0) return s;
    return path.length;
  };
  const mark = {
    anvil: whereZ(8800), // the anvil closes overhead: rain begins
    canyon: whereZ(6500),
    updraft: whereZ(300), // closest to the main updraft
    well: whereZ(-3000),
    wall: whereZ(-6400), // into the rear tower
    cave: whereZ(-10300),
    out: whereZ(-13600) // out of its north face
  };
  // Refine the wall and the way out from the baked cloud itself, when it is known.
  for (let s = whereZ(-5000); s < whereZ(-9000); s += 25) {
    if (stormSD(...path.position(s)) > -100) {
      mark.wall = s;
      break;
    }
  }
  for (let s = whereZ(-16500); s > whereZ(-11500); s -= 25) {
    if (stormSD(...path.position(s)) > -100) {
      mark.out = s;
      break;
    }
  }

  const fixed = options.cabin || {};
  /** The cabin at distance s and time t: all levels 0..1. */
  const cabinAt = (s, t) => {
    // Out of the storm the rain stops almost at once (a few seconds).
    const storm = Math.min(smooth(s, mark.anvil - 900, mark.anvil + 900), 1 - smooth(s, mark.out - 150, mark.out + 300));
    const cloud = fixed.cloud ?? cloudAt(s);
    const blind = smooth(s, mark.wall - 300, mark.wall + 700) * (1 - smooth(s, mark.out - 500, mark.out + 300));
    // Showers in the canyon and the hall, heavier near the wells and the updraft; a downpour in cloud.
    const showers = 0.32 + 0.22 * noise1(s / 1700, 3) + 0.3 * bump(s, mark.well, 1600) + 0.2 * bump(s, mark.updraft, 1500);
    const rain = storm * THREE.MathUtils.clamp(Math.max(showers, 0.85 * cloud + 0.6 * blind) * (0.85 + 0.15 * noise1(t * 0.31, 5)), 0, 1);
    const hail =
      Math.max(0.55 * bump(s, mark.updraft + 300, 1300), smooth(s, mark.wall + 500, mark.wall + 1700) * (1 - smooth(s, mark.out - 1200, mark.out - 200))) *
      (0.72 + 0.28 * noise1(t * 0.9, 7));
    const elmo =
      Math.max(0.5 * bump(s, mark.canyon - 400, 1500), smooth(s, mark.wall - 200, mark.wall + 900) * (1 - smooth(s, mark.out - 700, mark.out + 200))) *
      (0.6 + 0.4 * noise1(t * 0.43, 9));
    const turb = 0.07 + storm * (0.26 + 0.22 * bump(s, mark.updraft, 2600)) + 0.6 * blind;
    return {
      storm,
      cloud,
      rain: fixed.rain ?? rain,
      hail: fixed.hail ?? hail,
      elmo: fixed.elmo ?? Math.min(1, elmo * coronaAround(t)),
      turb: fixed.turb ?? Math.min(turb, 1)
    };
  };

  // The air of the storm moves, and its cloud with it: gusts every way, the main updraft (and
  // the air rising out of the well) carrying the mist up past the aircraft, and in the rear
  // tower it churns. World velocity (m/s) at distance s and time t; and its displacement since
  // the start (integrated once into a table, so a moment of the journey always looks the same).
  const airVelocity = (s, t, out) => {
    const storm = smooth(s, mark.anvil - 900, mark.anvil + 900) * (1 - smooth(s, mark.out - 200, mark.out + 900));
    const churn = smooth(s, mark.wall - 300, mark.wall + 700) * (1 - smooth(s, mark.out - 500, mark.out + 300));
    const k = 0.25 + 0.75 * storm + 0.8 * churn;
    out[0] = k * (3.5 * noise1(t * 0.19, 43) + 1.5 * noise1(t * 0.83, 46));
    out[1] = k * (4 * noise1(t * 0.23, 41) + 2.5 * noise1(t * 0.71, 42)) + 13 * bump(s, mark.updraft, 2200) + 6 * bump(s, mark.well, 1500);
    out[2] = k * (3.5 * noise1(t * 0.17, 44) + 1.5 * noise1(t * 0.77, 47));
    return out;
  };
  const AIR_DT = 0.05;
  const AIR_N = 24000; // 1200 s
  const airTable = new Float32Array((AIR_N + 1) * 3);
  {
    const v = [0, 0, 0];
    for (let i = 1; i <= AIR_N; i++) {
      const t = (i - 0.5) * AIR_DT;
      airVelocity(t * SPEED, t, v);
      for (let c = 0; c < 3; c++) airTable[i * 3 + c] = airTable[(i - 1) * 3 + c] + v[c] * AIR_DT;
    }
  }
  const airAt = (t, out) => {
    const x = Math.min(Math.max(t / AIR_DT, 0), AIR_N - 1e-6);
    const i = Math.floor(x);
    const f = x - i;
    for (let c = 0; c < 3; c++) out[c] = airTable[i * 3 + c] + (airTable[(i + 1) * 3 + c] - airTable[i * 3 + c]) * f;
    return out;
  };

  /**
   * The gusts that strike between journey times t0 and t1 (s), for the sound of the airframe:
   * { time, amp (0..1), drop (true when the bottom falls out) }. The same events as in gusts().
   */
  function gustEvents(t0, t1) {
    const slot = 0.7;
    const events = [];
    for (let j = Math.floor(t0 / slot) - 1; j <= Math.floor(t1 / slot); j++) {
      const time = (j + hash1(j * 8 + 2) * 0.9) * slot;
      if (time < t0 || time >= t1) continue;
      const rough = cabinAt(time * SPEED, time).turb;
      if (hash1(j * 8 + 1) > 0.18 + 0.62 * rough) continue;
      events.push({ time, amp: (0.3 + 0.7 * hash1(j * 8 + 3) ** 2) * rough, drop: hash1(j * 8 + 4) < 0.7 });
    }
    return events;
  }

  function smoothLook(dt) {
    const k = 1 - Math.exp(-dt * 9);
    look.yaw += (look.targetYaw - look.yaw) * k;
    look.pitch += (look.targetPitch - look.pitch) * k;
  }

  return {
    state,
    look,
    path,
    mark,
    cabinAt,
    gustEvents,

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
      const t = state.time;
      const cabin = cabinAt(t * SPEED, t);
      const k = cabin.turb;

      // Turbulence. The slow wander of the airframe turns the whole view. The jolts are too
      // quick for the eyes to follow: they stay on the world outside (as eyes do), and it is
      // the cockpit that jumps around them. So gusts and buffet mostly move the airframe
      // against the head, and only a part of them reaches the view of the world.
      const g = gusts(t, k);
      const buffet = k * k;
      const fastP = k * 0.0075 * g.pitch + buffet * 0.0006 * noise1(t * 23, 21);
      const fastR = k * 0.011 * g.roll + buffet * 0.0008 * noise1(t * 19, 22);
      const fastH = k * 0.003 * noise1(t * 3.1, 23) * Math.abs(g.roll);
      const slowP = k * (0.006 * noise1(t * 0.45, 11) + 0.004 * noise1(t * 1.1, 12));
      const slowR = k * (0.016 * noise1(t * 0.38, 13) + 0.008 * noise1(t * 0.9, 14));
      const slowH = k * 0.006 * noise1(t * 0.3, 15);
      const follow = 0.3; // the share of a jolt that the view of the world takes
      euler.set(state.pitch + slowP + follow * fastP, -state.heading + slowH + follow * fastH, -state.roll + slowR + follow * fastR, "YXZ");
      qSteady.setFromEuler(euler);
      euler.set((1 - follow) * fastP, (1 - follow) * fastH, (1 - follow) * fastR, "YXZ");
      qShake.setFromEuler(euler);
      qAircraft.copy(qSteady).multiply(qShake);
      euler.set(look.pitch, -look.yaw, 0, "YXZ");
      qLook.setFromEuler(euler);
      qHead.copy(qShake).invert().multiply(qLook);
      // The body lags the seat: when the aircraft drops, the eye rises in the cockpit.
      view.eye.set(
        k * (0.006 * noise1(t * 1.7, 31) + 0.004 * g.roll) + buffet * 0.0015 * noise1(t * 17, 32),
        k * (-0.03 * g.heave + 0.006 * noise1(t * 2.3, 33)) + buffet * 0.002 * noise1(t * 21, 34),
        k * 0.004 * noise1(t * 1.3, 35)
      );
      view.cabin = cabin;
      q.copy(qSteady).multiply(qLook);
      view.forward.set(0, 0, -1).applyQuaternion(q);
      view.right.set(1, 0, 0).applyQuaternion(q);
      view.up.set(0, 1, 0).applyQuaternion(q);
      view.tanHalf.set(tanX, tanY);
      view.alt = state.alt;
      view.x = state.x;
      view.z = state.z;
      view.time = t;
      // Rain and haze in the air of the storm, for the clouds.
      view.fog = cabin.storm;
      airAt(t, view.air);
      // Rain and mist in the air around the aircraft: the storm's showers (see mist.frag).
      view.airMist = cabin.storm * Math.min(1, 0.35 + cabin.rain);
      trafficAt(t, view.traffic);
      view.funnel.on = t < FUNNEL.until;
      view.funnel.x = FUNNEL.x - state.x;
      view.funnel.z = FUNNEL.z - state.z;
      view.funnel.spin = (t * FUNNEL.spin) % (Math.PI * 2000);
      view.sprite.power = 0;
      for (const sp of SPRITES) {
        const k = spritePower(t - sp.t);
        if (k <= 0) continue;
        // Beyond the storm's centre as seen from where the aircraft is when it flashes.
        const p = path.position(sp.t * SPEED);
        const dx = STORM_CENTRE[0] - p[0];
        const dz = STORM_CENTRE[1] - p[2];
        const d = Math.hypot(dx, dz) || 1;
        const ux = dx / d;
        const uz = dz / d;
        view.sprite.power = k;
        view.sprite.x = p[0] + ux * sp.along * 1000 - uz * sp.side * 1000 - state.x;
        view.sprite.z = p[2] + uz * sp.along * 1000 + ux * sp.side * 1000 - state.z;
        view.sprite.count = sp.count;
        view.sprite.seed = sp.seed;
      }
      {
        const a = path.position(t * SPEED + 34);
        const b = path.position(t * SPEED - 34);
        for (let c = 0; c < 3; c++) view.velocity[c] = (a[c] - b[c]) * (SPEED / 68);
      }
      airVelocity(t * SPEED, t, view.airVel);
      // The scud within sight, nearest first, relative to the camera (y stays altitude).
      const dist = b => Math.hypot(b.centre[0] - state.x, b.centre[1] - state.alt, b.centre[2] - state.z);
      order.sort((a, b) => dist(bodies[a]) - dist(bodies[b]));
      let n = 0;
      for (const i of order) {
        const b = bodies[i];
        if (n >= SCUD_MAX || dist(b) > 9000) break;
        view.scud.pos[n].set(b.centre[0] - state.x, b.centre[1], b.centre[2] - state.z, 0);
        view.scud.size[n].set(b.r[0], b.r[1], b.r[2], b.dense);
        view.scud.turn[n].set(b.turn[0], b.turn[1]);
        n++;
      }
      for (let i = n; i < SCUD_MAX; i++) view.scud.size[i].set(0, 0, 0, 0);
      view.scud.count = n;
      return view;
    }
  };
}
