import * as THREE from "three";

/**
 * Visible lightning channels, drawn over the finished image as thin glowing ribbons that face
 * the viewer. A channel in front of the clouds is seen directly; behind them, only as much as
 * the clouds let through (their depth and sky visibility come from the cloud passes).
 */

const MAX_SEGMENTS = 1200;

const vertexShader = /* glsl */ `
precision highp float;
in vec3 aA;
in vec3 aB;
in vec2 aCorner; // x: along the segment (0 or 1), y: side (-1 or 1)
in float aWidth;
in float aGlow;
uniform vec3 uCam;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform vec2 uScreen;
uniform float uPixels;
out float vAcross;
out float vGlow;
out float vWidth;
out float vDist;

vec3 toView(vec3 p) {
  vec3 r = p - uCam;
  return vec3(dot(r, uCamRight), dot(r, uCamUp), dot(r, uCamForward));
}

void main() {
  vec3 va = toView(aA);
  vec3 vb = toView(aB);
  const float near = 5.0;
  if (va.z < near && vb.z < near) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (va.z < near) va = mix(va, vb, (near - va.z) / (vb.z - va.z));
  if (vb.z < near) vb = mix(vb, va, (near - vb.z) / (va.z - vb.z));
  vec2 pa = va.xy / (va.z * uTanHalf) * 0.5 * uScreen;
  vec2 pb = vb.xy / (vb.z * uTanHalf) * 0.5 * uScreen;
  vec2 dir = pb - pa;
  float len = length(dir);
  dir = len > 1e-3 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float halfWidth = uPixels * (0.5 + 0.5 * aWidth);
  vec2 pos = mix(pa, pb, aCorner.x) + nrm * aCorner.y * halfWidth + dir * (aCorner.x * 2.0 - 1.0) * halfWidth * 0.5;
  gl_Position = vec4(pos / (0.5 * uScreen), 0.0, 1.0);
  vAcross = aCorner.y * halfWidth;
  vGlow = aGlow;
  vWidth = aWidth;
  vDist = mix(length(va), length(vb), aCorner.x);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uScene; // rgb + sky visibility
uniform sampler2D uDepth; // r = depth (km), -1 for open sky
uniform vec2 uScreen;
uniform float uPower;
uniform vec3 uColor;
uniform float uCoreScale;
in float vAcross;
in float vGlow;
in float vWidth;
in float vDist;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uScreen;
  float visibility = texture(uScene, uv).a;
  float depthKm = texture(uDepth, uv).r;
  float distKm = vDist * 1e-3;
  float seen = (depthKm < 0.0 || distKm < depthKm - 0.2) ? 1.0 : visibility;
  float x = abs(vAcross) / uCoreScale;
  float core = exp(-x * x / (vWidth * vWidth + 0.05)) * 1.6;
  float halo = exp(-x / 4.0) * 0.22;
  float i = (core + halo) * vGlow * uPower * seen;
  outColor = vec4(uColor * i, 1.0);
}
`;

export function createBolts(renderer) {
  const geometry = new THREE.BufferGeometry();
  const vertices = MAX_SEGMENTS * 4;
  const aA = new Float32Array(vertices * 3);
  const aB = new Float32Array(vertices * 3);
  const aCorner = new Float32Array(vertices * 2);
  const aWidth = new Float32Array(vertices);
  const aGlow = new Float32Array(vertices);
  const index = new Uint32Array(MAX_SEGMENTS * 6);
  for (let s = 0; s < MAX_SEGMENTS; s++) {
    const v = s * 4;
    aCorner.set([0, -1, 0, 1, 1, -1, 1, 1], v * 2);
    index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
  }
  const attr = (array, size) => new THREE.BufferAttribute(array, size).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aA", attr(aA, 3));
  geometry.setAttribute("aB", attr(aB, 3));
  geometry.setAttribute("aCorner", new THREE.BufferAttribute(aCorner, 2));
  geometry.setAttribute("aWidth", attr(aWidth, 1));
  geometry.setAttribute("aGlow", attr(aGlow, 1));
  // A dummy position attribute keeps three.js happy about bounding volumes.
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);

  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uCamRight: { value: new THREE.Vector3() },
      uCamUp: { value: new THREE.Vector3() },
      uCamForward: { value: new THREE.Vector3() },
      uTanHalf: { value: new THREE.Vector2(1, 1) },
      uScreen: { value: new THREE.Vector2(1, 1) },
      uPixels: { value: 12 },
      uCoreScale: { value: 1 },
      uScene: { value: null },
      uDepth: { value: null },
      uPower: { value: 0 },
      uColor: { value: new THREE.Vector3(0.85, 0.9, 1.0) }
    },
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let current = null;

  function upload(segments) {
    const n = Math.min(segments.length, MAX_SEGMENTS);
    for (let s = 0; s < n; s++) {
      const seg = segments[s];
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        aA.set(seg.a, v * 3);
        aB.set(seg.b, v * 3);
        aWidth[v] = seg.width;
        aGlow[v] = seg.glow;
      }
    }
    for (const name of ["aA", "aB", "aWidth", "aGlow"]) geometry.attributes[name].needsUpdate = true;
    geometry.setDrawRange(0, n * 6);
  }

  return {
    /** Draws the channel of the current flash (if any) over the frame in target (or the screen). */
    render(view, flash, sceneTarget, width, height, target = null) {
      if (!flash || !flash.on || !flash.bolt || flash.boltPower <= 0.01) return;
      if (flash.bolt !== current) {
        upload(flash.bolt);
        current = flash.bolt;
      }
      const u = material.uniforms;
      u.uCam.value.set(view.x, view.alt, view.z);
      u.uCamRight.value.copy(view.right);
      u.uCamUp.value.copy(view.up);
      u.uCamForward.value.copy(view.forward);
      u.uTanHalf.value.copy(view.tanHalf);
      u.uScreen.value.set(width, height);
      // About 2 px of core at 1080 lines, a halo of a few times that.
      u.uCoreScale.value = Math.max(height / 1080, 0.5);
      u.uPixels.value = 14 * u.uCoreScale.value;
      u.uScene.value = sceneTarget.textures[0];
      u.uDepth.value = sceneTarget.textures[1];
      u.uPower.value = flash.boltPower;
      u.uColor.value.set(...flash.color);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    }
  };
}
