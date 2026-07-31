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
  group.position.set(-12.5, 8.5, -1.5);
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
