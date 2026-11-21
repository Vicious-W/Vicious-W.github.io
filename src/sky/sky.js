import * as THREE from "three";
import { createPass } from "./fullscreen.js";
import { makeBlueNoise } from "./bluenoise.js";
import { bakeCumulusShapes, placeGiants, GIANTS, SHAPE } from "./cumulus.js";
import vertexShader from "../shaders/fullscreen.vert?raw";
import common from "../shaders/common.glsl?raw";
import transmittanceSrc from "../shaders/transmittance.frag?raw";
import multiScatterSrc from "../shaders/multiscatter.frag?raw";
import skyViewSrc from "../shaders/skyview.frag?raw";
import noiseSrc from "../shaders/noise.frag?raw";
import cloudMapSrc from "../shaders/cloudmap.frag?raw";
import cloudSlopeSrc from "../shaders/cloudslope.frag?raw";
import cloudsSrc from "../shaders/clouds.frag?raw";
import stormSrc from "../shaders/storm.glsl?raw";
import mistSrc from "../shaders/mist.frag?raw";
import mistTemporalSrc from "../shaders/misttemporal.frag?raw";
import temporalSrc from "../shaders/temporal.frag?raw";
import compositeSrc from "../shaders/composite.frag?raw";

const HEADER = [
  "precision highp float;",
  "precision highp int;",
  "precision highp sampler2D;",
  "precision highp sampler3D;",
  "in vec2 vUv;",
  ""
].join("\n");
const fragment = body => `${HEADER}${common}\n${body}`;

/** World-scale cloud parameters shared by JS (offset wrapping) and GLSL (defines). */
export const CLOUD = Object.freeze({
  bottom: 1500,
  topMax: 8200,
  basePeriod: 4800,
  baseYScale: 1.25,
  detailPeriod: 640,
  weatherPeriodA: 42000,
  weatherPeriodB: 11000,
  weatherPeriodC: 17000,
  cloudMapPeriod: 81920,
  cloudMapSize: 2048,
  cirrusPeriod: 26000,
  wind: { x: 7.0, z: -3.0 },
  cirrusWind: { x: 19.0, z: -5.0 }
});

// Rotations used in GLSL as mat2 (column-major): rotate(v) = (c*x - s*y, s*x + c*y).
const WEATHER_ROT = { c: 0.8, s: 0.6 };
const WEATHER_ROT2 = { c: 0.28, s: 0.96 };
const CLOUDMAP_ROT = { c: 0.96, s: 0.28 };
// Cirrus: rotate(v) = (0.6*x + 0.8*y, -0.8*x + 0.6*y), then stretch x by 0.28 into streaks.
const CIRRUS_ROT = { c: 0.6, s: -0.8 };
const CIRRUS_STRETCH = 0.28;
const wrap = (v, p) => v - p * Math.floor(v / p);

// The storm's mist (storm.glsl): its noise tiles every 256 m and drifts with the air (m/s); the
// smooth part of the base noise, drifting otherwise, stirs it.
export const MIST = Object.freeze({ period: 256, drift: { x: 2.5, y: 5.0, z: -1.8 } });
// The storm boils (night): its billows rise (m/s), its bulges roll up faster still. By day the
// clouds drift as they always have.
// Rates of a strong storm's updrafts, so that a tower's outline is seen to change within seconds.
const BOIL = Object.freeze({ billows: { x: 8.0, y: 22.0, z: -5.0 }, bulges: { x: -6.0, y: 28.0, z: 4.0 } });
// The mist pass draws the storm's cloud within this distance of the eye (m), at this fraction
// of the screen's resolution (mist is soft; its finest detail is a few pixels across).
export const NEAR = Object.freeze({ reach: 240, scale: 0.5 });
/** The storm's cloud code (storm.glsl) put in its place in a shader that uses it. */
export const withStorm = src => src.replace("// @storm (storm.glsl goes here)", stormSrc);

// One giant is placed by hand ahead of the starting view, so the first minutes include one.
// u: size, position in its cell (x, z), height, rotation, shape, thickness (all 0..1).
const HERO_GIANT = { i: 0, j: 3, u: [0.62, 0.55, 0.75, 0.7, 0.15, 0.0, 0.9] };
const glslFloat = v => (Number.isInteger(v) ? `${v}.0` : `${v}`);

function floatTarget(width, height, extra = {}) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    ...extra
  });
}

/** Histogram-equalise 8-bit channels in place, so thresholds map linearly to coverage. */
function equalize(data, channels) {
  const count = data.length / 4;
  for (const c of channels) {
    const hist = new Uint32Array(256);
    for (let i = c; i < data.length; i += 4) hist[data[i]]++;
    const lut = new Uint8Array(256);
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.min(255, Math.round(((acc + hist[v] * 0.5) / count) * 255));
      acc += hist[v];
    }
    for (let i = c; i < data.length; i += 4) data[i] = lut[data[i]];
  }
}

