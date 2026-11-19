// A spectrogram of a WAV (from listen.mjs) as a PNG beside it: time across, frequency up on a log
// scale (30 Hz to 12 kHz, grid at 100 Hz, 1 kHz and 10 kHz), level as a heat colour over the 60 dB
// below the loudest bin; under it the loudness (-50..0 dBFS, grid every 10 dB). For seeing what
// cannot be heard here: whether the air moves, how a clap of thunder starts, a whistle, a click.
//
//   node tools/spectro.mjs captures/audio/hall.wav [--width=1400]
import fs from "node:fs";
import { parseArgs, writePng } from "./lib.mjs";

const { options, rest } = parseArgs();
const file = rest[0];
if (!file) throw new Error("usage: node tools/spectro.mjs file.wav [--width=1400]");
const W = Number(options.width || 1400);
const H = 360;
const STRIP = 80;

// The WAV (16-bit or float), mixed to mono.
const buf = fs.readFileSync(file);
let p = 12;
let fmt = null;
let data = null;
while (p < buf.length) {
  const id = buf.toString("ascii", p, p + 4);
  const size = buf.readUInt32LE(p + 4);
  if (id === "fmt ") fmt = { ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
  if (id === "data") data = buf.subarray(p + 8, p + 8 + size);
  p += 8 + size + (size & 1);
}
const bytes = fmt.bits / 8;
const n = data.length / bytes / fmt.ch;
const x = new Float32Array(n);
for (let i = 0; i < n; i++) {
  let s = 0;
  for (let c = 0; c < fmt.ch; c++) {
    const o = (i * fmt.ch + c) * bytes;
    s += fmt.bits === 32 ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
  }
  x[i] = s / fmt.ch;
}

function fft(re, im) {
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
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < m; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
}

const sr = fmt.sr;
const N = 4096;
const hop = Math.max(1, Math.floor((n - N) / W));
const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const f0 = 30;
const f1 = 12000;
const cols = [];
const loud = [];
let top = -Infinity;
for (let c = 0; c < W; c++) {
  const s = c * hop;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  let e = 0;
  for (let i = 0; i < N; i++) {
    const v = s + i < n ? x[s + i] : 0;
    re[i] = v * win[i];
    e += v * v;
  }
  loud.push(10 * Math.log10(e / N + 1e-20));
  fft(re, im);
  const col = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const ka = Math.floor((f0 * Math.pow(f1 / f0, y / H) * N) / sr);
    const kb = Math.max(ka + 1, Math.ceil((f0 * Math.pow(f1 / f0, (y + 1) / H) * N) / sr));
    let m = 0;
    for (let k = ka; k < kb; k++) m = Math.max(m, re[k] * re[k] + im[k] * im[k]);
    col[y] = 10 * Math.log10(m + 1e-20);
    top = Math.max(top, col[y]);
  }
  cols.push(col);
}

const rgb = Buffer.alloc(W * (H + STRIP) * 3);
const heat = v => {
  const t = Math.min(Math.max(v, 0), 1);
  return [Math.min(255, 255 * Math.min(1, t * 2.2)), Math.min(255, 255 * Math.max(0, t * 2 - 0.6)), Math.min(255, 255 * Math.max(0, t * 3 - 2) + 240 * (1 - t) * t)];
};
const put = (px, py, v) => {
  const o = (py * W + px) * 3;
  rgb[o] = v[0];
  rgb[o + 1] = v[1];
  rgb[o + 2] = v[2];
};
for (let c = 0; c < W; c++) {
  for (let y = 0; y < H; y++) put(c, H - 1 - y, heat((cols[c][y] - (top - 60)) / 60));
  const h = Math.round(Math.min(Math.max((loud[c] + 50) / 50, 0), 1) * (STRIP - 4));
  for (let y = 0; y < STRIP; y++) put(c, H + STRIP - 1 - y, y < h ? [200, 200, 200] : [25, 25, 25]);
}
for (const f of [100, 1000, 10000]) {
  const y = H - 1 - Math.round((Math.log(f / f0) / Math.log(f1 / f0)) * H);
  for (let c = 0; c < W; c += 3) put(c, y, [140, 140, 140]);
}
for (let db = -40; db < 0; db += 10) {
  const y = H + STRIP - 1 - Math.round(((db + 50) / 50) * (STRIP - 4));
  for (let c = 0; c < W; c += 4) put(c, y, [90, 90, 160]);
}
const out = file.replace(/\.wav$/i, "") + ".png";
writePng(out, W, H + STRIP, rgb);
console.log(`${out}: ${(n / sr).toFixed(1)} s`);
