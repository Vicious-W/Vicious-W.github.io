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
uniform sampler2D uWeather;
uniform vec2 uCirrusOffset;

out vec4 outColor;

#ifdef NIGHT
// Night: the "sun" uniforms carry the moon. The flash channel is light per unit flash power.
uniform sampler2D uFlash;
uniform float uFlashPower;
uniform vec3 uFlashColor;
uniform float uTime;
uniform vec2 uScreen; // output size in pixels

// Stars on a fixed celestial grid: a cell of a 3D grid around the viewer may hold one star,
// kept away from the cell walls so a single look-up finds it. Brightness follows a steep power
// law: many faint stars, a few bright ones. They twinkle a little near the horizon.
vec3 starField(vec3 dir, float pixelAngle) {
  const float N = 260.0;
  vec3 g = dir * N;
  vec3 cell = floor(g);
  vec3 h = fract(sin(vec3(dot(cell, vec3(127.1, 311.7, 74.7)), dot(cell, vec3(269.5, 183.3, 246.1)),
                          dot(cell, vec3(113.5, 271.9, 124.6)))) * 43758.5453);
  float h2 = fract(sin(dot(cell, vec3(419.2, 371.9, 168.2))) * 43758.5453);
  if (h2 > 0.11) return vec3(0.0);
  vec3 star = normalize((cell + 0.25 + 0.5 * h) / N);
  float ang = acos(clamp(dot(dir, star), -1.0, 1.0));
  float spread = pixelAngle * 0.75;
  float b = pow(h.x, 7.0) * 3.0 + 0.012;
  float twinkle = 1.0 + 0.35 * (1.0 - smoothstep(0.0, 0.3, dir.y)) * sin(uTime * (7.0 + 9.0 * h.y) + 40.0 * h.z);
  vec3 tint = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.9, 0.75), h.z);
  return tint * b * twinkle * exp(-(ang * ang) / (spread * spread)) * 0.02;
}

// A thin crescent: the moon is a lit sphere whose bright limb faces the sun below the horizon.
vec3 moonDisc(vec3 dir, vec3 moonDir, vec3 tMoon) {
  const float R = 0.0046; // angular radius (rad)
  vec3 right = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, moonDir);
  vec2 q = vec2(dot(dir - moonDir, right), dot(dir - moonDir, up)) / R;
  float r2 = dot(q, q);
  if (r2 >= 1.0 || dot(dir, moonDir) < 0.0) return vec3(0.0);
  vec3 nrm = vec3(q, sqrt(1.0 - r2));
  vec3 lit = normalize(vec3(0.35, -0.75, -0.55)); // light from below, mostly from behind
  float shade = max(dot(nrm, lit), 0.0);
  float edge = 1.0 - smoothstep(0.92, 1.0, sqrt(r2));
  return uSunIlluminance * tMoon * (shade * edge * 9000.0 + 4.0 * edge); // faint earthshine in the dark part
}
#endif

const float CIRRUS_ALT = 9500.0;
const mat2 CIRRUS_ROT = mat2(0.6, -0.8, 0.8, 0.6);
const vec2 CIRRUS_STRETCH = vec2(0.28, 1.0);

// Thin cirrus high above everything: a lit 2D layer over the sky, streaked along the wind.
vec4 cirrusLayer(vec3 dir, float camAlt, float cosS, vec3 sunColor, vec3 ambient) {
  if (dir.y < -0.01) return vec4(0.0);
  float a = dot(dir.xz, dir.xz) * (0.5 / RG_M);
  float b = dir.y;
  float c = camAlt - CIRRUS_ALT;
  float s = sqrt(max(b * b - 4.0 * a * c, 0.0));
  float q = -0.5 * (b + (b >= 0.0 ? s : -s));
  float t = b >= 0.0 ? c / q : q / a;
  if (!(t > 0.0) || t > 320000.0) return vec4(0.0);
  vec2 world = CIRRUS_STRETCH * (CIRRUS_ROT * (dir.xz * t)) + uCirrusOffset;
  vec2 uv = world / CIRRUS_PERIOD;
  vec4 broad = texture(uWeather, uv);
  vec4 fine = texture(uWeather, uv * 5.0 + vec2(0.37, 0.11));
  float patches = smoothstep(0.52, 0.8, broad.r) * smoothstep(0.3, 0.7, broad.b);
  float streaks = smoothstep(0.4, 0.95, fine.g * 0.7 + broad.a * 0.3);
  float fade = exp(-t / 160000.0) * smoothstep(-0.01, 0.04, dir.y);
  float alpha = clamp(patches * streaks * 0.5, 0.0, 0.8) * fade;
  vec3 light = sunColor * (0.55 * hgPhase(0.75, cosS) + 0.45 * hgPhase(0.1, cosS)) * 2.2 + ambient * 0.9;
  return vec4(light * alpha, alpha);
}

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
  v = luma + 1.32 * (v - luma);
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

#ifdef NIGHT
  float pixelAngle = 2.0 * uTanHalf.y / uScreen.y;
  if (!belowHorizon) {
    sky += starField(dir, pixelAngle) * tView;
    sky += moonDisc(dir, uSunDir, transmittanceToTop(uTransmittance, uCamR, uSunDir.y));
  }
#else
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
#endif

  float camAlt = (uCamR - RG) * 1000.0;
  vec3 sunAtCirrus = uSunIlluminance * transmittanceToSun(uTransmittance, RG + 9.5, uSunDir.y);
  vec4 ci = cirrusLayer(dir, camAlt, cosS, sunAtCirrus, sky);
  sky = sky * (1.0 - ci.a) + ci.rgb;

  vec3 color = sky * scene.a + scene.rgb;
#ifdef NIGHT
  color += uFlashColor * (uFlashPower * texture(uFlash, vUv).r);
#endif

  // Optical glare around the sun, dimmed when clouds cover the solar disc. The bright core
  // over-exposes to white like the sun in a camera or to the eye, so it reads larger than
  // the 0.53 degree disc itself.
  float sunVisible = uSunOnScreen > 0.5 ? texture(uScene, uSunUv).a : 1.0;
  vec3 tSun = transmittanceToTop(uTransmittance, uCamR, uSunDir.y);
#ifdef NIGHT
  // A soft halo around the moon.
  float glare = 0.004 * hgPhase(0.93, cosS);
#else
  float glare = 0.00012 * hgPhase(0.994, cosS) + 0.004 * hgPhase(0.9, cosS);
  if (cosS > 0.0) {
    float ang = asin(min(length(cross(dir, uSunDir)), 1.0));
    glare += 1.8 * exp(-(ang * ang) / (0.014 * 0.014));
  }
#endif
  color += uSunIlluminance * tSun * glare * sunVisible;

  color = agx(color * uExposure);
  color = linearToSrgb(color);
  float dither = (hash12(gl_FragCoord.xy + mod(uFrame, 16.0) * 7.31) + hash12(gl_FragCoord.yx * 1.37 + 3.1) - 1.0) / 255.0;
  outColor = vec4(color + dither, 1.0);
}
