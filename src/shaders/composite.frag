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
// Night: the "sun" uniforms carry the moon. The lightning channels (r: the flash, g: the
// flicker) hold light per unit of their power.
uniform sampler2D uFlash;
uniform float uFlashPower;
uniform vec3 uFlashColor;
uniform float uFlickPower;
uniform vec3 uFlickColor;
uniform float uLinearOut; // 1: leave the image linear (exposed) for the cockpit's glass pass to finish
uniform vec3 uFlashPos[3];  // where the flash's light comes from, relative to the camera (y: altitude)
uniform vec3 uFlashWeight;
uniform vec3 uFlickPos;
uniform vec4 uSprite;       // a red sprite: where it stands (x, z relative to the camera, m), how bright, how many columns
uniform float uSpriteSeed;
uniform float uTime;
uniform vec2 uScreen; // output size in pixels

float spriteHash(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

// A cluster of red sprites, seen on a plane facing the camera at the cluster: x across, y up (km,
// y the height). Each column has a bright red head 66 to 74 km up, a red glow above it, and
// tendrils that hang 15 to 25 km below it, fanning out, turning blue-violet.
vec3 spriteGlow(float x, float y, float count, float seed) {
  vec3 col = vec3(0.0);
  for (int k = 0; k < 8; k++) {
    if (float(k) >= count) break;
    float fk = float(k);
    float xk = (spriteHash(seed + fk * 1.31) - 0.5) * 24.0;
    float w = 0.5 + 1.3 * spriteHash(seed + fk * 2.17);
    float yh = 66.0 + 8.0 * spriteHash(seed + fk * 3.71);
    float dx = x - xk;
    float head = exp(-dx * dx / (w * w)) * exp(-(y - yh) * (y - yh) / 9.0);
    float above = exp(-dx * dx / (w * w * 3.0)) * smoothstep(yh - 2.0, yh + 2.0, y) * exp(-max(y - yh, 0.0) / 8.0) * 0.45;
    float strands = 0.0;
    float depth = yh - y;
    if (depth > 0.0) {
      float reach = 15.0 + 10.0 * spriteHash(seed + fk * 5.3);
      for (int s = 0; s < 5; s++) {
        float fan = (spriteHash(seed + fk * 7.1 + float(s) * 1.7) - 0.5) * 0.5;
        float xs = xk + fan * depth;
        float ws = 0.1 + 0.012 * depth;
        strands += exp(-(x - xs) * (x - xs) / (ws * ws)) * exp(-depth / 10.0) * (1.0 - smoothstep(reach - 4.0, reach, depth));
      }
    }
    // (Deeper than they are: the night grade takes most of the colour out of what is outside.)
    vec3 tendril = mix(vec3(0.3, 0.05, 1.0), vec3(1.0, 0.0, 0.06), smoothstep(yh - 12.0, yh - 1.0, y));
    col += vec3(1.0, 0.0, 0.05) * (head + above) + tendril * strands * 0.5;
  }
  return col;
}

// The sea at night: black, but lightning over it lights the water around it and shines in it,
// a broad glossy smear (the storm's wind roughens the water). Per unit of irradiance at 1 km.
vec3 seaLit(vec3 dir, float camAlt, vec3 src, float weight) {
  vec3 p = vec3(dir.xz * (camAlt / -dir.y), 0.0).xzy;
  vec3 s = src - p;
  float d = length(s);
  vec3 l = s / max(d, 1.0);
  float dKm = d * 1e-3;
  float e = weight * exp(-dKm / 8.0) / (dKm * dKm + 0.02);
  float diffuse = 0.05 / PI * max(l.y, 0.0);
  float gloss = 0.012 * exp((max(dot(reflect(dir, vec3(0.0, 1.0, 0.0)), l), 0.0) - 1.0) / 0.012);
  return vec3(e * (diffuse + gloss));
}

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
  if (h2 > 0.06) return vec3(0.0);
  vec3 star = normalize((cell + 0.25 + 0.5 * h) / N);
  float ang = acos(clamp(dot(dir, star), -1.0, 1.0));
  float spread = pixelAngle * 0.75;
  float b = pow(h.x, 9.0) * 4.0 + 0.006 + 0.02 * pow(h.y, 4.0);
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
#ifdef NIGHT
  alpha *= 0.3; // at night cirrus is a faint veil in the moonlight, not streaks across the stars
#endif
  vec3 light = sunColor * (0.55 * hgPhase(0.75, cosS) + 0.45 * hgPhase(0.1, cosS)) * 2.2 + ambient * 0.9;
  return vec4(light * alpha, alpha);
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
    // A red sprite, far beyond the storm.
    if (uSprite.z > 0.0) {
      float D = length(uSprite.xy);
      vec2 n = uSprite.xy / max(D, 1.0);
      float along = dot(dir.xz, n);
      if (along > 0.05) {
        float t = D / along;
        float x = dot(dir.xz * t, vec2(-n.y, n.x)) * 1e-3;
        float y = ((uCamR - RG) * 1000.0 + dir.y * t) * 1e-3;
        sky += spriteGlow(x, y, uSprite.w, uSpriteSeed) * (uSprite.z * 0.06) * tView;
      }
    }
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
  if (belowHorizon && dir.y < -1e-3) {
    float seaAlt = (uCamR - RG) * 1000.0;
    vec3 sea = vec3(0.0);
    if (uFlashPower > 0.0) {
      for (int k = 0; k < 3; k++) sea += uFlashColor * uFlashPower * seaLit(dir, seaAlt, uFlashPos[k], uFlashWeight[k]);
    }
    if (uFlickPower > 0.0) sea += uFlickColor * uFlickPower * seaLit(dir, seaAlt, uFlickPos, 1.0);
    color += sea * scene.a;
  }
  vec2 lightning = texture(uFlash, vUv).rg;
  color += uFlashColor * (uFlashPower * lightning.r) + uFlickColor * (uFlickPower * lightning.g);
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

#ifdef NIGHT
  if (uLinearOut > 0.5) {
    outColor = vec4(color * uExposure, 1.0);
    return;
  }
#endif
  color = agx(color * uExposure);
  color = linearToSrgb(color);
  float dither = (hash12(gl_FragCoord.xy + mod(uFrame, 16.0) * 7.31) + hash12(gl_FragCoord.yx * 1.37 + 3.1) - 1.0) / 255.0;
  outColor = vec4(color + dither, 1.0);
}
