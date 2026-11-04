import * as THREE from "three";
import { createSky } from "./sky/sky.js";
import { createFlight } from "./flight.js";

const canvas = document.getElementById("view");
const veil = document.getElementById("veil");
const params = new URLSearchParams(location.search);
const still = params.has("still");
// Capture aid: "still&motion" flies 1/60 s per frame with the live temporal filter, to see
// what a viewer sees in flight rather than a converged average.
const motion = still && params.has("motion");
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

  const sky = createSky(renderer, { cloudScale: baseScale, quality: params.get("q") || "normal" });
  const flight = createFlight({
    alt: num("alt", undefined),
    heading: num("heading", undefined),
    yaw: num("yaw", undefined),
    pitch: num("pitch", undefined),
    time: num("t", undefined),
    x: num("x", undefined),
    z: num("z", undefined)
  });

  function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    sky.resize(Math.round(window.innerWidth * dpr), Math.round(window.innerHeight * dpr));
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

  if (still) {
    flight.snapLook();
    veil.style.transition = "none";
    veil.classList.add("gone");
  }
  const stillFrames = num("frames", 24);
  let last = performance.now();
  let revealed = false;

  function tick(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (!still) flight.update(dt);
    else if (motion) flight.update(1 / 60);
    sky.render(flight.view(window.innerWidth / window.innerHeight), { still: still && !motion });
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
