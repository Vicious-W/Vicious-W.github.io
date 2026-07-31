import { createPhysicalScene } from "./physicalScene.js";

export function createSourceScene({ section, canvas, reduceMotion }) {
  let physical = null;
  let disposed = false;

  return {
    mount() {
      section.classList.add("source-scene");
      canvas.setAttribute("aria-label", "SOURCE three-dimensional scene");
    },
    start() {
      if (physical || disposed) return;
      physical = createPhysicalScene({ section, canvas, reduceMotion });
    },
    pause() {
      // SOURCE owns its already-accepted visibility pause path. The adapter intentionally
      // does not introduce a second clock or alter reactor behavior.
    },
    resume() {},
    resize() {},
    requestReturn() { return true; },
    getDebugSnapshot() {
      return {
        id: "SOURCE",
        running: !!physical && !disposed,
        resources: { physicsWorlds: physical && !disposed ? 1 : 0, rafLoops: physical && !disposed ? 1 : 0 }
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      physical?.dispose();
      physical = null;
      section.classList.remove("physical-ready", "source-scene");
    }
  };
}
