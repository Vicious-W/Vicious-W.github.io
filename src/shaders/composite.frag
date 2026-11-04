// Full-resolution composite: sky, sun, upsampled clouds and sea, glare, tone mapping.

uniform sampler2D uScene;
uniform sampler2D uSkyView;
uniform sampler2D uTransmittance;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamR;
uniform vec3 uSunDir;
uniform vec3 uSunIlluminance;
uniform vec2 uSunUv;
uniform float uSunOnScreen;
uniform float uExposure;
uniform float uFrame;

out vec4 outColor;

// AgX (Troy Sobotka), polynomial fit by Benjamin Wrensch.
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 v) {
  const mat3 inset = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                          0.0784335999999992, 0.878468636469772, 0.0784336,
                          0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 outset = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                           -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                           -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  v = inset * v;
  v = clamp(log2(max(v, vec3(1e-10))), minEv, maxEv);
  v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // Gentle "look": a touch more contrast and saturation than base AgX.
  float luma = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3(0.0)), vec3(1.12));
  luma = pow(max(luma, 0.0), 1.12);
  v = luma + 1.28 * (v - luma);
  v = outset * v;
  return pow(max(v, vec3(0.0)), vec3(2.2));
}

vec3 linearToSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThanEqual(c, vec3(0.0031308))));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 dir = cameraRay(vUv, uCamRight, uCamUp, uCamForward, uTanHalf);
  vec4 scene = texture(uScene, vUv);
  vec3 sky = skyLookup(uSkyView, dir, uSunDir, uCamR);

  bool belowHorizon = rayIntersectsGround(uCamR, dir.y);
  float cosS = dot(dir, uSunDir);
  vec3 tView = belowHorizon ? vec3(0.0) : transmittanceToTop(uTransmittance, uCamR, dir.y);

  // Solar disc with limb darkening.
  if (cosS > 0.0 && !belowHorizon) {
    float rho = asin(min(length(cross(dir, uSunDir)), 1.0)) / SUN_ANGULAR_RADIUS;
    if (rho < 1.0) {
      float mu = sqrt(max(1.0 - rho * rho, 0.0));
      float limb = 1.0 - 0.6 * (1.0 - mu);
      vec3 sunRadiance = uSunIlluminance / (PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS);
      sky += sunRadiance * tView * limb;
    }
  }

  vec3 color = sky * scene.a + scene.rgb;

  // Optical glare around the sun, dimmed when clouds cover the solar disc.
  float sunVisible = uSunOnScreen > 0.5 ? texture(uScene, uSunUv).a : 1.0;
  vec3 tSun = transmittanceToTop(uTransmittance, uCamR, uSunDir.y);
  float glare = 0.00012 * hgPhase(0.994, cosS) + 0.004 * hgPhase(0.9, cosS);
  color += uSunIlluminance * tSun * glare * sunVisible;

  color = agx(color * uExposure);
  color = linearToSrgb(color);
  float dither = (hash12(gl_FragCoord.xy + mod(uFrame, 16.0) * 7.31) + hash12(gl_FragCoord.yx * 1.37 + 3.1) - 1.0) / 255.0;
  outColor = vec4(color + dither, 1.0);
}
