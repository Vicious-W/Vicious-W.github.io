import * as THREE from "three";
import { createBalloonModel } from "./balloonModel.js";

function tagSelectable(root, kind, id) {
  const selectables = [];
  root.traverse(object => {
    if (!object.isMesh && !object.isLine) return;
    object.userData.configKind = kind;
    object.userData.configId = id;
    selectables.push(object);
  });
  return selectables;
}

function registryEntries(registry, kind) {
  return Object.entries(registry || {}).map(([key, definition]) => {
    if (!definition || definition.id !== key || typeof definition.previewFactory !== "function") {
      throw new Error(`Invalid FLY ${kind} registry entry: ${key}`);
    }
    return [key, definition];
  });
}

function createPreviewEntry(kind, id, definition, seed) {
  const preview = definition.previewFactory({
    id,
    definition,
    weather: kind === "weather" ? definition.weatherFactory(seed) : undefined
  });
  if (!preview?.group || typeof preview.dispose !== "function") {
    throw new Error(`Invalid FLY ${kind} preview: ${id}`);
  }
  const selectables = preview.selectables?.length
    ? preview.selectables
    : tagSelectable(preview.group, kind, id);
  for (const object of selectables) {
    object.userData.configKind = kind;
    object.userData.configId = id;
  }
  const slot = new THREE.Group();
  slot.name = `FLY-config-${kind}-${id}`;
  slot.userData.configKind = kind;
  slot.userData.configId = id;
  const focusMaterial = new THREE.MeshBasicMaterial({
    color: 0xf4fbff,
    transparent: true,
    opacity: 0.94,
    depthWrite: false
  });
  const focusMarker = new THREE.Mesh(
    new THREE.TorusGeometry(kind === "vehicle" ? 11.15 : 4.75, 0.105, 8, 64),
    focusMaterial
  );
  focusMarker.name = `FLY-config-focus-${kind}-${id}`;
  focusMarker.position.y = kind === "vehicle" ? -7.74 : 0;
  focusMarker.rotation.x = Math.PI / 2;
  focusMarker.visible = false;
  focusMarker.raycast = () => {};
  slot.add(preview.group, focusMarker);
  return { id, definition, preview, slot, selectables, focusMarker };
}

export function createConfigSelectionController({ vehicleRegistry, weatherRegistry }) {
  const selection = { weatherId: null, vehicleId: null, confirmed: false };
  const compatible = (weatherId, vehicleId) => {
    const weather = weatherRegistry[weatherId];
    const vehicle = vehicleRegistry[vehicleId];
    return !!weather && !!vehicle
      && weather.compatibleVehicles.includes(vehicle.id)
      && vehicle.compatibleWeather.includes(weather.id);
  };
  return {
    selection,
    compatible,
    select(kind, id) {
      if (selection.confirmed) return false;
      if (kind === "weather") {
        const definition = weatherRegistry[id];
        if (!definition) return false;
        selection.weatherId = id;
        if (selection.vehicleId && !compatible(id, selection.vehicleId)) selection.vehicleId = null;
      } else if (kind === "vehicle") {
        const definition = vehicleRegistry[id];
        if (!definition) return false;
        selection.vehicleId = id;
        if (selection.weatherId && !compatible(selection.weatherId, id)) selection.weatherId = null;
      } else return false;
      return true;
    },
    confirm() {
      if (!selection.weatherId || !selection.vehicleId
        || !compatible(selection.weatherId, selection.vehicleId)) return false;
      selection.confirmed = true;
      return true;
    }
  };
}

/**
 * Registry-derived focus order for the canvas configuration controls. Keeping
 * this independent from selection lets an incompatible intermediate state stay
 * reachable while preventing it from being confirmed.
 */
