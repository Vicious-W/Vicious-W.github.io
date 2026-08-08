import * as THREE from "three";
import { createResourceScope } from "../../core/resourceScope.js";
import { createFlySession } from "./flySession.js";
import { C100_PILOT_ANCHORS, createBalloonModel } from "./balloonModel.js";
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
const PILOT_CONSOLE_CENTER = Object.freeze({
  x: (C100_PILOT_ANCHORS.burner.x + C100_PILOT_ANCHORS.vent.x) * 0.5,
  y: (C100_PILOT_ANCHORS.burner.y + C100_PILOT_ANCHORS.vent.y) * 0.5,
  z: (C100_PILOT_ANCHORS.burner.z + C100_PILOT_ANCHORS.vent.z) * 0.5
});

export const PILOT_VIEW_CONFIG = Object.freeze({
  fovDeg: 84,
  nearM: 0.035,
  farM: 16000,
  defaultYawRad: 0,
  defaultPitchRad: 0.29,
  minYawRad: -0.3,
  maxYawRad: 0.3,
  minPitchRad: 0.1,
  maxPitchRad: 0.72,
  eye: C100_PILOT_ANCHORS.eye
});

export function createContinuousControlLedger(actions = ["burner", "vent"]) {
  const owners = Object.fromEntries(actions.map(action => [action, new Set()]));
  const requireAction = action => {
    if (!owners[action]) throw new Error(`Unknown continuous control: ${action}`);
    return owners[action];
  };
  return {
    claim(action, owner) {
      requireAction(action).add(owner);
      return true;
    },
    release(action, owner) {
      return requireAction(action).delete(owner);
    },
    clear() {
      Object.values(owners).forEach(actionOwners => actionOwners.clear());
    },
    active(action) {
      return requireAction(action).size > 0;
    },
    snapshot() {
      return Object.fromEntries(Object.entries(owners).map(([action, actionOwners]) => [
        action,
        [...actionOwners].sort()
      ]));
    }
  };
}

export function resolvePilotEyePosition(
  basketPosition,
  basketTilt,
  target = new THREE.Vector3(),
  rotation = new THREE.Euler()
) {
  return target.set(
    PILOT_VIEW_CONFIG.eye.x,
    PILOT_VIEW_CONFIG.eye.y,
    PILOT_VIEW_CONFIG.eye.z
  ).applyEuler(rotation.set(basketTilt.x, 0, basketTilt.z)).add(basketPosition);
}

export function lockPilotTranslation(cameraPosition, desiredPosition) {
  cameraPosition.copy(desiredPosition);
  return cameraPosition;
}

