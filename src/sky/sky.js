import * as THREE from "three";
import { createPass } from "./fullscreen.js";
import vertexShader from "../shaders/fullscreen.vert?raw";
import common from "../shaders/common.glsl?raw";
import transmittanceSrc from "../shaders/transmittance.frag?raw";
import multiScatterSrc from "../shaders/multiscatter.frag?raw";
import skyViewSrc from "../shaders/skyview.frag?raw";
import noiseSrc from "../shaders/noise.frag?raw";
import cloudsSrc from "../shaders/clouds.frag?raw";
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
  wind: { x: 7.0, z: -3.0 }
});

const WEATHER_ROT = { c: 0.8, s: 0.6 };
const wrap = (v, p) => v - p * Math.floor(v / p);
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

function bakeVolume(renderer, pass, mode, size, slicesPerChunk, equalizeChannels) {
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
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
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
 */
export function createSky(renderer, { cloudScale = 0.5, quality = "normal" } = {}) {
  const sunIlluminance = new THREE.Vector3(1.0, 1.0, 1.0);

  // ---- one-off bakes ---------------------------------------------------------------
  const noisePass = createPass({
    vertexShader,
    fragmentShader: fragment(noiseSrc),
    uniforms: { uMode: { value: 0 }, uSize: { value: 128 }, uZ0: { value: 0 }, uDepth: { value: 128 } }
  });
  const baseNoise = bakeVolume(renderer, noisePass, 0, 128, 32, [0, 1]);
  const detailNoise = bakeVolume(renderer, noisePass, 1, 32, 32, [0, 1, 2]);
  const weather = bakeWeather(renderer, noisePass, 512);
  noisePass.dispose();

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

  const cloudDefines = {
    CLOUD_BOTTOM: glslFloat(CLOUD.bottom),
    CLOUD_TOP_MAX: glslFloat(CLOUD.topMax),
    BASE_PERIOD: glslFloat(CLOUD.basePeriod),
    BASE_Y_SCALE: glslFloat(CLOUD.baseYScale),
    DETAIL_PERIOD: glslFloat(CLOUD.detailPeriod),
    WEATHER_PERIOD_A: glslFloat(CLOUD.weatherPeriodA),
    WEATHER_PERIOD_B: glslFloat(CLOUD.weatherPeriodB)
  };

  const cloudPass = createPass({
    vertexShader,
    fragmentShader: fragment(cloudsSrc),
    defines: cloudDefines,
    uniforms: {
      ...camUniforms(),
      uTransmittance: { value: transmittance.texture },
      uMultiScatter: { value: multiScatter.texture },
      uSkyView: { value: skyView.texture },
      uBaseNoise: { value: baseNoise },
      uDetailNoise: { value: detailNoise },
      uWeather: { value: weather },
      uCamAlt: { value: 3000 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIlluminance: { value: sunIlluminance },
      uFrame: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBaseOffset: { value: new THREE.Vector3() },
      uDetailOffset: { value: new THREE.Vector3() },
      uWeatherOffsetA: { value: new THREE.Vector2() },
      uWeatherOffsetB: { value: new THREE.Vector2() },
      uCoverage: { value: 0.42 },
      uDensityScale: { value: 0.16 },
      uMaxSteps: { value: quality === "high" ? 420 : 280 },
      uStepScale: { value: quality === "high" ? 0.6 : 1.0 }
    }
  });

  const temporalPass = createPass({
    vertexShader,
    fragmentShader: fragment(temporalSrc),
    uniforms: {
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
      uTexel: { value: new THREE.Vector2() },
      uBlend: { value: 1 },
      uClampHistory: { value: 1 }
    }
  });

  const compositePass = createPass({
    vertexShader,
    fragmentShader: fragment(compositeSrc),
    uniforms: {
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

  let cloudTarget = null;
  let history = [null, null];
  let historyIndex = 0;
  let historyValid = false;
  let width = 1;
  let height = 1;
  let scale = cloudScale;
  let frame = 0;
  let accumulated = 0;
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
    cloudTarget = floatTarget(w, h, { count: 2 });
    history = [floatTarget(w, h, { count: 2 }), floatTarget(w, h, { count: 2 })];
    cloudPass.uniforms.uResolution.value.set(w, h);
    temporalPass.uniforms.uTexel.value.set(1 / w, 1 / h);
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
    get frame() { return frame; },
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
    },

    /**
     * view: { right, up, forward (THREE.Vector3), tanHalf (THREE.Vector2), alt (m),
     *         x, z (world metres), time (s), sunDir (THREE.Vector3) }
     * options: { still: average every frame without clamping (for converged captures) }
     */
    render(view, { still = false } = {}) {
      const camR = 6360 + view.alt / 1000;

      skyViewPass.uniforms.uCamR.value = camR;
      skyViewPass.uniforms.uSunDir.value.copy(view.sunDir);
      skyViewPass.render(renderer, skyView);

      // Cloud field offsets: wrapped per period so world coordinates never lose precision.
      const t = view.time;
      const cx = view.x - CLOUD.wind.x * t;
      const cz = view.z - CLOUD.wind.z * t;
      const u = cloudPass.uniforms;
      u.uBaseOffset.value.set(
        wrap(cx, CLOUD.basePeriod),
        wrap(t * 0.9, CLOUD.basePeriod / CLOUD.baseYScale),
        wrap(cz, CLOUD.basePeriod)
      );
      u.uDetailOffset.value.set(
        wrap(cx - t * 1.5, CLOUD.detailPeriod),
        wrap(t * 2.2, CLOUD.detailPeriod),
        wrap(cz + t * 0.7, CLOUD.detailPeriod)
      );
      u.uWeatherOffsetA.value.set(wrap(cx, CLOUD.weatherPeriodA), wrap(cz, CLOUD.weatherPeriodA));
      const rx = WEATHER_ROT.c * cx - WEATHER_ROT.s * cz;
      const rz = WEATHER_ROT.s * cx + WEATHER_ROT.c * cz;
      u.uWeatherOffsetB.value.set(wrap(rx, CLOUD.weatherPeriodB), wrap(rz, CLOUD.weatherPeriodB));
      setCamera(u, view);
      u.uCamAlt.value = view.alt;
      u.uSunDir.value.copy(view.sunDir);
      u.uFrame.value = frame;
      cloudPass.render(renderer, cloudTarget);

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
      if (!historyValid) {
        tu.uBlend.value = 1;
        accumulated = 0;
      } else if (still) {
        tu.uBlend.value = 1 / (accumulated + 1);
      } else {
        tu.uBlend.value = 0.14;
      }
      tu.uClampHistory.value = still ? 0 : 1;
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
      const sz = view.sunDir.dot(view.forward);
      if (sz > 0) {
        const sx = view.sunDir.dot(view.right) / (sz * view.tanHalf.x);
        const sy = view.sunDir.dot(view.up) / (sz * view.tanHalf.y);
        cu.uSunUv.value.set(sx * 0.5 + 0.5, sy * 0.5 + 0.5);
        cu.uSunOnScreen.value = Math.abs(sx) <= 1 && Math.abs(sy) <= 1 ? 1 : 0;
      } else {
        cu.uSunOnScreen.value = 0;
      }
      compositePass.render(renderer, null);

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
