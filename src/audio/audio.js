import { channelThrough, finer, flatten } from "./thunder.js";

/**
 * The sound of the night journey, all made in the browser (Web Audio):
 * - the cabin: the air rushing over the canopy (shaped like the cockpit recording the owner gave:
 *   even from 63 Hz to 2 kHz, falling steeply above), the fan behind the cabin and its engine;
 * - the weather on the glass: rain, hail and St. Elmo's fire (an AudioWorklet, see
 *   weather.worklet.js), following the cabin's levels and the discharges seen;
 * - the airframe in turbulence: a thud, a rattle, a creak at each gust;
 * - thunder: every flash's channel heard part by part as its sound arrives (thunder.js), through
 *   the canopy (muffled), from its side;
 * all into a limiter. Browsers let sound start only after a click or a key: start() then fades
 * it in. The mix is also offered as a MediaStream (window.__audioStream) for the recording tools.
 */

// Levels (linear gains); see the measurements in docs/HANDOVER.md.
const MIX = Object.freeze({ master: 0.9, wind: 0.22, fan: 0.012, engine: 0.02, weather: 0.32, knocks: 0.35, thunder: 15 });

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

/** Stereo pink noise (Paul Kellet's filter), the two sides independent, RMS about 0.25. */
function pinkNoise(ctx, seconds) {
  const n = Math.floor(seconds * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, n, ctx.sampleRate);
  const rand = rng(7);
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    // Loop seam: cross-fade the last 50 ms into the start.
    const f = Math.floor(0.05 * ctx.sampleRate);
    for (let i = 0; i < f; i++) d[i] = d[i] * (i / f) + d[n - f + i] * (1 - i / f);
  }
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

