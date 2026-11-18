/**
 * Thunder: the sound of one flash's channel as it reaches the aircraft (made in a worker, see
 * thunder.worker.js; pure arithmetic, no Web Audio).
 *
 * Every few metres of the channel is a shock wave that relaxes into a pressure pulse (an
 * N-wave, longer the further it has run). Each arrives when its sound has travelled (343 m/s),
 * so a channel kilometres long is heard as a roll that lasts seconds: the near parts first and
 * sharp (a crack, if they are close), the far parts later and low (the air takes the highs).
 * Parts lying across the line of sight send their pulses together: the claps in the roll. Every
 * return stroke sends it all again. Then the echoes from the sea and the clouds: a reverberation
 * of a few seconds, darker as it dies. Positions in the storm frame (metres, y up).
 */

export const SOUND = 343;

// RBJ biquad, applied in place.
function filter(data, type, f, q, sr) {
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
  for (let i = 0; i < data.length; i++) {
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
 * The echoes: a small feedback delay network (four lines, Hadamard mixing), each line dulled in
 * its loop, decaying over t60 seconds; mono in, two decorrelated outputs added to left, right.
 */
function reverberate(input, left, right, sr, t60, wet) {
  const lengths = [0.0613, 0.0787, 0.0991, 0.1213].map(s => Math.floor(s * sr));
  const lines = lengths.map(n => new Float32Array(n));
  const pos = [0, 0, 0, 0];
  const g = lengths.map(n => Math.pow(10, (-3 * n) / (sr * t60)));
  const damp = [0, 0, 0, 0];
  const k = 1 - Math.exp((-2 * Math.PI * 1100) / sr); // the loop's low-pass
  const out = [0, 0, 0, 0];
  for (let i = 0; i < input.length; i++) {
    for (let j = 0; j < 4; j++) out[j] = lines[j][pos[j]];
    // Hadamard mix (scaled to keep energy).
    const a = out[0] + out[1];
    const b = out[0] - out[1];
    const c = out[2] + out[3];
    const d = out[2] - out[3];
    const m = [a + c, b + d, a - c, b - d];
    for (let j = 0; j < 4; j++) {
      damp[j] += (m[j] * 0.5 - damp[j]) * k;
      lines[j][pos[j]] = input[i] + damp[j] * g[j];
      pos[j] = pos[j] + 1 === lengths[j] ? 0 : pos[j] + 1;
    }
    left[i] += wet * (out[0] + out[2]);
    right[i] += wet * (out[1] - out[3]);
  }
}

/**
 * segments: Float32Array of [ax, ay, az, bx, by, bz] per segment; listener: [x, y, z]; right:
 * the listener's right in the world; strokes: [{ t (s), a }]; power: how much sound the flash
 * makes. Returns { left, right, delay } (the samples start delay seconds after the flash), or
 * null.
 */
export function synthesize({ sampleRate: sr, segments, listener, right, strokes, power, maxSeconds = 26 }) {
  const parts = [];
  let rMin = Infinity;
  let rMax = 0;
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
    const pan = Math.max(-1, Math.min(1, (dx * right[0] + dy * right[1] + dz * right[2]) / r));
    // Spreading: the lows of thunder carry far (a storm 15 km off still rumbles), so the level
    // falls more slowly than 1/r; scaled to 1/r at 1 km.
    parts.push({ r, amp: (len * (0.25 + 0.75 * across)) / (1000 * Math.pow(r / 1000, 0.7)), pan });
    rMin = Math.min(rMin, r);
    rMax = Math.max(rMax, r);
  }
  if (!parts.length) return null;
  const span = strokes.length ? strokes[strokes.length - 1].t : 0;
  const seconds = Math.min((rMax - rMin) / SOUND + span + 0.2, maxSeconds - 4);
  const n = Math.ceil((seconds + 4) * sr);
  const low = [new Float32Array(n), new Float32Array(n)];
  const high = [new Float32Array(n), new Float32Array(n)];
  let seed = (rMin * 1000) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const st of strokes) {
    const strokeAmp = Math.pow(st.a, 0.7) * power;
    for (const p of parts) {
      const at = Math.round(((p.r - rMin) / SOUND + st.t) * sr);
      if (at >= n) continue;
      const gl = Math.cos(((p.pan + 1) * Math.PI) / 4);
      const gr = Math.sin(((p.pan + 1) * Math.PI) / 4);
      // The pulse: an N-wave, a few milliseconds near the channel, longer far from it.
      const T = Math.min(0.022, Math.max(0.006, 0.009 * Math.pow(p.r / 1000, 0.25))) * (0.8 + 0.4 * rand());
      const m = Math.floor(T * sr);
      const a = p.amp * strokeAmp;
      for (let k = 0; k < m && at + k < n; k++) {
        const x = k / m;
        const v = a * (1 - 2 * x) * Math.sin(Math.PI * x) ** 0.25;
        low[0][at + k] += v * gl;
        low[1][at + k] += v * gr;
      }
      // Close to the channel the shock is still steep: a crack.
      const crack = a * 2.5 * Math.exp(-p.r / 350);
      if (crack > 1e-5) {
        const mc = Math.floor(0.004 * sr);
        for (let k = 0; k < mc && at + k < n; k++) {
          const v = crack * (rand() * 2 - 1) * Math.exp(-k / (0.0009 * sr));
          high[0][at + k] += v * gl;
          high[1][at + k] += v * gr;
        }
      }
    }
  }
  // The air takes the highs: the further the nearest part, the duller it all is.
  const lowCut = 160 + 1400 * Math.exp(-rMin / 900);
  const highCut = Math.min(700 + 6000 * Math.exp(-rMin / 400), sr * 0.45);
  for (let c = 0; c < 2; c++) {
    filter(low[c], "lowpass", lowCut, 0.7, sr);
    filter(high[c], "highpass", 900, 0.7, sr);
    filter(high[c], "lowpass", highCut, 0.7, sr);
  }
  const left = new Float32Array(n);
  const rightOut = new Float32Array(n);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = low[0][i] + high[0][i];
    const r = low[1][i] + high[1][i];
    left[i] = 0.85 * l;
    rightOut[i] = 0.85 * r;
    mono[i] = 0.5 * (l + r);
  }
  reverberate(mono, left, rightOut, sr, 3.2, 0.32);
  return { left, right: rightOut, delay: rMin / SOUND };
}
