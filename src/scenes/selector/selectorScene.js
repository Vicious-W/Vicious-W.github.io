import * as THREE from "three";
import { createResourceScope } from "../../core/resourceScope.js";

const MAX_DPR = 1.5;

function disposeTree(root) {
  root.traverse(object => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) object.material.forEach(material => material.dispose());
    else object.material?.dispose?.();
  });
}

function reactorMiniature() {
  const group = new THREE.Group();
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x87c8ff, transmission: 0.72, opacity: 0.45, transparent: true, roughness: 0.08 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x173653, metalness: 0.65, roughness: 0.28 });
  const water = new THREE.MeshPhysicalMaterial({ color: 0x0874cc, transparent: true, opacity: 0.78, roughness: 0.12 });
  const shell = new THREE.Mesh(new THREE.BoxGeometry(4.9, 4.2, 4.9), glass);
  shell.position.y = 1.55;
  group.add(shell);
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.65, 2.6, 32, 1, true), steel);
  pool.position.y = 0.45;
  group.add(pool);
  const surface = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 0.08, 32), water);
  surface.position.y = 1.72;
  group.add(surface);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.9, 18), new THREE.MeshBasicMaterial({ color: 0x3cbcff }));
  core.position.y = 0.25;
  group.add(core);
  group.userData.id = "SOURCE";
  return group;
}

function flyMiniature() {
  const group = new THREE.Group();
  const envelope = new THREE.Mesh(
    new THREE.SphereGeometry(2.25, 32, 20),
    new THREE.MeshStandardMaterial({ color: 0x1675d1, roughness: 0.62, metalness: 0.02 })
  );
  envelope.scale.set(1, 1.18, 1);
  envelope.position.y = 1.75;
  group.add(envelope);
  for (let i = 0; i < 16; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(2.26, 0.025, 5, 36, Math.PI), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xbfe6ff : 0xeff9ff }));
    band.rotation.set(0, i * Math.PI / 8, Math.PI / 2);
    band.position.y = 1.75;
    band.scale.y = 1.18;
    group.add(band);
  }
  const basket = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.72, 0.78), new THREE.MeshStandardMaterial({ color: 0x7c4a25, roughness: 0.9 }));
  basket.position.y = -1.35;
  group.add(basket);
  const lines = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.5, -1.0, -0.35), new THREE.Vector3(-1.25, 0.0, -0.8),
      new THREE.Vector3(0.5, -1.0, -0.35), new THREE.Vector3(1.25, 0.0, -0.8),
      new THREE.Vector3(-0.5, -1.0, 0.35), new THREE.Vector3(-1.25, 0.0, 0.8),
      new THREE.Vector3(0.5, -1.0, 0.35), new THREE.Vector3(1.25, 0.0, 0.8)
    ]),
    new THREE.LineBasicMaterial({ color: 0xe8e1ca })
  );
  group.add(lines);
  group.userData.id = "FLY";
  return group;
}

export function createSelectorScene({ section, canvas, reduceMotion, requestScene }) {
  const scope = createResourceScope("site-selector");
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (error) {
    console.error("selector: renderer unavailable", error);
    return null;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(0x020b16, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07182c, 0.025);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
  camera.position.set(0, 4.5, 17);
  camera.lookAt(0, 1, 0);
  scene.add(new THREE.HemisphereLight(0xbfe5ff, 0x06111c, 2.1));
  const key = new THREE.DirectionalLight(0x91ccff, 3.4);
  key.position.set(-5, 9, 8);
  scene.add(key);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(24, 64), new THREE.MeshStandardMaterial({ color: 0x04172a, roughness: 0.78, metalness: 0.25 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2;
  scene.add(floor);
  const source = reactorMiniature();
  source.position.x = -5;
  const fly = flyMiniature();
  fly.position.x = 5;
  scene.add(source, fly);
  const entries = [source, fly];
  let focused = 0;
  let raf = 0;
  let running = false;
  let disposed = false;
  let last = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const resize = () => {
    const width = Math.max(1, section.clientWidth);
    const height = Math.max(1, section.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const portrait = camera.aspect < 0.8;
    const compact = camera.aspect >= 0.8 && camera.aspect < 1.12;
    source.position.x = portrait ? -3 : compact ? -4 : -5;
    fly.position.x = -source.position.x;
    camera.position.set(0, portrait ? 3.2 : 4.5, portrait ? 28 : compact ? 22 : 17);
    camera.lookAt(0, 1, 0);
    camera.updateProjectionMatrix();
  };

  const setFocus = index => {
    focused = (index + entries.length) % entries.length;
    entries.forEach((entry, i) => { entry.userData.focused = i === focused; });
  };

  const pick = event => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(entries, true);
    if (!hits.length) return -1;
    let object = hits[0].object;
    while (object.parent && !entries.includes(object)) object = object.parent;
    return entries.indexOf(object);
  };

  const onPointerMove = event => {
    const index = pick(event);
    if (index >= 0) { setFocus(index); canvas.style.cursor = "pointer"; }
    else canvas.style.cursor = "";
  };
  const onPointerUp = event => {
    const index = pick(event);
    if (index >= 0) requestScene(entries[index].userData.id);
  };
  const onKeyDown = event => {
    if (["ArrowLeft", "ArrowUp"].includes(event.key)) { setFocus(focused - 1); event.preventDefault(); }
    else if (["ArrowRight", "ArrowDown", "Tab"].includes(event.key)) { setFocus(focused + 1); event.preventDefault(); }
    else if (event.key === "Enter" || event.key === " ") { requestScene(entries[focused].userData.id); event.preventDefault(); }
  };

  const frame = now => {
    if (!running || disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    entries.forEach((entry, i) => {
      const target = entry.userData.focused ? 1.08 : 1;
      const scale = THREE.MathUtils.lerp(entry.scale.x, target, reduceMotion ? 1 : Math.min(1, dt * 8));
      entry.scale.setScalar(scale);
      if (!reduceMotion) entry.rotation.y += dt * (i ? 0.16 : -0.1);
      entry.position.y = Math.sin(now * 0.00045 + i * 2.1) * (reduceMotion ? 0 : 0.12);
    });
    renderer.render(scene, camera);
  };

  scope.listen(canvas, "pointermove", onPointerMove);
  scope.listen(canvas, "pointerup", onPointerUp);
  scope.listen(window, "keydown", onKeyDown);
  scope.listen(canvas, "webglcontextlost", event => { event.preventDefault(); running = false; cancelAnimationFrame(raf); });
  scope.listen(canvas, "webglcontextrestored", () => { resize(); running = true; last = performance.now(); raf = requestAnimationFrame(frame); });

  return {
    mount() {
      section.classList.add("selector-scene", "physical-ready");
      canvas.setAttribute("aria-label", "Choose SOURCE or FLY");
      canvas.tabIndex = 0;
      resize();
      setFocus(0);
    },
    start() { if (!running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } },
    pause() { running = false; cancelAnimationFrame(raf); },
    resume() { if (!disposed && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); } },
    resize,
    getDebugSnapshot() {
      return { id: "SITE_SELECT", focused: entries[focused].userData.id, resources: { rafLoops: running ? 1 : 0, listeners: scope.count, physicsWorlds: 0, audioVoices: 0 } };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      cancelAnimationFrame(raf);
      scope.dispose();
      disposeTree(scene);
      renderer.dispose();
      canvas.removeAttribute("tabindex");
      section.classList.remove("selector-scene", "physical-ready");
    }
  };
}