/** solo (capture aid): "cabin", "weather", "knocks" or "thunder" alone. */
export function createAudio({ solo = null } = {}) {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const sr = ctx.sampleRate;
  let started = false;
  let ready = false;

  // ---- the chain: buses, limiter, output (and a tap for the recording tools) ----------------
  const master = new GainNode(ctx, { gain: 0 });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -10, knee: 6, ratio: 12, attack: 0.002, release: 0.3 });
  master.connect(limiter).connect(ctx.destination);
  const tap = ctx.createMediaStreamDestination();
  limiter.connect(tap);
  const cabin = new GainNode(ctx, { gain: 1 });
  cabin.connect(master);
  // For listening to one part alone.
  const only = part => (solo && solo !== part ? 0 : 1);
  const cabinOnly = new GainNode(ctx, { gain: only("cabin") });
  cabinOnly.connect(cabin);
  // Sound from outside comes through the glass and the airframe: muffled, the canopy booming a
  // little in the lows.
  const outside = new GainNode(ctx, { gain: MIX.thunder * only("thunder") });
  outside
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1700, Q: 0.6 }))
    .connect(new BiquadFilterNode(ctx, { type: "peaking", frequency: 110, Q: 1.1, gain: 4 }))
    .connect(master);

  // ---- the air on the canopy ---------------------------------------------------------------
  const wind = new AudioBufferSourceNode(ctx, { buffer: pinkNoise(ctx, 8), loop: true });
  const windLevel = new GainNode(ctx, { gain: MIX.wind });
  const windSwell = new GainNode(ctx, { gain: 1 });
  wind
    .connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 58, Q: 0.7 }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2000, Q: 0.55 }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6000, Q: 0.5 }))
    .connect(windLevel)
    .connect(windSwell)
    .connect(cabinOnly);
  wind.start();

  // ---- the fan behind the cabin and its engine ----------------------------------------------
  const fanOut = new GainNode(ctx, { gain: MIX.fan });
  fanOut.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 800, Q: 0.5 })).connect(cabinOnly);
  const wobble = new OscillatorNode(ctx, { frequency: 0.23 });
  const wobbleDepth = new GainNode(ctx, { gain: 0.7 }); // Hz
  wobble.connect(wobbleDepth);
  [108, 216, 324, 432, 540].forEach((f, i) => {
    const o = new OscillatorNode(ctx, { frequency: f });
    const g = new GainNode(ctx, { gain: [1, 0.5, 0.3, 0.16, 0.08][i] });
    wobbleDepth.connect(o.frequency);
    o.connect(g).connect(fanOut);
    o.start();
  });
  const engine = new OscillatorNode(ctx, { type: "sawtooth", frequency: 46 });
  engine
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 140, Q: 0.7 }))
    .connect(new GainNode(ctx, { gain: MIX.engine }))
    .connect(cabinOnly);
  wobble.start();
  engine.start();

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
  const rand = rng(97);
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
    if (kind === "cg" && event.bolt) {
      segments = finer(event.bolt, 25);
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
    thunders++;
    synth({
      sampleRate: THUNDER_RATE,
      segments: flatten(segments),
      listener: [view.x, view.alt, view.z],
      right: [view.right.x, view.right.y, view.right.z],
      strokes: event.strokes.map(s => ({ t: s.t, a: s.a })),
      power
    })
      .then(out => {
        if (!out.left) return;
        const buffer = ctx.createBuffer(2, out.left.length, THUNDER_RATE);
        buffer.copyToChannel(out.left, 0);
        buffer.copyToChannel(out.right, 1);
        const res = { buffer, delay: out.delay };
        const at = toAudio(event.start + res.delay);
        if (window.__audioLog) {
          let peak = 0;
          for (let c = 0; c < 2; c++) for (const v of res.buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
          window.__audioLog.push({ id: event.id, kind, delay: +res.delay.toFixed(2), in: +(at - ctx.currentTime).toFixed(2), seconds: +res.buffer.duration.toFixed(1), peak: +peak.toFixed(4), segments: segments.length });
        }
        const s = new AudioBufferSourceNode(ctx, { buffer: res.buffer });
        s.connect(outside);
        const now = ctx.currentTime;
        if (at >= now) s.start(at);
        else if (now - at < res.buffer.duration - 0.05) s.start(now, now - at);
        else return;
        s.onended = () => s.disconnect();
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
      // The air is louder in turbulence and in the storm.
      windLevel.gain.setTargetAtTime(MIX.wind * (0.85 + 0.25 * cabinLevels.turb + 0.15 * cabinLevels.storm), now, 0.3);

      // Gusts a moment ahead: the air swells, the airframe thuds, rattles, creaks.
      const ahead = view.time + 0.15;
      if (gustEvents && ahead > gustsUntil) {
        const from = Math.max(gustsUntil, view.time - 0.05);
        for (const g of gustEvents(from, ahead)) {
          const at = toAudio(g.time);
          const a = Math.min(g.amp, 1);
          windSwell.gain.setTargetAtTime(1 + 0.6 * a, Math.max(at, now), 0.03);
          windSwell.gain.setTargetAtTime(1, Math.max(at, now) + 0.12, 0.35);
          play(knocks.thuds[Math.floor(rand() * 3)], MIX.knocks * a * (g.drop ? 1 : 0.7), rand() * 0.6 - 0.3, at);
          if (rand() < 0.6) play(knocks.rattles[Math.floor(rand() * 3)], MIX.knocks * 0.5 * a, rand() * 1.2 - 0.6, at + 0.02);
          if (rand() < 0.25) play(knocks.creaks[Math.floor(rand() * 2)], MIX.knocks * 0.4 * a, rand() * 1.4 - 0.7, at + 0.05);
        }
        gustsUntil = ahead;
      }

      // Thunder for each new flash, and now and then for the lesser lightning far away.
      const f = lit && lit.flash;
      if (f && f.event && f.event.id !== lastFlash) {
        lastFlash = f.event.id;
        thunder(f.event, f.event.kind, view, f.event.kind === "cg" ? 1 : 0.6);
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
