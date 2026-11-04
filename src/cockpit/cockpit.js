import * as THREE from "three";
import { createPass } from "../sky/fullscreen.js";
import vertexShader from "../shaders/fullscreen.vert?raw";
import common from "../shaders/common.glsl?raw";
import glassSrc from "../shaders/glass.frag?raw";

/**
 * The glass-bubble cockpit: a few frame members, a small instrument panel whose screens only
 * glow (no readable text), the seat, and the high wing and ducted fan behind. It is drawn into
 * its own layer, then the glass pass lays it over the outside seen through the glass, with
 * rain, hail and St. Elmo's fire on the glass.
 * Aircraft frame (m): the eye at the origin, -z ahead, +y up, +x right.
 */
export const BUBBLE = Object.freeze({ centre: [0, -0.25, -0.45], radii: [1.05, 1.15, 1.35], backZ: 0.35 });
// Frame members lie where the bubble meets these planes.
export const FRAMES = Object.freeze({ frontHoopZ: -0.95, rearHoopZ: 0.15, baseY: -1.05 });

const [CX, CY, CZ] = BUBBLE.centre;
const [RX, RY, RZ] = BUBBLE.radii;

/** Ring where the bubble meets the plane z = z0. */
function hoopZ(z0, from = 0, to = Math.PI * 2, n = 96) {
  const k = Math.sqrt(Math.max(1 - ((z0 - CZ) / RZ) ** 2, 0));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    pts.push(new THREE.Vector3(RX * k * Math.cos(a), CY + RY * k * Math.sin(a), z0));
  }
  return pts;
}

/** Ring where the bubble meets the plane y = y0 (the base). */
function hoopY(y0, n = 96) {
  const k = Math.sqrt(Math.max(1 - ((y0 - CY) / RY) ** 2, 0));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (Math.PI * 2 * i) / n;
    const z = CZ + RZ * k * Math.sin(a);
    pts.push(new THREE.Vector3(RX * k * Math.cos(a), y0, Math.min(z, BUBBLE.backZ)));
  }
  return pts;
}

