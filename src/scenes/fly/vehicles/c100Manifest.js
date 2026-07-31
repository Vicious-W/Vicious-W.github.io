const FT_TO_M = 0.3048;
const FT3_TO_M3 = 0.028316846592;
const LB_TO_KG = 0.45359237;

export const C100_MANIFEST = Object.freeze({
  id: "hotAirBalloonC100",
  configurationLabel: "FLY_REFERENCE_CONFIGURATION",
  geometry: Object.freeze({
    gores: { value: 16, unit: "count", label: "PRIMARY_SOURCE", source: "Cameron C-Type" },
    volume: { value: 100000 * FT3_TO_M3, original: "100,000 ft³", unit: "m³", label: "DERIVED" },
    height: { value: 65 * FT_TO_M, original: "65 ft", unit: "m", label: "DERIVED" },
    diameter: { value: 57 * FT_TO_M, original: "57 ft", unit: "m", label: "DERIVED" }
  }),
  certifiedWeight: { value: 2000 * LB_TO_KG, original: "2,000 lb", unit: "kg", label: "DERIVED", role: "limit-not-takeoff-mass" },
  masses: Object.freeze({
    envelope: { value: 218 * LB_TO_KG, unit: "kg", label: "DERIVED", source: "Cameron standard envelope weight" },
    basket: { value: 145, unit: "kg", label: "ENGINEERING_PROXY" },
    frameAndTwinBurners: { value: 58, unit: "kg", label: "ENGINEERING_PROXY" },
    twoTanksEmpty: { value: 52, unit: "kg", label: "ENGINEERING_PROXY" },
    initialFuel: { value: 76, unit: "kg", label: "ENGINEERING_PROXY" },
    pilot: { value: 82, unit: "kg", label: "ENGINEERING_PROXY" }
  }),
  thermal: Object.freeze({
    burnerHeatPowerW: { value: 6000000, label: "ENGINEERING_PROXY" },
    burnerEfficiency: { value: 0.68, label: "ENGINEERING_PROXY" },
    propaneLowerHeatingValueJKg: { value: 46000000, label: "ENGINEERING_PROXY" },
    heatLossWK: { value: 12000, label: "ENGINEERING_PROXY" },
    openMouthLossWK: { value: 2500, label: "ENGINEERING_PROXY" },
    ventLossWK: { value: 36000, label: "ENGINEERING_PROXY" },
    maximumTemperatureK: { value: 395, label: "ENGINEERING_PROXY", role: "material-protection-interlock" }
  }),
  dynamics: Object.freeze({
    suspensionRestLengthM: { value: 12.1, label: "ENGINEERING_PROXY" },
    suspensionStiffnessNm: { value: 19000, label: "ENGINEERING_PROXY" },
    suspensionDampingNsM: { value: 6200, label: "ENGINEERING_PROXY" },
    envelopeCd: { value: 0.47, label: "ENGINEERING_PROXY" },
    basketCd: { value: 1.05, label: "ENGINEERING_PROXY" }
  })
});

export const C100_MASS_WITHOUT_INTERNAL_AIR_KG = Object.values(C100_MANIFEST.masses)
  .reduce((total, entry) => total + entry.value, 0);
