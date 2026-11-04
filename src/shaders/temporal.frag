// Temporal accumulation of the jittered cloud rays, reprojected with the cloud depth.

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
uniform vec2 uTexel;
uniform float uBlend;
uniform float uClampHistory;

layout(location = 0) out vec4 outScene;
layout(location = 1) out vec4 outDepth;

vec2 projectPrev(vec3 v) {
  float z = dot(v, uPrevForward);
  if (z <= 1e-4) return vec2(-1.0);
  vec2 ndc = vec2(dot(v, uPrevRight) / (z * uPrevTanHalf.x), dot(v, uPrevUp) / (z * uPrevTanHalf.y));
  return ndc * 0.5 + 0.5;
}

void main() {
  vec4 cur = textureLod(uCurScene, vUv, 0.0);
  float depthKm = textureLod(uCurDepth, vUv, 0.0).r;
  vec3 dir = cameraRay(vUv, uCamRight, uCamUp, uCamForward, uTanHalf);

  vec2 prevUv;
  if (depthKm > 0.0) {
    vec3 P = vec3(0.0, uCamAlt, 0.0) + dir * (depthKm * 1000.0);
    prevUv = projectPrev(P - uPrevCamPos);
  } else {
    prevUv = projectPrev(dir);
  }

  vec4 result = cur;
  bool inside = prevUv.x >= 0.0 && prevUv.y >= 0.0 && prevUv.x <= 1.0 && prevUv.y <= 1.0;
  if (uBlend < 1.0 && inside) {
    vec4 hist = textureLod(uHistScene, prevUv, 0.0);
    if (uClampHistory > 0.5) {
      vec4 mn = cur;
      vec4 mx = cur;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec4 c = textureLod(uCurScene, vUv + vec2(float(x), float(y)) * uTexel, 0.0);
          mn = min(mn, c);
          mx = max(mx, c);
        }
      }
      vec4 slack = (mx - mn) * 0.25;
      hist = clamp(hist, mn - slack, mx + slack);
    }
    result = mix(hist, cur, uBlend);
  }
  outScene = result;
  outDepth = vec4(depthKm, 0.0, 0.0, 1.0);
}
