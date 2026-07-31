import { standardAtmosphere, moistAirDensity } from "../atmosphere/standardAtmosphere.js";

const TAU = Math.PI * 2;
const smooth = x => x * x * (3 - 2 * x);
const fract = x => x - Math.floor(x);
const hash = (x, z, seed) => fract(Math.sin(x * 127.1 + z * 311.7 + seed * 0.000031) * 43758.5453123);

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(fract(x)), fz = smooth(fract(z));
  const a = hash(ix, iz, seed), b = hash(ix + 1, iz, seed);
  const c = hash(ix, iz + 1, seed), d = hash(ix + 1, iz + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fz;
}

export function createClearWeather(seed = 0xc1002026) {
  const thermals = Array.from({ length: 18 }, (_, index) => {
    const a = hash(index, 19, seed) * TAU;
    const r = 110 + hash(index, 37, seed) * 900;
    return {
      x: Math.cos(a) * r,
      z: Math.sin(a) * r,
      radius: 24 + hash(index, 53, seed) * 38,
      strength: 0.7 + hash(index, 71, seed) * 1.3
    };
  });

  const sample = (position, simTime = 0) => {
    const altitude = Math.max(0, position.y || 0);
    const base = standardAtmosphere(altitude);
    const terrainHeating = valueNoise((position.x + seed * 0.01) / 350, (position.z - seed * 0.01) / 350, seed) - 0.5;
    const temperatureK = base.temperatureK + terrainHeating * 1.6;
    const humidity01 = Math.max(0.18, Math.min(0.62, 0.37 + valueNoise(position.x / 700, position.z / 700, seed + 9) * 0.16 - altitude * 0.000018));
    const densityKgM3 = moistAirDensity(base.pressurePa, temperatureK, humidity01);

    const layer = Math.max(0, Math.min(1, altitude / 900));
    const direction = 0.18 + layer * 1.12 + 0.12 * Math.sin(altitude / 180);
    const speed = 3.8 + altitude * 0.008 + 1.2 * Math.sin(altitude / 95);
    const gustPhase = simTime / 19 + position.x / 470 - position.z / 620;
    const gust = 0.75 * Math.sin(gustPhase) + 0.38 * Math.sin(gustPhase * 0.43 + 2.1);
    let vertical = 0;
    for (const thermal of thermals) {
      const dx = position.x - thermal.x, dz = position.z - thermal.z;
      const radial = Math.hypot(dx, dz) / thermal.radius;
      const altitudeFade = Math.max(0, 1 - altitude / 1400);
      if (radial < 1) vertical += thermal.strength * (1 - radial * radial) * altitudeFade;
      else if (radial < 1.8) vertical -= thermal.strength * 0.14 * (1 - (radial - 1) / 0.8) * altitudeFade;
    }
    const mechanical = Math.exp(-altitude / 55) * (valueNoise(position.x / 32 + simTime / 17, position.z / 32, seed + 101) - 0.5) * 1.1;
    const turbulence = {
      x: mechanical + 0.32 * Math.sin(simTime * 0.37 + position.z / 80),
      y: vertical + mechanical * 0.22,
      z: mechanical * 0.7 + 0.26 * Math.cos(simTime * 0.29 + position.x / 96)
    };
    const windVelocityMps = {
      x: Math.cos(direction) * (speed + gust) + turbulence.x,
      y: turbulence.y,
      z: Math.sin(direction) * (speed + gust) + turbulence.z
    };
    return {
      temperatureK,
      pressurePa: base.pressurePa,
      densityKgM3,
      humidity01,
      windVelocityMps,
      turbulenceVelocityMps: turbulence,
      precipitationKgM2s: 0,
      liquidWaterKgM3: 0,
      electricFieldVm: 0
    };
  };

  return { id: "clear", seed, thermals, sample };
}
