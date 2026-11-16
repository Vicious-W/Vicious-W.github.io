// Temporal accumulation of the jittered cloud rays, reprojected with the cloud depth.
// The cloud pass renders half the pixels each frame in a checkerboard that alternates every
// frame: pixel (x, y) is fresh when x + y + parity is even, and its value is stored at
// (x / 2, y) of the half-width current target. A fresh pixel blends its new sample into the
// reprojected history; the others keep the reprojected history, clamped to their fresh
// neighbours (all four direct neighbours of a pixel have the other parity), or take the
// neighbours' average where there is no history. The clamp is relaxed where the neighbourhood
// is (almost) only sea or sky: their reprojection is exact, so the history can be trusted,
// and clamping their noisy shading (cloud shadows on the glitter) would leave dark blocks.

uniform sampler2D uCurScene;
uniform sampler2D uCurDepth;
uniform sampler2D uHistScene;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamAlt;
uniform vec3 uPrevRight;
uniform vec3 uPrevUp;
uniform vec3 uPrevForward;
uniform vec2 uPrevTanHalf;
uniform vec3 uPrevCamPos;
uniform int uParity;
uniform float uBlend;
uniform float uClampHistory;
uniform float uHistoryValid;

layout(location = 0) out vec4 outScene;
layout(location = 1) out vec4 outDepth;

#ifdef NIGHT
// The lightning channels (r: the flash, g: the flicker; light per unit of their power) are
// rebuilt the same way, but the history of one is dropped when its lightning strikes anew:
// that light came from somewhere else.
uniform sampler2D uCurFlash;
uniform sampler2D uHistFlash;
uniform vec2 uFlashReset;
layout(location = 2) out vec4 outFlash;
#endif

ivec2 gFull;

vec2 projectPrev(vec3 v) {
  float z = dot(v, uPrevForward);
  if (z <= 1e-4) return vec2(-1.0);
  vec2 ndc = vec2(dot(v, uPrevRight) / (z * uPrevTanHalf.x), dot(v, uPrevUp) / (z * uPrevTanHalf.y));
  return ndc * 0.5 + 0.5;
}

// Only valid for fresh pixels. Off-screen neighbours are mirrored back inside: a step of two
// keeps the parity.
ivec2 inside(ivec2 q) {
  if (q.x < 0) q.x += 2;
  if (q.x >= gFull.x) q.x -= 2;
  if (q.y < 0) q.y += 2;
  if (q.y >= gFull.y) q.y -= 2;
  return q;
}

vec4 freshScene(ivec2 q) {
  q = inside(q);
  return texelFetch(uCurScene, ivec2(q.x >> 1, q.y), 0);
}

#ifdef NIGHT
vec2 freshFlash(ivec2 q) {
  q = inside(q);
  return texelFetch(uCurFlash, ivec2(q.x >> 1, q.y), 0).rg;
}
#endif

// r = depth (km), g = cloud opacity.
vec2 freshDepth(ivec2 q) {
  q = inside(q);
  return texelFetch(uCurDepth, ivec2(q.x >> 1, q.y), 0).rg;
}

