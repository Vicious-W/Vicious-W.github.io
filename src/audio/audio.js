import { channelThrough, finer, flatten } from "./thunder.js";
import { echoResponse } from "./thundersynth.js";
import { CREATURE, ORB, RADIO, STRIKE, catchTimes, radioCalls } from "../night/moments.js";
import { createRadio } from "./radio.js";

/**
 * The sound of the night journey, all made in the browser (Web Audio):
 * - the cabin: the air rushing over the canopy (shaped like the cockpit recording the owner gave:
 *   even from 63 Hz to 2 kHz, falling steeply above), never steady: it swells and fades, its
 *   colour wanders, rough air buffets it, a seam whistles in a strong gust; the fan behind the
 *   cabin and its engine, their speed wandering;
 * - the weather on the glass: rain, hail and St. Elmo's fire (an AudioWorklet, see
 *   weather.worklet.js), following the cabin's levels and the discharges seen;
 * - the airframe in turbulence: a thud, a rattle, a creak at each gust;
 * - the strike (moments.js): a bang inside the cabin, the ears deafened for a few seconds, the
 *   fan dying with the power and starting again as the relays catch;
 * - another aircraft passing close (moments.js): the roar of its engines, rising in pitch as it
 *   comes and falling as it goes, from where it is;
 * - the orb (moments.js): an unsteady electric hum, a hiss and crackle, from where it is;
 * - the creature (moments.js): when it shows close, a long, very low moan reaches the cabin
 *   seconds after the flash, from where it is;
 * - the radio (radio.js): from the second storm on, static that crackles with the lightning, and
 *   now and then a voice in it, too broken to make out;
 * - thunder: every flash's channel heard part by part as its sound arrives (thunder.js,
 *   thundersynth.js), through the canopy, from where each part is (it stays there as the head
 *   turns), with the echoes of the clouds and the sea; as strong as the flash was bright: far
 *   ones rumble, close ones crack and shake the cabin;
 * all into a limiter. Browsers let sound start only after a click or a key: start() then fades
 * it in. The mix is also offered as a MediaStream (window.__audioStream) for the recording tools.
 */

// Levels (linear gains); see the measurements in docs/HANDOVER.md.
const MIX = Object.freeze({ master: 0.8, wind: 0.12, whistle: 0.9, fan: 0.008, engine: 0.013, weather: 0.2, knocks: 0.44, thunder: 42, jet: 3.5, orb: 0.05, radio: 1 });

// Thunder as heard (thundersynth.js gives it in first-order ambisonics): each ear a virtual
// microphone looking its way, omni + side * (the head's axis . direction); and the echoes, a
// convolver on W (matched to the four-line network of the second version, within 1 dB).
const DECODE = Object.freeze({ omni: 0.6, side: 0.45, echoes: 0.25 });

// The air's slow wandering: time constants (s) of random walks in -1..1.
const WANDER = Object.freeze({ level: 4, tilt: 7, rpm: 10 });

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

/**
 * Fills a looping buffer: next() gives the samples one after another; the start is cross-faded
 * with what would have followed the end, so the loop has no seam.
 */
function loopBuffer(ctx, channels, seconds, sr, fade, makeNext) {
  const n = Math.floor(seconds * sr);
  const f = Math.floor(fade * sr);
  const buffer = ctx.createBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) {
    const next = makeNext(c);
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = next();
    for (let i = 0; i < f; i++) d[i] = d[i] * (i / f) + next() * (1 - i / f);
  }
  return buffer;
}

/** Stereo pink noise (Paul Kellet's filter), the two sides independent, RMS about 0.25. */
function pinkNoise(ctx, seconds, seed) {
  const rand = rng(seed);
  return loopBuffer(ctx, 2, seconds, ctx.sampleRate, 0.05, () => {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    return () => {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
      return v;
    };
  });
}

/**
 * Smooth random swings between lo and hi Hz, mono, at a low rate: something to shake a level
 * with. Scaled so that they stay within -1..1 (mostly within ±0.4).
 */
function swings(ctx, seconds, lo, hi, seed) {
  const sr = 8000;
  const rand = rng(seed);
  const kHi = 1 - Math.exp((-2 * Math.PI * hi) / sr);
  const kLo = 1 - Math.exp((-2 * Math.PI * lo) / sr);
  let a = 0;
  let b = 0;
  let slow = 0;
  const next = () => {
    a += (rand() * 2 - 1 - a) * kHi;
    b += (a - b) * kHi;
    slow += (b - slow) * kLo;
    return b - slow;
  };
  for (let i = 0; i < 4 * sr; i++) next(); // settle
  const buffer = loopBuffer(ctx, 1, seconds, sr, 0.5, () => next);
  const d = buffer.getChannelData(0);
  let peak = 1e-9;
  for (const v of d) peak = Math.max(peak, Math.abs(v));
  for (let i = 0; i < d.length; i++) d[i] /= peak;
  return buffer;
}