export function createConfigKeyboardNavigator({ vehicleRegistry, weatherRegistry }) {
  const groups = [
    { kind: "weather", ids: Object.keys(weatherRegistry || {}) },
    { kind: "vehicle", ids: Object.keys(vehicleRegistry || {}) },
    { kind: "confirm", ids: ["confirmedSelection"] }
  ];
  if (groups[0].ids.length === 0 || groups[1].ids.length === 0) {
    throw new Error("FLY configuration keyboard navigation requires weather and vehicle entries");
  }
  const itemIndexes = { weather: 0, vehicle: 0, confirm: 0 };
  let groupIndex = 0;
  const current = () => {
    const group = groups[groupIndex];
    const index = itemIndexes[group.kind];
    return { kind: group.kind, id: group.ids[index], index, count: group.ids.length };
  };
  const focus = (kind, id = null) => {
    const nextGroupIndex = groups.findIndex(group => group.kind === kind);
    if (nextGroupIndex < 0) return false;
    const group = groups[nextGroupIndex];
    const nextItemIndex = id == null ? itemIndexes[kind] : group.ids.indexOf(id);
    if (nextItemIndex < 0) return false;
    groupIndex = nextGroupIndex;
    itemIndexes[kind] = nextItemIndex;
    return true;
  };
  return {
    current,
    focus,
    move(key) {
      const normalized = String(key || "").toLowerCase();
      const group = groups[groupIndex];
      if (normalized === "arrowleft" || normalized === "arrowright") {
        const delta = normalized === "arrowright" ? 1 : -1;
        itemIndexes[group.kind] = (itemIndexes[group.kind] + delta + group.ids.length) % group.ids.length;
      } else if (normalized === "home" || normalized === "end") {
        itemIndexes[group.kind] = normalized === "home" ? 0 : group.ids.length - 1;
      } else if (normalized === "arrowup" || normalized === "arrowdown") {
        const delta = normalized === "arrowdown" ? 1 : -1;
        groupIndex = (groupIndex + delta + groups.length) % groups.length;
      } else return false;
      return true;
    },
    focusNext(selection) {
      if (!selection.weatherId) return focus("weather");
      if (!selection.vehicleId) return focus("vehicle");
      return focus("confirm");
    },
    snapshot() { return { ...current() }; }
  };
}

export function resolveConfigPointerTarget(point, targets, radiusPx = 96) {
  const candidates = [
    ...Object.entries(targets?.weatherById || {}).map(([id, target]) => ({ kind: "weather", id, target })),
    ...Object.entries(targets?.vehicleById || {}).map(([id, target]) => ({ kind: "vehicle", id, target })),
    { kind: "confirm", id: "confirmedSelection", target: targets?.confirm }
  ].filter(candidate => Number.isFinite(candidate.target?.x) && Number.isFinite(candidate.target?.y));
  let nearest = null;
  for (const candidate of candidates) {
    const distancePx = Math.hypot(point.x - candidate.target.x, point.y - candidate.target.y);
    if (!nearest || distancePx < nearest.distancePx) nearest = { ...candidate, distancePx };
  }
  if (!nearest || nearest.distancePx > radiusPx) return null;
  return { kind: nearest.kind, id: nearest.id, distancePx: nearest.distancePx };
}

/**
 * Instantiate every registered configuration preview. The scene consumes this
 * collection generically, so adding a compatible registry entry does not add a
 * new branch to the FLY main loop.
 */
export function createConfigPreviewCatalog({ vehicleRegistry, weatherRegistry, seed = 0xc1002026 }) {
  const vehicles = new Map(registryEntries(vehicleRegistry, "vehicle")
    .map(([id, definition]) => [id, createPreviewEntry("vehicle", id, definition, seed)]));
  const weather = new Map(registryEntries(weatherRegistry, "weather")
    .map(([id, definition]) => [id, createPreviewEntry("weather", id, definition, seed)]));
  const entries = [...vehicles.values(), ...weather.values()];
  return {
    vehicles,
    weather,
    entries,
    selectables: entries.flatMap(entry => entry.selectables),
    setSelected(selection) {
      vehicles.forEach(entry => entry.preview.setSelected?.(selection.vehicleId === entry.id));
      weather.forEach(entry => entry.preview.setSelected?.(selection.weatherId === entry.id));
    },
    setFocused(focus) {
      vehicles.forEach(entry => { entry.focusMarker.visible = focus?.kind === "vehicle" && focus.id === entry.id; });
      weather.forEach(entry => { entry.focusMarker.visible = focus?.kind === "weather" && focus.id === entry.id; });
    },
    update(time, reduceMotion = false) {
      entries.forEach(entry => entry.preview.update?.(time, reduceMotion));
    },
    dispose() {
      entries.forEach(entry => {
        entry.slot.remove(entry.preview.group, entry.focusMarker);
        entry.preview.dispose();
        entry.focusMarker.geometry.dispose();
        entry.focusMarker.material.dispose();
      });
      vehicles.clear();
      weather.clear();
    }
  };
}

