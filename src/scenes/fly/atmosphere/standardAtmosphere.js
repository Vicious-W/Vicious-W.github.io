export const ATMOSPHERE_CONSTANTS = Object.freeze({
  seaLevelTemperatureK: 288.15,
  seaLevelPressurePa: 101325,
  gravityMps2: 9.80665,
  dryAirGasConstantJKgK: 287.05287,
  vaporGasConstantJKgK: 461.495,
  troposphereLapseKPerM: -0.0065
});

export function standardAtmosphere(altitudeM = 0) {
  const c = ATMOSPHERE_CONSTANTS;
  const h = Math.max(-500, Math.min(20000, Number(altitudeM) || 0));
  let temperatureK;
  let pressurePa;
  if (h <= 11000) {
    temperatureK = c.seaLevelTemperatureK + c.troposphereLapseKPerM * h;
    pressurePa = c.seaLevelPressurePa * Math.pow(
      temperatureK / c.seaLevelTemperatureK,
      -c.gravityMps2 / (c.troposphereLapseKPerM * c.dryAirGasConstantJKgK)
    );
  } else {
    const t11 = c.seaLevelTemperatureK + c.troposphereLapseKPerM * 11000;
    const p11 = c.seaLevelPressurePa * Math.pow(
      t11 / c.seaLevelTemperatureK,
      -c.gravityMps2 / (c.troposphereLapseKPerM * c.dryAirGasConstantJKgK)
    );
    temperatureK = t11;
    pressurePa = p11 * Math.exp(-c.gravityMps2 * (h - 11000) / (c.dryAirGasConstantJKgK * t11));
  }
  return {
    altitudeM: h,
    temperatureK,
    pressurePa,
    densityKgM3: pressurePa / (c.dryAirGasConstantJKgK * temperatureK)
  };
}

export function moistAirDensity(pressurePa, temperatureK, humidity01 = 0) {
  const humidity = Math.max(0, Math.min(1, humidity01));
  const tempC = temperatureK - 273.15;
  const saturationPa = 610.94 * Math.exp((17.625 * tempC) / (tempC + 243.04));
  const vaporPa = Math.min(pressurePa * 0.08, saturationPa * humidity);
  const dryPa = pressurePa - vaporPa;
  return dryPa / (ATMOSPHERE_CONSTANTS.dryAirGasConstantJKgK * temperatureK)
    + vaporPa / (ATMOSPHERE_CONSTANTS.vaporGasConstantJKgK * temperatureK);
}
