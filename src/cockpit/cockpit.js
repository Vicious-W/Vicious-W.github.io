import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createPass } from "../sky/fullscreen.js";
import { createRibbons } from "../night/bolts.js";
import { createInstruments } from "./instruments.js";
import { createStreamers } from "./streamers.js";
import { WING, BEACONS, NAV, BEACON_COLOR, NAV_COLORS, BEACON_POWER, NAV_POWER, beaconPulse } from "./lamps.js";
import vertexShader from "../shaders/fullscreen.vert?raw";
import common from "../shaders/common.glsl?raw";
import glassSrc from "../shaders/glass.frag?raw";

/**
 * The glass-bubble cockpit. Almost all of it is glass: straight ahead there is nothing but the
 * view and, low in it, the small console with its glowing instruments. The canopy's frame is
 * one bow well to the sides and overhead, a spine over the head, and an arch behind; the floor
 * is glass too, on either side of a narrow keel that carries the console, the pedals, the
 * stick and the seat. Above and behind, the wing, with its red and green lights at the tips.
 *
 * It is drawn into its own layer (premultiplied: opaque parts, plus glowing things that only
 * add light), then the glass pass finishes the frame: the outside seen through the wet glass,
 * rain and hail in the air, the aircraft's lights in cloud, reflections of the instruments,
 * the cockpit on top, tone mapping.
 * Cabin frame (m): the eye at the origin, -z ahead, +y up, +x right.
 */
export const BUBBLE = Object.freeze({ centre: [0, -0.25, -0.45], radii: [1.05, 1.15, 1.35], backZ: 0.6 });
const BOW_Z = -0.55; // the bow: where the canopy's frame crosses the glass, ahead of the shoulders
const ARCH_Z = 0.57; // the arch behind the seat

// Lights of the aircraft: see lamps.js.
export { BEACONS, NAV };

const C = new THREE.Vector3(...BUBBLE.centre);
const R = new THREE.Vector3(...BUBBLE.radii);

/** Outward normal of the bubble at a point on it. */
function outward(p) {
  return new THREE.Vector3((p.x - C.x) / (R.x * R.x), (p.y - C.y) / (R.y * R.y), (p.z - C.z) / (R.z * R.z)).normalize();
}

/** Ring where the bubble meets the plane z = z0. */
function ringZ(z0, n = 144) {
  const k = Math.sqrt(Math.max(1 - ((z0 - C.z) / R.z) ** 2, 0));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n;
    pts.push(new THREE.Vector3(R.x * k * Math.cos(a), C.y + R.y * k * Math.sin(a), z0));
  }
  return pts;
}

/** The bubble's top line (x = 0) from z0 back to z1. */
function topLine(z0, z1, n = 64) {
  const b0 = Math.acos(-(z0 - C.z) / R.z);
  const b1 = Math.acos(-(z1 - C.z) / R.z);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const b = b0 + ((b1 - b0) * i) / n;
    pts.push(new THREE.Vector3(0, C.y + R.y * Math.sin(b), C.z - R.z * Math.cos(b)));
  }
  return pts;
}

/**
 * A frame member lying against the inside of the glass along the given points: an oval
 * section, width across the glass and depth into the cabin.
 */
