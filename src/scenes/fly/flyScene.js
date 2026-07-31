import * as THREE from "three";
import { createResourceScope } from "../../core/resourceScope.js";
import { createFlySession } from "./flySession.js";
import { createBalloonModel } from "./balloonModel.js";
import { createWorldView } from "./worldView.js";
import { createFlyAudio } from "./audio/flyAudio.js";
import { vehicleRegistry, weatherRegistry, DEFAULT_FLY_SELECTION } from "./registry.js";

const MAX_DPR = 1.5;
const CAMERA_MODES = ["PILOT", "CHASE", "ORBIT"];
const clamp = THREE.MathUtils.clamp;

function iconButton(action, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `fly-icon-control fly-${action}`;
  button.dataset.action = action;
  button.setAttribute("aria-label", label);
  return button;
}

function disposeObject(object) {
  const geometries = new Set(), materials = new Set();
  object.traverse(child => {
    if (child.geometry) geometries.add(child.geometry);
    if (Array.isArray(child.material)) child.material.forEach(material => materials.add(material));
    else if (child.material) materials.add(child.material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

function interpolateVehicle(previous, current, alpha) {
  if (!previous || !current) return current;
  const mixVector = (a, b) => ({
    x: THREE.MathUtils.lerp(a.x, b.x, alpha),
    y: THREE.MathUtils.lerp(a.y, b.y, alpha),
    z: THREE.MathUtils.lerp(a.z, b.z, alpha)
  });
  return {
    ...current,
    envelope: {
      ...current.envelope,
      position: mixVector(previous.envelope.position, current.envelope.position),
      velocity: mixVector(previous.envelope.velocity, current.envelope.velocity)
    },
    basket: {
      ...current.basket,
      position: mixVector(previous.basket.position, current.basket.position),
      velocity: mixVector(previous.basket.velocity, current.basket.velocity),
      tilt: mixVector(previous.basket.tilt, current.basket.tilt)
    }
  };
}

export function createFlyScene({ section, canvas, reduceMotion, requestSelector }) {
  const scope = createResourceScope("fly-scene");
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (error) {
    console.error("FLY: renderer unavailable", error);
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MAX_DPR));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x77bde8);
  const camera = new THREE.PerspectiveCamera(56, 1, 0.08, 2600);
  const audio = createFlyAudio();
  let session = null;
  let worldView = null;
  let balloonModel = null;
  let previewModel = null;
  let previewGround = null;
  let running = false;
  let disposed = false;
  let raf = 0;
  let last = 0;
  let phase = "FLY_CONFIG";
  let guideWasFlight = false;
  let returnConfirming = false;
  let cameraModeIndex = 0;
  let lookYaw = 0;
  let lookPitch = -0.08;
  let lookPointer = null;
  let activeControlPointer = null;
  let activeControlAction = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const desiredCamera = new THREE.Vector3();
  const desiredTarget = new THREE.Vector3();

  scene.add(new THREE.HemisphereLight(0xd8f2ff, 0x485f31, 2.3));
  const previewLight = new THREE.DirectionalLight(0xffefdc, 3.5);
  previewLight.position.set(-18, 28, 20);
  scene.add(previewLight);

  const overlay = document.createElement("div");
  overlay.className = "fly-overlay";
  section.appendChild(overlay);
  scope.add(() => overlay.remove());

  const guide = document.createElement("section");
  guide.className = "fly-guide";
  guide.hidden = true;
  guide.setAttribute("role", "dialog");
  guide.setAttribute("aria-modal", "true");
  guide.setAttribute("aria-labelledby", "fly-guide-title");
  const guideTitle = document.createElement("h1");
  guideTitle.id = "fly-guide-title";
  const guideList = document.createElement("dl");
  const guideSafety = document.createElement("p");
  const guideLaunch = iconButton("depart", "Confirm and begin flight");
  guide.append(guideTitle, guideList, guideSafety, guideLaunch);
  overlay.appendChild(guide);

  const flightControls = document.createElement("div");
  flightControls.className = "fly-flight-controls";
  flightControls.hidden = true;
  const burnerButton = iconButton("burner", "Hold main burner");
  const ventButton = iconButton("vent", "Hold top vent");
  const recoveryButton = iconButton("recovery", "Request automatic safe landing");
  const cameraButton = iconButton("camera", "Change camera");
  const helpButton = iconButton("help", "Open vehicle guide");
  const returnButton = iconButton("return", "Return to scene selection");
  flightControls.append(burnerButton, ventButton, recoveryButton, cameraButton, helpButton, returnButton);
  overlay.appendChild(flightControls);

  const returnConfirm = document.createElement("div");
  returnConfirm.className = "fly-return-confirm";
  returnConfirm.hidden = true;
  returnConfirm.setAttribute("role", "dialog");
  returnConfirm.setAttribute("aria-label", "Confirm ending this flight");
  const confirmReturnButton = iconButton("confirm-return", "Confirm return to scene selection");
  const cancelReturnButton = iconButton("cancel-return", "Continue flight");
  returnConfirm.append(confirmReturnButton, cancelReturnButton);
  overlay.appendChild(returnConfirm);

  const buildPreview = () => {
    previewModel = createBalloonModel();
    previewModel.group.rotation.y = -0.35;
    scene.add(previewModel.group);
    const fake = {
      envelope: { position: { x: 0, y: 5, z: 0 } },
      basket: { position: { x: 0, y: -7.1, z: 0 }, tilt: { x: 0, y: 0, z: 0 } },
      stage: "PREVIEW", heatInputW: 0, burnerValve: 0
    };
    previewModel.update(fake);
    previewGround = new THREE.Mesh(new THREE.CircleGeometry(55, 64), new THREE.MeshStandardMaterial({ color: 0x456f32, roughness: 0.92 }));
    previewGround.rotation.x = -Math.PI / 2;
    previewGround.position.y = -7.82;
    scene.add(previewGround);
    camera.position.set(24, 6, 31);
    camera.lookAt(0, 2, 0);
  };

  const disposePreview = () => {
    if (previewModel) { scene.remove(previewModel.group); previewModel.dispose(); previewModel = null; }
    if (previewGround) { scene.remove(previewGround); disposeObject(previewGround); previewGround = null; }
  };

  const resize = () => {
    const width = Math.max(1, section.clientWidth);
    const height = Math.max(1, section.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!session) {
      camera.position.set(camera.aspect < 0.72 ? 27 : 24, camera.aspect < 0.72 ? 8 : 6, camera.aspect < 0.72 ? 52 : 31);
      camera.lookAt(0, 2, 0);
    }
  };

  const clearContinuousControls = () => {
    session?.clearControls();
    activeControlPointer = null;
    activeControlAction = null;
    burnerButton.classList.remove("is-active");
    ventButton.classList.remove("is-active");
  };

  const startFlight = () => {
    if (session) return;
    disposePreview();
    session = createFlySession({ seed: 0xc1002026, selection: DEFAULT_FLY_SELECTION });
    worldView = createWorldView({ scene, world: session.world, atmosphere: session.atmosphere });
    balloonModel = createBalloonModel();
    scene.add(balloonModel.group);
    session.resume();
    audio.unlock();
    flightControls.hidden = false;
    phase = "READY_ON_FIELD";
  };

  const populateGuide = () => {
    const definition = vehicleRegistry[DEFAULT_FLY_SELECTION.vehicleId].guideDefinition;
    guideTitle.textContent = definition.title;
    guideList.replaceChildren();
    definition.controls.forEach(([term, description]) => {
      const dt = document.createElement("dt"); dt.textContent = term;
      const dd = document.createElement("dd"); dd.textContent = description;
      guideList.append(dt, dd);
    });
    guideSafety.textContent = definition.safety;
  };

  const openGuide = () => {
    if (guide.hidden === false || returnConfirming) return;
    guideWasFlight = !!session;
    clearContinuousControls();
    if (session) session.pause("guide");
    audio.suspend();
    populateGuide();
    guide.hidden = false;
    phase = "FLY_GUIDE";
    guideLaunch.focus();
  };

  const closeGuide = ({ depart = false } = {}) => {
    if (guide.hidden) return;
    guide.hidden = true;
    if (!session && depart) startFlight();
    else if (session) {
      session.resume();
      audio.resume();
      phase = session.state.stage;
    } else phase = "FLY_CONFIG";
    canvas.focus({ preventScroll: true });
  };

  const cycleCamera = () => { cameraModeIndex = (cameraModeIndex + 1) % CAMERA_MODES.length; };

  const showReturnConfirm = () => {
    if (!session || session.state.controlOwner === "RECOVERED") { requestSelector(); return; }
    if (returnConfirming) return;
    returnConfirming = true;
    clearContinuousControls();
    session.pause("return-confirm");
    audio.suspend();
    returnConfirm.hidden = false;
    confirmReturnButton.focus();
  };
  const cancelReturn = () => {
    if (!returnConfirming) return;
    returnConfirming = false;
    returnConfirm.hidden = true;
    session?.resume();
    audio.resume();
    canvas.focus({ preventScroll: true });
  };

  const setControl = (action, active) => {
    if (!session || guide.hidden === false || returnConfirming) return false;
    const accepted = session.setControl(action, active);
    if (accepted) (action === "burner" ? burnerButton : ventButton).classList.toggle("is-active", active);
    return accepted;
  };

  const bindHoldButton = (button, action) => {
    scope.listen(button, "pointerdown", event => {
      if (!setControl(action, true)) return;
      activeControlPointer = event.pointerId;
      activeControlAction = action;
      try { button.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
      event.preventDefault();
    });
    const release = event => {
      if (activeControlAction !== action || (event && activeControlPointer !== event.pointerId)) return;
      setControl(action, false);
      activeControlPointer = null; activeControlAction = null;
    };
    scope.listen(button, "pointerup", release);
    scope.listen(button, "pointercancel", release);
    scope.listen(button, "lostpointercapture", release);
  };
  bindHoldButton(burnerButton, "burner");
  bindHoldButton(ventButton, "vent");

  scope.listen(recoveryButton, "click", () => { clearContinuousControls(); session?.requestRecovery(); });
  scope.listen(cameraButton, "click", cycleCamera);
  scope.listen(helpButton, "click", openGuide);
  scope.listen(returnButton, "click", showReturnConfirm);
  scope.listen(confirmReturnButton, "click", requestSelector);
  scope.listen(cancelReturnButton, "click", cancelReturn);
  scope.listen(guideLaunch, "click", () => closeGuide({ depart: true }));

  const canvasPoint = event => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  };
  const onPointerDown = event => {
    if (!session) { openGuide(); return; }
    if (!guide.hidden || returnConfirming) return;
    canvasPoint(event);
    raycaster.setFromCamera(pointer, camera);
    const hit = balloonModel ? raycaster.intersectObjects(balloonModel.controlMeshes, false)[0] : null;
    if (hit?.object.userData.action && setControl(hit.object.userData.action, true)) {
      activeControlPointer = event.pointerId;
      activeControlAction = hit.object.userData.action;
      try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
      event.preventDefault();
      return;
    }
    lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
  };
  const onPointerMove = event => {
    if (!lookPointer || event.pointerId !== lookPointer.id) return;
    const dx = event.clientX - lookPointer.x, dy = event.clientY - lookPointer.y;
    lookPointer.x = event.clientX; lookPointer.y = event.clientY;
    lookYaw -= dx * 0.003;
    lookPitch = clamp(lookPitch - dy * 0.0025, -1.1, 0.85);
  };
  const onPointerEnd = event => {
    if (activeControlPointer === event.pointerId) {
      setControl(activeControlAction, false);
      activeControlPointer = null; activeControlAction = null;
    }
    if (lookPointer?.id === event.pointerId) lookPointer = null;
  };
  scope.listen(canvas, "pointerdown", onPointerDown);
  scope.listen(canvas, "pointermove", onPointerMove);
  scope.listen(canvas, "pointerup", onPointerEnd);
  scope.listen(canvas, "pointercancel", onPointerEnd);
  scope.listen(canvas, "lostpointercapture", onPointerEnd);
  scope.listen(canvas, "contextmenu", event => event.preventDefault());

  const onKeyDown = event => {
    if (event.repeat && ["r", "c", "h"].includes(event.key.toLowerCase())) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "spacebar") { setControl("burner", true); event.preventDefault(); }
    else if (key === "v") { setControl("vent", true); event.preventDefault(); }
    else if (key === "r") { clearContinuousControls(); session?.requestRecovery(); }
    else if (key === "c") cycleCamera();
    else if (key === "h" && guide.hidden) openGuide();
  };
  const onKeyUp = event => {
    const key = event.key.toLowerCase();
    if (key === " " || key === "spacebar") setControl("burner", false);
    else if (key === "v") setControl("vent", false);
  };
  const onBlur = () => { clearContinuousControls(); lookPointer = null; };
  scope.listen(window, "keydown", onKeyDown);
  scope.listen(window, "keyup", onKeyUp);
  scope.listen(window, "blur", onBlur);

  const updateCamera = (snapshot, dt) => {
    const basket = session.world.localOf(snapshot.vehicle.basket.position);
    const envelope = snapshot.stage === "RECOVERED"
      ? { x: basket.x + 8, y: basket.y + 1.5, z: basket.z }
      : session.world.localOf(snapshot.vehicle.envelope.position);
    const mode = CAMERA_MODES[cameraModeIndex];
    if (mode === "PILOT") {
      desiredCamera.set(basket.x, basket.y + 0.86, basket.z);
      const cosPitch = Math.cos(lookPitch);
      desiredTarget.set(
        desiredCamera.x + Math.sin(lookYaw) * cosPitch * 20,
        desiredCamera.y + Math.sin(lookPitch) * 20,
        desiredCamera.z - Math.cos(lookYaw) * cosPitch * 20
      );
      camera.position.lerp(desiredCamera, Math.min(1, dt * 12));
    } else {
      const centerY = (basket.y + envelope.y) * 0.5;
      const radius = mode === "CHASE" ? 31 : 27;
      const angle = mode === "CHASE" ? Math.atan2(snapshot.vehicle.basket.velocity.x + 0.1, snapshot.vehicle.basket.velocity.z + 0.1) + Math.PI : lookYaw;
      desiredCamera.set(basket.x + Math.sin(angle) * radius, centerY + 8 + Math.sin(lookPitch) * 9, basket.z + Math.cos(angle) * radius);
      desiredTarget.set((basket.x + envelope.x) * 0.5, centerY, (basket.z + envelope.z) * 0.5);
      camera.position.lerp(desiredCamera, Math.min(1, dt * (reduceMotion ? 12 : 4.5)));
    }
    camera.lookAt(desiredTarget);
  };

  const frame = now => {
    if (!running || disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    if (!session) {
      if (previewModel && !reduceMotion) previewModel.group.rotation.y += dt * 0.1;
    } else {
      if (guide.hidden && !returnConfirming) session.update(dt);
      const snapshot = session.snapshot();
      const renderVehicle = interpolateVehicle(
        session.clock.previousSnapshot?.vehicle,
        session.clock.currentSnapshot?.vehicle || snapshot.vehicle,
        session.clock.alpha
      );
      phase = guide.hidden ? snapshot.stage : "FLY_GUIDE";
      balloonModel.update(renderVehicle, session.world.origin);
      worldView.sync(snapshot.simTime);
      updateCamera({ ...snapshot, vehicle: renderVehicle }, dt);
      audio.update(snapshot);
    }
    renderer.render(scene, camera);
  };

  scope.listen(canvas, "webglcontextlost", event => {
    event.preventDefault();
    running = false; cancelAnimationFrame(raf);
    session?.pause("webgl-context-lost");
  });
  scope.listen(canvas, "webglcontextrestored", () => {
    resize(); session?.resume(); running = true; last = performance.now(); raf = requestAnimationFrame(frame);
  });

  const debugApi = {
    get stage() { return phase; },
    get controlOwner() { return session?.state.controlOwner || "NONE"; },
    get session() { return session?.snapshot() || null; },
    get atmosphere() { return session ? { sample: (position, time) => session.atmosphere.sample(position, time) } : null; },
    get vehicle() { return session?.vehicle.snapshot() || null; },
    get world() { return session?.world.snapshot() || null; },
    get originShiftCount() { return session?.world.originShiftCount || 0; },
    get activeChunkCount() { return session?.world.chunks.size || 0; },
    get audio() { return audio.status(); },
    get cameras() { return { active: CAMERA_MODES[cameraModeIndex], modes: CAMERA_MODES.slice(), yaw: lookYaw, pitch: lookPitch }; },
    get registries() { return { vehicles: Object.keys(vehicleRegistry), weather: Object.keys(weatherRegistry), selected: { ...DEFAULT_FLY_SELECTION } }; },
    depart: () => { startFlight(); guide.hidden = true; return session?.snapshot(); },
    openGuide,
    closeGuide: () => closeGuide({ depart: false }),
    control: (name, active) => setControl(name, active),
    requestRecovery: () => session?.requestRecovery() || false,
    cycleCamera: () => { cycleCamera(); return CAMERA_MODES[cameraModeIndex]; },
    advance: seconds => { const steps = session?.advance(seconds) || 0; return { steps, snapshot: session?.snapshot() || null }; },
    evidence: () => session ? {
      trajectory: session.state.trajectory.slice(),
      recoveryPlans: session.state.recoveryPlans.slice(),
      originEvents: session.state.originEvents.slice()
    } : null,
    resources: () => ({ rafLoops: running ? 1 : 0, physicsWorlds: session ? 1 : 0, listeners: scope.count, audioVoices: audio.status().voices, chunks: session?.world.chunks.size || 0 })
  };

  return {
    mount() {
      section.classList.add("fly-scene", "physical-ready");
      canvas.setAttribute("aria-label", "FLY three-dimensional configuration and flight scene");
      canvas.tabIndex = 0;
      buildPreview();
      resize();
      window.__FLY__ = debugApi;
    },
    start() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } },
    pause(reason) { running = false; cancelAnimationFrame(raf); clearContinuousControls(); session?.pause(reason); audio.suspend(); },
    resume() { if (disposed || running) return; session?.resume(); audio.resume(); running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
    resize,
    requestReturn() {
      if (!guide.hidden) { closeGuide({ depart: false }); return false; }
      if (!session || session.state.controlOwner === "RECOVERED") return true;
      if (returnConfirming) return true;
      showReturnConfirm();
      return false;
    },
    getDebugSnapshot() {
      return {
        id: "FLY", stage: phase, controlOwner: session?.state.controlOwner || "NONE",
        resources: debugApi.resources(),
        session: session?.snapshot() || null
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false; cancelAnimationFrame(raf);
      clearContinuousControls();
      scope.dispose();
      session?.dispose();
      audio.dispose();
      worldView?.dispose();
      if (balloonModel) { scene.remove(balloonModel.group); balloonModel.dispose(); }
      disposePreview();
      renderer.dispose();
      section.classList.remove("fly-scene", "physical-ready");
      canvas.removeAttribute("tabindex");
      if (window.__FLY__ === debugApi) delete window.__FLY__;
    }
  };
}
