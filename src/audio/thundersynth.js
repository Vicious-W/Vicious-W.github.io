/**
 * Thunder: the sound of one flash's channel as it reaches the aircraft (made in a worker, see
 * thunder.worker.js; pure arithmetic, no Web Audio).
 *
 * Every few metres of the channel is a shock wave that relaxes into a pressure pulse (an
 * N-wave, longer the further it has run). Each arrives when its sound has travelled (343 m/s),
 * so a channel kilometres long is heard as a roll that lasts seconds. Parts lying across the
 * line of sight send their pulses together: the claps in the roll; parts running away from the
 * listener spread theirs out: a rip. Close to the channel the shock is still steep: a crack, a
 * tearing sound within a kilometre or two. The air takes the highs, more the further a part is:
 * the first of it may be a crack, the last of it is a low rumble. Every return stroke sends it
 * all again.
 *
 * Each part is heard from where it is: the sound comes out in first-order ambisonics (W, X, Y,
 * Z: the pressure and its three directions in the world), so that audio.js can turn it with the
 * listener's head. The echoes from the clouds and the sea are added there, by a convolver with
 * echoResponse(). Positions in the storm frame (metres, y up).
 */

export const SOUND = 343;

// RBJ biquad, applied in place over [from, to).
function filter(data, type, f, q, sr, from = 0, to = data.length) {
  const w = (2 * Math.PI * f) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  let b0, b1, b2;
  if (type === "lowpass") {
    b0 = (1 - c) / 2;
    b1 = 1 - c;
    b2 = (1 - c) / 2;
  } else {
    b0 = (1 + c) / 2;
    b1 = -(1 + c);
    b2 = (1 + c) / 2;
  }
  const a1 = (-2 * c) / a0;
  const a2 = (1 - alpha) / a0;
  b0 /= a0;
  b1 /= a0;
  b2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = from; i < to; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

/**
 * What the air leaves of the highs after r metres: absorption grows with frequency (a few dB a
 * kilometre at 1 kHz, about as f^1.5) and the pulses spread out. The frequency where the loss
 * is about 3 dB (Hz).
 */
export const dullAt = r => 1000 * Math.pow(750 / Math.max(r, 60), 2 / 3);

/**
 * The echoes of thunder from the clouds and the sea, as an impulse response for a convolver
 * (sample rate sr): a dense, smooth decay over t60 seconds that darkens as it dies (the later
 * echoes have lost their highs), with a soft start, each side its own. Energy 1 per side.
 */
export function echoResponse(sr, { seconds = 4, t60 = 3.2, seed = 61 } = {}) {
  const n = Math.floor(seconds * sr);
  return [0, 1].map(side => {
    let s = (seed + side * 7919) >>> 0;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const d = new Float32Array(n);
    let a = 0;
    let b = 0;
    let k = 0;
    let e = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if ((i & 63) === 0) k = 1 - Math.exp((-2 * Math.PI * (350 + 2600 * Math.exp(-t / 0.8))) / sr);
      a += (rand() * 2 - 1 - a) * k;
      b += (a - b) * k;
      const v = b * Math.exp((-6.91 * t) / t60) * (1 - Math.exp(-t / 0.015));
      d[i] = v;
      e += v * v;
    }
    const g = 1 / Math.sqrt(e);
    for (let i = 0; i < n; i++) d[i] *= g;
    return d;
  });
}

// How fast the crack of the steep shock dies away with distance (m).
const CRACK_REACH = 1500;
// Distance bands, each dulled by the air as far as its own distance.
const BANDS = 6;

/**
 * segments: Float32Array of [ax, ay, az, bx, by, bz] per segment; listener: [x, y, z]; strokes:
 * [{ t (s), a }]; power: how much sound the flash makes. Returns { channels: [W, X, Y, Z], delay }
 * (the samples start delay seconds after the flash), or null.
 */