/** Overhead bow in the plane x = 0, from the top of the front hoop over the head to the back. */
function bow(n = 96) {
  const pts = [];
  const b0 = Math.acos(-(FRAMES.frontHoopZ - CZ) / RZ);
  const b1 = Math.acos(-(BUBBLE.backZ - CZ) / RZ);
  for (let i = 0; i <= n; i++) {
    const b = b0 + ((b1 - b0) * i) / n;
    pts.push(new THREE.Vector3(0, CY + RY * Math.sin(b), CZ - RZ * Math.cos(b)));
  }
  return pts;
}

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
uniform float uKind;       // 0 = plain, 1 = frame member, 2 = screen
uniform vec3 uScreenTint;
uniform vec3 uSkyDir;      // moon (or sun), in the aircraft frame
uniform vec3 uSkyLight;
uniform vec3 uAmbient;
uniform vec3 uFlashDir;
uniform vec3 uFlashLight;
uniform vec3 uPanelPos;
uniform vec3 uPanelLight;
uniform float uElmo;
uniform float uTime;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 light = uAmbient + uSkyLight * max(dot(n, uSkyDir), 0.0);
  // A flash lights everything a little (it is all around inside a cloud), more what faces it.
  light += uFlashLight * (0.3 + 0.7 * max(dot(n, uFlashDir), 0.0));
  vec3 lp = uPanelPos - vPos;
  light += uPanelLight * max(dot(n, normalize(lp)), 0.0) / (dot(lp, lp) + 0.03);
  // St. Elmo's fire bathes the cockpit in violet.
  light += vec3(0.25, 0.3, 0.8) * 0.0015 * uElmo;
  vec3 c = uAlbedo * light;
  if (uKind > 1.5) {
    // Screens: a soft glow with slow abstract traces, never text or numbers.
    vec2 uv = vUv;
    float base = 0.55 + 0.15 * uv.y;
    float trace = smoothstep(0.035, 0.0, abs(uv.y - 0.5 - 0.18 * sin(uv.x * 7.0 + uTime * 0.6) * sin(uTime * 0.23)));
    float sweep = smoothstep(0.08, 0.0, abs(fract(uv.x - uTime * 0.07) - 0.5)) * 0.5;
    float grain = 0.9 + 0.1 * hash(floor(uv * vec2(60.0, 30.0)));
    float edge = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x) * smoothstep(0.0, 0.1, uv.y) * smoothstep(1.0, 0.9, uv.y);
    c += uScreenTint * (base + 1.6 * trace + sweep) * grain * edge;
  }
  if (uKind > 0.5 && uKind < 1.5 && uElmo > 0.0) {
    // St. Elmo's fire on the frame: hot spots that run along it and crackle, over a faint glow.
    float along = vUv.x * 80.0;
    float run = max(sin(along * 0.9 + uTime * 6.0) * sin(along * 0.37 - uTime * 3.3), 0.0);
    float spots = pow(run, 5.0);
    float crackle = step(0.55, hash(vec2(floor(uTime * 40.0), floor(along * 0.5))));
    c += vec3(0.45, 0.55, 1.0) * uElmo * (0.008 + 0.22 * spots * (0.3 + 0.7 * crackle));
  }
  outColor = vec4(c, 1.0);
}
`;

function material(albedo, kind = 0, tint = [0, 0, 0], shared) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: meshVertex,
    fragmentShader: meshFragment,
    uniforms: {
      ...shared,
      uAlbedo: { value: new THREE.Vector3(...albedo) },
      uKind: { value: kind },
      uScreenTint: { value: new THREE.Vector3(...tint) }
    },
    side: THREE.DoubleSide
  });
}

export function createCockpit(renderer) {
  const shared = {
    uSkyDir: { value: new THREE.Vector3(0, 1, 0) },
    uSkyLight: { value: new THREE.Vector3() },
    uAmbient: { value: new THREE.Vector3() },
    uFlashDir: { value: new THREE.Vector3(0, 1, 0) },
    uFlashLight: { value: new THREE.Vector3() },
    uPanelPos: { value: new THREE.Vector3(0, -0.52, -0.74) },
    uPanelLight: { value: new THREE.Vector3(0.012, 0.007, 0.003) },
    uElmo: { value: 0 },
    uTime: { value: 0 }
  };
  const scene = new THREE.Scene();
  const frameMat = material([0.07, 0.07, 0.075], 1, [0, 0, 0], shared);
  const darkMat = material([0.035, 0.035, 0.04], 0, [0, 0, 0], shared);
  const seatMat = material([0.05, 0.045, 0.045], 0, [0, 0, 0], shared);
  const hullMat = material([0.12, 0.12, 0.13], 0, [0, 0, 0], shared);
  const amberMat = material([0, 0, 0], 2, [0.016, 0.009, 0.0035], shared);
  const greenMat = material([0, 0, 0], 2, [0.004, 0.014, 0.008], shared);

  const tube = (points, radius, closed = false) =>
    new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points, closed), points.length * 2, radius, 10, closed), frameMat);

  // Frame: a hoop ahead framing the view, one beside the head, an overhead bow, the base ring.
  scene.add(tube(hoopZ(FRAMES.frontHoopZ), 0.024, true));
  scene.add(tube(hoopZ(FRAMES.rearHoopZ), 0.03, true));
  scene.add(tube(bow(), 0.022));
  scene.add(tube(hoopY(FRAMES.baseY), 0.03, true));

  // Instrument panel: a small console low ahead, tilted towards the eye, with two screens.
  const panel = new THREE.Group();
  panel.position.set(0, -0.6, -0.78);
  panel.rotation.x = -0.45;
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.16), darkMat);
  panel.add(box);
  for (const [x, mat] of [[-0.125, amberMat], [0.125, greenMat]]) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.1), mat);
    screen.position.set(x, 0.0615, 0.0);
    screen.rotation.x = -Math.PI / 2;
    panel.add(screen);
  }
  // A short stem down to the floor frame.
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.45, 10), darkMat);
  stem.position.set(0, -0.26, 0.02);
  panel.add(stem);
  scene.add(panel);

  // Seat: back behind the head, cushion below.
  const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.85, 0.09), seatMat);
  seatBack.position.set(0, -0.32, 0.3);
  seatBack.rotation.x = 0.12;
  scene.add(seatBack);
  const cushion = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), seatMat);
  cushion.position.set(0, -0.82, 0.05);
  scene.add(cushion);

  // Bulkhead closing the bubble behind the seat.
  const k = Math.sqrt(1 - ((BUBBLE.backZ - CZ) / RZ) ** 2);
  const bulkhead = new THREE.Mesh(new THREE.CircleGeometry(1, 48), darkMat);
  bulkhead.scale.set(RX * k, RY * k, 1);
  bulkhead.position.set(0, CY, BUBBLE.backZ);
  scene.add(bulkhead);

  // High wing above and behind, and the ducted fan at the back.
  const wing = new THREE.Mesh(new THREE.BoxGeometry(15, 0.12, 1.5), hullMat);
  wing.position.set(0, 1.12, 1.35);
  scene.add(wing);
  const duct = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.12, 12, 48), hullMat);
  duct.position.set(0, 0.25, 3.0);
  scene.add(duct);

  const camera = new THREE.PerspectiveCamera(60, 1, 0.03, 60);
  let layer = null;

  const glassPass = createPass({
    vertexShader,
    fragmentShader: `precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nin vec2 vUv;\n${common}\n${glassSrc}`,
    defines: {
      BUBBLE_C: `vec3(${BUBBLE.centre.map(v => v.toFixed(3)).join(", ")})`,
      BUBBLE_R: `vec3(${BUBBLE.radii.map(v => v.toFixed(3)).join(", ")})`,
      BACK_Z: BUBBLE.backZ.toFixed(3),
      FRONT_HOOP_Z: FRAMES.frontHoopZ.toFixed(3),
      REAR_HOOP_Z: FRAMES.rearHoopZ.toFixed(3),
      BASE_Y: FRAMES.baseY.toFixed(3)
    },
    uniforms: {
      uOutside: { value: null },
      uCockpit: { value: null },
      uHeadRight: { value: new THREE.Vector3(1, 0, 0) },
      uHeadUp: { value: new THREE.Vector3(0, 1, 0) },
      uHeadForward: { value: new THREE.Vector3(0, 0, -1) },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uEye: { value: new THREE.Vector3() },
      uTime: { value: 0 },
      uRain: { value: 0 },
      uHail: { value: 0 },
      uElmo: { value: 0 },
      uFlash: { value: 0 },
      uPanelGlow: { value: 1 },
      uExposure: { value: 8 },
      uScreen: { value: new THREE.Vector2(1, 1) }
    }
  });

  const inverse = new THREE.Quaternion();
  const tmp = new THREE.Vector3();

  return {
    /**
     * view: the frame's view (with qAircraft, qHead, eye, cabin), outside: the finished
     * outside image; draws the cockpit and the glass to the screen.
     */
    render(view, outside, width, height, { skyLight = [0, 0, 0], ambient = [0, 0, 0], exposure = 8 } = {}) {
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
      inverse.copy(view.qAircraft).invert();
      shared.uSkyDir.value.copy(view.sunDir).applyQuaternion(inverse);
      shared.uSkyLight.value.set(...skyLight).multiplyScalar(1 - cabin.inside);
      shared.uAmbient.value.set(...ambient);
      const f = view.flash;
      if (f && f.on) {
        // Light of the flash at the aircraft, with the falloff the clouds use (km).
        let e = 0;
        const c = [0, 0, 0];
        for (let i = 0; i < 3; i++) {
          const d = Math.hypot(f.pos[i][0] - view.x, f.pos[i][1] - view.alt, f.pos[i][2] - view.z) * 1e-3;
          e += f.weight[i] * Math.exp(-d / 8) / (d * d + 0.04);
          for (let a = 0; a < 3; a++) c[a] += f.weight[i] * f.pos[i][a];
        }
        tmp.set(c[0] - view.x, c[1] - view.alt, c[2] - view.z).normalize().applyQuaternion(inverse);
        shared.uFlashDir.value.copy(tmp);
        const power = f.power * e * 0.25;
        shared.uFlashLight.value.set(f.color[0] * power, f.color[1] * power, f.color[2] * power);
        glassPass.uniforms.uFlash.value = Math.min(power * 0.5, 4);
      } else {
        shared.uFlashLight.value.set(0, 0, 0);
        glassPass.uniforms.uFlash.value = 0;
      }
      shared.uElmo.value = cabin.elmo;
      shared.uTime.value = view.time;

      camera.position.copy(view.eye);
      camera.quaternion.copy(view.qHead);
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(view.tanHalf.y));
      camera.aspect = view.tanHalf.x / view.tanHalf.y;
      camera.updateProjectionMatrix();
      renderer.setRenderTarget(layer);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);

      const g = glassPass.uniforms;
      g.uOutside.value = outside;
      g.uCockpit.value = layer.texture;
      g.uHeadRight.value.set(1, 0, 0).applyQuaternion(view.qHead);
      g.uHeadUp.value.set(0, 1, 0).applyQuaternion(view.qHead);
      g.uHeadForward.value.set(0, 0, -1).applyQuaternion(view.qHead);
      g.uTanHalf.value.copy(view.tanHalf);
      g.uEye.value.copy(view.eye);
      g.uTime.value = view.time;
      g.uRain.value = cabin.rain;
      g.uHail.value = cabin.hail;
      g.uElmo.value = cabin.elmo;
      g.uExposure.value = exposure;
      g.uScreen.value.set(width, height);
      glassPass.render(renderer, null);
    }
  };
}
