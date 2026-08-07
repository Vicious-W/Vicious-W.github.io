import * as THREE from "three";
import { createResourceScope } from "../../core/resourceScope.js";
import { createFlySession } from "./flySession.js";
import { createBalloonModel } from "./balloonModel.js";
import { createWorldView } from "./worldView.js";
import { createFlyAudio } from "./audio/flyAudio.js";
import { FLY_REGISTRIES } from "./registry.js";
import {
  createConfigKeyboardNavigator,
  createConfigPreviewCatalog,
  createConfigSelectionController,
  layoutConfigPreviewCatalog,
  resolveConfigPointerTarget
} from "./configPreview.js";

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

export function applyOriginShiftToObserver(observer, shift) {
  for (const vector of [observer.cameraPosition, observer.desiredCamera, observer.desiredTarget]) {
    if (!vector) continue;
    vector.x -= shift.delta.x;
    vector.y -= shift.delta.y;
    vector.z -= shift.delta.z;
  }
  return observer;
}

export function createFlyScene({
  section,
  canvas,
  reduceMotion,
  requestSelector,
  registries = FLY_REGISTRIES,
  sessionFactory = createFlySession
}) {
  const activeVehicleRegistry = registries.vehicles;
  const activeWeatherRegistry = registries.weather;
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
  let previewCatalog = null;
  let previewGround = null;
  let configConfirm = null;
  let configSelectables = [];
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
  const pointerControlActions = new Map();
  const controlOwners = { burner: new Set(), vent: new Set() };
  const configController = createConfigSelectionController({
    vehicleRegistry: activeVehicleRegistry,
    weatherRegistry: activeWeatherRegistry
  });
  const configKeyboard = createConfigKeyboardNavigator({
    vehicleRegistry: activeVehicleRegistry,
    weatherRegistry: activeWeatherRegistry
  });
  const configSelection = configController.selection;
  let handledOriginEvents = 0;
  const originCameraCorrections = [];
  let lastGuideFocus = null;
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
    previewCatalog = createConfigPreviewCatalog({
      vehicleRegistry: activeVehicleRegistry,
      weatherRegistry: activeWeatherRegistry,
      seed: 0xc1002026
    });
    previewCatalog.entries.forEach(entry => scene.add(entry.slot));
    layoutConfigPreviewCatalog(previewCatalog, camera.aspect);
    configSelectables.push(...previewCatalog.selectables);
    previewGround = new THREE.Mesh(new THREE.CircleGeometry(55, 64), new THREE.MeshStandardMaterial({ color: 0x456f32, roughness: 0.92 }));
    previewGround.rotation.x = -Math.PI / 2;
    previewGround.position.y = -7.82;
    scene.add(previewGround);

    configConfirm = new THREE.Group();
    configConfirm.name = "FLY-config-confirm";
    configConfirm.position.set(12, -6.7, 0);
    const ringMaterial = new THREE.MeshStandardMaterial({ color: 0x355268, emissive: 0x06121b, metalness: 0.35, roughness: 0.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.22, 10, 48), ringMaterial);
    ring.rotation.x = Math.PI / 2;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.72, 1.92, 0.18, 32), ringMaterial);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.4, 5), ringMaterial);
    arrow.rotation.z = -Math.PI / 2;
    arrow.position.y = 0.55;
    configConfirm.add(ring, pad, arrow);
    configConfirm.traverse(object => {
      if (!object.isMesh) return;
      object.userData.configKind = "confirm";
      object.userData.configId = "confirmedSelection";
      configSelectables.push(object);
    });
    configConfirm.userData.material = ringMaterial;
    scene.add(configConfirm);
    camera.position.set(24, 6, 31);
    camera.lookAt(0, 2, 0);
  };

  const disposePreview = () => {
    if (previewCatalog) {
      previewCatalog.entries.forEach(entry => scene.remove(entry.slot));
      previewCatalog.dispose();
      previewCatalog = null;
    }
    if (configConfirm) { scene.remove(configConfirm); disposeObject(configConfirm); configConfirm = null; }
    configSelectables = [];
    if (previewGround) { scene.remove(previewGround); disposeObject(previewGround); previewGround = null; }
  };

  const resize = () => {
    const width = Math.max(1, section.clientWidth);
    const height = Math.max(1, section.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!session) {
      if (previewCatalog) layoutConfigPreviewCatalog(previewCatalog, camera.aspect);
      camera.position.set(camera.aspect < 0.72 ? 27 : 24, camera.aspect < 0.72 ? 8 : 6, camera.aspect < 0.72 ? 52 : 31);
      camera.lookAt(0, 2, 0);
    }
  };

  const syncConfigVisuals = () => {
    const keyboardFocus = configKeyboard.current();
    previewCatalog?.setSelected(configSelection);
    previewCatalog?.setFocused(keyboardFocus);
    const ready = !!configSelection.vehicleId && !!configSelection.weatherId
      && configController.compatible(configSelection.weatherId, configSelection.vehicleId);
    if (configConfirm) {
      const focused = keyboardFocus.kind === "confirm";
      configConfirm.userData.material.color.setHex(focused ? 0xe7f8ff : ready ? 0x42bdf0 : 0x355268);
      configConfirm.userData.material.emissive.setHex(focused ? 0x176f94 : ready ? 0x0a6d99 : 0x06121b);
      configConfirm.scale.setScalar((ready ? 1.08 : 0.82) * (focused ? 1.08 : 1));
    }
    if (!session) {
      if (keyboardFocus.kind === "confirm") {
        const status = ready
          ? `Confirm ${configSelection.weatherId} weather and ${configSelection.vehicleId} vehicle.`
          : "Configuration incomplete; choose both a compatible weather and vehicle.";
        canvas.setAttribute("aria-label", `FLY configuration. ${status} Use Up and Down Arrow to change category, then Enter or Space to activate.`);
      } else {
        const registry = keyboardFocus.kind === "weather" ? activeWeatherRegistry : activeVehicleRegistry;
        const definition = registry[keyboardFocus.id];
        const name = definition.accessibleLabel || definition.guideDefinition?.title || keyboardFocus.id;
        const selectedId = keyboardFocus.kind === "weather" ? configSelection.weatherId : configSelection.vehicleId;
        const status = selectedId === keyboardFocus.id ? "selected" : "not selected";
        canvas.setAttribute("aria-label", `FLY configuration. ${keyboardFocus.kind} option ${keyboardFocus.index + 1} of ${keyboardFocus.count}: ${name}; ${status}. Use Left and Right Arrow to browse, Up and Down Arrow to change category, then Enter or Space to select.`);
      }
    }
  };

  const selectConfig = (kind, id) => {
    if (session || configSelection.confirmed) return false;
    if (!configController.select(kind, id)) return false;
    configKeyboard.focus(kind, id);
    configKeyboard.focusNext(configSelection);
    syncConfigVisuals();
    return true;
  };

  const confirmConfig = () => {
    if (session) return false;
    if (configSelection.confirmed) { openGuide(); return true; }
    if (!configController.confirm()) return false;
    openGuide();
    return true;
  };

  const clearContinuousControls = () => {
    session?.clearControls();
    pointerControlActions.clear();
    controlOwners.burner.clear();
    controlOwners.vent.clear();
    burnerButton.classList.remove("is-active");
    ventButton.classList.remove("is-active");
  };

  const startFlight = () => {
    if (session || !configSelection.confirmed) return false;
    disposePreview();
    session = sessionFactory({
      seed: 0xc1002026,
      selection: { weatherId: configSelection.weatherId, vehicleId: configSelection.vehicleId },
      registries
    });
    worldView = createWorldView({ scene, world: session.world, atmosphere: session.atmosphere });
    balloonModel = createBalloonModel();
    scene.add(balloonModel.group);
    session.resume();
    audio.unlock();
    flightControls.hidden = false;
    canvas.setAttribute("aria-label", "FLY three-dimensional flight scene");
    phase = "READY_ON_FIELD";
    return true;
  };

  const populateGuide = () => {
    const definition = activeVehicleRegistry[configSelection.vehicleId].guideDefinition;
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
    lastGuideFocus = document.activeElement instanceof HTMLElement ? document.activeElement : canvas;
    clearContinuousControls();
    if (session) session.pause("guide");
    audio.suspend();
    populateGuide();
    guide.hidden = false;
    canvas.inert = true;
    flightControls.inert = true;
    guideLaunch.setAttribute("aria-label", guideWasFlight ? "Close guide and resume flight" : "Confirm selection and begin flight");
    phase = "FLY_GUIDE";
    guideLaunch.focus();
    queueMicrotask(() => { if (!guide.hidden) guideLaunch.focus({ preventScroll: true }); });
  };

  const closeGuide = ({ depart = false } = {}) => {
    if (guide.hidden) return;
    guide.hidden = true;
    canvas.inert = false;
    flightControls.inert = false;
    if (!session && depart) startFlight();
    else if (session) {
      session.resume();
      audio.resume();
      phase = session.state.stage;
    } else phase = "FLY_CONFIG";
    const restore = guideWasFlight && lastGuideFocus?.isConnected ? lastGuideFocus : canvas;
    restore.focus({ preventScroll: true });
    lastGuideFocus = null;
  };

  scope.listen(guide, "keydown", event => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    guideLaunch.focus();
  });

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

  const syncOwnedControl = action => {
    const active = controlOwners[action].size > 0;
    setControl(action, active);
  };

  const claimControl = (action, owner) => {
    if (!session || !setControl(action, true)) return false;
    controlOwners[action].add(owner);
    (action === "burner" ? burnerButton : ventButton).classList.add("is-active");
    return true;
  };

  const releaseControl = (action, owner) => {
    if (!controlOwners[action]?.delete(owner)) return false;
    syncOwnedControl(action);
    return true;
  };

  const claimPointerControl = (pointerId, action) => {
    const owner = `pointer:${pointerId}`;
    const previous = pointerControlActions.get(pointerId);
    if (previous && previous !== action) releaseControl(previous, owner);
    if (!claimControl(action, owner)) return false;
    pointerControlActions.set(pointerId, action);
    return true;
  };

  const releasePointerControl = pointerId => {
    const action = pointerControlActions.get(pointerId);
    if (!action) return false;
    pointerControlActions.delete(pointerId);
    return releaseControl(action, `pointer:${pointerId}`);
  };

  const bindHoldButton = (button, action) => {
    scope.listen(button, "pointerdown", event => {
      if (!claimPointerControl(event.pointerId, action)) return;
      try { button.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
      event.preventDefault();
    });
    const release = event => releasePointerControl(event.pointerId);
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
    if (!session) {
      if (!guide.hidden) return;
      canvasPoint(event);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(configSelectables, false)[0];
      const rect = canvas.getBoundingClientRect();
      const projectedTarget = resolveConfigPointerTarget(
        { x: event.clientX, y: event.clientY },
        configTargetPixels(),
        Math.max(44, Math.min(96, Math.min(rect.width, rect.height) * 0.14))
      );
      const kind = projectedTarget?.kind || hit?.object.userData.configKind;
      const id = projectedTarget?.id || hit?.object.userData.configId;
      if (kind === "confirm") { event.preventDefault(); confirmConfig(); }
      else if (kind && id) { event.preventDefault(); selectConfig(kind, id); }
      else {
        lookPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, config: true };
        try { canvas.setPointerCapture(event.pointerId); } catch (error) { /* synthetic pointer */ }
      }
      return;
    }
    if (!guide.hidden || returnConfirming) return;
    canvasPoint(event);
    raycaster.setFromCamera(pointer, camera);
    const hit = balloonModel ? raycaster.intersectObjects(balloonModel.controlMeshes, false)[0] : null;
    if (hit?.object.userData.action && claimPointerControl(event.pointerId, hit.object.userData.action)) {
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
    if (lookPointer.config) {
      const selected = previewCatalog?.vehicles.get(configSelection.vehicleId)
        || previewCatalog?.vehicles.values().next().value;
      if (selected) selected.preview.group.rotation.y += dx * 0.006;
      return;
    }
    lookYaw -= dx * 0.003;
    lookPitch = clamp(lookPitch - dy * 0.0025, -1.1, 0.85);
  };
  const onPointerEnd = event => {
    releasePointerControl(event.pointerId);
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
    if (!session && guide.hidden) {
      if (event.repeat && (key === "enter" || key === " " || key === "spacebar")) {
        event.preventDefault();
        return;
      }
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "home", "end"].includes(key)) {
        configKeyboard.move(key);
        syncConfigVisuals();
        event.preventDefault();
      } else if (key === "enter" || key === " " || key === "spacebar") {
        const target = configKeyboard.current();
        if (target.kind === "confirm") confirmConfig();
        else selectConfig(target.kind, target.id);
        event.preventDefault();
      }
      return;
    }
    if (key === " " || key === "spacebar") { claimControl("burner", "keyboard:burner"); event.preventDefault(); }
    else if (key === "v") { claimControl("vent", "keyboard:vent"); event.preventDefault(); }
    else if (key === "r") { clearContinuousControls(); session?.requestRecovery(); }
    else if (key === "c") cycleCamera();
    else if (key === "h" && guide.hidden) openGuide();
  };
  const onKeyUp = event => {
    const key = event.key.toLowerCase();
    if (key === " " || key === "spacebar") releaseControl("burner", "keyboard:burner");
    else if (key === "v") releaseControl("vent", "keyboard:vent");
  };
  const onBlur = () => { clearContinuousControls(); lookPointer = null; };
  scope.listen(window, "keydown", onKeyDown);
  scope.listen(window, "keyup", onKeyUp);
  scope.listen(window, "blur", onBlur);
  scope.listen(window, "orientationchange", onBlur);
  scope.listen(document, "visibilitychange", () => { if (document.hidden) onBlur(); });

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
      previewCatalog?.update(now / 1000, reduceMotion);
    } else {
      if (guide.hidden && !returnConfirming) session.update(dt);
      const snapshot = session.snapshot();
      const renderVehicle = interpolateVehicle(
        session.clock.previousSnapshot?.vehicle,
        session.clock.currentSnapshot?.vehicle || snapshot.vehicle,
        session.clock.alpha
      );
      while (handledOriginEvents < session.state.originEvents.length) {
        const event = session.state.originEvents[handledOriginEvents++];
        const before = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
        applyOriginShiftToObserver({
          cameraPosition: camera.position,
          desiredCamera,
          desiredTarget
        }, event);
        originCameraCorrections.push({
          simTime: event.simTime,
          cameraMode: CAMERA_MODES[cameraModeIndex],
          delta: { ...event.delta },
          before,
          after: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
          translationErrorM: Math.hypot(
            camera.position.x - (before.x - event.delta.x),
            camera.position.y - (before.y - event.delta.y),
            camera.position.z - (before.z - event.delta.z)
          )
        });
        if (originCameraCorrections.length > 64) originCameraCorrections.shift();
      }
      phase = guide.hidden ? snapshot.stage : "FLY_GUIDE";
      balloonModel.update(renderVehicle, session.world.origin);
      worldView.sync(snapshot.simTime);
      updateCamera({ ...snapshot, vehicle: renderVehicle }, dt);
      audio.update(snapshot);
    }
    renderer.render(scene, camera);
  };

  const configTargetPixels = () => {
    const rect = canvas.getBoundingClientRect();
    const project = (object, offsetY = 0) => {
      if (!object) return null;
      const position = new THREE.Vector3();
      object.getWorldPosition(position);
      position.y += offsetY;
      position.project(camera);
      return {
        x: rect.left + (position.x + 1) * rect.width * 0.5,
        y: rect.top + (1 - position.y) * rect.height * 0.5
      };
    };
    const vehicleTargets = Object.fromEntries([...previewCatalog?.vehicles.entries() || []]
      .map(([id, entry]) => [id, project(entry.slot, 4)]));
    const weatherTargets = Object.fromEntries([...previewCatalog?.weather.entries() || []]
      .map(([id, entry]) => [id, project(entry.slot)]));
    return {
      weather: Object.values(weatherTargets)[0] || null,
      vehicle: Object.values(vehicleTargets)[0] || null,
      weatherById: weatherTargets,
      vehicleById: vehicleTargets,
      confirm: project(configConfirm)
    };
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
    get registries() {
      return {
        vehicles: Object.keys(activeVehicleRegistry),
        weather: Object.keys(activeWeatherRegistry),
        selected: { ...configSelection }
      };
    },
    get configKeyboard() {
      return { ...configKeyboard.snapshot(), ariaLabel: canvas.getAttribute("aria-label") };
    },
    get configTargets() { return configTargetPixels(); },
    selectConfig,
    confirmConfig,
    depart: () => {
      if (!configSelection.confirmed) return null;
      guide.hidden = true;
      canvas.inert = false;
      flightControls.inert = false;
      startFlight();
      return session?.snapshot() || null;
    },
    openGuide,
    closeGuide: () => closeGuide({ depart: false }),
    control: (name, active) => setControl(name, active),
    requestRecovery: () => session?.requestRecovery() || false,
    cycleCamera: () => { cycleCamera(); return CAMERA_MODES[cameraModeIndex]; },
    advance: seconds => { const steps = session?.advance(seconds) || 0; return { steps, snapshot: session?.snapshot() || null }; },
    evidence: () => session ? {
      trajectory: session.state.trajectory.slice(),
      recoveryPlans: session.state.recoveryPlans.slice(),
      recoveryContactAttempts: session.state.recoveryContactAttempts.slice(),
      originEvents: session.state.originEvents.slice(),
      unsafeContactEvents: session.state.unsafeContactEvents.slice(),
      originCameraCorrections: originCameraCorrections.slice()
    } : null,
    resources: () => ({ rafLoops: running ? 1 : 0, physicsWorlds: session ? 1 : 0, listeners: scope.count, audioVoices: audio.status().voices, chunks: session?.world.chunks.size || 0 })
  };

  return {
    mount() {
      section.classList.add("fly-scene", "physical-ready");
      canvas.removeAttribute("aria-hidden");
      canvas.tabIndex = 0;
      buildPreview();
      syncConfigVisuals();
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
