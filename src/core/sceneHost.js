import { createResourceScope } from "./resourceScope.js";
import { createSelectorScene } from "../scenes/selector/selectorScene.js";
import { createSourceScene } from "../scenes/reactor/sourceScene.js";
import { createFlyScene } from "../scenes/fly/flyScene.js";

const SCENES = Object.freeze({ SOURCE: createSourceScene, FLY: createFlyScene });

export function createSceneHost({ section, canvas, reduceMotion = false }) {
  const hostScope = createResourceScope("site-host");
  let active = null;
  let activeId = null;
  let generation = 0;
  let state = "BOOT";
  let disposed = false;
  const counts = { created: { SITE_SELECT: 0, SOURCE: 0, FLY: 0 }, disposed: { SITE_SELECT: 0, SOURCE: 0, FLY: 0 } };

  const context = () => ({
    section,
    canvas,
    reduceMotion,
    generation,
    requestScene: id => activate(id),
    requestSelector: () => activateSelector()
  });

  const teardown = () => {
    if (!active) return;
    const oldId = activeId;
    try { active.dispose(); } finally {
      counts.disposed[oldId]++;
      active = null;
      activeId = null;
      section.className = "physical-scene scene-host";
      canvas.className = "physical-surface";
      canvas.style.cursor = "";
      canvas.removeAttribute("aria-label");
    }
  };

  const mount = (id, factory, options) => {
    teardown();
    generation++;
    activeId = id;
    counts.created[id]++;
    active = factory(context());
    if (!active) throw new Error(`${id} scene did not initialize`);
    active.mount?.(section);
    active.start?.(options);
    state = id === "SITE_SELECT" ? "SITE_SELECT" : `${id}_SESSION`;
    publish();
    return active;
  };

  const activateSelector = () => {
    if (disposed) return null;
    return mount("SITE_SELECT", createSelectorScene);
  };

  const activate = id => {
    const key = String(id || "").toUpperCase();
    if (disposed || !SCENES[key]) return false;
    mount(key, SCENES[key], { seed: 0xc1002026 });
    return true;
  };

  const onVisibility = () => {
    if (!active) return;
    if (document.hidden) active.pause?.("hidden");
    else active.resume?.("visible");
  };
  const onResize = () => active?.resize?.({ width: section.clientWidth, height: section.clientHeight });
  const onKeyDown = event => {
    if (event.key !== "Escape" || activeId === "SITE_SELECT") return;
    if (active?.requestReturn && active.requestReturn() === false) return;
    activateSelector();
  };

  const publish = () => {
    window.__SITE__ = {
      get state() { return state; },
      get activeScene() { return activeId; },
      get sceneGeneration() { return generation; },
      get resourceCounts() {
        return {
          hostListeners: hostScope.count,
          created: { ...counts.created },
          disposed: { ...counts.disposed },
          active: active?.getDebugSnapshot?.()?.resources || null
        };
      },
      chooseScene: id => activate(id),
      returnToSelector: () => activateSelector(),
      snapshot: () => ({
        state, activeScene: activeId, sceneGeneration: generation,
        scene: active?.getDebugSnapshot?.() || null,
        counts: JSON.parse(JSON.stringify(counts))
      })
    };
  };

  hostScope.listen(document, "visibilitychange", onVisibility);
  hostScope.listen(window, "resize", onResize);
  hostScope.listen(window, "keydown", onKeyDown);

  const requested = new URLSearchParams(location.search).get("scene")?.toUpperCase();
  if (requested && SCENES[requested]) activate(requested);
  else activateSelector();

  return {
    activate,
    activateSelector,
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown();
      hostScope.dispose();
      if (window.__SITE__) delete window.__SITE__;
    }
  };
}
