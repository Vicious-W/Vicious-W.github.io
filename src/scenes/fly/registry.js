import { C100_MANIFEST } from "./vehicles/c100Manifest.js";
import { createHotAirBalloon } from "./vehicles/hotAirBalloon.js";
import { createClearWeather } from "./weather/clearWeather.js";
import { createC100ConfigPreview, createClearWeatherConfigPreview } from "./configPreview.js";

export const vehicleRegistry = Object.freeze({
  hotAirBalloonC100: Object.freeze({
    id: "hotAirBalloonC100",
    manifest: C100_MANIFEST,
    previewFactory: createC100ConfigPreview,
    compatibleWeather: ["clear"],
    vehicleFactory: createHotAirBalloon,
    controlSchema: Object.freeze({ burner: "hold", vent: "hold", recovery: "request" }),
    recoveryStrategy: "wind-layer-balloon-recovery-v1",
    guideDefinition: Object.freeze({
      title: "Cameron C-100 reference balloon",
      controls: Object.freeze([
        ["Space / flame handle", "Hold the main burner; release to close."],
        ["V / red vent line", "Hold the top vent; release to close."],
        ["R / recovery control", "Request automatic safe landing and recovery."],
        ["C / camera control", "Switch PILOT, CHASE, and ORBIT views."],
        ["Pointer / touch", "Look around or hold the physical burner and vent controls."]
      ]),
      safety: "There is no direct horizontal steering. Direction comes from wind layers reached by climbing or descending."
    })
  })
});

export const weatherRegistry = Object.freeze({
  clear: Object.freeze({
    id: "clear",
    previewFactory: createClearWeatherConfigPreview,
    weatherFactory: createClearWeather,
    compatibleVehicles: ["hotAirBalloonC100"],
    sourceManifest: Object.freeze({ baseline: "U.S. Standard Atmosphere 1976", localField: "ENGINEERING_PROXY" })
  })
});

export const DEFAULT_FLY_SELECTION = Object.freeze({ weatherId: "clear", vehicleId: "hotAirBalloonC100" });
