/**
 * The shape of a flash's channel, for its thunder (made in thundersynth.js, in a worker).
 *
 * Every few metres of the channel is a shock wave that relaxes into a pressure pulse (an
 * N-wave, longer the further it has run). Each arrives when its sound has travelled (343 m/s),
 * so a channel kilometres long is heard as a roll that lasts seconds: the near parts first and
 * sharp (a crack, if they are close), the far parts later and low (the air takes the highs).
 * Parts lying across the line of sight send their pulses together: the claps in the roll. Every
 * return stroke sends it all again. Then the echoes from the sea and the clouds: a long,
 * darkening tail. Positions are in the storm frame (metres, y up).
 */

const SOUND = 343;

/** A jagged channel through the given points (a flash inside the cloud), as segments. */
export function channelThrough(points, rand, step = 25) {
  const segments = [];
  const split = (p, q, rough) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d <= step) {
      segments.push({ a: p, b: q });
      return;
    }
    const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const off = d * rough;
    m[0] += (rand() - 0.5) * off;
    m[1] += (rand() - 0.5) * off * 0.6;
    m[2] += (rand() - 0.5) * off;
    split(p, m, rough);
    split(m, q, rough);
  };
  for (let i = 0; i + 1 < points.length; i++) split(points[i], points[i + 1], 0.32);
  return segments;
}

/** Splits long segments so none is longer than step (m). */
export function finer(segments, step = 25) {
  const out = [];
  for (const s of segments) {
    const d = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
    const n = Math.max(1, Math.ceil(d / step));
    for (let k = 0; k < n; k++) {
      const f0 = k / n;
      const f1 = (k + 1) / n;
      out.push({
        a: s.a.map((v, i) => v + (s.b[i] - v) * f0),
        b: s.a.map((v, i) => v + (s.b[i] - v) * f1)
      });
    }
  }
  return out;
}

/** Segments as a flat array [ax, ay, az, bx, by, bz, ...] for the worker. */
export function flatten(segments) {
  const out = new Float32Array(segments.length * 6);
  segments.forEach((s, i) => out.set([s.a[0], s.a[1], s.a[2], s.b[0], s.b[1], s.b[2]], i * 6));
  return out;
}
