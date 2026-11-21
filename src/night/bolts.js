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
uniform float uPoint; // 1: each segment is a point (a lamp): a round glow
out float vAcross;
out float vAlong;
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
  vec2 pos = mix(pa, pb, aCorner.x) + nrm * aCorner.y * halfWidth + dir * (aCorner.x * 2.0 - 1.0) * halfWidth * (uPoint > 0.5 ? 1.0 : 0.5);
  gl_Position = vec4(pos / (0.5 * uScreen), 0.0, 1.0);
  vAcross = aCorner.y * halfWidth;
  vAlong = uPoint > 0.5 ? (aCorner.x * 2.0 - 1.0) * halfWidth : 0.0;
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
uniform float uPoint;
in float vAcross;
in float vAlong;
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
  float x = length(vec2(vAcross, vAlong)) / uCoreScale;
  float core = exp(-x * x / (vWidth * vWidth + 0.05)) * 1.6;
  float halo = exp(-x / 4.0) * 0.22;
  // A lamp in rain and mist, seen by the eye: a wide, faint glare around the point.
  if (uPoint > 0.5) halo += exp(-x / 9.0) * 0.06 + exp(-x / 28.0) * 0.012;
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
      uPoint: { value: 0 },
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
    render({ eye, right, up, forward, tanHalf, width, height, power, color, pixels, coreScale, near, occlusion = null, points = false }, target = null) {
      const u = material.uniforms;
      u.uPoint.value = points ? 1 : 0;
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

/**
 * Lamps seen directly (another aircraft's: moments.js), as small round glows, dimmed by the
 * clouds before them (the mist near the aircraft dims them in the glass pass). lamps: { pos,
 * light } relative to the eye in world axes.
 */
export function createLampPoints(renderer, count = 4) {
  const points = Array.from({ length: count }, () => createRibbons(renderer, 1));
  const eye = new THREE.Vector3();
  return {
    render(view, lamps, sceneTarget, width, height, target = null, gain = 1) {
      const coreScale = Math.max(height / 1080, 0.5);
      eye.set(view.x, view.alt, view.z);
      lamps.pos.forEach((p, i) => {
        const l = lamps.light[i];
        const intensity = Math.max(l.x, l.y, l.z);
        if (intensity <= 0) return;
        const d2 = Math.max(p.lengthSq(), 400);
        const at = [view.x + p.x, view.alt + p.y, view.z + p.z];
        points[i].set([{ a: at, b: at, width: 1, glow: 1 }]);
        points[i].render(
          {
            eye,
            right: view.right,
            up: view.up,
            forward: view.forward,
            tanHalf: view.tanHalf,
            width,
            height,
            power: (gain * 10000 * intensity) / d2,
            color: [l.x / intensity, l.y / intensity, l.z / intensity],
            pixels: 70 * coreScale,
            coreScale,
            near: 1,
            occlusion: sceneTarget,
            points: true
          },
          target
        );
      });
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
      if (!flash || !flash.on || !flash.bolt) return;
      const spider = flash.kind === "spider";
      if (spider) {
        // The web as far as its leaders have reached: the tips bright, behind them a glow that
        // fades; then the strokes light all of it, the main channel most.
        const age = flash.age ?? 0;
        const crawl = flash.event ? flash.event.crawl : 1;
        const lit = [];
        for (const s of flash.bolt) {
          const since = age - s.at;
          if (since < 0) continue;
          const lead = age < crawl + 0.05 ? 0.9 * Math.exp(-since / 0.06) + 0.25 * Math.exp(-since / 0.5) : 0;
          const stroke = age >= crawl ? Math.min(flash.boltPower, 1.5) * (s.main ? 1 : 0.5) : 0;
          const glow = lead + stroke;
          if (glow > 0.01) lit.push({ a: s.a, b: s.b, width: s.width, glow });
        }
        ribbons.set(lit);
        current = null;
      } else {
        if (flash.boltPower <= 0.01) return;
        if (flash.bolt !== current) {
          ribbons.set(flash.bolt);
          current = flash.bolt;
        }
      }
      // About 2 px of core at 1080 lines, a halo of a few times that. The strike's channel is
      // metres away: wide, blinding, in front of any cloud, and it moves with the aircraft.
      const coreScale = Math.max(height / 1080, 0.5);
      const strike = flash.kind === "strike";
      ribbons.render(
        {
          eye: strike && flash.anchor ? eye.set(...flash.anchor) : eye.set(view.x, view.alt, view.z),
          right: view.right,
          up: view.up,
          forward: view.forward,
          tanHalf: view.tanHalf,
          width,
          height,
          power: (spider ? 1 : flash.boltPower) * gain * (strike ? 4 : 1),
          color: flash.color,
          pixels: (strike ? 40 : 14) * coreScale,
          coreScale: strike ? coreScale * 3 : coreScale,
          near: strike ? 1.5 : 5,
          occlusion: strike ? null : sceneTarget
        },
        target
      );
    }
  };
}