export function deriveFlightControlState(snapshot, cameraMode = "PILOT") {
  const owner = snapshot?.controlOwner || "NONE";
  const manual = owner === "MANUAL";
  const manualControls = snapshot?.manualControls || { burner: 0, vent: 0 };
  const vehicle = snapshot?.vehicle || {};
  return {
    burner: {
      disabled: !manual || vehicle.fuelKg <= 1e-8 || !!vehicle.temperatureLimited,
      pressed: manual && manualControls.burner > 0.5,
      status: !manual ? "automatic-owner" : vehicle.temperatureLimited ? "temperature-limited" : "available"
    },
    vent: {
      disabled: !manual,
      pressed: manual && manualControls.vent > 0.5,
      status: manual ? "available" : "automatic-owner"
    },
    recovery: {
      disabled: !manual,
      pressed: owner === "AUTO_RECOVERY",
      status: owner === "RECOVERED" ? "recovered" : owner === "AUTO_RECOVERY" ? "automatic" : "available"
    },
    camera: { disabled: false, pressed: false, status: String(cameraMode).toLowerCase() },
    help: { disabled: false, pressed: false, status: "available" },
    return: { disabled: false, pressed: false, status: "available" }
  };
}

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
  const camera = new THREE.PerspectiveCamera(56, 1, 0.08, PILOT_VIEW_CONFIG.farM);
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
  let lookYaw = PILOT_VIEW_CONFIG.defaultYawRad;
  let lookPitch = PILOT_VIEW_CONFIG.defaultPitchRad;
  let lookPointer = null;
  const pointerControlActions = new Map();
  const controlOwners = createContinuousControlLedger();
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
  const pilotEyeOffset = new THREE.Vector3();
  const pilotConsoleOffset = new THREE.Vector3();
  const pilotBasketRotation = new THREE.Euler();
  let pilotEffectiveYaw = lookYaw;
  let pilotEffectivePitch = lookPitch;
  let pilotFramingAssisted = false;

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
  guideSafety.id = "fly-guide-safety";
  guide.setAttribute("aria-describedby", guideSafety.id);
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
  burnerButton.setAttribute("aria-keyshortcuts", "Space");
  ventButton.setAttribute("aria-keyshortcuts", "V");
  recoveryButton.setAttribute("aria-keyshortcuts", "R");
  cameraButton.setAttribute("aria-keyshortcuts", "C");
  helpButton.setAttribute("aria-keyshortcuts", "H");
  returnButton.setAttribute("aria-keyshortcuts", "Escape");
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

  const flightButtons = Object.freeze({
    burner: burnerButton,
    vent: ventButton,
    recovery: recoveryButton,
    camera: cameraButton,
    help: helpButton,
    return: returnButton
  });

  const syncFlightControlState = snapshot => {
    const presentation = deriveFlightControlState(snapshot, CAMERA_MODES[cameraModeIndex]);
    for (const [action, button] of Object.entries(flightButtons)) {
      const state = presentation[action];
      button.disabled = state.disabled;
      button.setAttribute("aria-disabled", String(state.disabled));
      button.dataset.status = state.status;
      button.classList.toggle("is-active", state.pressed);
      if (action === "burner" || action === "vent") {
        button.classList.toggle("is-pressed", state.pressed);
      }
      button.classList.toggle("is-automatic", action === "recovery" && state.status === "automatic");
      button.classList.toggle("is-complete", action === "recovery" && state.status === "recovered");
      if (["burner", "vent", "recovery"].includes(action)) {
        button.setAttribute("aria-pressed", String(state.pressed));
      }
    }
    cameraButton.dataset.mode = CAMERA_MODES[cameraModeIndex];
    cameraButton.setAttribute("aria-label", `Change camera; current view ${CAMERA_MODES[cameraModeIndex]}`);
    return presentation;
  };

  const setGuidePhysicalHighlights = active => {
    balloonModel?.setGuideHighlights(active);
    previewCatalog?.vehicles.get(configSelection.vehicleId)?.preview.setGuideHighlights?.(active);
  };

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
    controlOwners.clear();
    if (session) syncFlightControlState(session.snapshot());
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
    lookYaw = PILOT_VIEW_CONFIG.defaultYawRad;
    lookPitch = PILOT_VIEW_CONFIG.defaultPitchRad;
    cameraModeIndex = 0;
    session.resume();
    audio.unlock();
    flightControls.hidden = false;
    canvas.setAttribute("aria-label", "FLY three-dimensional flight scene");
    phase = "READY_ON_FIELD";
    const snapshot = session.snapshot();
    syncFlightControlState(snapshot);
    updateCamera(snapshot, 1);
    return true;
  };

  const populateGuide = () => {
    const definition = activeVehicleRegistry[configSelection.vehicleId].guideDefinition;
    guideTitle.textContent = definition.title;
    guideList.replaceChildren();
    definition.controls.forEach(control => {
      const dt = document.createElement("dt");
      dt.dataset.action = control.action;
      const symbol = document.createElement("span");
      symbol.className = `fly-guide-symbol fly-guide-symbol-${control.action}`;
      symbol.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = control.label;
      const keys = document.createElement("span");
      keys.className = "fly-guide-keys";
      control.keys.forEach(key => {
        const keycap = document.createElement("kbd");
        keycap.textContent = key;
        keys.append(keycap);
      });
      dt.append(symbol, label, keys);
      const dd = document.createElement("dd");
      const mapping = document.createElement("span");
      mapping.className = "fly-guide-mapping";
      mapping.textContent = `Screen: ${control.screen}. ${control.description}`;
      dd.append(mapping);
      if (control.physical) {
        const physical = document.createElement("span");
        physical.className = "fly-guide-physical";
        physical.textContent = `Physical control: ${control.physical}.`;
        dd.append(physical);
      }
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
    setGuidePhysicalHighlights(true);
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
    setGuidePhysicalHighlights(false);
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

  const cycleCamera = () => {
    cameraModeIndex = (cameraModeIndex + 1) % CAMERA_MODES.length;
    if (session) syncFlightControlState(session.snapshot());
    return CAMERA_MODES[cameraModeIndex];
  };

  const requestRecovery = () => {
    clearContinuousControls();
    const accepted = session?.requestRecovery() || false;
    if (session) syncFlightControlState(session.snapshot());
    return accepted;
  };

  const showReturnConfirm = () => {
    if (!session || session.state.controlOwner === "RECOVERED") { requestSelector(); return; }
    if (returnConfirming) return;
    returnConfirming = true;
    clearContinuousControls();
    session.pause("return-confirm");
    audio.suspend();
    flightControls.inert = true;
    canvas.inert = true;
    returnConfirm.hidden = false;
    confirmReturnButton.focus();
  };
  const cancelReturn = () => {
    if (!returnConfirming) return;
    returnConfirming = false;
    returnConfirm.hidden = true;
    flightControls.inert = false;
    canvas.inert = false;
    session?.resume();
    audio.resume();
    canvas.focus({ preventScroll: true });
  };

  const setControl = (action, active) => {
    if (!session || guide.hidden === false || returnConfirming) return false;
    const accepted = session.setControl(action, active);
    if (accepted) syncFlightControlState(session.snapshot());
    return accepted;
  };

  const syncOwnedControl = action => {
    const active = controlOwners.active(action);
    setControl(action, active);
  };

  const claimControl = (action, owner) => {
    if (!session || !setControl(action, true)) return false;
    controlOwners.claim(action, owner);
    return true;
  };

  const releaseControl = (action, owner) => {
    if (!controlOwners.release(action, owner)) return false;
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
    const release = event => {
      releasePointerControl(event.pointerId);
    };
    scope.listen(button, "pointerup", release);
    scope.listen(button, "pointercancel", release);
    scope.listen(button, "lostpointercapture", release);
    scope.listen(button, "keydown", event => {
      if (![' ', "Enter"].includes(event.key) || event.repeat) return;
      claimControl(action, `button-keyboard:${action}`);
      event.preventDefault();
      event.stopPropagation();
    });
    scope.listen(button, "keyup", event => {
      if (![' ', "Enter"].includes(event.key)) return;
      releaseControl(action, `button-keyboard:${action}`);
      event.preventDefault();
      event.stopPropagation();
    });
  };
  bindHoldButton(burnerButton, "burner");
  bindHoldButton(ventButton, "vent");

  for (const button of Object.values(flightButtons)) {
    scope.listen(button, "pointerdown", () => {
      if (!button.disabled && button !== burnerButton && button !== ventButton) {
        button.classList.add("is-pressed");
      }
    });
    const releaseFeedback = () => {
      if (button !== burnerButton && button !== ventButton) button.classList.remove("is-pressed");
    };
    scope.listen(button, "pointerup", releaseFeedback);
    scope.listen(button, "pointercancel", releaseFeedback);
    scope.listen(button, "pointerleave", releaseFeedback);
    if (button !== burnerButton && button !== ventButton) {
      scope.listen(button, "keydown", event => {
        if (![' ', "Enter"].includes(event.key) || button.disabled) return;
        button.classList.add("is-pressed");
        event.stopPropagation();
      });
      scope.listen(button, "keyup", event => {
        if (![' ', "Enter"].includes(event.key)) return;
        button.classList.remove("is-pressed");
        event.stopPropagation();
      });
    }
  }

  scope.listen(recoveryButton, "click", requestRecovery);
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
    const hits = balloonModel ? raycaster.intersectObjects(balloonModel.controlMeshes, false) : [];
    const hitActions = new Set(hits.map(hit => hit.object.userData.action).filter(Boolean));
    let physicalAction = null;
    let nearestControlDistance = Infinity;
    for (const [action, anchor] of Object.entries(balloonModel?.controlAnchors || {})) {
      if (!hitActions.has(action)) continue;
      const projected = new THREE.Vector3();
      anchor.getWorldPosition(projected);
      projected.project(camera);
      const distance = Math.hypot(pointer.x - projected.x, pointer.y - projected.y);
      if (distance < nearestControlDistance) {
        nearestControlDistance = distance;
        physicalAction = action;
      }
    }
    if (physicalAction && claimPointerControl(event.pointerId, physicalAction)) {
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
    lookYaw = clamp(
      lookYaw - dx * 0.003,
      PILOT_VIEW_CONFIG.minYawRad,
      PILOT_VIEW_CONFIG.maxYawRad
    );
    lookPitch = clamp(
      lookPitch - dy * 0.0025,
      PILOT_VIEW_CONFIG.minPitchRad,
      PILOT_VIEW_CONFIG.maxPitchRad
    );
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
    else if (key === "r") requestRecovery();
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
      if (camera.fov !== PILOT_VIEW_CONFIG.fovDeg || camera.near !== PILOT_VIEW_CONFIG.nearM) {
        camera.fov = PILOT_VIEW_CONFIG.fovDeg;
        camera.near = PILOT_VIEW_CONFIG.nearM;
        camera.far = PILOT_VIEW_CONFIG.farM;
        camera.updateProjectionMatrix();
      }
      pilotBasketRotation.set(
        snapshot.vehicle.basket.tilt.x,
        0,
        snapshot.vehicle.basket.tilt.z
      );
      resolvePilotEyePosition(basket, snapshot.vehicle.basket.tilt, desiredCamera, pilotBasketRotation);
      pilotEyeOffset.copy(desiredCamera).sub(basket);
      pilotConsoleOffset.set(
        PILOT_CONSOLE_CENTER.x,
        PILOT_CONSOLE_CENTER.y,
        PILOT_CONSOLE_CENTER.z
      ).applyEuler(pilotBasketRotation);
      const consoleX = pilotConsoleOffset.x - pilotEyeOffset.x;
      const consoleY = pilotConsoleOffset.y - pilotEyeOffset.y;
      const consoleZ = pilotConsoleOffset.z - pilotEyeOffset.z;
      const consoleYaw = Math.atan2(consoleX, -consoleZ);
      const consolePitch = Math.atan2(consoleY, Math.hypot(consoleX, consoleZ));
      const verticalMargin = THREE.MathUtils.degToRad(camera.fov * 0.5) * 0.72;
      const horizontalMargin = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) * camera.aspect) * 0.72;
      pilotEffectiveYaw = clamp(lookYaw, consoleYaw - horizontalMargin, consoleYaw + horizontalMargin);
      pilotEffectivePitch = clamp(lookPitch, consolePitch - verticalMargin, consolePitch + verticalMargin);
      pilotFramingAssisted = Math.abs(pilotEffectiveYaw - lookYaw) > 1e-5
        || Math.abs(pilotEffectivePitch - lookPitch) > 1e-5;
      const cosPitch = Math.cos(pilotEffectivePitch);
      desiredTarget.set(
        desiredCamera.x + Math.sin(pilotEffectiveYaw) * cosPitch * 20,
        desiredCamera.y + Math.sin(pilotEffectivePitch) * 20,
        desiredCamera.z - Math.cos(pilotEffectiveYaw) * cosPitch * 20
      );
      lockPilotTranslation(camera.position, desiredCamera);
    } else {
      if (camera.fov !== 56 || camera.near !== 0.08) {
        camera.fov = 56;
        camera.near = 0.08;
        camera.far = PILOT_VIEW_CONFIG.farM;
        camera.updateProjectionMatrix();
      }
      const centerY = (basket.y + envelope.y) * 0.5;
      const radius = mode === "CHASE" ? 31 : 27;
      const angle = mode === "CHASE" ? Math.atan2(snapshot.vehicle.basket.velocity.x + 0.1, snapshot.vehicle.basket.velocity.z + 0.1) + Math.PI : lookYaw;
      desiredCamera.set(basket.x + Math.sin(angle) * radius, centerY + 8 + Math.sin(lookPitch) * 9, basket.z + Math.cos(angle) * radius);
      desiredTarget.set((basket.x + envelope.x) * 0.5, centerY, (basket.z + envelope.z) * 0.5);
      camera.position.lerp(desiredCamera, Math.min(1, dt * (reduceMotion ? 12 : 4.5)));
    }
    camera.up.set(0, 1, 0);
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
      balloonModel.setControlState(snapshot.controlOwner === "MANUAL" ? snapshot.manualControls : snapshot.controls);
      balloonModel.update(renderVehicle, session.world.origin);
      worldView.sync(snapshot.simTime, snapshot.vehicle.basket.position);
      updateCamera({ ...snapshot, vehicle: renderVehicle }, dt);
      syncFlightControlState(snapshot);
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

  const flightTargetPixels = () => {
    if (!balloonModel) return null;
    balloonModel.group.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    const rect = canvas.getBoundingClientRect();
    return Object.fromEntries(Object.entries(balloonModel.controlAnchors).map(([action, object]) => {
      const worldPosition = new THREE.Vector3();
      object.getWorldPosition(worldPosition);
      const cameraPosition = worldPosition.clone().applyMatrix4(camera.matrixWorldInverse);
      const ndc = worldPosition.clone().project(camera);
      return [action, {
        x: rect.left + (ndc.x + 1) * rect.width * 0.5,
        y: rect.top + (1 - ndc.y) * rect.height * 0.5,
        ndc: { x: ndc.x, y: ndc.y, z: ndc.z },
        cameraDepthM: -cameraPosition.z,
        visible: cameraPosition.z < -camera.near && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1
      }];
    }));
  };

  const controlDomSnapshot = () => {
    const heldOwners = controlOwners.snapshot();
    return Object.fromEntries(Object.entries(flightButtons).map(([action, button]) => [action, {
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled"),
      ariaPressed: button.getAttribute("aria-pressed"),
      status: button.dataset.status,
      mode: button.dataset.mode || null,
      classes: [...button.classList],
      heldOwners: heldOwners[action] || []
    }]));
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
    get cameras() {
      return {
        active: CAMERA_MODES[cameraModeIndex],
        modes: CAMERA_MODES.slice(),
        yaw: lookYaw,
        pitch: lookPitch,
        effectiveYaw: pilotEffectiveYaw,
        effectivePitch: pilotEffectivePitch,
        framingAssisted: pilotFramingAssisted,
        fovDeg: camera.fov,
        nearM: camera.near,
        farM: camera.far,
        yawLimits: [PILOT_VIEW_CONFIG.minYawRad, PILOT_VIEW_CONFIG.maxYawRad],
        pitchLimits: [PILOT_VIEW_CONFIG.minPitchRad, PILOT_VIEW_CONFIG.maxPitchRad],
        translationLockErrorM: CAMERA_MODES[cameraModeIndex] === "PILOT"
          ? camera.position.distanceTo(desiredCamera)
          : null
      };
    },
    get worldView() { return worldView?.snapshot() || null; },
    get controls() { return controlDomSnapshot(); },
    get physicalControlTargets() { return flightTargetPixels(); },
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
    requestRecovery,
    cycleCamera,
    setLook: (yaw, pitch) => {
      lookYaw = clamp(
        Number.isFinite(yaw) ? yaw : lookYaw,
        PILOT_VIEW_CONFIG.minYawRad,
        PILOT_VIEW_CONFIG.maxYawRad
      );
      lookPitch = clamp(
        Number.isFinite(pitch) ? pitch : lookPitch,
        PILOT_VIEW_CONFIG.minPitchRad,
        PILOT_VIEW_CONFIG.maxPitchRad
      );
      return { yaw: lookYaw, pitch: lookPitch };
    },
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
