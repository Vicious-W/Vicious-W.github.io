// Temporal resolve of the mist around the aircraft (mist.frag): the new frame's jittered march,
// blended with the last result reprojected at the mist's own depth (it streams past fast: a
// wisp ten metres away moves tens of pixels a frame), clamped to the new frame's neighbourhood
// so that what moved off a pixel does not linger there.

uniform sampler2D uCur;       // rgb: light, a: transmittance
uniform sampler2D uCurDepth;  // r: representative depth of the mist (m)
uniform sampler2D uHist;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamAlt;
uniform vec3 uPrevRight;
uniform vec3 uPrevUp;
uniform vec3 uPrevForward;
uniform vec2 uPrevTanHalf;
uniform vec3 uPrevCamPos;     // the last camera, relative to this one (y: its altitude)
uniform float uBlend;
uniform float uClampHistory;
uniform float uHistoryValid;
out vec4 outColor;

vec2 projectPrev(vec3 v) {
  float z = dot(v, uPrevForward);
  if (z <= 1e-4) return vec2(-1.0);
  vec2 ndc = vec2(dot(v, uPrevRight) / (z * uPrevTanHalf.x), dot(v, uPrevUp) / (z * uPrevTanHalf.y));
  return ndc * 0.5 + 0.5;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uCur, 0);
  vec4 cur = texelFetch(uCur, p, 0);
  vec4 mn = cur;
  vec4 mx = cur;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      vec4 c = texelFetch(uCur, clamp(p + ivec2(x, y), ivec2(0), size - 1), 0);
      mn = min(mn, c);
      mx = max(mx, c);
    }
  }
  vec4 result = cur;
  if (uHistoryValid > 0.5) {
    float depth = texelFetch(uCurDepth, p, 0).r;
    vec3 dir = cameraRay(vUv, uCamRight, uCamUp, uCamForward, uTanHalf);
    vec2 prevUv = projectPrev(vec3(0.0, uCamAlt, 0.0) + dir * depth - uPrevCamPos);
    if (all(greaterThanEqual(prevUv, vec2(0.0))) && all(lessThanEqual(prevUv, vec2(1.0)))) {
      vec4 hist = textureLod(uHist, prevUv, 0.0);
      if (uClampHistory > 0.5) hist = clamp(hist, mn, mx);
      result = mix(hist, cur, uBlend);
    }
  }
  outColor = result;
}
