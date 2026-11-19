// Where the night journey's lightning strikes, without rendering: flies the journey on the CPU
// (the baked storm, the journey, the lightning scheduler, as the page runs them) and reports how
// close each flash's channel comes to the aircraft, by stretch of the journey. Close flashes are
// what make thunder crack; far ones only rumble.
//
//   node tools/strikes.mjs [--from=0] [--to=520] [--step=60]
import { parseArgs } from "./lib.mjs";
import { bakeStorm } from "../src/night/storm.js";
import { createLightning } from "../src/night/lightning.js";
import { createJourney } from "../src/night/journey.js";

const { options } = parseArgs();
const from = Number(options.from ?? 0);
const to = Number(options.to ?? 520);
const step = Number(options.step ?? 60);

const storm = bakeStorm();
const flight = createJourney({ time: from, stormSD: storm.sample });
const lightning = createLightning({ stormSD: storm.sample });

// Distance from p to the segment a-b.
const segDist = (p, a, b) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2 || 1;
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
};

const flashes = [];
let last = -1;
while (flight.state.time < to) {
  flight.update(1 / 30);
  const view = flight.view(16 / 9);
  const lit = lightning.update(view, flight.state.time, 1 / 30);
  const e = lit.flash.event;
  if (!lit.flash.on || !e || e.id === last) continue;
  last = e.id;
  const p = [view.x, view.alt, view.z];
  let d = Infinity;
  if (e.kind === "cg" && e.bolt) {
    for (const s of e.bolt) d = Math.min(d, segDist(p, s.a, s.b));
  } else {
    // The channel the thunder is made from (audio.js): through the three sources, extended.
    const s = e.sources;
    const ext = (q, f, k) => q.map((v, i) => v + (v - f[i]) * k);
    const pts = [ext(s[0], s[1], 0.4), s[0], s[1], s[2], ext(s[2], s[1], 0.4)];
    for (let k = 0; k + 1 < pts.length; k++) d = Math.min(d, segDist(p, pts[k], pts[k + 1]));
  }
  flashes.push({ t: flight.state.time, kind: e.kind, d });
}

const edges = [500, 1000, 1500, 2000, 3000, 5000, Infinity];
console.log(`nearest part of each flash's channel, km:  <0.5  <1 <1.5  <2  <3  <5 more`);
for (let a = from; a < to; a += step) {
  const r = flashes.filter(x => x.t >= a && x.t < a + step);
  const counts = edges.map((v, i) => r.filter(x => x.d < v && x.d >= (edges[i - 1] || 0)).length);
  console.log(`t ${String(a).padStart(3)}-${String(a + step).padEnd(3)}  ${String(r.length).padStart(3)} flashes          ${counts.map(c => String(c).padStart(4)).join("")}`);
}
const close = flashes.filter(x => x.d < 2000);
console.log(`within 2 km: ${close.map(x => `${x.t.toFixed(0)} s ${x.kind} ${Math.round(x.d)} m`).join(", ") || "none"}`);