function bakeWeather(renderer, pass, size) {
  const target = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false
  });
  pass.uniforms.uMode.value = 2;
  pass.render(renderer, target);
  const data = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(target, 0, 0, size, size, data);
  target.dispose();
  equalize(data, [0, 1, 2, 3]);
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Bakes a tileable 3D noise. pack(rgba): optional, turns the four equalised channels into one
 * value 0..1, stored as a half float: half the memory of the four 8-bit channels, and smooth
 * where the shader cuts it at a threshold (8 bits left terraces there).
 */
function bakeVolume(renderer, pass, mode, size, slicesPerChunk, equalizeChannels, pack = null) {
  const target = new THREE.WebGLRenderTarget(size, size * slicesPerChunk, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false
  });
  const data = new Uint8Array(size * size * size * 4);
  const slab = new Uint8Array(size * size * slicesPerChunk * 4);
  pass.uniforms.uMode.value = mode;
  pass.uniforms.uSize.value = size;
  pass.uniforms.uDepth.value = size;
  for (let z0 = 0; z0 < size; z0 += slicesPerChunk) {
    pass.uniforms.uZ0.value = z0;
    pass.render(renderer, target);
    renderer.readRenderTargetPixels(target, 0, 0, size, size * slicesPerChunk, slab);
    data.set(slab, z0 * size * size * 4);
  }
  target.dispose();
  equalize(data, equalizeChannels);
  let texels = data;
  if (pack) {
    // Equalise the packed values (a fine histogram), so they spread evenly over 0..1.
    const n = size * size * size;
    const BINS = 65536;
    const bin = new Uint16Array(n);
    const hist = new Uint32Array(BINS);
    for (let i = 0; i < n; i++) {
      const v = pack(data[i * 4] / 255, data[i * 4 + 1] / 255, data[i * 4 + 2] / 255, data[i * 4 + 3] / 255);
      bin[i] = Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)));
      hist[bin[i]]++;
    }
    const lut = new Uint16Array(BINS);
    let acc = 0;
    for (let b = 0; b < BINS; b++) {
      lut[b] = THREE.DataUtils.toHalfFloat((acc + hist[b] * 0.5) / n);
      acc += hist[b];
    }
    texels = new Uint16Array(n);
    for (let i = 0; i < n; i++) texels[i] = lut[bin[i]];
  }
  const texture = new THREE.Data3DTexture(texels, size, size, size);
  texture.format = pack ? THREE.RedFormat : THREE.RGBAFormat;
  texture.type = pack ? THREE.HalfFloatType : THREE.UnsignedByteType;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Physically based sky (Hillaire 2020 LUTs), raymarched cumulus at reduced resolution with
 * temporal accumulation, an ocean below, and a full-resolution composite.
 * night: { storm (texture), min [x, z], size [x, y, z], range, base, calm } for the night journey:
 * the "sun" becomes the moon, the thunderstorm joins the clouds, and lightning is lit.
 */