export function synthesize({ sampleRate: sr, segments, listener, strokes, power, maxSeconds = 22 }) {
  const parts = [];
  let rMin = Infinity;
  let rMax = 0;
  const dist = (x, y, z) => Math.max(Math.hypot(x - listener[0], y - listener[1], z - listener[2]), 30);
  for (let s = 0; s < segments.length; s += 6) {
    const vx = segments[s + 3] - segments[s];
    const vy = segments[s + 4] - segments[s + 1];
    const vz = segments[s + 5] - segments[s + 2];
    const len = Math.hypot(vx, vy, vz);
    if (len < 1e-3) continue;
    const dx = (segments[s] + segments[s + 3]) / 2 - listener[0];
    const dy = (segments[s + 1] + segments[s + 4]) / 2 - listener[1];
    const dz = (segments[s + 2] + segments[s + 5]) / 2 - listener[2];
    const r = Math.max(Math.hypot(dx, dy, dz), 30);
    const along = (vx * dx + vy * dy + vz * dz) / (len * r);
    const across = Math.sqrt(Math.max(1 - along * along, 0));
    // A part running away from the listener is heard over the time its sound takes to cross
    // it: pulses from along it, one every few metres of path.
    const ra = dist(segments[s], segments[s + 1], segments[s + 2]);
    const rb = dist(segments[s + 3], segments[s + 4], segments[s + 5]);
    const k = Math.min(6, 1 + Math.floor(Math.abs(rb - ra) / 5));
    const rs = k === 1 ? [r] : Array.from({ length: k }, (_, j) => ra + ((rb - ra) * (j + 0.5)) / k);
    // Spreading: about 1/r, a little slower (the lows of thunder carry: a storm 15 km off still
    // rumbles); 1 at 1 km. Strongest across the line of sight.
    const amp = (len * (0.35 + 0.65 * across)) / (1000 * Math.pow(r / 1000, 0.85) * k);
    parts.push({ r, rs, amp, dir: [dx / r, dy / r, dz / r] });
    for (const q of rs) {
      rMin = Math.min(rMin, q);
      rMax = Math.max(rMax, q);
    }
  }
  if (!parts.length) return null;
  const span = strokes.length ? strokes[strokes.length - 1].t : 0;
  const seconds = Math.min((rMax - rMin) / SOUND + span + 0.2, maxSeconds);
  const n = Math.ceil((seconds + 0.3) * sr);
  const out = [0, 1, 2, 3].map(() => new Float32Array(n));
  let seed = (rMin * 1000) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const logSpan = Math.log(rMax / rMin);
  const bands = logSpan > 0.05 ? BANDS : 1;
  const bandOf = r => Math.min(bands - 1, Math.max(0, Math.floor((Math.log(r / rMin) / (logSpan || 1)) * bands)));
  const crackLength = Math.floor(0.004 * sr);
  const crackDecay = 0.0009 * sr;
  const ringOut = Math.floor(0.06 * sr);
  const arrival = (q, st) => Math.round(((q - rMin) / SOUND + st.t) * sr);
  for (let band = 0; band < bands; band++) {
    const members = parts.filter(p => bandOf(p.r) === band);
    if (!members.length) continue;
    // This band's stretch of time and its distance.
    let first = n;
    let last = 0;
    let wr = 0;
    let w = 0;
    for (const p of members) {
      wr += p.amp * Math.log(p.r);
      w += p.amp;
      for (const st of strokes) {
        for (const q of p.rs) {
          const at = arrival(q, st);
          if (at >= n) continue;
          first = Math.min(first, at);
          last = Math.max(last, at + Math.max(Math.floor(0.0264 * sr), crackLength));
        }
      }
    }
    if (first >= n) continue;
    const to = Math.min(n, last + ringOut);
    const m = to - first;
    // Pulses (low) and cracks (high), each in W, X, Y, Z.
    const low = [0, 1, 2, 3].map(() => new Float32Array(m));
    const high = [0, 1, 2, 3].map(() => new Float32Array(m));
    for (const p of members) {
      const g = [1, p.dir[0], p.dir[1], p.dir[2]];
      for (const st of strokes) {
        const a = p.amp * Math.pow(st.a, 0.7) * power;
        for (const q of p.rs) {
          const at = arrival(q, st) - first;
          if (at + first >= n) continue;
          // The pulse: an N-wave, a few milliseconds near the channel, longer far from it.
          const T = Math.min(0.022, Math.max(0.003, 0.0045 * Math.pow(q / 300, 0.3))) * (0.8 + 0.4 * rand());
          const len = Math.floor(T * sr);
          for (let i = 0; i < len && at + i < m; i++) {
            const x = i / len;
            const v = a * (1 - 2 * x) * Math.sin(Math.PI * x) ** 0.25;
            for (let c = 0; c < 4; c++) low[c][at + i] += v * g[c];
          }
          // The crack of the steep shock.
          const crack = a * 4 * Math.exp(-q / CRACK_REACH);
          if (crack > 1e-5) {
            for (let i = 0; i < crackLength && at + i < m; i++) {
              const v = crack * (rand() * 2 - 1) * Math.exp(-i / crackDecay);
              for (let c = 0; c < 4; c++) high[c][at + i] += v * g[c];
            }
          }
        }
      }
    }
    // The air takes the highs, as far as this band's distance.
    const dull = dullAt(Math.exp(wr / w));
    for (let c = 0; c < 4; c++) {
      filter(low[c], "lowpass", Math.min(1.3 * dull, 0.45 * sr), 0.7, sr);
      filter(high[c], "highpass", 600, 0.7, sr);
      filter(high[c], "lowpass", Math.min(5 * dull, 0.45 * sr), 0.7, sr);
      const o = out[c];
      for (let i = 0; i < m; i++) o[first + i] += low[c][i] + high[c][i];
    }
  }
  return { channels: out, delay: rMin / SOUND };
}