function frameStrip(points, closed, width, depth) {
  const K = 12;
  const n = points.length;
  const position = new Float32Array(n * K * 3);
  const uv = new Float32Array(n * K * 2);
  const index = [];
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const prev = points[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)];
    const next = points[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    const t = next.clone().sub(prev).normalize();
    const nrm = outward(p);
    const b = new THREE.Vector3().crossVectors(nrm, t).normalize();
    if (i > 0) along += p.distanceTo(points[i - 1]);
    for (let k = 0; k < K; k++) {
      const a = (Math.PI * 2 * k) / K;
      const v = p.clone().addScaledVector(b, Math.cos(a) * width * 0.5).addScaledVector(nrm, (Math.sin(a) - 1) * depth * 0.5);
      position.set([v.x, v.y, v.z], (i * K + k) * 3);
      uv.set([along, k / K], (i * K + k) * 2);
    }
  }
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < K; k++) {
      const l = (k + 1) % K;
      index.push(i * K + k, j * K + k, i * K + l, i * K + l, j * K + k, j * K + l);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

/** The wing: an aerofoil lofted from tip to tip, tapered, with a little dihedral. */
function wingGeometry() {
  // Section in chord units: x back along the chord, y up.
  const upper = [[0, 0], [0.012, 0.022], [0.05, 0.045], [0.12, 0.064], [0.25, 0.08], [0.42, 0.076], [0.62, 0.056], [0.82, 0.028], [1, 0.003]];
  const lower = [[0.82, -0.012], [0.62, -0.026], [0.42, -0.038], [0.25, -0.042], [0.12, -0.036], [0.05, -0.026], [0.012, -0.013]];
  const section = upper.concat(lower);
  const S = section.length;
  const stations = 15;
  const position = [];
  const index = [];
  for (let i = 0; i < stations; i++) {
    const u = (i / (stations - 1)) * 2 - 1; // -1 left tip .. 1 right tip
    const f = Math.abs(u);
    const chord = WING.rootChord + (WING.tipChord - WING.rootChord) * f;
    const y = WING.rootY + (WING.tipY - WING.rootY) * f;
    for (const [sx, sy] of section) position.push(u * WING.span, y + sy * chord, WING.leading + sx * chord);
  }
  for (let i = 0; i < stations - 1; i++) {
    for (let k = 0; k < S; k++) {
      const l = (k + 1) % S;
      index.push(i * S + k, i * S + l, (i + 1) * S + k, i * S + l, (i + 1) * S + l, (i + 1) * S + k);
    }
  }
  // Tip caps.
  for (const i of [0, stations - 1]) for (let k = 1; k < S - 1; k++) index.push(i * S, i * S + k, i * S + k + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array((position.length / 3) * 2), 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

const DIRS = 3; // moon, flash, flicker
const POINTS = 7; // three screens, two wing-tip lights, the belly beacon, St. Elmo's fire

const meshVertex = /* glsl */ `
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const meshFragment = /* glsl */ `
precision highp float;
uniform vec3 uAlbedo;
uniform float uGloss;       // 0 matt .. 1 polished
uniform float uKind;        // 0 surface, 1 instrument face, 2 lamp
uniform vec3 uEmissive;
uniform sampler2D uAtlas;
uniform float uFaceGain;
uniform vec3 uEye;
uniform vec3 uAmbient;
uniform vec3 uDirDir[${DIRS}];   // towards each distant light, cabin frame
uniform vec3 uDirLight[${DIRS}];
uniform vec3 uPointPos[${POINTS}];
uniform vec3 uPointLight[${POINTS}];
uniform float uFogSigma;    // cloud and rain outside the glass (1/m)
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(uEye - vPos);
  vec3 diffuse = uAmbient;
  vec3 specular = vec3(0.0);
  vec3 pointSpecular = vec3(0.0);
  float shininess = mix(6.0, 90.0, uGloss);
  float specAmount = mix(0.02, 0.5, uGloss) * (shininess + 8.0) / 25.0;
  for (int i = 0; i < ${DIRS}; i++) {
    vec3 l = uDirDir[i];
    // Light from the sky and from lightning comes through glass all around and off the
    // clouds: it wraps around things rather than leaving their far side black.
    float wrap = i == 0 ? 0.0 : 0.35;
    float nl = max((dot(n, l) + wrap) / (1.0 + wrap), 0.0);
    diffuse += uDirLight[i] * nl;
    specular += uDirLight[i] * pow(max(dot(n, normalize(l + v)), 0.0), shininess) * step(0.0, dot(n, l));
  }
  for (int i = 0; i < ${POINTS}; i++) {
    vec3 lp = uPointPos[i] - vPos;
    float d2 = dot(lp, lp);
    vec3 l = lp * inversesqrt(d2);
    vec3 e = uPointLight[i] / (d2 + 0.01);
    diffuse += e * max(dot(n, l), 0.0);
    pointSpecular += e * pow(max(dot(n, normalize(l + v)), 0.0), shininess) * step(0.0, dot(n, l));
  }
  vec3 c = uAlbedo * diffuse + (specular + pointSpecular) * specAmount;
  if (uKind > 0.5 && uKind < 1.5) {
    // The instruments glow; their glass also shows a little of the lightning and the moon
    // (the lamps near it, its own screens among them, light the cabin, not its face).
    c = texture(uAtlas, vUv).rgb * uFaceGain + 0.3 * specular;
  } else if (uKind > 1.5) {
    c = uEmissive;
  }
  // Outside the glass (the wing, its lamps), cloud and rain hide things: they let through what
  // is behind them in the image of the outside, which shows the cloud.
  float T = exp(-uFogSigma * max(length(vPos - uEye) - 1.3, 0.0));
  outColor = vec4(c * T, T);
}
`;

/**
 * stormSD(x, y, z): the baked storm distance (for the radar and for whether the moon shows).
 */
export function createCockpit(renderer, { stormSD = () => -1500, show = 0 } = {}) {
  const instruments = createInstruments({ stormSD });
  const shared = {
    uAtlas: { value: instruments.texture },
    uFaceGain: { value: 0.014 },
    uEye: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Vector3() },
    uDirDir: { value: Array.from({ length: DIRS }, () => new THREE.Vector3(0, 1, 0)) },
    uDirLight: { value: Array.from({ length: DIRS }, () => new THREE.Vector3()) },
    uPointPos: { value: Array.from({ length: POINTS }, () => new THREE.Vector3()) },
    uPointLight: { value: Array.from({ length: POINTS }, () => new THREE.Vector3()) },
    uFogSigma: { value: 0 }
  };
  const material = (albedo, gloss, kind = 0, emissive = [0, 0, 0]) =>
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: meshVertex,
      fragmentShader: meshFragment,
      uniforms: {
        ...shared,
        uAlbedo: { value: new THREE.Vector3(...albedo) },
        uGloss: { value: gloss },
        uKind: { value: kind },
        uEmissive: { value: new THREE.Vector3(...emissive) }
      },
      side: THREE.DoubleSide
    });
  const frameMat = material([0.06, 0.062, 0.068], 0.55);
  const panelMat = material([0.028, 0.028, 0.032], 0.2);
  const metalMat = material([0.11, 0.115, 0.125], 0.7);
  const fabricMat = material([0.04, 0.037, 0.036], 0.0);
  const hullMat = material([0.16, 0.165, 0.18], 0.35);
  const faceMat = material([0, 0, 0], 0.8, 1);
  const lampMats = NAV_COLORS.map(c => material([0, 0, 0], 0, 2, c.map(v => v * 0.8)));

  const scene = new THREE.Scene();
  const add = (geometry, mat, position = [0, 0, 0], rotation = [0, 0, 0], parent = scene) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(...position);
    mesh.rotation.set(...rotation);
    parent.add(mesh);
    return mesh;
  };

  // The canopy's frame.
  add(frameStrip(ringZ(BOW_Z), true, 0.05, 0.022), frameMat);
  add(frameStrip(ringZ(ARCH_Z), true, 0.06, 0.03), frameMat);
  add(frameStrip(topLine(BOW_Z, ARCH_Z), false, 0.046, 0.022), frameMat);

  // Keel along the floor, from under the pedals back to the seat.
  add(new RoundedBoxGeometry(0.3, 0.05, 1.86, 3, 0.015), frameMat, [0, -1.145, -0.33]);

  // Console: the instruments' face tilted towards the eye, under a short glare shield, on a
  // pedestal that stands on the keel.
  const CONSOLE_SCALE = 0.85;
  const consoleGroup = new THREE.Group();
  consoleGroup.position.set(0, -0.56, -1.0);
  consoleGroup.rotation.x = -0.49;
  consoleGroup.scale.setScalar(CONSOLE_SCALE);
  scene.add(consoleGroup);
  add(new RoundedBoxGeometry(0.53, 0.275, 0.16, 4, 0.022), panelMat, [0, 0, 0], [0, 0, 0], consoleGroup);
  const face = add(new THREE.PlaneGeometry(0.49, 0.245), faceMat, [0, 0, 0.0815], [0, 0, 0], consoleGroup);
  const shield = add(new RoundedBoxGeometry(0.57, 0.016, 0.21, 3, 0.007), panelMat, [0, 0.147, 0.035], [0, 0, 0], consoleGroup);
  add(new RoundedBoxGeometry(0.13, 0.46, 0.12, 3, 0.02), panelMat, [0, -0.9, -1.02]);

  // Pedals and stick.
  for (const side of [-1, 1]) {
    add(new RoundedBoxGeometry(0.1, 0.13, 0.02, 2, 0.006), metalMat, [side * 0.17, -0.985, -1.17], [-0.6, 0, 0]);
    add(new THREE.CylinderGeometry(0.011, 0.011, 0.17, 8), metalMat, [side * 0.17, -1.06, -1.12], [0.5, 0, 0]);
  }
  add(new THREE.CylinderGeometry(0.012, 0.014, 0.5, 10), metalMat, [0, -0.87, -0.47], [0.11, 0, 0]);
  add(new THREE.CapsuleGeometry(0.022, 0.09, 4, 12), fabricMat, [0, -0.58, -0.44], [0.11, 0, 0]);

  // Seat: pan, back, a narrow headrest.
  add(new RoundedBoxGeometry(0.46, 0.09, 0.46, 3, 0.03), fabricMat, [0, -0.8, 0.1]);
  add(new RoundedBoxGeometry(0.44, 0.66, 0.09, 3, 0.03), fabricMat, [0, -0.47, 0.38], [0.14, 0, 0]);
  add(new RoundedBoxGeometry(0.2, 0.16, 0.07, 3, 0.025), fabricMat, [0, -0.02, 0.34]);

  // Bulkhead closing the bubble behind the seat.
  const kBack = Math.sqrt(1 - ((BUBBLE.backZ - C.z) / R.z) ** 2);
  const bulkhead = add(new THREE.CircleGeometry(1, 64), panelMat, [0, C.y, BUBBLE.backZ]);
  bulkhead.scale.set(R.x * kBack, R.y * kBack, 1);

  // Wing above and behind, on its pylon, with a lamp at each tip.
  add(wingGeometry(), hullMat);
  // A slim fairing carries it over the cabin.
  add(new RoundedBoxGeometry(0.34, 0.72, 1.7, 3, 0.15), hullMat, [0, 0.86, 1.6]);
  NAV.forEach((p, i) => add(new THREE.SphereGeometry(0.035, 12, 8), lampMats[i], p));

  // Where the instruments' face and the glare shield are, for their reflections in the glass
  // and for the light they shed.
  scene.updateMatrixWorld(true);
  const facePos = face.getWorldPosition(new THREE.Vector3());
  const faceQ = face.getWorldQuaternion(new THREE.Quaternion());
  const faceU = new THREE.Vector3(1, 0, 0).applyQuaternion(faceQ);
  const faceV = new THREE.Vector3(0, 1, 0).applyQuaternion(faceQ);
  const faceN = new THREE.Vector3(0, 0, 1).applyQuaternion(faceQ);
  const shieldPos = shield.getWorldPosition(new THREE.Vector3());
  const shieldQ = shield.getWorldQuaternion(new THREE.Quaternion());
  // Light the screens shed into the cabin: the attitude display, the radar, the dials.
  const screens = [
    { at: [-0.14, 0.02], color: [0.4, 0.55, 0.9] },
    { at: [0.04, 0.02], color: [0.25, 0.9, 0.4] },
    { at: [0.19, 0.03], color: [1.0, 0.6, 0.2] }
  ];
  screens.forEach((s, i) => {
    shared.uPointPos.value[i].copy(facePos).addScaledVector(faceU, s.at[0]).addScaledVector(faceV, s.at[1]).addScaledVector(faceN, 0.05);
  });
  NAV.forEach((p, i) => shared.uPointPos.value[3 + i].set(...p));
  shared.uPointPos.value[5].set(...BEACONS[1]);

  const streamers = createStreamers({ bubble: BUBBLE, bowZ: BOW_Z, archZ: ARCH_Z });
  const ribbons = createRibbons(renderer, 1400);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.03, 60);
  let layer = null;

  const glassPass = createPass({
    vertexShader,
    fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nin vec2 vUv;\n${common}\n${glassSrc}`,
    defines: {
      BUBBLE_C: `vec3(${BUBBLE.centre.map(v => v.toFixed(3)).join(", ")})`,
      BUBBLE_R: `vec3(${BUBBLE.radii.map(v => v.toFixed(3)).join(", ")})`,
      BACK_Z: BUBBLE.backZ.toFixed(3),
      GLOWS: `${streamers.max}`
    },
    uniforms: {
      uOutside: { value: null },
      uCockpit: { value: null },
      uMist: { value: null },
      uMistOn: { value: 0 },
      uShow: { value: show },
      uAtlas: { value: instruments.texture },
      uHeadRight: { value: new THREE.Vector3(1, 0, 0) },
      uHeadUp: { value: new THREE.Vector3(0, 1, 0) },
      uHeadForward: { value: new THREE.Vector3(0, 0, -1) },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uEye: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uRain: { value: 0 },
      uHail: { value: 0 },
      uCloud: { value: 0 },
      uMotes: { value: 0 },
      uHaze: { value: 0 },
      uWindAxis: { value: new THREE.Vector3(0, 0, 1) },
      uWindSpeed: { value: 68 },
      uMoteAxis: { value: new THREE.Vector3(0, 0, 1) },
      uMoteSpeed: { value: 68 },
      uLight: { value: [new THREE.Vector3(), new THREE.Vector3()] },
      uBeaconPos: { value: BEACONS.map(p => new THREE.Vector3(...p)) },
      uBeacon: { value: new THREE.Vector3() },
      uNavPos: { value: NAV.map(p => new THREE.Vector3(...p)) },
      uNav: { value: NAV_COLORS.map(c => new THREE.Vector3(...c).multiplyScalar(NAV_POWER)) },
      uFacePos: { value: facePos },
      uFaceU: { value: faceU },
      uFaceV: { value: faceV },
      uFaceHalf: { value: new THREE.Vector2(0.245, 0.1225).multiplyScalar(CONSOLE_SCALE) },
      uFaceGain: shared.uFaceGain,
      uShieldPos: { value: shieldPos },
      uShieldU: { value: new THREE.Vector3(1, 0, 0).applyQuaternion(shieldQ) },
      uShieldV: { value: new THREE.Vector3(0, 0, 1).applyQuaternion(shieldQ) },
      uShieldHalf: { value: new THREE.Vector2(0.285, 0.105).multiplyScalar(CONSOLE_SCALE) },
      uGlow: { value: Array.from({ length: streamers.max }, () => new THREE.Vector4()) },
      uExposure: { value: 8 },
      uDazzle: { value: 0 },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 }
    }
  });

  const inverse = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const headRight = new THREE.Vector3();
  const headUp = new THREE.Vector3();
  const headForward = new THREE.Vector3();
  let frame = 0;

  // Irradiance of lightning at the aircraft (colour), and the direction it comes from.
  function lightningAt(view, positions, weights, power, depth, color, outDir, outLight) {
    let e = 0;
    tmp.set(0, 0, 0);
    positions.forEach((p, k) => {
      const d = Math.hypot(p[0] - view.x, p[1] - view.alt, p[2] - view.z) * 1e-3;
      e += (weights[k] * Math.exp(-d / 8)) / (d * d + 0.12);
      tmp.x += weights[k] * (p[0] - view.x);
      tmp.y += weights[k] * (p[1] - view.alt);
      tmp.z += weights[k] * (p[2] - view.z);
    });
    const spread = 1 + depth / 380;
    const scale = (power * e) / (spread * spread);
    outDir.copy(tmp).normalize().applyQuaternion(inverse);
    outLight.set(color[0] * scale, color[1] * scale, color[2] * scale);
  }

  let lastFire = null;

  return {
    /** St. Elmo's fire as last drawn (for the sound). */
    get fire() {
      return lastFire;
    },

    /**
     * view: the frame's view (with qAircraft, qHead, eye, cabin, flash, flick);
     * outside: the image of the outside, linear and exposed. Draws the finished frame to the
     * screen.
     */
    render(view, outside, width, height, { mist = null, skyLight = [0, 0, 0], exposure = 8 } = {}) {
      if (!layer || layer.width !== width || layer.height !== height) {
        layer?.dispose();
        layer = new THREE.WebGLRenderTarget(width, height, {
          type: THREE.HalfFloatType,
          format: THREE.RGBAFormat,
          depthBuffer: true,
          stencilBuffer: false,
          samples: 4
        });
      }
      const cabin = view.cabin;
      const t = view.time;
      inverse.copy(view.qAircraft).invert();
      // The power (it fails after the strike: moments.js).
      const power = view.power ?? { on: 1, booting: false };
      instruments.update(view, t, power);
      shared.uFaceGain.value = 0.014 * power.on;

      // The moon: seen from the aircraft or hidden by the storm (worked out in main.js).
      const moonSeen = view.moonSeen ?? 1;
      shared.uDirDir.value[0].copy(view.sunDir).applyQuaternion(inverse);
      shared.uDirLight.value[0].set(...skyLight).multiplyScalar(moonSeen * (1 - cabin.cloud));
      shared.uAmbient.value.set(...skyLight).multiplyScalar(0.05 + 0.1 * moonSeen);
      shared.uFogSigma.value = 0.12 * cabin.cloud + 0.003 * cabin.rain * cabin.storm;

      // Lightning.
      const g = glassPass.uniforms;
      const f = view.flash;
      const k = view.flick;
      if (f && f.on && f.power > 0) lightningAt(view, f.pos, f.weight, f.power, f.depth, f.color, shared.uDirDir.value[1], shared.uDirLight.value[1]);
      else shared.uDirLight.value[1].set(0, 0, 0);
      if (k && k.on && k.power > 0) lightningAt(view, [k.pos], [1], k.power, k.depth, k.color, shared.uDirDir.value[2], shared.uDirLight.value[2]);
      else shared.uDirLight.value[2].set(0, 0, 0);
      for (let i = 0; i < 2; i++) g.uLight.value[i].copy(shared.uDirLight.value[1 + i]);

      // The aircraft's own lights. The beacons flash: a sharp rise, a short tail.
      const pulse = beaconPulse(t);
      g.uBeacon.value.set(...BEACON_COLOR).multiplyScalar(BEACON_POWER * pulse * power.on);
      // In cloud the beacons' flashes fill the cloud around, and the cabin with it.
      shared.uAmbient.value.addScaledVector(g.uBeacon.value, 0.003 * cabin.cloud);
      screens.forEach((s, i) => shared.uPointLight.value[i].set(...s.color).multiplyScalar(0.0011 * power.on * (power.booting ? 0.6 : 1)));
      NAV_COLORS.forEach((c, i) => {
        shared.uPointLight.value[3 + i].set(...c).multiplyScalar(0.09 * power.on);
        g.uNav.value[i].set(...c).multiplyScalar(NAV_POWER * power.on);
        lampMats[i].uniforms.uEmissive.value.set(...c).multiplyScalar(0.8 * power.on);
      });
      shared.uPointLight.value[5].set(...BEACON_COLOR).multiplyScalar(0.5 * pulse * power.on);
      // A strike right at the aircraft dazzles: the whole view goes white with its strokes.
      // (its return strokes, not the glow between them).
      const stroke = f && f.on && f.kind === "strike" && f.event ? f.power / f.event.scale : 0;
      g.uDazzle.value = 0.06 * Math.max(stroke - 0.45, 0) ** 2;

      // St. Elmo's fire: streamers over the glass, and their violet light in the cabin.
      const fire = streamers.update(t, cabin.elmo);
      lastFire = fire;
      shared.uPointPos.value[6].copy(fire.centre);
      shared.uPointLight.value[6].set(0.3, 0.36, 1.0).multiplyScalar(0.012 * fire.light);
      for (let i = 0; i < streamers.max; i++) g.uGlow.value[i].copy(fire.glows[i]);

      // The head in the cabin.
      headRight.set(1, 0, 0).applyQuaternion(view.qHead);
      headUp.set(0, 1, 0).applyQuaternion(view.qHead);
      headForward.set(0, 0, -1).applyQuaternion(view.qHead);
      shared.uEye.value.copy(view.eye);
      camera.position.copy(view.eye);
      camera.quaternion.copy(view.qHead);
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(view.tanHalf.y));
      camera.aspect = view.tanHalf.x / view.tanHalf.y;
      camera.updateProjectionMatrix();

      // The layer: streamers first (they are on the glass, behind everything in the cabin),
      // then the cockpit over them.
      renderer.setRenderTarget(layer);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      if (fire.segments) {
        if (fire.changed) ribbons.set(fire.segments);
        const coreScale = Math.max(height / 1080, 0.5);
        ribbons.render(
          {
            eye: view.eye,
            right: headRight,
            up: headUp,
            forward: headForward,
            tanHalf: view.tanHalf,
            width,
            height,
            power: 0.11 * fire.power,
            color: [0.62, 0.6, 1.0],
            pixels: 9 * coreScale,
            coreScale: coreScale * 0.8,
            near: 0.05
          },
          layer
        );
      }
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(layer);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;

      // The glass pass finishes the frame.
      g.uOutside.value = outside;
      g.uCockpit.value = layer.texture;
      g.uMist.value = mist;
      g.uMistOn.value = mist ? 1 : 0;
      g.uHeadRight.value.copy(headRight);
      g.uHeadUp.value.copy(headUp);
      g.uHeadForward.value.copy(headForward);
      g.uTanHalf.value.copy(view.tanHalf);
      g.uEye.value.copy(view.eye);
      g.uTime.value = t;
      g.uRain.value = cabin.rain;
      g.uHail.value = cabin.hail;
      g.uCloud.value = cabin.cloud;
      g.uMotes.value = cabin.mist ?? cabin.cloud;
      g.uHaze.value = cabin.storm;
      // Rain as the cabin meets it: the drops fall, and the air streams back past the cabin.
      const fall = tmp.set(0, -8, 0).applyQuaternion(inverse);
      fall.z += view.speed ?? 68;
      g.uWindSpeed.value = fall.length();
      g.uWindAxis.value.copy(fall).normalize();
      // The cloud's droplets ride the air: its gusts and drafts, as the cabin meets them.
      const air = view.airVel || [0, 0, 0];
      const ride = tmp.set(air[0], air[1], air[2]).applyQuaternion(inverse);
      ride.z += view.speed ?? 68;
      g.uMoteSpeed.value = ride.length();
      g.uMoteAxis.value.copy(ride).normalize();
      g.uExposure.value = exposure;
      g.uScreen.value.set(width, height);
      g.uFrame.value = frame++;
      glassPass.render(renderer, null);
    }
  };
}
