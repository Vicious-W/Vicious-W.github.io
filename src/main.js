import * as THREE from "three";
import { createSky } from "./sky/sky.js";
import { createFlight } from "./flight.js";
import { createJourney } from "./night/journey.js";
import { bakeStorm, STORM } from "./night/storm.js";
import { createLightning } from "./night/lightning.js";
import { createBolts } from "./night/bolts.js";
import { createCockpit } from "./cockpit/cockpit.js";

const canvas = document.getElementById("view");
const veil = document.getElementById("veil");
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

  const coarsePointer = matchMedia("(pointer: coarse)").matches;
  const dpr = Math.min(window.devicePixelRatio || 1, coarsePointer ? 1.25 : 1.5);
  const baseScale = num("scale", coarsePointer ? 0.35 : 0.5);
  renderer.setPixelRatio(dpr);

  const storm = night ? bakeStorm() : null;
  const sky = createSky(renderer, {
    cloudScale: baseScale,
    quality: params.get("q") || "normal",
    maxSteps: num("steps", 0),
    night: storm && { storm: storm.texture, min: STORM.min, size: STORM.size, range: STORM.range, base: STORM.base, calm: STORM.calm }
  });
  // Capture aids: "night&free" flies the free day-style flight (x, z, alt, heading) at night;
  // rain, hail, elmo, turb, cloud (0..1) hold the cabin's levels; "cockpit=0" shows the
  // outside alone.
  const cabin = {};
  for (const key of ["rain", "hail", "elmo", "turb", "cloud"]) if (params.has(key)) cabin[key] = num(key, 0);
  const flight = night && !params.has("free")
    ? createJourney({ time: num("t", undefined), yaw: num("yaw", undefined), pitch: num("pitch", undefined), cabin, stormSD: storm.sample })
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
  const cockpit = night && !params.has("free") && params.get("cockpit") !== "0" ? createCockpit(renderer, { stormSD: storm.sample }) : null;
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

  // Lower the cloud resolution on slower GPUs, raise it back when there is headroom.
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
    if (avg > 1 / 45) next = Math.max(0.28, next - 0.05);
    else if (avg < 1 / 57 && next < baseScale) next = Math.min(baseScale, next + 0.05);
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
  if (still) {
    flight.snapLook();
    veil.style.transition = "none";
    veil.classList.add("gone");
  }
  const stillFrames = num("frames", 24);
  const lightning = night ? createLightning({ stormSD: storm.sample }) : null;
  const bolts = night ? createBolts(renderer) : null;
  let flashControl = null;
  let last = performance.now();
  let revealed = false;

  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const step = still ? (motion ? 1 / 60 : 0) : dt;
    if (step > 0) flight.update(step);
    const view = flight.view(window.innerWidth / window.innerHeight);
    if (lightning) {
      // Capture aids: "flash=ic|near|cg&ft=ms" holds one flash, ft milliseconds after its first
      // stroke; "flick=1" holds the flicker lit.
      if (!flashControl) {
        const held = still && (params.has("flash") || params.has("flick"));
        flashControl = held ? lightning.force(view, params.get("flash"), num("ft", 15), params.get("flick") === "1") : lightning;
      }
      const lit = flashControl.update(view, flight.state.time, step || 1 / 60);
      view.flash = lit.flash;
      view.flick = lit.flick;
      view.stormGlow = lit.glow;
    }
    sky.render(view, { still: still && !motion, target: frameTarget, linear: !!cockpit });
    // A bolt's channel is blinding: in linear light it is drawn well past white.
    if (bolts) bolts.render(view, view.flash, sky.scene, canvas.width, canvas.height, frameTarget, cockpit ? 6 : 1);
    if (cockpit) {
      const light = sky.light;
      cockpit.render(view, frameTarget.texture, canvas.width, canvas.height, {
        skyLight: [light.x, light.y, light.z],
        exposure: sky.exposure
      });
    }
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
