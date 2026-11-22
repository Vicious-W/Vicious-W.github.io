/**
 * The radio (PLAN.md 5.4: in the later storms, calls in the radio's noise). From the second
 * storm on, the radio in the cabin hisses with static that crackles with every flash, and now
 * and then a voice comes through it, too broken to make out: a few phrases with the rise and
 * fall of speech, its strength fading in and out, cut off by the squelch. Every call begins the
 * same way, as if calling the same name. All made with nodes: a buzzing source through three
 * formant filters that move from vowel to vowel, bursts of noise for the consonants, all through
 * a radio's narrow band and a small speaker, driven a little hard.
 */

// Formants of vowels (Hz): a, e, i, o, u, and the neutral one.
const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240], [500, 1500, 2500]];
// Levels (linear): the static as it idles, as the squelch opens, its burst as it closes; the voice.
const LEVEL = Object.freeze({ idle: 0.016, open: 0.03, burst: 0.09, voice: 0.11, fric: 0.05 });

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

/** Static: a hiss with pops and crackle in it, mono, looping (made once). */
function staticBuffer(ctx, seconds, seed) {
  const rand = rng(seed);
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buffer = ctx.createBuffer(1, n, sr);
  const d = buffer.getChannelData(0);
  let lp = 0;
  let pop = 0;
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1;
    lp += (w - lp) * 0.35;
    // Pops, a few a second, and now and then a run of crackle.
    if (rand() < 9 / sr) pop = (rand() < 0.5 ? -1 : 1) * (0.6 + rand());
    if (rand() < 0.4 / sr) pop = (rand() < 0.5 ? -1 : 1) * 2.2;
    pop *= 0.985;
    d[i] = 0.5 * lp + 0.25 * w + pop;
  }
  // No seam where it loops.
  const f = Math.floor(0.05 * sr);
  for (let i = 0; i < f; i++) d[i] = d[i] * (i / f) + d[n - f + i] * (1 - i / f);
  return buffer;
}

