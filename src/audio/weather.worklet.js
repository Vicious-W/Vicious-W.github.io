// The weather on the canopy, made sample by sample on the audio thread (an AudioWorklet):
// - rain: countless small drops striking the glass, each a tick of a millisecond or two; at
//   the aircraft's speed they come by thousands a second and merge into a hiss with grain, and a
//   dull drumming of the canopy under them;
// - hail: fewer, much harder knocks, each ringing in the glass for a few hundredths of a second,
//   left and right at random, with a thud;
// - St. Elmo's fire: the crackle of tiny discharges and the hiss of corona.
// Parameters (0..1, smoothed here): rain, hail, corona; flicker follows the discharges seen.
// Stereo out. No imports: the file is loaded as is (audioWorklet.addModule).

const TAU = Math.PI * 2;

// A two-pole resonator: rings at f (Hz) with decay time tau (s).
function resonator(f, tau, sr) {
  const r = Math.exp(-1 / (tau * sr));
  return { a1: 2 * r * Math.cos((TAU * f) / sr), a2: -r * r, g: (1 - r * r) * 0.5, y1: 0, y2: 0 };
}
function ring(s, x) {
  const y = s.g * x + s.a1 * s.y1 + s.a2 * s.y2;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}
// RBJ band-pass (constant 0 dB peak gain) as a biquad state.
function bandpass(f, q, sr) {
  const w = (TAU * f) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function highpass(f, q, sr) {
  const w = (TAU * f) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function biquad(s, x) {
  const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

class Weather extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rain", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "hail", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "corona", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "flicker", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.seed = 0x9e3779b9;
    this.level = { rain: 0, hail: 0, corona: 0, flicker: 0 };
    this.ch = [0, 1].map(c => ({
      // Rain: envelope of the ticks, their colour, and the drumming under them.
      rainEnv: 0,
      rainBody: bandpass(c ? 1450 : 1250, 0.6, sr),
      rainTink: bandpass(c ? 3600 : 3200, 1.4, sr),
      rainDull: 0,
      drum: resonator(c ? 190 : 170, 0.025, sr),
      drum2: resonator(c ? 410 : 380, 0.015, sr),
      // Hail: the glass rings in a few modes; the thud below.
      modes: [resonator(c ? 1220 : 1130, 0.035, sr), resonator(c ? 2480 : 2310, 0.022, sr), resonator(c ? 4150 : 3870, 0.012, sr)],
      thud: resonator(c ? 150 : 135, 0.03, sr),
      click: 0,
      // Corona: crackle and hiss.
      crackEnv: 0,
      crackHp: highpass(2600, 0.7, sr),
      hissHp: highpass(4200, 0.7, sr)
    }));
    this.rainDecay = Math.exp(-1 / (0.0028 * sr));
    this.dull = 1 - Math.exp((-2 * Math.PI * 5000) / sr); // one-pole low-pass at 5 kHz
    this.crackDecay = Math.exp(-1 / (0.00018 * sr));
    this.clickDecay = Math.exp(-1 / (0.0006 * sr));
  }

  rand() {
    // xorshift32
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    const n = out[0].length;
    const sr = sampleRate;
    const L = this.level;
    // Follow the parameters smoothly (about a tenth of a second).
    const k = 1 - Math.exp(-n / (0.1 * sr));
    L.rain += (parameters.rain[0] - L.rain) * k;
    L.hail += (parameters.hail[0] - L.hail) * k;
    L.corona += (parameters.corona[0] - L.corona) * k;
    L.flicker += (parameters.flicker[0] - L.flicker) * Math.min(1, k * 4);
    const pRain = (L.rain * 9000) / sr; // drops a second, per channel
    const rainGain = 0.32 * Math.pow(L.rain, 0.7);
    const pHail = (L.hail * 22) / sr;
    const pCrack = (L.corona * (120 + 900 * L.flicker)) / sr;
    const hiss = L.corona * (0.006 + 0.015 * L.flicker);
    for (let c = 0; c < out.length && c < 2; c++) {
      const s = this.ch[c];
      const o = out[c];
      for (let i = 0; i < n; i++) {
        let y = 0;
        if (L.rain > 0.001) {
          let drop = 0;
          if (this.rand() < pRain) {
            const u = this.rand();
            drop = u * u * u;
            s.rainEnv += drop;
          }
          s.rainEnv *= this.rainDecay;
          const x = s.rainEnv * (this.rand() * 2 - 1);
          const ticks = 0.8 * biquad(s.rainBody, x) + 0.25 * biquad(s.rainTink, x);
          s.rainDull += (ticks - s.rainDull) * this.dull;
          const drum = ring(s.drum, drop * 12) + 0.6 * ring(s.drum2, drop * 12);
          y += rainGain * (s.rainDull + 0.5 * drum);
        }
        if (L.hail > 0.001) {
          let hit = 0;
          if (this.rand() < pHail) {
            // A hailstone: louder on one side or the other.
            const u = this.rand();
            const side = this.rand();
            hit = (0.25 + 0.75 * u * u) * (c === 0 ? 1 - 0.8 * side : 0.2 + 0.8 * side);
            s.click += hit;
          }
          s.click *= this.clickDecay;
          const x = hit * 6 + s.click * (this.rand() * 2 - 1) * 0.5;
          y += 0.6 * (ring(s.modes[0], x) * 1.0 + ring(s.modes[1], x) * 0.6 + ring(s.modes[2], x) * 0.3) + 0.9 * ring(s.thud, hit * 6);
        }
        if (L.corona > 0.001) {
          if (this.rand() < pCrack) s.crackEnv += 0.2 + 0.8 * this.rand() ** 2;
          s.crackEnv *= this.crackDecay;
          y += 0.5 * biquad(s.crackHp, s.crackEnv * (this.rand() * 2 - 1)) + hiss * biquad(s.hissHp, this.rand() * 2 - 1);
        }
        o[i] = y;
      }
    }
    return true;
  }
}

registerProcessor("weather", Weather);