void main() {
  gFull = ivec2(textureSize(uHistScene, 0));
  ivec2 p = ivec2(gl_FragCoord.xy);
  bool fresh = ((p.x + p.y + uParity) & 1) == 0;

  vec4 cur;
  float depthKm;
  float cloud;
  vec4 mn;
  vec4 mx;
  if (fresh) {
    cur = freshScene(p);
    vec2 dc = freshDepth(p);
    depthKm = dc.x;
    cloud = dc.y;
    mn = cur;
    mx = cur;
    // The diagonal neighbours are fresh too.
    for (int k = 0; k < 4; k++) {
      ivec2 o = ivec2((k & 1) * 2 - 1, (k >> 1) * 2 - 1);
      vec4 c = freshScene(p + o);
      mn = min(mn, c);
      mx = max(mx, c);
      cloud = max(cloud, freshDepth(p + o).y);
    }
  } else {
    vec4 c0 = freshScene(p + ivec2(-1, 0));
    vec4 c1 = freshScene(p + ivec2(1, 0));
    vec4 c2 = freshScene(p + ivec2(0, -1));
    vec4 c3 = freshScene(p + ivec2(0, 1));
    cur = 0.25 * (c0 + c1 + c2 + c3);
    mn = min(min(c0, c1), min(c2, c3));
    mx = max(max(c0, c1), max(c2, c3));
    // Reproject with the neighbours' depth (sky where none of them sees cloud or sea).
    vec2 e0 = freshDepth(p + ivec2(-1, 0));
    vec2 e1 = freshDepth(p + ivec2(1, 0));
    vec2 e2 = freshDepth(p + ivec2(0, -1));
    vec2 e3 = freshDepth(p + ivec2(0, 1));
    vec4 d = vec4(e0.x, e1.x, e2.x, e3.x);
    vec4 hit = step(0.0, d);
    float n = dot(hit, vec4(1.0));
    depthKm = n > 0.0 ? dot(d * hit, vec4(1.0)) / n : -1.0;
    cloud = max(max(e0.y, e1.y), max(e2.y, e3.y));
  }

  vec3 dir = cameraRay(vUv, uCamRight, uCamUp, uCamForward, uTanHalf);
  vec2 prevUv;
  if (depthKm > 0.0) {
    vec3 P = vec3(0.0, uCamAlt, 0.0) + dir * (depthKm * 1000.0);
    prevUv = projectPrev(P - uPrevCamPos);
  } else {
    prevUv = projectPrev(dir);
  }

  vec4 result = cur;
  bool onScreen = prevUv.x >= 0.0 && prevUv.y >= 0.0 && prevUv.x <= 1.0 && prevUv.y <= 1.0;
  if (uHistoryValid > 0.5 && onScreen) {
    vec4 hist = textureLod(uHistScene, prevUv, 0.0);
    if (uClampHistory > 0.5) {
      vec4 slack = (mx - mn) * mix(2.0, 0.25, smoothstep(0.15, 0.6, cloud));
      hist = clamp(hist, mn - slack, mx + slack);
    }
    result = fresh ? mix(hist, cur, uBlend) : hist;
  }
  outScene = result;
  outDepth = vec4(depthKm, cloud, 0.0, 1.0);

#ifdef NIGHT
  vec2 fcur;
  vec2 fmn;
  vec2 fmx;
  if (fresh) {
    fcur = freshFlash(p);
    fmn = fcur;
    fmx = fcur;
    for (int k = 0; k < 4; k++) {
      vec2 c = freshFlash(p + ivec2((k & 1) * 2 - 1, (k >> 1) * 2 - 1));
      fmn = min(fmn, c);
      fmx = max(fmx, c);
    }
  } else {
    vec2 c0 = freshFlash(p + ivec2(-1, 0));
    vec2 c1 = freshFlash(p + ivec2(1, 0));
    vec2 c2 = freshFlash(p + ivec2(0, -1));
    vec2 c3 = freshFlash(p + ivec2(0, 1));
    fcur = 0.25 * (c0 + c1 + c2 + c3);
    fmn = min(min(c0, c1), min(c2, c3));
    fmx = max(max(c0, c1), max(c2, c3));
  }
  vec2 flash = fcur;
  if (uHistoryValid > 0.5 && onScreen) {
    vec2 fh = textureLod(uHistFlash, prevUv, 0.0).rg;
    if (uClampHistory > 0.5) fh = clamp(fh, fmn - (fmx - fmn) * 0.25, fmx + (fmx - fmn) * 0.25);
    flash = mix(fresh ? mix(fh, fcur, uBlend) : fh, fcur, step(0.5, uFlashReset));
  }
  outFlash = vec4(flash, 0.0, 1.0);
#endif
}
