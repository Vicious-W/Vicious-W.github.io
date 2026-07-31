import { createSceneHost } from "./core/sceneHost.js";

const sceneRoot = document.querySelector(".physical-scene");
const sceneCanvas = document.querySelector(".physical-surface");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (sceneRoot && sceneCanvas) {
  try {
    createSceneHost({ section: sceneRoot, canvas: sceneCanvas, reduceMotion });
  } catch (error) {
    console.error("site scene host failed to load", error);
  }
}
