// The thunderstorm without rendering: bakes it as the site does, then writes plans at several
// altitudes and sections across and along the path (1 px = 100 m; the path in red; clear air
// dark, within reach of the shader's noise blue-grey, cloud grey to white), and prints the
// clearance around the aircraft and the cabin timeline every 15 s of the journey.
//
//   node tools/storm-view.mjs [--out=captures/storm]
import path from "node:path";
import { bakeStorm, STORM } from "../src/night/storm.js";
import { createPath, createJourney } from "../src/night/journey.js";
import { CAPTURES, parseArgs, writePng } from "./lib.mjs";

const { options } = parseArgs();
const out = path.resolve(String(options.out || path.join(CAPTURES, "storm")));
const t0 = performance.now();
const { sample } = bakeStorm();
console.log(`bake ${(performance.now() - t0).toFixed(0)} ms`);
const route = createPath();
const journey = createJourney({ stormSD: sample });
console.log(`path ${(route.length / 1000).toFixed(1)} km;`, Object.entries(journey.mark).map(([k, v]) => `${k} ${(v / 68).toFixed(0)} s`).join(", "));

const shade = d => {
  if (d <= -1490) return [8, 10, 26];
  if (d < -435) return [14, 20, 48];
  if (d < 0) return [40, 52, 96];
  const v = 110 + Math.min(d / 1500, 1) * 130;
  return [v, v, v];
};
const image = (name, w, h, pixel) => {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set(pixel(x, y), (y * w + x) * 3);
  writePng(path.join(out, `${name}.png`), w, h, rgb);
};
const pts = [];
for (let s = 0; s <= route.length; s += 60) pts.push(route.position(s));
const onPath = new Set(pts.map(p => `${Math.round((p[0] - STORM.min[0]) / 100)},${Math.round((p[2] - STORM.min[1]) / 100)}`));

const W = STORM.size[0] / 100;
const H = STORM.size[2] / 100;
for (const y of [2200, 3200, 4700, 7000, 9500, 11000]) {
  image(`plan-${y}`, W, H, (px, pz) => (onPath.has(`${px},${pz}`) ? [255, 80, 60] : shade(sample(STORM.min[0] + (px + 0.5) * 100, y, STORM.min[1] + (pz + 0.5) * 100))));
}
for (const z of [7800, 4800, 1000, -3000, -6500, -10300]) {
  const at = pts.reduce((best, p) => (Math.abs(p[2] - z) < Math.abs(best[2] - z) ? p : best), pts[0]);
  image(`section-z${z}`, W, 140, (px, py) => {
    const x = STORM.min[0] + (px + 0.5) * 100;
    const y = (139.5 - py) * 100;
    return Math.hypot(x - at[0], y - at[1]) < 120 ? [255, 80, 60] : shade(sample(x, y, z));
  });
}
image("along", Math.ceil(route.length / 100), 140, (px, py) => {
  const p = route.position(px * 100);
  const y = (139.5 - py) * 100;
  return Math.abs(y - p[1]) < 60 ? [255, 80, 60] : shade(sample(p[0], y, p[2]));
});
console.log(`images: ${out}`);

const reach = (p, d, max) => {
  for (let s = 0; s < max; s += 100) if (sample(p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s) > 0) return s;
  return Infinity;
};
for (let t = 0; t <= 540; t += 15) {
  const s = t * 68;
  const p = route.position(s);
  const q = route.position(s + 50);
  const n = Math.hypot(q[0] - p[0], q[2] - p[2]);
  const right = [-(q[2] - p[2]) / n, 0, (q[0] - p[0]) / n];
  const c = journey.cabinAt(s, t);
  const lv = Object.entries(c).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(" ");
  console.log(
    `t ${String(t).padStart(3)}  (${p.map(v => v.toFixed(0)).join(", ")})  in cloud ${sample(...p).toFixed(0).padStart(6)} m  clear left ${reach(p, right.map(v => -v), 12000)} right ${reach(p, right, 12000)} up ${reach(p, [0, 1, 0], 9000)} down ${reach(p, [0, -1, 0], 4900)} | ${lv}`
  );
}
