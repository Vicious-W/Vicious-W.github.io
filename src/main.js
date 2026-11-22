import * as THREE from "three";
import { createSky, NEAR } from "./sky/sky.js";
import { createFlight } from "./flight.js";
import { createJourney } from "./night/journey.js";
import { bakeStorm, makeSampler, stormTexture, SECOND, STORM, STORM2 } from "./night/storm.js";
import { createLightning } from "./night/lightning.js";
import { createBolts, createLampPoints } from "./night/bolts.js";
import { createCockpit } from "./cockpit/cockpit.js";
import { lampsInWorld } from "./cockpit/lamps.js";
import { powerAt } from "./night/moments.js";
import { createAudio } from "./audio/audio.js";

const canvas = document.getElementById("view");
const veil = document.getElementById("veil");
const door = document.getElementById("door");
const params = new URLSearchParams(location.search);
const still = params.has("still");
// Capture aid: "still&motion" flies 1/60 s per frame with the live temporal filter, to see
// what a viewer sees in flight rather than a converged average.
const motion = still && params.has("motion");
// Scene two, the night journey through the thunderstorm.
const night = params.has("night");
const num = (key, fallback) => (params.has(key) ? Number(params.get(key)) : fallback);

function start() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: still
    });
  } catch (error) {
    // Without WebGL2 the page stays a calm deep blue.
    console.error("WebGL2 is unavailable", error);
    return;
  }

  // Desktop only, and the best look first: clouds at full resolution with the finer march.
  // The resolution gives way only if the frame rate falls below 30.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const baseScale = num("scale", 1);
  renderer.setPixelRatio(dpr);

  // The second storm is baked in a worker meanwhile (it is far off at first); until it arrives
  // the storms' distance is the first's alone.
  // (In captures it is baked here, so every still has it.)
  const bakeWorker = night && !still ? new Worker(new URL("./night/stormbake.worker.js", import.meta.url), { type: "module" }) : null;
  if (bakeWorker) bakeWorker.postMessage("bake");
  const storm = night ? bakeStorm() : null;
  let sample2 = null;
  const stormSD = night ? (x, y, z) => (sample2 ? Math.max(storm.sample(x, y, z), sample2(x, y, z)) : storm.sample(x, y, z)) : null;
  const sky = createSky(renderer, {
    cloudScale: baseScale,
    quality: params.get("q") || "high",
    maxSteps: num("steps", 0),
    night: storm && { storm: storm.texture, min: STORM.min, size: STORM.size, range: STORM.range, base: STORM.base, calm: STORM.calm, calm2: STORM2.calm }
  });
  // Capture aids: "night&free" flies the free day-style flight (x, z, alt, heading) at night;
  // rain, hail, elmo, turb, cloud (0..1) hold the cabin's levels; "cockpit=0" shows the
  // outside alone.
  const cabin = {};
  for (const key of ["rain", "hail", "elmo", "turb", "cloud"]) if (params.has(key)) cabin[key] = num(key, 0);
  const flight = night && !params.has("free")
    ? createJourney({ time: num("t", undefined), hold: params.has("hold") ? num("t", 0) : undefined, yaw: num("yaw", undefined), pitch: num("pitch", undefined), cabin, stormSD })
    : createFlight({
        alt: num("alt", undefined),
        heading: num("heading", undefined),
        yaw: num("yaw", undefined),
        pitch: num("pitch", undefined),
        time: num("t", undefined),
        x: num("x", undefined),
        z: num("z", undefined)
      });

  // At night the outside is finished into a texture, then seen through the cockpit's glass.
  const cockpit = night && !params.has("free") && params.get("cockpit") !== "0" ? createCockpit(renderer, { stormSD, show: { mist: 1, outside: 2 }[params.get("show")] || 0 }) : null;
  let frameTarget = null;
  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    sky.resize(Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr));
    if (cockpit) {
      frameTarget?.dispose();
      // Linear light: the glass pass refracts and adds to it, then tone-maps.
      frameTarget = new THREE.WebGLRenderTarget(canvas.width, canvas.height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false
      });
    }
  }
  resize();
  window.addEventListener("resize", resize);

  // Drag to look around, like turning your head.
  let drag = null;
  canvas.addEventListener("pointerdown", event => {
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", event => {
    if (!drag || event.pointerId !== drag.id) return;
    flight.lookBy(event.clientX - drag.x, event.clientY - drag.y);
    drag.x = event.clientX;
    drag.y = event.clientY;
  });
  const endDrag = event => {
    if (drag && event.pointerId === drag.id) drag = null;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", event => event.preventDefault());

  // A safety net only: lower the cloud resolution if frames take too long, raise it back after.
  let timeAcc = 0;
  let frameCount = 0;
  let cooldown = 2;
  function adaptResolution(dt) {
    timeAcc += dt;
    frameCount++;
    cooldown -= dt;
    if (timeAcc < 1) return;
    const avg = timeAcc / frameCount;
    timeAcc = 0;
    frameCount = 0;
    if (cooldown > 0) return;
    let next = sky.cloudScale;
    if (avg > 1 / 30) next = Math.max(0.5, next - 0.05);
    else if (avg < 1 / 45 && next < baseScale) next = Math.min(baseScale, next + 0.05);
    if (next !== sky.cloudScale) {
      sky.setCloudScale(next);
      cooldown = 3;
    }
  }

  if (night) {
    // The night opens out of black.
    document.body.style.background = "#000";
    veil.style.background = "#000";
  }

  // The way between the day and the night (a dot in the corner, PLAN.md 5.6): the picture goes
  // dark, then the other one opens. Not in captures.
  if (door && !still) {
    door.href = night ? location.pathname : "?night";
    door.setAttribute("aria-label", night ? "day" : "night");
    if (night) door.classList.add("night");
    setTimeout(() => door.classList.add("shown"), 4000);
    door.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      veil.style.transition = "opacity 1.6s ease";
      veil.style.background = night ? "#0a2440" : "#000";
      veil.classList.remove("gone");
      setTimeout(() => (location.href = door.href), 1700);
    });
  } else if (door) {
    door.remove();
  }
  if (still) {
    flight.snapLook();
    veil.style.transition = "none";
    veil.classList.add("gone");
  }
  const stillFrames = num("frames", 24);

  // The sound of the night journey. Browsers let it start only after a click or a key; capture
  // aid: "sound" starts it at once (the tools allow that).
  const audio = cockpit && !still ? createAudio({ solo: params.get("solo") }) : null;
  if (audio) {
    window.__audioStream = audio.stream;
    const begin = () => audio.start();
    window.addEventListener("pointerdown", begin, { once: true });
    window.addEventListener("keydown", begin, { once: true });
    document.addEventListener("visibilitychange", () => audio.pause(document.hidden));
    if (params.has("sound")) audio.start();
  }

  // The air around the aircraft on the night journey: whether the storm's cloud is within reach
  // of the mist pass, the moon past the storm (it comes and goes softly), how open the air
  // above is, and the aircraft's lamps.
  let moonSeen = 1;
  const lamps = { pos: [0, 1, 2, 3].map(() => new THREE.Vector3()), light: [0, 1, 2, 3].map(() => new THREE.Vector3()) };
  const clamp01 = v => Math.min(Math.max(v, 0), 1);
  function airAround(view) {
    const sd = stormSD(view.x, view.alt, view.z);
    // Within reach of the storm, or of scud (the nearest is first; its reach as in storm.glsl).
    let scud = Infinity;
    if (view.scud && view.scud.count > 0) {
      const p = view.scud.pos[0];
      const s = view.scud.size[0];
      const reachK = s.w > 0 ? Math.min(Math.max(1 + 170 / (320 * s.w), 1.3), 2.4) : 1 + (1.2 * 320) / Math.min(s.x, s.y, s.z);
      scud = Math.hypot(p.x, p.y - view.alt, p.z) - Math.max(s.x, s.y, s.z) * reachK;
    }
    view.near = (sd > -(NEAR.reach + 900) || scud < NEAR.reach + 300 || (view.airMist ?? 0) > 0.02) && params.get("near") !== "0" ? NEAR.reach : 0;
    let open = 1;
    for (let d = 400; d < 16000 && open > 0; d += 500) {
      if (stormSD(view.x + view.sunDir.x * d, view.alt + view.sunDir.y * d, view.z + view.sunDir.z * d) > -150) open = 0;
    }
    moonSeen += (open - moonSeen) * 0.08;
    view.moonSeen = moonSeen;
    const above = h => stormSD(view.x, view.alt + h, view.z);
    const openNear = 1 - clamp01(above(420) / 420 + 0.5);
    view.open = [openNear, openNear * (0.3 + 0.7 * (1 - clamp01(above(1900) / 900 + 0.5)))];
    view.lamps = lampsInWorld(view.qAircraft, view.time, lamps);
    // After the strike the lamps are dark until the power comes back.
    view.power = powerAt(view.time);
    if (!view.power.on) for (const l of view.lamps.light) l.set(0, 0, 0);
  }
  const lightning = night ? createLightning({ stormSD, seed: num("bolt", 9) }) : null;
  if (night && still) {
    const second = bakeStorm(SECOND);
    sample2 = second.sample;
    sky.setSecondStorm(second.texture, STORM2.min);
  }
  if (bakeWorker) {
    bakeWorker.onmessage = e => {
      sample2 = makeSampler(e.data.field, STORM2);
      sky.setSecondStorm(stormTexture(e.data.data, STORM2), STORM2.min);
      bakeWorker.terminate();
    };
  }
  const bolts = night ? createBolts(renderer) : null;
  // (Its shader, which the lamps of other aircraft and the sparks on the glass share, compiled in
  // the background: else the first flash stalls its frame.)
  bolts?.compile().catch(() => {});
  const trafficPoints = night ? createLampPoints(renderer) : null;
  let flashControl = null;
  let last = performance.now();
  let revealed = false;

  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const step = still ? (motion ? 1 / 60 : 0) : dt;
    if (step > 0) flight.update(step);
    const view = flight.view(window.innerWidth / window.innerHeight);
    let lit = null;
    if (lightning) {
      // Capture aids: "flash=ic|near|cg&ft=ms" holds one flash, ft milliseconds after its first
      // stroke; "flick=1" holds the flicker lit.
      if (!flashControl) {
        const held = still && (params.has("flash") || params.has("flick"));
        flashControl = held ? lightning.force(view, params.get("flash"), num("ft", 15), params.get("flick") === "1") : lightning;
      }
      lit = flashControl.update(view, flight.state.time, step || 1 / 60);
      view.flash = lit.flash;
      view.flick = lit.flick;
      view.stormGlow = lit.glow;
      view.deepGlow = lit.deep;
    }
    if (cockpit) airAround(view);
    sky.render(view, { still: still && !motion, target: frameTarget, linear: !!cockpit });
    // A bolt's channel is blinding: in linear light it is drawn well past white.
    if (bolts) bolts.render(view, view.flash, sky.scene, canvas.width, canvas.height, frameTarget, cockpit ? 6 : 1);
    // Another aircraft's lamps, seen directly (moments.js).
    if (trafficPoints && view.traffic && view.traffic.on) trafficPoints.render(view, view.traffic, sky.scene, canvas.width, canvas.height, frameTarget, cockpit ? 6 : 1);
    if (cockpit) {
      const light = sky.light;
      cockpit.render(view, frameTarget.texture, canvas.width, canvas.height, {
        mist: sky.mist,
        skyLight: [light.x, light.y, light.z],
        exposure: sky.exposure
      });
    }
    if (audio) audio.update(view, { lit, fire: cockpit.fire, gustEvents: flight.gustEvents });
    if (!revealed && sky.frame > 4) {
      veil.classList.add("gone");
      revealed = true;
    }
    if (still) {
      if (sky.accumulated >= stillFrames) {
        window.__stillDone = true;
        return;
      }
    } else {
      adaptResolution(dt);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.__sky = { flight, sky, renderer };
}

start();
