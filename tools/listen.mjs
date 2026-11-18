// Listens to the night journey: runs it live from t with the sound on, captures the mix (the
// page's window.__audioStream) as raw samples, and reports what it sounds like in numbers:
// octave-band levels (dB relative to the loudest band, as in the reference table of
// docs/HANDOVER.md, and in dBFS), the loudness over time and the peaks. Saves a WAV too.
//
//   node tools/listen.mjs --query="night&t=380" [--seconds=10] [--name=clip] [--url=...] [--headed]
import fs from "node:fs";
import path from "node:path";
import { CAPTURES, gpuName, launch, parseArgs, serve, watchConsole } from "./lib.mjs";

const { options } = parseArgs();
const seconds = Number(options.seconds || 10);
const name = String(options.name || "clip");
const out = path.join(CAPTURES, "audio");
fs.mkdirSync(out, { recursive: true });

const site = await serve(options);
const browser = await launch(options);
const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
const issues = watchConsole(page);
await page.goto(`${site.base}/?sound&${options.query || "night"}`, { waitUntil: "commit", timeout: 600000 });
console.log(`GPU: ${await gpuName(page)}`);
await page.waitForFunction(() => (window.__sky?.sky.frame || 0) > 5 && window.__audioStream, null, { timeout: 600000, polling: 100 });

const result = await page.evaluate(async seconds => {
  const ac = new AudioContext();
  await ac.resume();
  const src = ac.createMediaStreamSource(window.__audioStream);
  const sp = ac.createScriptProcessor(4096, 2, 2);
  const chunks = [[], []];
  let frames = 0;
  sp.onaudioprocess = e => {
    for (let c = 0; c < 2; c++) chunks[c].push(new Float32Array(e.inputBuffer.getChannelData(c)));
    frames += e.inputBuffer.length;
  };
  const mute = ac.createGain();
  mute.gain.value = 0;
  src.connect(sp).connect(mute).connect(ac.destination);
  // Past the fade-in (2.5 s) first.
  await new Promise(r => setTimeout(r, 3000));
  frames = 0;
  chunks[0].length = 0;
  chunks[1].length = 0;
  const t0 = window.__sky.flight.state.time;
  await new Promise(r => setTimeout(r, seconds * 1000));
  sp.disconnect();
  const n = frames;
  const join = list => {
    const a = new Float32Array(n);
    let o = 0;
    for (const c of list) {
      a.set(c.subarray(0, Math.min(c.length, n - o)), o);
      o += c.length;
      if (o >= n) break;
    }
    return a;
  };
  const L = join(chunks[0]);
  const R = join(chunks[1]);
  const sr = ac.sampleRate;

  // Octave bands from an averaged spectrum (Welch, 16384-point FFT).
  const N = 16384;
  const fft = (re, im) => {
    const m = re.length;
    for (let i = 1, j = 0; i < m; i++) {
      let bit = m >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= m; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      for (let i = 0; i < m; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k);
          const wi = Math.sin(ang * k);
          const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k + len / 2] = re[i + k] - xr;
          im[i + k + len / 2] = im[i + k] - xi;
          re[i + k] += xr;
          im[i + k] += xi;
        }
      }
    }
  };
  const power = new Float64Array(N / 2);
  let segs = 0;
  for (let start = 0; start + N <= n; start += N / 2) {
    for (const ch of [L, R]) {
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = ch[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
      fft(re, im);
      for (let i = 0; i < N / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i];
      segs++;
    }
  }
  const centres = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const bands = centres.map(fc => {
    const lo = fc / Math.SQRT2;
    const hi = fc * Math.SQRT2;
    let e = 0;
    for (let i = 1; i < N / 2; i++) {
      const f = (i * sr) / N;
      if (f >= lo && f < hi) e += power[i];
    }
    return e / Math.max(segs, 1);
  });
  const maxBand = Math.max(...bands);
  const rel = bands.map(e => (e > 0 ? 10 * Math.log10(e / maxBand) : -99));
  // Loudness over time (RMS of both channels, dBFS, every half second) and peaks.
  const step = Math.floor(sr / 2);
  const rms = [];
  let peak = 0;
  for (let s = 0; s + step <= n; s += step) {
    let e = 0;
    for (let i = s; i < s + step; i++) {
      e += L[i] * L[i] + R[i] * R[i];
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    rms.push(10 * Math.log10(e / (2 * step) + 1e-12));
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += L[i] * L[i] + R[i] * R[i];
  // 16-bit WAV.
  const wav = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  wav.setUint32(4, 36 + n * 4, true);
  str(8, "WAVEfmt ");
  wav.setUint32(16, 16, true);
  wav.setUint16(20, 1, true);
  wav.setUint16(22, 2, true);
  wav.setUint32(24, sr, true);
  wav.setUint32(28, sr * 4, true);
  wav.setUint16(32, 4, true);
  wav.setUint16(34, 16, true);
  str(36, "data");
  wav.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  const bytes = new Uint8Array(wav.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return {
    sr,
    seconds: n / sr,
    t0,
    centres,
    rel,
    abs: bands.map(e => 10 * Math.log10(e / (segs ? 1 : 1) + 1e-20)),
    rms,
    overall: 10 * Math.log10(total / (2 * n) + 1e-12),
    peak: 20 * Math.log10(peak + 1e-12),
    wav: btoa(bin)
  };
}, seconds);

const file = path.join(out, `${name}.wav`);
fs.writeFileSync(file, Buffer.from(result.wav, "base64"));
console.log(`${name}: t ${result.t0.toFixed(1)}..${(result.t0 + result.seconds).toFixed(1)} s, ${result.sr} Hz, overall ${result.overall.toFixed(1)} dBFS RMS, peak ${result.peak.toFixed(1)} dBFS`);
console.log(`octaves  ${result.centres.map(c => String(c >= 1000 ? `${c / 1000}k` : c).padStart(5)).join("")}`);
console.log(`relative ${result.rel.map(v => v.toFixed(0).padStart(5)).join("")}`);
console.log(`loudness every 0.5 s (dBFS): ${result.rms.map(v => v.toFixed(0)).join(" ")}`);
console.log(`wav: ${file}`);
const bad = issues();
if (bad.length) console.log(bad.slice(0, 20).join("\n"));
await browser.close();
site.close();