export function createSky(renderer, { cloudScale = 0.5, quality = "normal", night = null, maxSteps = 0 } = {}) {
  // Moonlight, bluish as night scenes look to the eye, and brighter than a real crescent's:
  // like a night in a film, dark but readable.
  const sunIlluminance = night
    ? new THREE.Vector3(0.55, 0.68, 1.0).multiplyScalar(0.06)
    : new THREE.Vector3(1.0, 1.0, 1.0);
  const wind = night ? { x: 0, z: 0 } : CLOUD.wind;
  const targets = night ? 3 : 2;

  // ---- one-off bakes ---------------------------------------------------------------
  const noisePass = createPass({
    vertexShader,
    fragmentShader: fragment(noiseSrc),
    uniforms: { uMode: { value: 0 }, uSize: { value: 128 }, uZ0: { value: 0 }, uDepth: { value: 128 } }
  });
  const baseNoise = bakeVolume(renderer, noisePass, 0, 128, 32, [0, 1]);
  const detailNoise = bakeVolume(renderer, noisePass, 1, 32, 32, [0, 1, 2]);
  const weather = bakeWeather(renderer, noisePass, 512);
  // The storm's mist at metre scale (night only).
  // One channel: rounded puffs, some wisps (see noise.frag).
  const mistNoise = night ? bakeVolume(renderer, noisePass, 3, 128, 32, [0, 1], (r, g) => 0.25 * r + 0.75 * g) : null;
  noisePass.dispose();

  // Rare giant towering cumulus: baked 3D shapes, placed on a coarse grid in cloud-map space.
  const giantShape = bakeCumulusShapes();
  const giants = placeGiants({
    tile: CLOUD.cloudMapPeriod,
    depth: CLOUD.topMax - CLOUD.bottom - 300,
    hero: HERO_GIANT
  });
  const giantDefines = {
    GIANT_CELL: glslFloat(GIANTS.cell),
    GIANT_GRID: `${GIANTS.grid}`,
    GIANT_COUNT: `${GIANTS.grid * GIANTS.grid}`,
    GIANT_RANGE: glslFloat(SHAPE.range),
    GIANT_EXTENT: glslFloat(SHAPE.extent)
  };

  // Placement of the other heaped clouds (large cumulus to many fragments), kept on the GPU:
  // baked, then a second pass adds the slope of the envelope (see cloudslope.frag).
  const mapTarget = mipmaps =>
    new THREE.WebGLRenderTarget(CLOUD.cloudMapSize, CLOUD.cloudMapSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
      magFilter: mipmaps ? THREE.LinearFilter : THREE.NearestFilter,
      generateMipmaps: mipmaps,
      depthBuffer: false,
      stencilBuffer: false
    });
  const rawMap = mapTarget(false);
  const cloudMapPass = createPass({
    vertexShader,
    fragmentShader: fragment(cloudMapSrc),
    defines: giantDefines,
    uniforms: { uTile: { value: CLOUD.cloudMapPeriod }, uGiantA: { value: giants.a } }
  });
  cloudMapPass.render(renderer, rawMap);
  cloudMapPass.dispose();
  const cloudMap = mapTarget(true);
  const cloudSlopePass = createPass({
    vertexShader,
    fragmentShader: fragment(cloudSlopeSrc),
    defines: { TEXEL_METRES: glslFloat(CLOUD.cloudMapPeriod / CLOUD.cloudMapSize) },
    uniforms: { uMap: { value: rawMap.texture } }
  });
  cloudSlopePass.render(renderer, cloudMap);
  cloudSlopePass.dispose();
  rawMap.dispose();

  const blueNoise = new THREE.DataTexture(makeBlueNoise(64), 64, 64, THREE.RedFormat, THREE.UnsignedByteType);
  blueNoise.minFilter = THREE.NearestFilter;
  blueNoise.magFilter = THREE.NearestFilter;
  blueNoise.wrapS = blueNoise.wrapT = THREE.RepeatWrapping;
  blueNoise.generateMipmaps = false;
  blueNoise.unpackAlignment = 1;
  blueNoise.needsUpdate = true;

  const transmittance = floatTarget(256, 64);
  const transmittancePass = createPass({ vertexShader, fragmentShader: fragment(transmittanceSrc), uniforms: {} });
  transmittancePass.render(renderer, transmittance);
  transmittancePass.dispose();

  const multiScatter = floatTarget(32, 32);
  const multiScatterPass = createPass({
    vertexShader,
    fragmentShader: fragment(multiScatterSrc),
    uniforms: { uTransmittance: { value: transmittance.texture } }
  });
  multiScatterPass.render(renderer, multiScatter);
  multiScatterPass.dispose();

  // ---- per-frame passes ------------------------------------------------------------
  const skyView = floatTarget(192, 108);
  const skyViewPass = createPass({
    vertexShader,
    fragmentShader: fragment(skyViewSrc),
    uniforms: {
      uTransmittance: { value: transmittance.texture },
      uMultiScatter: { value: multiScatter.texture },
      uCamR: { value: 6363 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: sunIlluminance }
    }
  });

  const camUniforms = () => ({
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamForward: { value: new THREE.Vector3(0, 0, -1) },
    uTanHalf: { value: new THREE.Vector2(1, 1) }
  });

  const nightDefines = night ? { NIGHT: "1" } : {};
  const cloudDefines = {
    ...nightDefines,
    CLOUD_BOTTOM: glslFloat(night ? night.base : CLOUD.bottom),
    CLOUD_TOP_MAX: glslFloat(night ? 13500 : CLOUD.topMax),
    BASE_PERIOD: glslFloat(CLOUD.basePeriod),
    BASE_Y_SCALE: glslFloat(CLOUD.baseYScale),
    DETAIL_PERIOD: glslFloat(CLOUD.detailPeriod),
    WEATHER_PERIOD_A: glslFloat(CLOUD.weatherPeriodA),
    WEATHER_PERIOD_B: glslFloat(CLOUD.weatherPeriodB),
    WEATHER_PERIOD_C: glslFloat(CLOUD.weatherPeriodC),
    CLOUDMAP_PERIOD: glslFloat(CLOUD.cloudMapPeriod),
    ...giantDefines,
    ...(night
      ? {
          STORM_SIZE: `vec3(${night.size.map(glslFloat).join(", ")})`,
          STORM_MIN: `vec2(${night.min.map(glslFloat).join(", ")})`,
          STORM_CALM: `vec4(${night.calm.map(glslFloat).join(", ")})`,
          STORM_RANGE: glslFloat(night.range)
        }
      : {})
  };

  const cloudPass = createPass({
    vertexShader,
    fragmentShader: fragment(night ? withStorm(cloudsSrc) : cloudsSrc),
    defines: cloudDefines,
    uniforms: {
      ...camUniforms(),
      uTransmittance: { value: transmittance.texture },
      uMultiScatter: { value: multiScatter.texture },
      uSkyView: { value: skyView.texture },
      uBaseNoise: { value: baseNoise },
      uDetailNoise: { value: detailNoise },
      uWeather: { value: weather },
      uBlueNoise: { value: blueNoise },
      uCloudMap: { value: cloudMap.texture },
      uCloudMapOffset: { value: new THREE.Vector2() },
      uGiantShape: { value: giantShape },
      uGiants: { value: giants.texture },
      uCamAlt: { value: 3000 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: sunIlluminance },
      uFrame: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uParity: { value: 0 },
      uBaseOffset: { value: new THREE.Vector3() },
      uDetailOffset: { value: new THREE.Vector3() },
      uWeatherOffsetA: { value: new THREE.Vector2() },
      uWeatherOffsetB: { value: new THREE.Vector2() },
      uWeatherOffsetC: { value: new THREE.Vector2() },
      uDensityScale: { value: 0.19 },
      uMaxSteps: { value: maxSteps || (quality === "high" ? 420 : 280) },
      uStepScale: { value: quality === "high" ? 0.6 : 1.0 },
      ...(night
        ? {
            uStorm: { value: night.storm },
            uStormCam: { value: new THREE.Vector2() },
            uMistNoise: { value: mistNoise },
            uMistOffset: { value: new THREE.Vector3() },
            uNearDist: { value: 0 },
            uScudPos: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
            uScudSize: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
            uScudTurn: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) },
            uFlashPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
            uFlashWeight: { value: new THREE.Vector3() },
            uFlashOn: { value: 0 },
            uFlashDepth: { value: 0 },
            uFlickPos: { value: new THREE.Vector3() },
            uFlickOn: { value: 0 },
            uFlickDepth: { value: 0 },
            uFog: { value: 0 },
            uStormGlow: { value: 0 }
          }
        : {})
    }
  });

  const temporalPass = createPass({
    vertexShader,
    fragmentShader: fragment(temporalSrc),
    defines: nightDefines,
    uniforms: {
      ...(night ? { uCurFlash: { value: null }, uHistFlash: { value: null }, uFlashReset: { value: new THREE.Vector2() } } : {}),
      ...camUniforms(),
      uCurScene: { value: null },
      uCurDepth: { value: null },
      uHistScene: { value: null },
      uCamAlt: { value: 3000 },
      uPrevRight: { value: new THREE.Vector3(1, 0, 0) },
      uPrevUp: { value: new THREE.Vector3(0, 1, 0) },
      uPrevForward: { value: new THREE.Vector3(0, 0, -1) },
      uPrevTanHalf: { value: new THREE.Vector2(1, 1) },
      uPrevCamPos: { value: new THREE.Vector3() },
      uParity: { value: 0 },
      uBlend: { value: 1 },
      uClampHistory: { value: 1 },
      uHistoryValid: { value: 0 }
    }
  });

  const compositePass = createPass({
    vertexShader,
    fragmentShader: fragment(compositeSrc),
    defines: { ...nightDefines, CIRRUS_PERIOD: glslFloat(CLOUD.cirrusPeriod) },
    uniforms: {
      ...(night
        ? {
            uFlash: { value: null },
            uFlashPower: { value: 0 },
            uFlashColor: { value: new THREE.Vector3(0.8, 0.88, 1.0) },
            uLinearOut: { value: 0 },
            uFlickPower: { value: 0 },
            uFlickColor: { value: new THREE.Vector3(0.72, 0.82, 1.0) },
            uTime: { value: 0 },
            uScreen: { value: new THREE.Vector2(1, 1) }
          }
        : {}),
      uWeather: { value: weather },
      uCirrusOffset: { value: new THREE.Vector2() },
      ...camUniforms(),
      uScene: { value: null },
      uSkyView: { value: skyView.texture },
      uTransmittance: { value: transmittance.texture },
      uCamR: { value: 6363 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: sunIlluminance },
      uSunUv: { value: new THREE.Vector2() },
      uSunOnScreen: { value: 0 },
      uExposure: { value: 8 },
      uFrame: { value: 0 }
    }
  });

  // The mist around the aircraft (night): shares the cloud pass's noise, storm and lightning.
  const cu0 = cloudPass.uniforms;
  const mistPass = night
    ? createPass({
        vertexShader,
        fragmentShader: fragment(withStorm(mistSrc)),
        defines: cloudDefines,
        uniforms: {
          ...camUniforms(),
          uTransmittance: cu0.uTransmittance,
          uSkyView: cu0.uSkyView,
          uBaseNoise: cu0.uBaseNoise,
          uDetailNoise: cu0.uDetailNoise,
          uBlueNoise: cu0.uBlueNoise,
          uBaseOffset: cu0.uBaseOffset,
          uDetailOffset: cu0.uDetailOffset,
          uStorm: cu0.uStorm,
          uStormCam: cu0.uStormCam,
          uMistNoise: cu0.uMistNoise,
          uMistOffset: cu0.uMistOffset,
          uScudPos: cu0.uScudPos,
          uScudSize: cu0.uScudSize,
          uScudTurn: cu0.uScudTurn,
          uCamAlt: cu0.uCamAlt,
          uResolution: { value: new THREE.Vector2(1, 1) },
          uFrame: cu0.uFrame,
          uNear: { value: 0 },
          uSunDir: cu0.uSunDir,
          uSunIlluminance: cu0.uSunIlluminance,
          uMoonSeen: { value: 1 },
          uOpen: { value: new THREE.Vector2(1, 1) },
          uDensityScale: cu0.uDensityScale,
          uExposure: compositePass.uniforms.uExposure,
          uStormGlow: cu0.uStormGlow,
          uFlashPos: cu0.uFlashPos,
          uFlashWeight: cu0.uFlashWeight,
          uFlashPower: { value: 0 },
          uFlashColor: compositePass.uniforms.uFlashColor,
          uFlashDepth: cu0.uFlashDepth,
          uFlickPos: cu0.uFlickPos,
          uFlickPower: { value: 0 },
          uFlickColor: compositePass.uniforms.uFlickColor,
          uFlickDepth: cu0.uFlickDepth,
          uLampPos: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
          uLamp: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) },
          uTurbA: { value: new THREE.Vector3() },
          uTurbB: { value: new THREE.Vector3() },
          uShutter: { value: new THREE.Vector3() },
          uAirMist: { value: 0 }
        }
      })
    : null;
  const mistTemporalPass = night
    ? createPass({
        vertexShader,
        fragmentShader: fragment(mistTemporalSrc),
        uniforms: {
          ...camUniforms(),
          uCur: { value: null },
          uCurDepth: { value: null },
          uHist: { value: null },
          uCamAlt: cu0.uCamAlt,
          uPrevRight: { value: new THREE.Vector3(1, 0, 0) },
          uPrevUp: { value: new THREE.Vector3(0, 1, 0) },
          uPrevForward: { value: new THREE.Vector3(0, 0, -1) },
          uPrevTanHalf: { value: new THREE.Vector2(1, 1) },
          uPrevCamPos: { value: new THREE.Vector3() },
          uBlend: { value: 1 },
          uClampHistory: { value: 1 },
          uHistoryValid: { value: 0 }
        }
      })
    : null;
  let mistTarget = null; // this frame's march: light and transmittance, depth
  let mistHistory = [null, null];
  let mistIndex = 0;
  let mistValid = false;
  let mistAccumulated = 0;
  let mistOn = false;

  let cloudTarget = null;
  let history = [null, null];
  let historyIndex = 0;
  let historyValid = false;
  let width = 1;
  let height = 1;
  let scale = cloudScale;
  let frame = 0;
  let accumulated = 0;
  let lastFlashId = -1;
  let lastFlickId = -1;
  const prev = {
    right: new THREE.Vector3(1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    forward: new THREE.Vector3(0, 0, -1),
    tanHalf: new THREE.Vector2(1, 1),
    x: 0,
    z: 0,
    alt: 3000
  };

  function allocate() {
    cloudTarget?.dispose();
    history.forEach(target => target?.dispose());
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    // Checkerboard: the cloud pass renders half the pixels each frame into a half-width target.
    cloudTarget = floatTarget(Math.ceil(w / 2), h, { count: targets });
    history = [floatTarget(w, h, { count: targets }), floatTarget(w, h, { count: targets })];
    cloudPass.uniforms.uResolution.value.set(w, h);
    if (mistPass) {
      mistTarget?.dispose();
      mistHistory.forEach(target => target?.dispose());
      const mw = Math.max(1, Math.round(width * NEAR.scale));
      const mh = Math.max(1, Math.round(height * NEAR.scale));
      mistTarget = floatTarget(mw, mh, { count: 2 });
      mistHistory = [floatTarget(mw, mh), floatTarget(mw, mh)];
      mistValid = false;
      mistPass.uniforms.uResolution.value.set(mw, mh);
    }
    historyValid = false;
    accumulated = 0;
  }

  function setCamera(uniforms, view) {
    uniforms.uCamRight.value.copy(view.right);
    uniforms.uCamUp.value.copy(view.up);
    uniforms.uCamForward.value.copy(view.forward);
    uniforms.uTanHalf.value.copy(view.tanHalf);
  }

  return {
    get cloudScale() { return scale; },
    /** Illuminance of the sun (day) or the moon (night). */
    get light() { return sunIlluminance; },
    /** Exposure applied to the finished image. */
    get exposure() { return compositePass.uniforms.uExposure.value; },
    /** The reconstructed cloud image of the last frame: rgb + sky visibility, and depth. */
    get scene() { return history[historyIndex]; },
    get frame() { return frame; },
    /** The mist around the aircraft (night): rgb = its light (exposed), a = what shows through; null when off. */
    get mist() { return mistOn ? mistHistory[mistIndex].texture : null; },
    get accumulated() { return accumulated; },

    resize(w, h) {
      width = w;
      height = h;
      allocate();
    },

    setCloudScale(next) {
      if (Math.abs(next - scale) < 1e-3) return;
      scale = next;
      allocate();
    },

    resetHistory() {
      historyValid = false;
      accumulated = 0;
      mistValid = false;
    },

    /**
     * view: { right, up, forward (THREE.Vector3), tanHalf (THREE.Vector2), alt (m),
     *         x, z (world metres), time (s), sunDir (THREE.Vector3) }
     * options: { still: average every frame without clamping (for converged captures),
     *            target: where the finished image goes (the screen when null),
     *            linear: (night) leave the image linear and exposed, without tone mapping }
     */
    render(view, { still = false, target = null, linear = false } = {}) {
      const camR = 6360 + view.alt / 1000;

      skyViewPass.uniforms.uCamR.value = camR;
      skyViewPass.uniforms.uSunDir.value.copy(view.sunDir);
      skyViewPass.render(renderer, skyView);

      // Cloud field offsets: wrapped per period so world coordinates never lose precision.
      const t = view.time;
      const cx = view.x - wind.x * t;
      const cz = view.z - wind.z * t;
      const u = cloudPass.uniforms;
      u.uBaseOffset.value.set(
        wrap(cx - (night ? BOIL.billows.x * t : 0), CLOUD.basePeriod),
        wrap(night ? -t * BOIL.billows.y : t * 0.9, CLOUD.basePeriod / CLOUD.baseYScale),
        wrap(cz - (night ? BOIL.billows.z * t : 0), CLOUD.basePeriod)
      );
      u.uDetailOffset.value.set(
        wrap(cx + t * (night ? -BOIL.bulges.x : -1.5), CLOUD.detailPeriod),
        wrap(night ? -t * BOIL.bulges.y : t * 2.2, CLOUD.detailPeriod),
        wrap(cz + t * (night ? -BOIL.bulges.z : 0.7), CLOUD.detailPeriod)
      );
      u.uWeatherOffsetA.value.set(wrap(cx, CLOUD.weatherPeriodA), wrap(cz, CLOUD.weatherPeriodA));
      const rx = WEATHER_ROT.c * cx - WEATHER_ROT.s * cz;
      const rz = WEATHER_ROT.s * cx + WEATHER_ROT.c * cz;
      u.uWeatherOffsetB.value.set(wrap(rx, CLOUD.weatherPeriodB), wrap(rz, CLOUD.weatherPeriodB));
      const rx2 = WEATHER_ROT2.c * cx - WEATHER_ROT2.s * cz;
      const rz2 = WEATHER_ROT2.s * cx + WEATHER_ROT2.c * cz;
      u.uWeatherOffsetC.value.set(wrap(rx2, CLOUD.weatherPeriodC), wrap(rz2, CLOUD.weatherPeriodC));
      const mx = CLOUDMAP_ROT.c * cx - CLOUDMAP_ROT.s * cz;
      const mz = CLOUDMAP_ROT.s * cx + CLOUDMAP_ROT.c * cz;
      u.uCloudMapOffset.value.set(wrap(mx, CLOUD.cloudMapPeriod), wrap(mz, CLOUD.cloudMapPeriod));

      // Cirrus drift faster in the stronger wind aloft.
      const kx = view.x - CLOUD.cirrusWind.x * t;
      const kz = view.z - CLOUD.cirrusWind.z * t;
      const crx = (CIRRUS_ROT.c * kx - CIRRUS_ROT.s * kz) * CIRRUS_STRETCH;
      const crz = CIRRUS_ROT.s * kx + CIRRUS_ROT.c * kz;
      compositePass.uniforms.uCirrusOffset.value.set(wrap(crx, CLOUD.cirrusPeriod), wrap(crz, CLOUD.cirrusPeriod));
      setCamera(u, view);
      u.uCamAlt.value = view.alt;
      u.uSunDir.value.copy(view.sunDir);
      u.uFrame.value = frame;
      u.uParity.value = frame & 1;
      const flash = night && view.flash && view.flash.on ? view.flash : null;
      const flick = night && view.flick && view.flick.on ? view.flick : null;
      if (night) {
        u.uStormCam.value.set(view.x - night.min[0], view.z - night.min[1]);
        // The mist drifts, and moves with the air of the storm (drafts and gusts).
        const air = view.air || [0, 0, 0];
        u.uMistOffset.value.set(
          wrap(view.x - MIST.drift.x * t - air[0], MIST.period),
          wrap(-MIST.drift.y * t - air[1], MIST.period),
          wrap(view.z - MIST.drift.z * t - air[2], MIST.period)
        );

        u.uFog.value = view.fog ?? 0;
        // The scud on the journey's way (none in the free flight).
        for (let i = 0; i < 8; i++) {
          if (view.scud) {
            u.uScudPos.value[i].copy(view.scud.pos[i]);
            u.uScudSize.value[i].copy(view.scud.size[i]);
            u.uScudTurn.value[i].copy(view.scud.turn[i]);
          } else {
            u.uScudSize.value[i].set(0, 0, 0, 0);
          }
        }
        // The mist pass takes over the storm's cloud near the aircraft whenever it is within reach.
        mistOn = (view.near ?? 0) > 0;
        u.uNearDist.value = mistOn ? view.near : 0;
        u.uStormGlow.value = view.stormGlow ?? 0;
        u.uFlashOn.value = flash ? 1 : 0;
        u.uFlickOn.value = flick ? 1 : 0;
        // Sources relative to the camera (y stays altitude, as in the cloud shader).
        if (flash) {
          flash.pos.forEach((q, k) => u.uFlashPos.value[k].set(q[0] - view.x, q[1], q[2] - view.z));
          u.uFlashWeight.value.set(flash.weight[0], flash.weight[1], flash.weight[2]);
          u.uFlashDepth.value = flash.depth;
        }
        if (flick) {
          u.uFlickPos.value.set(flick.pos[0] - view.x, flick.pos[1], flick.pos[2] - view.z);
          u.uFlickDepth.value = flick.depth;
        }
      }
      cloudPass.render(renderer, cloudTarget);
      if (mistOn) {
        const m = mistPass.uniforms;
        setCamera(m, view);
        m.uNear.value = view.near;
        // Turbulence close by: two layers of eddies sweeping past each other, so the mist curls
        // and changes shape within seconds (see mist.frag).
        const air = view.air || [0, 0, 0];
        m.uTurbA.value.set(wrap(view.x - air[0] + 11 * t, MIST.period), wrap(-air[1] - 7 * t, MIST.period), wrap(view.z - air[2] - 10 * t, MIST.period));
        m.uTurbB.value.set(wrap(view.x - air[0] - 16 * t, MIST.period / 3), wrap(-air[1] + 10 * t, MIST.period / 3), wrap(view.z - air[2] + 13 * t, MIST.period / 3));
        m.uAirMist.value = view.airMist ?? 0;
        // The shutter: the mist is seen over the last sixtieth of a second of flight (it streaks).
        m.uShutter.value.copy(view.forward).multiplyScalar(0);
        if (view.velocity) m.uShutter.value.set(...view.velocity).multiplyScalar(1 / 60);
        m.uMoonSeen.value = view.moonSeen ?? 1;
        m.uOpen.value.set(...(view.open ?? [1, 1]));
        m.uFlashPower.value = flash ? flash.power : 0;
        if (flash) compositePass.uniforms.uFlashColor.value.set(...flash.color);
        m.uFlickPower.value = flick ? flick.power : 0;
        for (let k = 0; k < 4; k++) {
          if (view.lamps) {
            m.uLampPos.value[k].copy(view.lamps.pos[k]);
            m.uLamp.value[k].copy(view.lamps.light[k]);
          } else {
            m.uLamp.value[k].set(0, 0, 0);
          }
          // Another aircraft's (moments.js).
          if (view.traffic && view.traffic.on) {
            m.uLampPos.value[4 + k].copy(view.traffic.pos[k]);
            m.uLamp.value[4 + k].copy(view.traffic.light[k]).multiplyScalar(4);
          } else {
            m.uLamp.value[4 + k].set(0, 0, 0);
          }
        }
        mistPass.render(renderer, mistTarget);
        // Resolve: blend with the last frames, reprojected at the mist's depth.
        const r = mistTemporalPass.uniforms;
        setCamera(r, view);
        r.uCur.value = mistTarget.textures[0];
        r.uCurDepth.value = mistTarget.textures[1];
        r.uHist.value = mistHistory[mistIndex].texture;
        r.uPrevRight.value.copy(prev.right);
        r.uPrevUp.value.copy(prev.up);
        r.uPrevForward.value.copy(prev.forward);
        r.uPrevTanHalf.value.copy(prev.tanHalf);
        r.uPrevCamPos.value.set(prev.x - view.x, prev.alt, prev.z - view.z);
        if (!mistValid) mistAccumulated = 0;
        r.uHistoryValid.value = mistValid ? 1 : 0;
        r.uBlend.value = !mistValid ? 1 : still ? 1 / (mistAccumulated + 1) : 0.35;
        r.uClampHistory.value = still ? 0 : 1;
        mistIndex = 1 - mistIndex;
        mistTemporalPass.render(renderer, mistHistory[mistIndex]);
        mistValid = true;
        mistAccumulated++;
      } else {
        mistValid = false;
      }

      const read = history[historyIndex];
      const write = history[1 - historyIndex];
      const tu = temporalPass.uniforms;
      setCamera(tu, view);
      tu.uCamAlt.value = view.alt;
      tu.uCurScene.value = cloudTarget.textures[0];
      tu.uCurDepth.value = cloudTarget.textures[1];
      tu.uHistScene.value = read.textures[0];
      tu.uPrevRight.value.copy(prev.right);
      tu.uPrevUp.value.copy(prev.up);
      tu.uPrevForward.value.copy(prev.forward);
      tu.uPrevTanHalf.value.copy(prev.tanHalf);
      tu.uPrevCamPos.value.set(prev.x - view.x, prev.alt, prev.z - view.z);
      tu.uParity.value = frame & 1;
      if (!historyValid) accumulated = 0;
      tu.uHistoryValid.value = historyValid ? 1 : 0;
      // Each pixel gets a new sample every other frame: a still capture averages all of them;
      // in flight, a moving average over about five samples.
      tu.uBlend.value = !historyValid ? 1 : still ? 1 / (Math.floor(accumulated / 2) + 1) : 0.22;
      tu.uClampHistory.value = still ? 0 : 1;
      if (night) {
        tu.uCurFlash.value = cloudTarget.textures[2];
        tu.uHistFlash.value = read.textures[2];
        const id = flash ? flash.id : -1;
        const idK = flick ? flick.id : -1;
        tu.uFlashReset.value.set(id !== lastFlashId ? 1 : 0, idK !== lastFlickId ? 1 : 0);
        lastFlashId = id;
        lastFlickId = idK;
      }
      temporalPass.render(renderer, write);
      historyIndex = 1 - historyIndex;
      historyValid = true;
      accumulated++;

      const cu = compositePass.uniforms;
      setCamera(cu, view);
      cu.uScene.value = write.textures[0];
      cu.uCamR.value = camR;
      cu.uSunDir.value.copy(view.sunDir);
      cu.uFrame.value = frame;
      if (night) {
        cu.uFlash.value = write.textures[2];
        cu.uFlashPower.value = flash ? flash.power : 0;
        if (flash) cu.uFlashColor.value.set(...flash.color);
        cu.uFlickPower.value = flick ? flick.power : 0;
        cu.uLinearOut.value = linear ? 1 : 0;
        cu.uTime.value = view.time;
        cu.uScreen.value.set(width, height);
      }
      const sz = view.sunDir.dot(view.forward);
      if (sz > 0) {
        const sx = view.sunDir.dot(view.right) / (sz * view.tanHalf.x);
        const sy = view.sunDir.dot(view.up) / (sz * view.tanHalf.y);
        cu.uSunUv.value.set(sx * 0.5 + 0.5, sy * 0.5 + 0.5);
        cu.uSunOnScreen.value = Math.abs(sx) <= 1 && Math.abs(sy) <= 1 ? 1 : 0;
      } else {
        cu.uSunOnScreen.value = 0;
      }
      compositePass.render(renderer, target);

      prev.right.copy(view.right);
      prev.up.copy(view.up);
      prev.forward.copy(view.forward);
      prev.tanHalf.copy(view.tanHalf);
      prev.x = view.x;
      prev.z = view.z;
      prev.alt = view.alt;
      frame++;
    }
  };
}
