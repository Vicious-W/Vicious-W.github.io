import * as THREE from "three";

/**
 * Glowing ribbons that face the viewer: line segments drawn additively, each with a hot core
 * and a soft halo. They draw the visible lightning channels over the image of the outside (a
 * channel in front of the clouds is seen directly; behind them, only as much as the clouds
 * let through: their depth and sky visibility come from the cloud passes), and the small
 * discharges that crawl over the cockpit's glass.
 */

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
uniform float uNear;
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
  float near = uNear;
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
uniform float uOcclude; // 1: hide what lies behind the clouds
in float vAcross;
in float vGlow;
in float vWidth;
in float vDist;
out vec4 outColor;

void main() {
  float seen = 1.0;
  if (uOcclude > 0.5) {
    vec2 uv = gl_FragCoord.xy / uScreen;
    float visibility = texture(uScene, uv).a;
    float depthKm = texture(uDepth, uv).r;
    float distKm = vDist * 1e-3;
    seen = (depthKm < 0.0 || distKm < depthKm - 0.2) ? 1.0 : visibility;
  }
  float x = abs(vAcross) / uCoreScale;
  float core = exp(-x * x / (vWidth * vWidth + 0.05)) * 1.6;
  float halo = exp(-x / 4.0) * 0.22;
  float i = (core + halo) * vGlow * uPower * seen;
  outColor = vec4(uColor * i, 1.0);
}
`;

/**
 * A set of ribbons. set(segments) loads segments { a, b, width, glow } (points as [x, y, z]);
 * render(...) draws them, adding their light to the target without touching its alpha.
 */
export function createRibbons(renderer, maxSegments = 1200) {
  const geometry = new THREE.BufferGeometry();
  const vertices = maxSegments * 4;
  const aA = new Float32Array(vertices * 3);
  const aB = new Float32Array(vertices * 3);
  const aCorner = new Float32Array(vertices * 2);
  const aWidth = new Float32Array(vertices);
  const aGlow = new Float32Array(vertices);
  const index = new Uint32Array(maxSegments * 6);
  for (let s = 0; s < maxSegments; s++) {
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
      uNear: { value: 5 },
      uCoreScale: { value: 1 },
      uOcclude: { value: 0 },
      uScene: { value: null },
      uDepth: { value: null },
      uPower: { value: 0 },
      uColor: { value: new THREE.Vector3(0.85, 0.9, 1.0) }
    },
    // Adds light; leaves the target's alpha as it is.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  return {
    set(segments) {
      const n = Math.min(segments.length, maxSegments);
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
    },

    /**
     * eye, right, up, forward (THREE.Vector3) and tanHalf: the camera, in the frame of the
     * segments; pixels: half-width of the ribbon on screen; occlusion: the cloud image
     * (textures[0] rgb + visibility, [1] depth) to hide what lies behind clouds, or null.
     */
    render({ eye, right, up, forward, tanHalf, width, height, power, color, pixels, coreScale, near, occlusion = null }, target = null) {
      const u = material.uniforms;
      u.uCam.value.copy(eye);
      u.uCamRight.value.copy(right);
      u.uCamUp.value.copy(up);
      u.uCamForward.value.copy(forward);
      u.uTanHalf.value.copy(tanHalf);
      u.uScreen.value.set(width, height);
      u.uCoreScale.value = coreScale;
      u.uPixels.value = pixels;
      u.uNear.value = near;
      u.uOcclude.value = occlusion ? 1 : 0;
      u.uScene.value = occlusion ? occlusion.textures[0] : null;
      u.uDepth.value = occlusion ? occlusion.textures[1] : null;
      u.uPower.value = power;
      u.uColor.value.set(...color);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
    }
  };
}

/** The visible channel of the current flash. */
export function createBolts(renderer) {
  const ribbons = createRibbons(renderer, 1200);
  const eye = new THREE.Vector3();
  let current = null;
  return {
    /**
     * Draws the channel of the flash (if it has one) over the frame in target (or the screen).
     * gain scales its light: 1 for a tone-mapped image, more for a linear one.
     */
    render(view, flash, sceneTarget, width, height, target = null, gain = 1) {
      if (!flash || !flash.on || !flash.bolt || flash.boltPower <= 0.01) return;
      if (flash.bolt !== current) {
        ribbons.set(flash.bolt);
        current = flash.bolt;
      }
      // About 2 px of core at 1080 lines, a halo of a few times that.
      const coreScale = Math.max(height / 1080, 0.5);
      ribbons.render(
        {
          eye: eye.set(view.x, view.alt, view.z),
          right: view.right,
          up: view.up,
          forward: view.forward,
          tanHalf: view.tanHalf,
          width,
          height,
          power: flash.boltPower * gain,
          color: flash.color,
          pixels: 14 * coreScale,
          coreScale,
          near: 5,
          occlusion: sceneTarget
        },
        target
      );
    }
  };
}
