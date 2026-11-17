import * as THREE from "three";

/**
 * The instruments: one canvas, redrawn a few times a second, that glows on the face of the
 * console. No letter or number anywhere: an attitude display that follows the aircraft, a
 * weather radar that shows the storm cells around it, a few dials and bars, a row of lamps.
 */
const W = 1024;
const H = 512;
const TAU = Math.PI * 2;

// Radar: a fan ahead of the aircraft, swept from side to side.
const RADAR = { az: 56, rg: 40, half: (65 * Math.PI) / 180, range: 36000, period: 3.2 };
const ECHO = ["#000", "#0b4d18", "#18902a", "#b9a51c", "#c0301c", "#b022a8"];

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** stormSD(x, y, z): the baked storm distance (m, positive inside), for the radar. */
export function createInstruments({ stormSD = () => -1500 } = {}) {
  // Both canvases are drawn on the CPU (willReadFrequently). A GPU canvas has to be synced
  // with WebGL at every upload, and with the storm keeping the GPU busy that sync broke the
  // frame pacing on a real GPU: bursts of frames, then stalls of 80-200 ms at each redraw.
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;

  // Echoes are painted beam by beam into their own canvas, as the sweep passes.
  const echoCanvas = document.createElement("canvas");
  echoCanvas.width = 352;
  echoCanvas.height = 352;
  const eg = echoCanvas.getContext("2d", { willReadFrequently: true });
  eg.fillStyle = "#010304";
  eg.fillRect(0, 0, 352, 352);
  const EO = [176, 326]; // the radar's origin in that canvas
  const ER = 300;
  let sweepAt = -1; // last azimuth column painted
  let drawnAt = -1e9;
  const euler = new THREE.Euler();

  // One radar beam: echo levels along it, weaker behind heavy rain (the beam is used up).
  function paintBeam(i, view, heading) {
    const a = heading + ((i + 0.5) / RADAR.az * 2 - 1) * RADAR.half;
    const dx = Math.sin(a);
    const dz = -Math.cos(a);
    let spent = 0;
    for (let j = 0; j < RADAR.rg; j++) {
      const r = ((j + 0.5) / RADAR.rg) * RADAR.range;
      const x = view.x + dx * r;
      const z = view.z + dz * r;
      const d = Math.max(stormSD(x, view.alt - 1400, z), stormSD(x, view.alt, z), stormSD(x, view.alt + 2200, z));
      let level = d < -350 ? 0 : d < 50 ? 1 : d < 450 ? 2 : d < 850 ? 3 : d < 1250 ? 4 : 5;
      if (spent > 9000) level = Math.max(level - 2, 0);
      else if (spent > 4500) level = Math.max(level - 1, 0);
      if (level >= 3) spent += RADAR.range / RADAR.rg;
      levels[j] = level;
    }
    const a0 = (i / RADAR.az * 2 - 1) * RADAR.half - Math.PI / 2;
    const a1 = ((i + 1) / RADAR.az * 2 - 1) * RADAR.half - Math.PI / 2 + 0.004;
    eg.fillStyle = "#010304";
    eg.beginPath();
    eg.moveTo(EO[0], EO[1]);
    eg.arc(EO[0], EO[1], ER + 1, a0, a1);
    eg.closePath();
    eg.fill();
    for (let j = 0; j < RADAR.rg; j++) {
      if (!levels[j]) continue;
      const r0 = (j / RADAR.rg) * ER;
      const r1 = ((j + 1) / RADAR.rg) * ER + 0.6;
      eg.fillStyle = ECHO[levels[j]];
      eg.beginPath();
      eg.arc(EO[0], EO[1], r1, a0, a1);
      eg.arc(EO[0], EO[1], r0, a1, a0, true);
      eg.closePath();
      eg.fill();
    }
  }
  const levels = new Uint8Array(RADAR.rg);

  function drawAttitude(roll, pitch, heading, alt, t) {
    const x0 = 28;
    const y0 = 28;
    const s = 352;
    const cx = x0 + s / 2;
    const cy = y0 + s / 2;
    g.save();
    roundRect(g, x0, y0, s, s, 14);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-roll);
    const off = THREE.MathUtils.radToDeg(pitch) * 5.2;
    const sky = g.createLinearGradient(0, -420 + off, 0, off);
    sky.addColorStop(0, "#082a55");
    sky.addColorStop(1, "#2a6fb4");
    g.fillStyle = sky;
    g.fillRect(-500, -500 + off, 1000, 500);
    const ground = g.createLinearGradient(0, off, 0, 420 + off);
    ground.addColorStop(0, "#6a4520");
    ground.addColorStop(1, "#2a190a");
    g.fillStyle = ground;
    g.fillRect(-500, off, 1000, 500);
    g.strokeStyle = "#e8eef4";
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(-500, off);
    g.lineTo(500, off);
    g.stroke();
    // Pitch ladder.
    g.lineWidth = 2;
    for (let deg = -30; deg <= 30; deg += 5) {
      if (deg === 0) continue;
      const y = off - deg * 5.2;
      const half = deg % 10 === 0 ? 46 : 22;
      g.beginPath();
      g.moveTo(-half, y);
      g.lineTo(half, y);
      g.stroke();
    }
    // Bank pointer moves with the horizon; the scale stays with the aircraft.
    g.fillStyle = "#e8eef4";
    g.beginPath();
    g.moveTo(0, -146);
    g.lineTo(-9, -128);
    g.lineTo(9, -128);
    g.closePath();
    g.fill();
    g.rotate(roll);
    g.strokeStyle = "#e8eef4";
    g.lineWidth = 2;
    for (const deg of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = THREE.MathUtils.degToRad(deg) - Math.PI / 2;
      const r1 = deg % 30 === 0 ? 168 : 160;
      g.beginPath();
      g.moveTo(Math.cos(a) * 150, Math.sin(a) * 150);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      g.stroke();
    }
    // The aircraft: two amber wings and a dot.
    g.strokeStyle = "#f0a428";
    g.lineWidth = 6;
    g.lineCap = "round";
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(sx * 96, 0);
      g.lineTo(sx * 40, 0);
      g.lineTo(sx * 40, 14);
      g.stroke();
    }
    g.fillStyle = "#f0a428";
    g.fillRect(-4, -4, 8, 8);
    // Tapes: speed on the left, altitude on the right, their marks sliding past a pointer.
    g.lineCap = "butt";
    for (const [tx, tw, value, step] of [[-168, 40, 68 + 2 * Math.sin(t * 0.7), 2], [128, 44, alt, 60]]) {
      g.fillStyle = "rgba(4, 8, 14, 0.62)";
      g.fillRect(tx, -118, tw, 236);
      g.strokeStyle = "#cfd8e0";
      g.lineWidth = 1.5;
      const slide = ((value / step) % 1) * 22;
      for (let k = -7; k <= 7; k++) {
        const y = k * 22 + slide;
        if (Math.abs(y) > 114) continue;
        const long = (Math.floor(value / step) - k) % 5 === 0;
        g.beginPath();
        g.moveTo(tx < 0 ? tx + tw : tx, y);
        g.lineTo(tx < 0 ? tx + tw - (long ? 16 : 8) : tx + (long ? 16 : 8), y);
        g.stroke();
      }
      g.strokeStyle = "#f0a428";
      g.lineWidth = 2;
      g.strokeRect(tx + 1, -11, tw - 2, 22);
    }
    // Heading: marks along the bottom.
    g.fillStyle = "rgba(4, 8, 14, 0.62)";
    g.fillRect(-110, 138, 220, 30);
    g.strokeStyle = "#cfd8e0";
    g.lineWidth = 1.5;
    const hd = THREE.MathUtils.radToDeg(heading);
    const hs = ((hd / 5) % 1) * 20;
    for (let k = -6; k <= 6; k++) {
      const x = k * 20 - hs;
      if (Math.abs(x) > 106) continue;
      const long = (Math.floor(hd / 5) + k) % 2 === 0;
      g.beginPath();
      g.moveTo(x, 138);
      g.lineTo(x, 138 + (long ? 14 : 7));
      g.stroke();
    }
    g.fillStyle = "#f0a428";
    g.beginPath();
    g.moveTo(0, 168);
    g.lineTo(-7, 156);
    g.lineTo(7, 156);
    g.closePath();
    g.fill();
    g.restore();
  }

  function drawRadar(t) {
    const x0 = 404;
    const y0 = 28;
    const s = 352;
    const ox = x0 + s / 2;
    const oy = y0 + s - 26;
    const R = 300;
    g.save();
    roundRect(g, x0, y0, s, s, 14);
    g.clip();
    // Echoes.
    g.drawImage(echoCanvas, ox - EO[0], oy - EO[1]);
    // Range rings and bearing marks.
    g.strokeStyle = "rgba(90, 190, 210, 0.55)";
    g.lineWidth = 1.2;
    g.setLineDash([5, 7]);
    for (let k = 1; k <= 4; k++) {
      g.beginPath();
      g.arc(ox, oy, (R * k) / 4, -Math.PI / 2 - RADAR.half, -Math.PI / 2 + RADAR.half);
      g.stroke();
    }
    g.setLineDash([]);
    for (let deg = -60; deg <= 60; deg += 15) {
      const a = THREE.MathUtils.degToRad(deg) - Math.PI / 2;
      g.beginPath();
      g.moveTo(ox + Math.cos(a) * (R - (deg % 30 === 0 ? 14 : 7)), oy + Math.sin(a) * (R - (deg % 30 === 0 ? 14 : 7)));
      g.lineTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R);
      g.stroke();
    }
    for (const side of [-1, 1]) {
      const a = side * RADAR.half - Math.PI / 2;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + Math.cos(a) * R, oy + Math.sin(a) * R);
      g.stroke();
    }
    // The sweep.
    const phase = (t / RADAR.period) % 1;
    const u = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    const sa = (u * 2 - 1) * RADAR.half - Math.PI / 2;
    g.strokeStyle = "rgba(120, 255, 150, 0.8)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(ox + Math.cos(sa) * R, oy + Math.sin(sa) * R);
    g.stroke();
    // The aircraft.
    g.fillStyle = "#e8eef4";
    g.beginPath();
    g.moveTo(ox, oy - 12);
    g.lineTo(ox - 8, oy + 8);
    g.lineTo(ox + 8, oy + 8);
    g.closePath();
    g.fill();
    g.restore();
    return Math.min(RADAR.az - 1, Math.floor(u * RADAR.az));
  }

  function drawDial(cx, cy, r, value, color, arcFrom, arcTo) {
    g.fillStyle = "#020405";
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();
    const a0 = Math.PI * 0.75;
    const span = Math.PI * 1.5;
    g.strokeStyle = color;
    g.lineWidth = 2;
    for (let k = 0; k <= 12; k++) {
      const a = a0 + (span * k) / 12;
      const inner = r - (k % 3 === 0 ? 13 : 7);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      g.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3));
      g.stroke();
    }
    g.strokeStyle = "#1e9a3c";
    g.lineWidth = 4;
    g.beginPath();
    g.arc(cx, cy, r - 17, a0 + span * arcFrom, a0 + span * arcTo);
    g.stroke();
    const a = a0 + span * THREE.MathUtils.clamp(value, 0, 1);
    g.strokeStyle = "#f2f4f6";
    g.lineWidth = 3;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8);
    g.lineTo(cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20));
    g.stroke();
    g.lineCap = "butt";
    g.fillStyle = "#30363c";
    g.beginPath();
    g.arc(cx, cy, 5, 0, TAU);
    g.fill();
  }

  function draw(view, t) {
    euler.setFromQuaternion(view.qAircraft, "YXZ");
    const pitch = euler.x;
    const heading = -euler.y;
    const roll = -euler.z;
    const cabin = view.cabin || { turb: 0, hail: 0, elmo: 0, storm: 0 };
    // The face itself: dark, with shallow wells for the screens.
    g.fillStyle = "#07090b";
    g.fillRect(0, 0, W, H);
    drawAttitude(roll, pitch, heading, view.alt, t);
    // Radar: paint the beams the sweep has passed since the last time, then show it.
    const phase = (t / RADAR.period) % 1;
    const now = Math.min(RADAR.az - 1, Math.floor((phase < 0.5 ? phase * 2 : 2 - phase * 2) * RADAR.az));
    if (sweepAt < 0) {
      for (let i = 0; i < RADAR.az; i++) paintBeam(i, view, heading);
    } else {
      const step = now >= sweepAt ? 1 : -1;
      for (let i = sweepAt; i !== now + step; i += step) paintBeam(i, view, heading);
    }
    sweepAt = now;
    drawRadar(t);
    // Dials: they tremble with the airframe.
    const shake = cabin.turb * 0.03;
    const n = k => Math.sin(t * (3.1 + k * 1.7) + k * 2.4) * Math.sin(t * (1.3 + k * 0.9) + k);
    drawDial(836, 92, 60, 0.71 + shake * n(1), "#e39a22", 0.45, 0.85);
    drawDial(948, 92, 60, 0.58 + shake * n(2) * 1.4, "#e39a22", 0.3, 0.8);
    drawDial(836, 222, 46, 0.5 + 0.02 * n(3) + shake * n(4), "#cfd8e0", 0.35, 0.7);
    drawDial(948, 222, 46, 0.64 + 0.01 * n(5), "#cfd8e0", 0.4, 0.9);
    // Bars.
    for (let k = 0; k < 7; k++) {
      const x = 792 + k * 29;
      const level = [0.82, 0.78, 0.55, 0.6, 0.66, 0.43, 0.71][k] + 0.02 * n(k + 6);
      g.fillStyle = "#020405";
      g.fillRect(x, 286, 18, 92);
      for (let seg = 0; seg < 12; seg++) {
        if (seg / 12 > level) break;
        g.fillStyle = seg >= 10 ? "#e39a22" : "#1e9a3c";
        g.fillRect(x + 3, 372 - seg * 7.4, 12, 5);
      }
    }
    // A row of lamps: most dark; a few steady; some wake up in the storm.
    const blink = Math.floor(t * 2.2) % 2 === 0;
    for (let k = 0; k < 16; k++) {
      const x = 34 + k * 44;
      let color = "#0b0e11";
      if (k === 2) color = "#1e9a3c";
      if (k === 9) color = "#2a6fb4";
      if (k === 5 && cabin.storm > 0.5) color = "#e39a22";
      if (k === 6 && cabin.hail > 0.25) color = "#e39a22";
      if (k === 12 && cabin.turb > 0.75 && blink) color = "#d22a1c";
      if (k === 13 && cabin.elmo > 0.35) color = "#e39a22";
      g.fillStyle = color;
      roundRect(g, x, 404, 32, 16, 4);
      g.fill();
    }
    // Knobs: dark, each with a thin lit ring and a pointer.
    for (let k = 0; k < 9; k++) {
      const cx = 60 + k * 80;
      g.fillStyle = "#020405";
      g.beginPath();
      g.arc(cx, 462, 22, 0, TAU);
      g.fill();
      g.strokeStyle = "rgba(227, 154, 34, 0.5)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(cx, 462, 25, 0, TAU);
      g.stroke();
      const a = k * 1.3 + 0.4;
      g.strokeStyle = "#8a9096";
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(cx, 462);
      g.lineTo(cx + Math.cos(a) * 18, 462 + Math.sin(a) * 18);
      g.stroke();
    }
  }

  return {
    texture,
    /** Redraws when a tenth of a second has passed (or the time jumped). */
    update(view, t) {
      if (t >= drawnAt && t - drawnAt < 0.1) return;
      drawnAt = t;
      draw(view, t);
      texture.needsUpdate = true;
    }
  };
}