function driveCurve(k) {
  const c = new Float32Array(1025);
  for (let i = 0; i < c.length; i++) {
    const x = (i / (c.length - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

/**
 * The radio, into bus. noise: a looping noise buffer (for the consonants). update(view, now,
 * toAudio): each frame; call(at): a call at audio time at; sferic(at, k): a flash's crackle.
 */
export function createRadio(ctx, bus, noise) {
  // The set: its band, its small speaker over to the left, a little overdriven.
  const input = new GainNode(ctx, { gain: 1 });
  const level = new GainNode(ctx, { gain: 0 });
  input
    .connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 380, Q: 0.7 }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2900, Q: 0.9 }))
    .connect(new BiquadFilterNode(ctx, { type: "peaking", frequency: 1700, Q: 1.2, gain: 5 }))
    .connect(new WaveShaperNode(ctx, { curve: driveCurve(2.4) }))
    .connect(level)
    .connect(new StereoPannerNode(ctx, { pan: -0.3 }))
    .connect(bus);

  // The static.
  const hiss = new AudioBufferSourceNode(ctx, { buffer: staticBuffer(ctx, 6, 53), loop: true });
  const hissLevel = new GainNode(ctx, { gain: LEVEL.idle });
  hiss.connect(hissLevel).connect(input);
  hiss.start();

  // The voice: a buzz through three formants, and the noise of consonants; how strong it comes
  // through (fade) wanders.
  const glottis = new OscillatorNode(ctx, { type: "sawtooth", frequency: 120 });
  const voice = new GainNode(ctx, { gain: 0 });
  const formants = [0, 1, 2].map(i => {
    const f = new BiquadFilterNode(ctx, { type: "bandpass", frequency: VOWELS[5][i], Q: [5, 8, 10][i] });
    glottis.connect(f).connect(new GainNode(ctx, { gain: [1.0, 0.75, 0.4][i] })).connect(voice);
    return f;
  });
  const breath = new AudioBufferSourceNode(ctx, { buffer: noise, loop: true, playbackRate: 0.93 });
  const fric = new GainNode(ctx, { gain: 0 });
  const fricBand = new BiquadFilterNode(ctx, { type: "bandpass", frequency: 3000, Q: 1.3 });
  breath.connect(fricBand).connect(fric);
  const fade = new GainNode(ctx, { gain: 0 });
  voice.connect(fade);
  fric.connect(fade);
  fade.connect(input);
  glottis.start();
  breath.start();

  let busyUntil = 0;
  let calls = 0;

  /** Speech-like syllables from audio time t, in the voice of pitch base: returns its end. */
  function phrase(r, t, base, words, last) {
    const total = words.reduce((a, w) => a + w, 0);
    let k = 0;
    for (const syllables of words) {
      for (let s = 0; s < syllables; s++, k++) {
        const v = VOWELS[Math.floor(r() * VOWELS.length)];
        const dur = 0.08 + r() * 0.15;
        // A consonant first, often: a hiss or a burst.
        if (r() < 0.55) {
          const len = 0.03 + r() * 0.05;
          fricBand.frequency.setValueAtTime(2200 + r() * 2600, t);
          fric.gain.setTargetAtTime(LEVEL.fric * (0.5 + r()), t, 0.006);
          fric.gain.setTargetAtTime(0, t + len, 0.012);
          t += len * 0.8;
        }
        // The vowel: formants glide to it; the pitch falls through the phrase, the stressed
        // syllables a little higher, and a question rises at its end.
        for (let i = 0; i < 3; i++) formants[i].frequency.setTargetAtTime(v[i] * (0.93 + 0.14 * r()), t, 0.02);
        const along = k / Math.max(total - 1, 1);
        let pitch = base * (1.15 - 0.3 * along) * (r() < 0.3 ? 1.12 : 1);
        if (last && along > 0.8 && r() < 0.5) pitch *= 1.25;
        glottis.frequency.setTargetAtTime(pitch, t, 0.03);
        voice.gain.setTargetAtTime(LEVEL.voice * (0.7 + 0.3 * r()), t, 0.012);
        voice.gain.setTargetAtTime(0, t + dur, 0.022);
        t += dur + 0.02;
      }
      t += 0.04 + r() * 0.14;
    }
    return t;
  }

  return {
    /** A call at audio time at (if none is under way): returns when it ends. */
    call(at) {
      if (at < busyUntil) return busyUntil;
      const r = rng(1009 + 7919 * calls++);
      // The squelch opens.
      let t = at;
      hissLevel.gain.setTargetAtTime(LEVEL.open, t, 0.01);
      t += 0.25 + 0.3 * r();
      const base = 104 + 22 * r();
      const phrases = 2 + Math.floor(r() * 3);
      for (let p = 0; p < phrases; p++) {
        // The first phrase is always the same: a name, called.
        const words = p === 0 ? [2, 1, 2] : Array.from({ length: 2 + Math.floor(r() * 4) }, () => 1 + Math.floor(r() * 3));
        const pr = p === 0 ? rng(424242) : r;
        // How strongly it comes through, wandering as it goes.
        fade.gain.setTargetAtTime(0.25 + 0.75 * r(), t, 0.15);
        const end = phrase(pr, t, base, words, p === phrases - 1);
        fade.gain.setTargetAtTime(0.2 + 0.8 * r(), (t + end) / 2, 0.2);
        t = end + 0.35 + 0.6 * r();
      }
      // The squelch closes: a burst of static, then the hiss again.
      hissLevel.gain.setTargetAtTime(LEVEL.burst, t, 0.004);
      hissLevel.gain.setTargetAtTime(LEVEL.idle, t + 0.16, 0.03);
      fade.gain.setTargetAtTime(0, t, 0.02);
      busyUntil = t + 0.5;
      return busyUntil;
    },

    /** A flash's crackle in the static (lightning is heard on the radio before its thunder). */
    sferic(at, k) {
      if (at < busyUntil) return;
      hissLevel.gain.setTargetAtTime(LEVEL.idle + 0.05 * Math.min(k, 1.5), at, 0.003);
      hissLevel.gain.setTargetAtTime(LEVEL.idle, at + 0.05 + 0.1 * Math.min(k, 1), 0.05);
    },

    /** How loud the set is (0: off), now. */
    set(on, now) {
      level.gain.setTargetAtTime(on, now, 0.8);
    }
  };
}