/** The airframe's sounds in a gust, made once: thuds, rattles of loose things, creaks. */
function knockSounds(ctx) {
  const sr = ctx.sampleRate;
  const rand = rng(31);
  const make = (seconds, fill) => {
    const b = ctx.createBuffer(1, Math.floor(seconds * sr), sr);
    fill(b.getChannelData(0));
    return b;
  };
  const thuds = [52, 61, 70].map(f0 =>
    make(0.4, d => {
      let phase = 0;
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr;
        phase += (2 * Math.PI * f0 * (1 - 0.3 * Math.min(t / 0.3, 1))) / sr;
        lp += ((rand() * 2 - 1) - lp) * 0.04;
        d[i] = (Math.sin(phase) * 0.9 + lp * 1.5) * Math.exp(-t / 0.075) * (1 - Math.exp(-t / 0.003));
      }
    })
  );
  const rattles = [0, 1, 2].map(() =>
    make(0.4, d => {
      const clicks = 6 + Math.floor(rand() * 6);
      for (let k = 0; k < clicks; k++) {
        const at = Math.floor(Math.min(0.32, -Math.log(1 - rand() * 0.95) * 0.08) * sr);
        const f = 2800 + rand() * 3200;
        const a = 0.5 * Math.exp(-at / sr / 0.12) * (0.4 + 0.6 * rand());
        for (let i = 0; i < 0.004 * sr && at + i < d.length; i++) d[at + i] += a * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (0.0008 * sr));
      }
    })
  );
  const creaks = [0, 1].map(() =>
    make(0.8, d => {
      // Stick-slip: the frame grinds in pulses that slow down, each ringing in the structure.
      let t = 0.02;
      while (t < 0.7) {
        const f = 420 - 220 * (t / 0.7) + rand() * 30;
        const a = Math.sin(Math.PI * Math.min(t / 0.7, 1)) * (0.4 + 0.6 * rand());
        const at = Math.floor(t * sr);
        for (let i = 0; i < 0.03 * sr && at + i < d.length; i++) d[at + i] += a * 0.35 * Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / (0.006 * sr));
        t += 1 / (40 - 18 * (t / 0.7) + rand() * 6);
      }
    })
  );
  return { thuds, rattles, creaks };
}

/**
 * The strike as heard inside the cabin, made once: the crack of the channel at the nose, the
 * blast of its shock over the airframe and the boom after it, the current crackling through
 * the airframe, the canopy's frame ringing. And a relay's click.
 */
function strikeSounds(ctx) {
  const sr = ctx.sampleRate;
  const rand = rng(77);
  const n = Math.floor(1.6 * sr);
  const bang = ctx.createBuffer(2, n, sr);
  const modes = [[310, 0.25], [820, 0.12], [1650, 0.06], [2900, 0.04]];
  for (let c = 0; c < 2; c++) {
    const d = bang.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const crack = (rand() * 2 - 1) * Math.exp(-t / 0.0025);
      const x = t / 0.008;
      const blast = t < 0.008 ? (1 - 2 * x) * 1.2 : 0;
      lp += (rand() * 2 - 1 - lp) * 0.02;
      const boom = lp * 6 * Math.exp(-t / 0.18) * (1 - Math.exp(-t / 0.004));
      const sizzle = (rand() < 0.08 ? rand() * 2 - 1 : 0) * Math.exp(-t / 0.05) * 0.8;
      let ring = 0;
      for (const [f, a] of modes) ring += a * Math.sin(2 * Math.PI * f * (c ? 1.012 : 1) * t) * Math.exp(-t / ((0.35 * 300) / f + 0.05));
      d[i] = crack + blast + boom + sizzle + 0.5 * ring * (1 - Math.exp(-t / 0.002));
    }
  }
  const click = ctx.createBuffer(1, Math.floor(0.03 * sr), sr);
  const k = click.getChannelData(0);
  for (let i = 0; i < k.length; i++) {
    const t = i / sr;
    k[i] = (Math.sin(2 * Math.PI * 3100 * t) * 0.6 + (rand() * 2 - 1) * 0.4) * Math.exp(-t / 0.0015) + 0.3 * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t / 0.006);
  }
  return { bang, click };
}

