import * as THREE from "three";

/**
 * St. Elmo's fire on the canopy: short-lived branching discharges that start at the frame and
 * creep over the glass towards the nose, re-striking along nearly the same way a few times
 * before they die, as in the pilots' videos. Stateless: a moment of the journey always shows
 * the same fire.
 */
const SLOTS = 6;
const TICK = 1 / 24; // a streamer changes its shape this often
const EPOCH = 0.32; // and lives about this long

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createStreamers({ bubble, bowZ }) {
  const C = new THREE.Vector3(...bubble.centre);
  const R = new THREE.Vector3(...bubble.radii);
  // Where a ray from the eye (at the origin) leaves the glass.
  const glassAlong = dir => {
    const o = new THREE.Vector3(0, 0, 0).sub(C).divide(R);
    const d = dir.clone().divide(R);
    const a = d.dot(d);
    const b = o.dot(d);
    const c = o.dot(o) - 1;
    return dir.clone().multiplyScalar((-b + Math.sqrt(Math.max(b * b - a * c, 0))) / a);
  };
  const nose = new THREE.Vector3(C.x, C.y, C.z - R.z);
  const onGlass = p => p.sub(C).divide(R).normalize().multiply(R).add(C);
  const normalAt = p => new THREE.Vector3((p.x - C.x) / (R.x * R.x), (p.y - C.y) / (R.y * R.y), (p.z - C.z) / (R.z * R.z)).normalize();
  const kBow = Math.sqrt(1 - ((bowZ - C.z) / R.z) ** 2);

  const glows = Array.from({ length: SLOTS }, () => new THREE.Vector4());
  const centre = new THREE.Vector3();
  const out = { segments: null, changed: false, power: 0, glows, centre, light: 0 };
  let lastTick = -1;
  let segments = [];

  function grow(rand, start, dir, length, width, glow, depth) {
    let p = start.clone();
    let d = dir.clone();
    // Short straight pieces with sharp turns between them, like any spark's path.
    const step = 0.014;
    const heading = d.clone();
    for (let s = 0; s < length; s += step) {
      const n = normalAt(p);
      const side = new THREE.Vector3().crossVectors(n, d).normalize();
      d.copy(heading).addScaledVector(side, (rand() - 0.5) * 1.6).addScaledVector(n, -d.dot(n)).normalize();
      heading.addScaledVector(side, (rand() - 0.5) * 0.25).addScaledVector(n, -heading.dot(n)).normalize();
      const q = onGlass(p.clone().addScaledVector(d, step));
      const fade = 1 - (s / length) * 0.75;
      segments.push({ a: [p.x, p.y, p.z], b: [q.x, q.y, q.z], width, glow: glow * fade });
      if (depth > 0 && rand() < 0.15) {
        const turn = (rand() < 0.5 ? -1 : 1) * (0.5 + rand() * 0.7);
        const bd = d.clone().addScaledVector(side, turn).normalize();
        grow(rand, q, bd, (length - s) * (0.25 + 0.35 * rand()), width * 0.65, glow * fade * 0.75, depth - 1);
      }
      p = q;
    }
  }

  return {
    max: SLOTS,
    /** level 0..1: how strong the fire is. */
    update(t, level) {
      const tick = Math.floor(t / TICK);
      out.changed = false;
      if (tick === lastTick) return out;
      lastTick = tick;
      out.changed = true;
      segments = [];
      centre.set(0, 0, 0);
      let light = 0;
      for (let s = 0; s < SLOTS; s++) {
        glows[s].set(0, 0, 0, 0);
        if (level <= 0.01) continue;
        const epoch = Math.floor(t / EPOCH + s * 0.37);
        const life = rng(epoch * 131 + s * 977 + 5);
        if (life() > level * 0.95) continue;
        let root;
        let aim;
        let length;
        if (life() < 0.45) {
          // From the bow (anywhere around it, mostly its upper half and sides), creeping over
          // the glass towards the nose.
          const a = life() < 0.75 ? Math.PI * (0.05 + 0.9 * life()) : Math.PI * (1.2 + 0.6 * life());
          root = onGlass(new THREE.Vector3(R.x * kBow * Math.cos(a), C.y + R.y * kBow * Math.sin(a), bowZ - 0.02));
          aim = nose.clone().add(new THREE.Vector3((life() - 0.5) * 1.2, (life() - 0.5) * 1.2, 0)).sub(root);
          length = 0.3 + 0.5 * life() * (0.5 + 0.5 * level);
        } else {
          // Where charge has built up on the glass itself, ahead: a small branching discharge
          // that crawls a little way in any direction.
          const az = life() * Math.PI * 2;
          const off = 0.15 + 0.5 * Math.sqrt(life());
          root = glassAlong(new THREE.Vector3(Math.cos(az) * off * 1.3, Math.sin(az) * off * 0.8 - 0.05, -1).normalize());
          aim = new THREE.Vector3(life() - 0.5, life() - 0.5, life() - 0.5);
          length = 0.12 + 0.35 * life() * (0.5 + 0.5 * level);
        }
        aim.addScaledVector(normalAt(root), -aim.dot(normalAt(root))).normalize();
        // This tick's strike: sometimes dark, never quite the same path.
        const strike = rng(tick * 7919 + s * 104729 + epoch);
        const power = strike() < 0.28 ? 0 : 0.45 + 0.55 * strike();
        if (power > 0) grow(strike, root, aim, length, 1, power, 2);
        glows[s].set(root.x, root.y, root.z, power);
        centre.addScaledVector(root, power);
        light += power;
      }
      if (light > 0) centre.multiplyScalar(1 / light);
      out.segments = segments.length ? segments : null;
      out.power = 1;
      out.light = light;
      return out;
    }
  };
}
