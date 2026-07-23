const sceneRoot = document.querySelector(".physical-scene");
const sceneCanvas = document.querySelector(".physical-surface");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (sceneRoot && sceneCanvas) {
  import("./scenes/reactor/physicalScene.js")
    .then(({ createPhysicalScene }) => {
      createPhysicalScene({
        section: sceneRoot,
        canvas: sceneCanvas,
        reduceMotion
      });
    })
    .catch(error => {
      console.error("physical scene failed to load", error);
    });
}
