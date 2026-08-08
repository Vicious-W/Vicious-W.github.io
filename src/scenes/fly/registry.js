import { C100_MANIFEST } from "./vehicles/c100Manifest.js";
import { createHotAirBalloon } from "./vehicles/hotAirBalloon.js";
import { createClearWeather } from "./weather/clearWeather.js";
import { createC100ConfigPreview, createClearWeatherConfigPreview } from "./configPreview.js";

export const vehicleRegistry = Object.freeze({
  hotAirBalloonC100: Object.freeze({
    id: "hotAirBalloonC100",
    accessibleLabel: "Cameron C-100 hot-air balloon",
    manifest: C100_MANIFEST,
    previewFactory: createC100ConfigPreview,
    compatibleWeather: ["clear"],
    vehicleFactory: createHotAirBalloon,
    controlSchema: Object.freeze({ burner: "hold", vent: "hold", recovery: "request" }),
    recoveryStrategy: "wind-layer-balloon-recovery-v1",
    guideDefinition: Object.freeze({
      title: "Cameron C-100 reference balloon",
      controls: Object.freeze([
        Object.freeze({
          action: "burner",
          label: "Main burner",
          keys: Object.freeze(["Space"]),
          screen: "lower-right flame control",
          physical: "yellow handle below the twin burners",
          description: "Hold by key, pointer, or touch; release to close the same burner valve."
        }),
        Object.freeze({
          action: "vent",
          label: "Top vent",
          keys: Object.freeze(["V"]),
          screen: "lower-right red line control",
          physical: "red ring and red overhead deflation line",
          description: "Hold by key, pointer, or touch; release to close the same top vent."
        }),
        Object.freeze({
          action: "recovery",
          label: "Safe recovery",
          keys: Object.freeze(["R"]),
          screen: "lower-left circular-arrow control",
          physical: null,
          description: "Request automatic planning, landing, and recovery; manual flight controls then disable."
        }),
        Object.freeze({
          action: "camera",
          label: "Camera view",
          keys: Object.freeze(["C"]),
          screen: "lower-left camera control",
          physical: null,
          description: "Cycle PILOT, CHASE, and ORBIT; drag the scene to look around."
        }),
        Object.freeze({
          action: "help",
          label: "Vehicle guide",
          keys: Object.freeze(["H"]),
          screen: "top-right question control",
          physical: null,
          description: "Open this guide; flight pauses and held controls release."
        }),
        Object.freeze({
          action: "return",
          label: "End flight",
          keys: Object.freeze(["Esc"]),
          screen: "top-left return control",
          physical: null,
          description: "Open the confirmation step before returning to scene selection."
        })
      ]),
      safety: "There is no direct horizontal steering. Direction comes from the visible wind and thermal layers reached by climbing or descending. Every circular screen control accepts pointer and touch; only the yellow burner handle and red vent ring in PILOT are direct physical hold controls."
    })
  })
});

export const weatherRegistry = Object.freeze({
  clear: Object.freeze({
    id: "clear",
    accessibleLabel: "Clear weather",
    previewFactory: createClearWeatherConfigPreview,
    weatherFactory: createClearWeather,
    compatibleVehicles: ["hotAirBalloonC100"],
    sourceManifest: Object.freeze({ baseline: "U.S. Standard Atmosphere 1976", localField: "ENGINEERING_PROXY" })
  })
});

export const DEFAULT_FLY_SELECTION = Object.freeze({ weatherId: "clear", vehicleId: "hotAirBalloonC100" });

export const FLY_REGISTRIES = Object.freeze({
  vehicles: vehicleRegistry,
  weather: weatherRegistry
});