export function layoutConfigPreviewCatalog(catalog, aspect) {
  const portrait = aspect < 0.72;
  const place = (entries, { centerX, y, z, spacing, multiScale }) => {
    const count = entries.length;
    entries.forEach((entry, index) => {
      entry.slot.position.set(centerX + (index - (count - 1) / 2) * spacing, y, z);
      entry.slot.scale.setScalar(count > 1 ? multiScale : 1);
    });
  };
  place([...catalog.vehicles.values()], {
    centerX: 0,
    y: 0,
    z: 0,
    spacing: portrait ? 12 : 15,
    multiScale: portrait ? 0.62 : 0.7
  });
  place([...catalog.weather.values()], {
    centerX: portrait ? -12.5 : -18,
    y: 8.5,
    z: -1.5,
    spacing: portrait ? 6 : 8,
    multiScale: 0.78
  });
  return catalog;
}

export function createC100ConfigPreview({ id = "hotAirBalloonC100" } = {}) {
  const model = createBalloonModel();
  const group = model.group;
  group.rotation.y = -0.35;
  const fake = {
    envelope: { position: { x: 0, y: 5, z: 0 } },
    basket: { position: { x: 0, y: -7.1, z: 0 }, tilt: { x: 0, y: 0, z: 0 } },
    stage: "PREVIEW",
    heatInputW: 0,
    burnerValve: 0
  };
  model.update(fake);
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: 0x69c9ff,
    transparent: true,
    opacity: 0.22,
    depthWrite: false
  });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(10.2, 0.1, 8, 72), haloMaterial);
  halo.rotation.x = Math.PI / 2;
  halo.position.y = -7.76;
  group.add(halo);
  const selectables = tagSelectable(group, "vehicle", id);
  return {
    id,
    group,
    selectables,
    setSelected(selected) {
      haloMaterial.opacity = selected ? 0.92 : 0.22;
      group.scale.setScalar(selected ? 1.025 : 1);
    },
    update(time, reduceMotion = false) {
      if (!reduceMotion) group.rotation.y += 0.0014 + Math.sin(time * 0.35) * 0.00015;
    },
    dispose() { model.dispose(); }
  };
}

export function createClearWeatherConfigPreview({ id = "clear", weather = null } = {}) {
  const group = new THREE.Group();
  const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xffd983 });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(2.05, 24, 16), sunMaterial);
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: 0x8bd9ff,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  const rings = new THREE.Group();
  for (let index = 0; index < 3; index++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.1 + index * 0.75, 0.08, 6, 48), haloMaterial);
    ring.rotation.set(Math.PI / 2 + index * 0.24, index * 0.31, 0);
    rings.add(ring);
  }
  const windMaterial = new THREE.MeshBasicMaterial({ color: 0xd9f5ff });
  const windBeads = new THREE.Group();
  for (let index = 0; index < 7; index++) {
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), windMaterial);
    bead.userData.phase = index / 7;
    windBeads.add(bead);
  }
  group.add(sun, rings, windBeads);
  const selectables = tagSelectable(group, "weather", id);
  return {
    id,
    group,
    selectables,
    setSelected(selected) {
      haloMaterial.opacity = selected ? 0.9 : 0.22;
      sunMaterial.color.setHex(selected ? 0xffedac : 0xffd983);
      group.scale.setScalar(selected ? 1.08 : 1);
    },
    update(time, reduceMotion = false) {
      if (!reduceMotion) rings.rotation.y = time * 0.13;
      const sample = weather?.sample({ x: 0, y: 35, z: 0 }, time);
      const wind = sample?.windVelocityMps || { x: 4, z: 1 };
      const speed = THREE.MathUtils.clamp(Math.hypot(wind.x, wind.z), 1, 12);
      windBeads.rotation.y = Math.atan2(wind.z, wind.x);
      windBeads.children.forEach(bead => {
        const progress = (bead.userData.phase + time * speed * 0.018) % 1;
        bead.position.set(-4.2 + progress * 8.4, Math.sin(progress * Math.PI * 2) * 0.42, 2.4 + Math.cos(progress * Math.PI * 2) * 0.24);
      });
    },
    dispose() {
      const geometries = new Set(), materials = new Set();
      group.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        if (object.material) materials.add(object.material);
      });
      geometries.forEach(geometry => geometry.dispose());
      materials.forEach(material => material.dispose());
    }
  };
}