/** solo (capture aid): "cabin", "weather", "knocks" or "thunder" alone. */
export function createAudio({ solo = null } = {}) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  let started = false;
  let ready = false;
  const rand = rng(97);

  // ---- the chain: buses, limiter, output (and a tap for the recording tools) ----------------
  const master = new GainNode(ctx, { gain: 0 });
  // Only the loudest peaks (a close crack of thunder) are held back; what is too quick for the
  // limiter (a strike a hundred metres away) is rounded off below full scale.
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -8, knee: 3, ratio: 20, attack: 0.002, release: 0.3 });
  const curve = new Float32Array(1025);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 4 - 2; // the shaper sees -2..2, halved below
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a < 0.8 ? a : 0.8 + 0.17 * Math.tanh((a - 0.8) / 0.17));
  }
  const clip = new WaveShaperNode(ctx, { curve, oversample: "none" });
  const out = new GainNode(ctx, { gain: 1 });
  // The ears: after the strike's bang everything is dulled for a few seconds, and they ring.
  const hearing = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 20000, Q: 0.5 });
  master.connect(hearing).connect(limiter).connect(new GainNode(ctx, { gain: 0.5 })).connect(clip).connect(out).connect(ctx.destination);
  const ringing = new OscillatorNode(ctx, { frequency: 6300 });
  const ringingLevel = new GainNode(ctx, { gain: 0 });
  ringing.connect(ringingLevel).connect(limiter);
  ringing.start();
  const tap = ctx.createMediaStreamDestination();
  out.connect(tap);
  const cabin = new GainNode(ctx, { gain: 1 });
  cabin.connect(master);
  // For listening to one part alone.
  const only = part => (solo && solo !== part ? 0 : 1);
  const cabinOnly = new GainNode(ctx, { gain: only("cabin") });
  cabinOnly.connect(cabin);
  // Sound from outside comes through the canopy, a bubble of acrylic: it takes a little more of
  // each octave above a couple of kilohertz, and booms a little in the lows.
  const canopy = new BiquadFilterNode(ctx, { type: "highshelf", frequency: 1800, gain: -4 });
  canopy
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 7000, Q: 0.5 }))
    .connect(new BiquadFilterNode(ctx, { type: "peaking", frequency: 100, Q: 1, gain: 2 }))
    .connect(master);
  // Thunder comes as W, X, Y, Z (the world's axes) and is decoded each frame for the way the head
  // faces (update), so it is heard where the lightning was however the head turns.
  const outside = new GainNode(ctx, { gain: MIX.thunder * only("thunder"), channelCount: 4, channelCountMode: "explicit", channelInterpretation: "discrete" });
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 4 });
  outside.connect(split);
  const ears = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  ears.connect(canopy);
  const decode = [0, 1].map(side => {
    const sum = new GainNode(ctx, { channelCount: 1, channelCountMode: "explicit" });
    sum.connect(ears, 0, side);
    return [0, 1, 2, 3].map(k => {
      const g = new GainNode(ctx, { gain: k === 0 ? DECODE.omni : 0 });
      split.connect(g, k);
      g.connect(sum);
      return g;
    });
  });
  // The echoes from the clouds and the sea, from all around.
  const response = echoResponse(ctx.sampleRate);
  const echoes = new ConvolverNode(ctx, { normalize: false });
  const responseBuffer = ctx.createBuffer(2, response[0].length, ctx.sampleRate);
  response.forEach((d, c) => responseBuffer.copyToChannel(d, c));
  echoes.buffer = responseBuffer;
  split.connect(new GainNode(ctx, { gain: DECODE.echoes }), 0).connect(echoes).connect(canopy);

  // ---- the air on the canopy ---------------------------------------------------------------
  // Flow noise is never steady. The big eddies swell and fade its lows over seconds; the small
  // ones that make its hiss come and go in bursts; rough air buffets the canopy a few times a
  // second; and as the aircraft's speed and attitude wander, so do the sound's level and colour.
  // The rushing air is split three ways (the parts add up to the whole), each part shaken by its
  // own slow random swings, deeper in rough air.
  const windLevel = new GainNode(ctx, { gain: MIX.wind });
  const windSwell = new GainNode(ctx, { gain: 1 });
  windLevel.connect(windSwell).connect(cabinOnly);
  const air = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, 8, 7), loop: true });
  const bed = air
    .connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 58, Q: 0.7 }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2000, Q: 0.55 }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6000, Q: 0.5 }));
  air.start();
  const lows = bed.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 300, Q: 0.6 }));
  const highs = bed.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 1200, Q: 0.6 }));
  const mids = new GainNode(ctx, { gain: 1 });
  bed.connect(mids);
  lows.connect(new GainNode(ctx, { gain: -1 })).connect(mids);
  highs.connect(new GainNode(ctx, { gain: -1 })).connect(mids);
  // Random swings added to a level (an AudioParam); returns their depth (a gain, 0 at first).
  const shake = (param, seconds, lo, hi, seed) => {
    const s = new AudioBufferSourceNode(ctx, { buffer: swings(ctx, seconds, lo, hi, seed), loop: true });
    const depth = new GainNode(ctx, { gain: 0 });
    s.connect(depth).connect(param);
    s.start();
    return depth;
  };
  // Each part: its swings (Hz) and their depth in calm air and in rough air.
  const parts = [
    { from: lows, lo: 0.15, hi: 3, calm: 0.7, rough: 1.1, seconds: 23, seed: 11 },
    { from: mids, lo: 0.3, hi: 5, calm: 0.55, rough: 0.95, seconds: 19, seed: 12 },
    { from: highs, lo: 0.6, hi: 9, calm: 0.45, rough: 0.8, seconds: 17, seed: 13 }
  ].map(p => {
    const gain = new GainNode(ctx, { gain: 1 });
    p.from.connect(gain).connect(windLevel);
    return { ...p, gain, depth: shake(gain.gain, p.seconds, p.lo, p.hi, p.seed) };
  });
  // Buffeting in rough air: the lows thump a few times a second.
  const buffet = shake(parts[0].gain.gain, 13, 2, 12, 14);
  // A seam of the canopy whistles faintly when a strong gust loads it (on the right).
  const WHISTLE = 2150;
  const whistle = new BiquadFilterNode(ctx, { type: "bandpass", frequency: WHISTLE, Q: 30, channelCount: 1, channelCountMode: "explicit" });
  const whistleLevel = new GainNode(ctx, { gain: 0 });
  air.connect(whistle).connect(whistleLevel).connect(new StereoPannerNode(ctx, { pan: 0.35 })).connect(cabinOnly);

  // ---- the fan behind the cabin and its engine ----------------------------------------------
  // Their speed wanders a little (rpm: a fraction of it), sags for a moment when a gust loads
  // them (load), and the blades chop the air unevenly.
  // When the power fails they run down (spin) and fall silent (fanPower).
  const rpm = new ConstantSourceNode(ctx, { offset: 0 });
  const load = new ConstantSourceNode(ctx, { offset: 0 });
  const spin = new ConstantSourceNode(ctx, { offset: 0 });
  rpm.start();
  load.start();
  spin.start();
  const bySpeed = (f, param) => {
    const hz = new GainNode(ctx, { gain: f });
    rpm.connect(hz);
    load.connect(hz);
    spin.connect(hz);
    hz.connect(param);
  };
  // Both are behind the cabin: heard from there as the head turns (update).
  const behind = new StereoPannerNode(ctx, { pan: 0 });
  const fanPower = new GainNode(ctx, { gain: 1 });
  fanPower.connect(behind).connect(cabinOnly);
  const fanOut = new GainNode(ctx, { gain: MIX.fan });
  fanOut.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 800, Q: 0.5 })).connect(fanPower);
  shake(fanOut.gain, 11, 1, 9, 21).gain.value = 0.25 * MIX.fan;
  [108, 216, 324, 432, 540].forEach((f, i) => {
    const o = new OscillatorNode(ctx, { frequency: f });
    bySpeed(f, o.frequency);
    o.connect(new GainNode(ctx, { gain: [1, 0.5, 0.3, 0.16, 0.08][i] })).connect(fanOut);
    o.start();
  });
  const engine = new OscillatorNode(ctx, { type: "sawtooth", frequency: 46 });
  bySpeed(46, engine.frequency);
  engine
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 140, Q: 0.7 }))
    .connect(new GainNode(ctx, { gain: MIX.engine }))
    .connect(fanPower);
  engine.start();
  const walks = { level: 0, tilt: 0, rpm: 0 };
  let lastWalk = null;
  // One step of a random walk that keeps within about ±1 (an Ornstein-Uhlenbeck process).
  const wander = (v, dt, tau) => Math.max(-1, Math.min(1, v - (v * dt) / tau + (rand() * 2 - 1) * 0.5 * Math.sqrt((6 * dt) / tau)));

  // ---- another aircraft's engines, outside -------------------------------------------------
  // A jet's roar (broadband, centred low), the whine of its fan blades and a low hum, all
  // shifted together by its approach (Doppler), dulled by the air with distance, from its side.
  const jetNoise = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, 6, 41), loop: true });
  const jetWhine = new OscillatorNode(ctx, { type: "sawtooth", frequency: 1850 });
  const jetHum = new OscillatorNode(ctx, { type: "triangle", frequency: 78 });
  const jetAir = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 4000, Q: 0.6 });
  const jetLevel = new GainNode(ctx, { gain: 0 });
  const jetPan = new StereoPannerNode(ctx, { pan: 0 });
  jetNoise.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: 650, Q: 0.45 })).connect(jetAir);
  jetWhine.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: 1850, Q: 9 })).connect(new GainNode(ctx, { gain: 0.06 })).connect(jetAir);
  jetHum.connect(new GainNode(ctx, { gain: 0.12 })).connect(jetAir);
  jetAir.connect(jetLevel).connect(jetPan).connect(new GainNode(ctx, { gain: only("thunder") })).connect(canopy);
  for (const s of [jetNoise, jetWhine, jetHum]) s.start();

  // ---- the orb, outside ----------------------------------------------------------------------
  // An electric hum with a buzz in it, unsteady; a hiss; crackle (played as it goes).
  const orbHum = new OscillatorNode(ctx, { type: "sawtooth", frequency: 94 });
  const orbWobble = new OscillatorNode(ctx, { frequency: 2.7 });
  orbWobble.connect(new GainNode(ctx, { gain: 3 })).connect(orbHum.frequency);
  const orbHiss = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, 5, 77), loop: true });
  const orbLevel = new GainNode(ctx, { gain: 0 });
  const orbPan = new StereoPannerNode(ctx, { pan: 0 });
  orbHum.connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: 380, Q: 0.9 })).connect(new GainNode(ctx, { gain: 0.6 })).connect(orbLevel);
  orbHiss.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 2600, Q: 0.7 })).connect(new GainNode(ctx, { gain: 0.5 })).connect(orbLevel);
  orbLevel.connect(orbPan).connect(new GainNode(ctx, { gain: only("thunder") })).connect(canopy);
  for (const s of [orbHum, orbWobble, orbHiss]) s.start();
  const crackles = [0, 1, 2].map(i => {
    const r = rng(301 + i);
    const n = Math.floor((0.012 + 0.02 * i) * ctx.sampleRate);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let j = 0; j < n; j++) d[j] = (r() * 2 - 1) * Math.exp(-j / (0.15 * n)) * (r() < 0.3 ? 1 : 0.4);
    return b;
  });

  // ---- the creature's moan ------------------------------------------------------------------
  // Three harmonics of a very low voice, sliding down, through the dark air (low-passed), with a
  // slow beat in it; made each time it is heard.
  const moaned = new Set();
  function moan(at, pan, level) {
    const out = new GainNode(ctx, { gain: 0 });
    const air = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 190, Q: 0.8 });
    const beat = new OscillatorNode(ctx, { frequency: 1.1 + 0.4 * rand() });
    const depth = new GainNode(ctx, { gain: 0.35 });
    const swell = new GainNode(ctx, { gain: 0.65 });
    beat.connect(depth).connect(swell.gain);
    air.connect(swell).connect(out).connect(new StereoPannerNode(ctx, { pan })).connect(new GainNode(ctx, { gain: only("thunder") })).connect(canopy);
    const f0 = 29 + 6 * rand();
    const voices = [1, 1.5, 2.02].map((k, i) => {
      const o = new OscillatorNode(ctx, { type: "sawtooth", frequency: f0 * k });
      o.frequency.setValueAtTime(f0 * k, at);
      o.frequency.exponentialRampToValueAtTime(f0 * k * 0.82, at + 6.5);
      o.connect(new GainNode(ctx, { gain: [1, 0.45, 0.25][i] })).connect(air);
      return o;
    });
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(level, at + 1.8);
    out.gain.setTargetAtTime(level * 0.8, at + 1.8, 1.5);
    out.gain.setTargetAtTime(0, at + 4.2, 1.1);
    for (const o of [...voices, beat]) {
      o.start(at);
      o.stop(at + 9);
    }
    voices[0].onended = () => out.disconnect();
  }

  // ---- the radio -------------------------------------------------------------------------------
  const radioBus = new GainNode(ctx, { gain: MIX.radio * only("radio") });
  radioBus.connect(cabin);
  const radio = createRadio(ctx, radioBus, pinkNoise(ctx, 5, 61));
  let radioUntil = null;

  // ---- weather on the glass (once the worklet is loaded) ------------------------------------
  let weather = null;
  const weatherOut = new GainNode(ctx, { gain: MIX.weather * only("weather") });
  weatherOut.connect(cabin);
  ctx.audioWorklet
    .addModule(new URL("./weather.worklet.js", import.meta.url))
    .then(() => {
      weather = new AudioWorkletNode(ctx, "weather", { numberOfInputs: 0, outputChannelCount: [2] });
      weather.connect(weatherOut);
      ready = true;
    })
    .catch(e => console.warn("weather sounds unavailable", e));

  // ---- the airframe and the thunder ---------------------------------------------------------
  const knocks = knockSounds(ctx);
  const strike = strikeSounds(ctx);
  let struck = false;
  // Thunder is made in a worker, at a rate that holds its highs (it has few above 8 kHz).
  const THUNDER_RATE = 24000;
  const worker = new Worker(new URL("./thunder.worker.js", import.meta.url), { type: "module" });
  const jobs = new Map();
  let jobId = 0;
  worker.onmessage = e => {
    const done = jobs.get(e.data.id);
    jobs.delete(e.data.id);
    if (done) done(e.data);
  };
  const synth = job =>
    new Promise(resolve => {
      const id = jobId++;
      jobs.set(id, resolve);
      worker.postMessage({ id, job }, [job.segments.buffer]);
    });
  const play = (buffer, gain, pan, at, bus = cabin) => {
    const s = new AudioBufferSourceNode(ctx, { buffer, playbackRate: 0.9 + 0.2 * rand() });
    s.connect(new GainNode(ctx, { gain: gain * only("knocks") })).connect(new StereoPannerNode(ctx, { pan })).connect(bus);
    s.start(Math.max(at, ctx.currentTime));
    s.onended = () => s.disconnect();
  };

  let offset = 0; // audio time minus journey time
  const toAudio = t => t + offset;
  let gustsUntil = -Infinity;
  let lastFlash = -1;
  let lastFlick = -1;
  let lastFlickThunder = -Infinity;
  let thunders = 0;

  function thunder(event, kind, view, power) {
    if (thunders >= 8) return;
    const r = rng(event.id * 7919 + 13);
    let segments;
    if ((kind === "cg" || kind === "strike" || kind === "spider") && event.bolt) {
      // (A web of spider lightning is heard by its main channel, in coarser steps.)
      segments = kind === "spider" ? finer(event.bolt.filter(s => s.main), 50) : finer(event.bolt, 25);
    } else if (kind === "flick") {
      const p = event.pos;
      const a = r() * Math.PI * 2;
      const half = 400 + 600 * r();
      const d = [Math.cos(a) * half, (r() - 0.5) * half * 0.6, Math.sin(a) * half];
      segments = channelThrough([[p[0] - d[0], p[1] - d[1], p[2] - d[2]], p, [p[0] + d[0], p[1] + d[1], p[2] + d[2]]], r, 50);
    } else {
      const s = event.sources;
      const ext = (q, from, k) => q.map((v, i) => v + (v - from[i]) * k);
      segments = channelThrough([ext(s[0], s[1], 0.4), s[0], s[1], s[2], ext(s[2], s[1], 0.4)], r, 25);
    }
    // As strong as the flash was bright among its kind (strength 0.6..1.4, lightning.js), and
    // a little more or less besides (log-normal, about ±3 dB).
    const energy = power * Math.pow(event.strength ?? 1, 1.5) * Math.exp(0.35 * ((r() + r() + r()) * 2 - 3));
    thunders++;
    synth({
      sampleRate: THUNDER_RATE,
      segments: flatten(segments),
      listener: [view.x, view.alt, view.z],
      strokes: event.strokes.map(s => ({ t: s.t, a: s.a })),
      power: energy
    })
      .then(out => {
        if (!out.channels) return;
        const buffer = ctx.createBuffer(4, out.channels[0].length, THUNDER_RATE);
        out.channels.forEach((d, c) => buffer.copyToChannel(d, c));
        const at = toAudio(event.start + out.delay);
        const near = out.delay * 343;
        if (window.__audioLog) {
          let peak = 0;
          for (const v of out.channels[0]) peak = Math.max(peak, Math.abs(v));
          window.__audioLog.push({ id: event.id, kind, arrive: +(event.start + out.delay).toFixed(2), near: Math.round(near), energy: +energy.toFixed(2), in: +(at - ctx.currentTime).toFixed(2), seconds: +buffer.duration.toFixed(1), peak: +peak.toFixed(4), segments: segments.length });
        }
        const s = new AudioBufferSourceNode(ctx, { buffer });
        s.connect(outside);
        const now = ctx.currentTime;
        if (at >= now) s.start(at);
        else if (now - at < buffer.duration - 0.05) s.start(now, now - at);
        else return;
        s.onended = () => s.disconnect();
        // A close one hits the airframe: a thud, loose things rattle.
        const hit = Math.min(Math.max((1600 - near) / 1100, 0), 1) * Math.min(energy, 1.5);
        if (hit > 0.05 && at >= now) {
          const side = rand() * 0.8 - 0.4;
          play(knocks.thuds[Math.floor(rand() * 3)], MIX.knocks * 0.8 * hit, side, at);
          play(knocks.rattles[Math.floor(rand() * 3)], MIX.knocks * 0.5 * hit, -side, at + 0.03);
          if (hit > 0.4) play(knocks.rattles[Math.floor(rand() * 3)], MIX.knocks * 0.35 * hit, side, at + 0.12 + 0.15 * rand());
        }
      })
      .finally(() => thunders--);
  }

  return {
    /** The mix as a stream, for recordings. */
    stream: tap.stream,
    get started() {
      return started;
    },

    /** Starts the sound (from a click or a key), fading in. */
    start() {
      if (started) return;
      started = true;
      ctx.resume();
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(0, now);
      master.gain.linearRampToValueAtTime(MIX.master, now + 2.5);
    },

    pause(paused) {
      if (!started) return;
      if (paused) ctx.suspend();
      else ctx.resume();
    },

    /**
     * Each frame. view: the journey's view (time, position, axes, cabin); lit: the lightning
     * (flash and flick, with their events); fire: St. Elmo's fire as drawn; gustEvents(t0, t1):
     * the journey's gusts.
     */
    update(view, { lit, fire, gustEvents }) {
      if (!started) return;
      const now = ctx.currentTime;
      offset = now - view.time;
      const cabinLevels = view.cabin;

      if (ready) {
        const p = weather.parameters;
        p.get("rain").value = cabinLevels.rain;
        p.get("hail").value = cabinLevels.hail;
        p.get("corona").value = cabinLevels.elmo;
        p.get("flicker").value = fire ? Math.min(1, fire.light / 2.5) : 0;
      }

      // The air: louder in turbulence and in the storm; its level, colour and the fan's speed
      // wander; rough air shakes it deeper and buffets it.
      const dt = lastWalk === null ? 0 : Math.min(Math.max(now - lastWalk, 0), 0.2);
      lastWalk = now;
      for (const key in walks) walks[key] = wander(walks[key], dt, WANDER[key]);
      const turb = cabinLevels.turb;
      windLevel.gain.setTargetAtTime(MIX.wind * (0.85 + 0.25 * turb + 0.15 * cabinLevels.storm) * (1 + 0.3 * walks.level), now, 0.3);
      parts[0].gain.gain.setTargetAtTime(1 - 0.2 * walks.tilt, now, 0.5);
      parts[2].gain.gain.setTargetAtTime(1 + 0.4 * walks.tilt, now, 0.5);
      for (const p of parts) p.depth.gain.setTargetAtTime(p.calm + (p.rough - p.calm) * turb, now, 0.5);
      buffet.gain.setTargetAtTime(0.6 * Math.pow(turb, 1.5), now, 0.3);
      rpm.offset.setTargetAtTime(0.012 * walks.rpm, now, 0.8);

      // The fan and the engine behind the cabin, to the side the head has turned from.
      const q = view.qAircraft;
      const back = [2 * (q.x * q.z + q.w * q.y), 2 * (q.y * q.z - q.w * q.x), 1 - 2 * (q.x * q.x + q.y * q.y)];
      behind.pan.setTargetAtTime(0.7 * (back[0] * view.right.x + back[1] * view.right.y + back[2] * view.right.z), now, 0.05);

      // Thunder heard as the head now faces: left ear omni - side * (right . XYZ), right ear +.
      const ear = [view.right.x, view.right.y, view.right.z];
      for (let k = 1; k < 4; k++) {
        decode[0][k].gain.setTargetAtTime(-DECODE.side * ear[k - 1], now, 0.02);
        decode[1][k].gain.setTargetAtTime(DECODE.side * ear[k - 1], now, 0.02);
      }

      // Gusts a moment ahead: the air swells, the airframe thuds, rattles, creaks; a strong one
      // makes a seam whistle.
      // Another aircraft passing: heard where it was when the sound now arriving left it.
      const tr = view.traffic;
      // (The twin, moments.js, makes no sound at all.)
      if (tr && tr.on && tr.where && tr.kind !== "twin") {
        const me = [view.x, view.alt, view.z];
        let p = tr.where(view.time);
        for (let k = 0; k < 2; k++) p = tr.where(view.time - Math.hypot(p[0] - me[0], p[1] - me[1], p[2] - me[2]) / 343);
        const rel = [p[0] - me[0], p[1] - me[1], p[2] - me[2]];
        const dist = Math.max(Math.hypot(...rel), 1);
        const mine = view.velocity || [0, 0, 0];
        const away = ((tr.velocity[0] - mine[0]) * rel[0] + (tr.velocity[1] - mine[1]) * rel[1] + (tr.velocity[2] - mine[2]) * rel[2]) / dist;
        const shift = 343 / (343 + away);
        jetNoise.playbackRate.setTargetAtTime(shift, now, 0.05);
        jetWhine.frequency.setTargetAtTime(1850 * shift, now, 0.05);
        jetHum.frequency.setTargetAtTime(78 * shift, now, 0.05);
        jetAir.frequency.setTargetAtTime(600 + 5400 * Math.exp(-dist / 350), now, 0.05);
        jetLevel.gain.setTargetAtTime((MIX.jet * 60) / Math.max(dist, 30), now, 0.05);
        jetPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, (rel[0] * view.right.x + rel[1] * view.right.y + rel[2] * view.right.z) / dist)), now, 0.05);
      } else {
        jetLevel.gain.setTargetAtTime(0, now, 0.3);
      }

      // The orb: heard from where it is, less once it is in cloud; crackling now and then.
      const orb = view.orb;
      if (orb && orb.on) {
        const dist = Math.max(orb.pos.length(), 3);
        const k = Math.min(1, orb.light.z / ORB.power) * (orb.inside > 0 ? 0.3 : 1);
        const pan = Math.max(-1, Math.min(1, orb.pos.dot(view.right) / dist));
        orbLevel.gain.setTargetAtTime((MIX.orb * 20 * k) / dist, now, 0.1);
        orbPan.pan.setTargetAtTime(pan, now, 0.05);
        if (rand() < dt * 6 * k) play(crackles[Math.floor(rand() * 3)], (MIX.orb * 60 * k) / dist, pan, now, canopy);
      } else {
        orbLevel.gain.setTargetAtTime(0, now, 0.3);
      }

      // The creature, close: its moan, as long after the flash as sound takes to come.
      const cr = view.creature;
      if (cr && cr.on && cr.world) {
        CREATURE.forEach((c, i) => {
          if (moaned.has(i) || c.size <= 0 || c.along > 4000 || view.time < c.flashes[0] || view.time > c.until) return;
          moaned.add(i);
          const dist = Math.hypot(cr.pos.x, cr.pos.y - view.alt, cr.pos.z);
          const pan = Math.max(-1, Math.min(1, (cr.pos.x * view.right.x + cr.pos.z * view.right.z) / Math.max(Math.hypot(cr.pos.x, cr.pos.z), 1)));
          moan(Math.max(toAudio(c.flashes[0] + dist / 343), now), pan, 0.35 * Math.min(1, 2500 / dist));
        });
      }

      // The radio: alive from the second storm on, with its calls.
      radio.set(view.time > RADIO.on ? 1 : 0, now);
      if (radioUntil === null) radioUntil = view.time;
      if (view.time + 0.4 > radioUntil) {
        for (const c of radioCalls(radioUntil, view.time + 0.4)) radio.call(Math.max(toAudio(c), now));
        radioUntil = view.time + 0.4;
      }

      // The strike: the bang, the ears, the power gone and back.
      if (!struck && view.time >= STRIKE.t - 0.25 && view.time < STRIKE.t + 1) {
        struck = true;
        const at = Math.max(toAudio(STRIKE.t), now);
        play(strike.bang, 1.6, 0, at);
        hearing.frequency.setValueAtTime(20000, at);
        hearing.frequency.setTargetAtTime(600, at + 0.004, 0.01);
        hearing.frequency.setTargetAtTime(20000, at + 0.7, 1.5);
        ringingLevel.gain.setTargetAtTime(0.006 * only("knocks"), at + 0.05, 0.2);
        ringingLevel.gain.setTargetAtTime(0, at + 1, 2.8);
        fanPower.gain.setTargetAtTime(0, at + 0.05, 0.9);
        spin.offset.setTargetAtTime(-0.7, at + 0.05, 1.3);
        const back = toAudio(STRIKE.t + STRIKE.dark + STRIKE.flicker);
        fanPower.gain.setTargetAtTime(1, back, 0.7);
        spin.offset.setTargetAtTime(0, back, 0.9);
        for (const c of catchTimes()) play(strike.click, 0.35, 0.25, toAudio(c));
      }

      const ahead = view.time + 0.15;
      if (gustEvents && ahead > gustsUntil) {
        const from = Math.max(gustsUntil, view.time - 0.05);
        for (const g of gustEvents(from, ahead)) {
          const at = Math.max(toAudio(g.time), now);
          const a = Math.min(g.amp, 1);
          windSwell.gain.setTargetAtTime(1 + 0.8 * a, at, 0.03);
          windSwell.gain.setTargetAtTime(1, at + 0.12, 0.35);
          load.offset.setTargetAtTime(-0.025 * a, at, 0.08);
          load.offset.setTargetAtTime(0, at + 0.25, 0.7);
          play(knocks.thuds[Math.floor(rand() * 3)], MIX.knocks * a * (g.drop ? 1 : 0.7), rand() * 0.6 - 0.3, at);
          if (rand() < 0.6) play(knocks.rattles[Math.floor(rand() * 3)], MIX.knocks * 0.5 * a, rand() * 1.2 - 0.6, at + 0.02);
          if (rand() < 0.25) play(knocks.creaks[Math.floor(rand() * 2)], MIX.knocks * 0.4 * a, rand() * 1.4 - 0.7, at + 0.05);
          if (a > 0.45 && rand() < 0.6) {
            whistleLevel.gain.setTargetAtTime(MIX.whistle * (a - 0.35), at + 0.05, 0.1);
            whistleLevel.gain.setTargetAtTime(0, at + 0.35 + 0.5 * rand(), 0.4);
            whistle.frequency.setTargetAtTime(WHISTLE * (1.03 + 0.05 * a), at + 0.05, 0.15);
            whistle.frequency.setTargetAtTime(WHISTLE, at + 0.5, 0.6);
          }
        }
        gustsUntil = ahead;
      }

      // Thunder for each new flash, and now and then for the lesser lightning far away.
      const f = lit && lit.flash;
      if (f && f.event && f.event.id !== lastFlash) {
        lastFlash = f.event.id;
        // (The strike is mostly its bang, in the cabin; its channel rolls on outside, quieter.)
        thunder(f.event, f.event.kind, view, { ic: 0.6, strike: 0.15 }[f.event.kind] ?? 1);
        // The radio hears it at once.
        radio.sferic(Math.max(toAudio(f.event.start ?? view.time), now), f.event.strength ?? 1);
      }
      const k = lit && lit.flick;
      if (k && k.event && k.event.id !== lastFlick) {
        lastFlick = k.event.id;
        if (view.time - lastFlickThunder > 1.4) {
          lastFlickThunder = view.time;
          thunder(k.event, "flick", view, 0.5);
        }
      }
    }
  };
}
