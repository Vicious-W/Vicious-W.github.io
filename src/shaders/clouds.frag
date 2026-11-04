// Volumetric cumulus over the sea, one ray per pixel at reduced resolution.
// Output 0: rgb = radiance of clouds and sea (aerial perspective included), a = sky visibility.
// Output 1: r = representative depth in km, or -1 when the ray only sees sky.
// BASE_PERIOD, DETAIL_PERIOD, WEATHER_PERIOD_A/B, CLOUD_BOTTOM and CLOUD_TOP_MAX come from defines.

uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform sampler2D uSkyView;
uniform sampler3D uBaseNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeather;

uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamAlt;
uniform vec3 uSunDir;
uniform vec3 uSunIlluminance;
uniform float uFrame;
uniform vec2 uResolution;
uniform vec3 uBaseOffset;
uniform vec3 uDetailOffset;
uniform vec2 uWeatherOffsetA;
uniform vec2 uWeatherOffsetB;
uniform float uCoverage;
uniform float uDensityScale;
uniform int uMaxSteps;
uniform float uStepScale;

layout(location = 0) out vec4 outScene;
layout(location = 1) out vec4 outDepth;

const float MAX_DIST = 64000.0;
const float DETAIL_DIST = 15000.0;
const float ALBEDO = 0.985;
const mat2 WEATHER_ROT = mat2(0.8, 0.6, -0.6, 0.8);

float remap(float v, float l0, float h0, float l1, float h1) {
  return l1 + (v - l0) * (h1 - l1) / (h0 - l0);
}

// Altitude above the sea with the planet curvature (camera sits at x = z = 0).
float altitudeAt(vec3 p) {
  return p.y + dot(p.xz, p.xz) * (0.5 / RG_M);
}

// Stable roots of a t^2 + b t + c = 0 (a >= 0), sorted.
int quadRoots(float a, float b, float c, out vec2 roots) {
  roots = vec2(-1.0);
  if (a < 1e-14) {
    if (abs(b) < 1e-9) return 0;
    roots = vec2(-c / b);
    return 1;
  }
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return 0;
  float s = sqrt(disc);
  float q = -0.5 * (b + (b >= 0.0 ? s : -s));
  float r1 = q / a;
  float r2 = abs(q) > 1e-20 ? c / q : r1;
  roots = vec2(min(r1, r2), max(r1, r2));
  return 2;
}

bool cloudInterval(float y0, vec3 d, out float t0, out float t1) {
  float a = dot(d.xz, d.xz) * (0.5 / RG_M);
  vec2 rb;
  vec2 rt;
  int nb = quadRoots(a, d.y, y0 - CLOUD_BOTTOM, rb);
  int nt = quadRoots(a, d.y, y0 - CLOUD_TOP_MAX, rt);
  t0 = -1.0;
  t1 = -1.0;
  if (y0 >= CLOUD_BOTTOM && y0 <= CLOUD_TOP_MAX) {
    t0 = 0.0;
    t1 = nt > 0 ? rt.y : MAX_DIST;
    if (nb >= 1 && rb.x > 0.0) t1 = min(t1, rb.x);
  } else if (y0 < CLOUD_BOTTOM) {
    if (nb == 0 || rb.y <= 0.0) return false;
    t0 = rb.y;
    t1 = nt > 0 ? rt.y : MAX_DIST;
  } else {
    if (nt < 2 || rt.y <= 0.0) return false;
    t0 = max(rt.x, 0.0);
    t1 = (nb >= 1 && rb.x > 0.0) ? rb.x : rt.y;
  }
  t1 = min(t1, MAX_DIST);
  return t1 > t0;
}

float seaHit(float y0, vec3 d) {
  vec2 r;
  int n = quadRoots(dot(d.xz, d.xz) * (0.5 / RG_M), d.y, y0, r);
  return (n > 0 && r.x > 0.0) ? r.x : -1.0;
}

struct Weather {
  float coverage;
  float top;
};

Weather weatherAt(vec2 xz, float lodLocal, float lodRegional) {
  vec2 ua = (xz + uWeatherOffsetA) / WEATHER_PERIOD_A;
  vec2 ub = (WEATHER_ROT * xz + uWeatherOffsetB) / WEATHER_PERIOD_B;
  vec4 wa = textureLod(uWeather, ua, max(lodRegional, 0.0));
  vec4 wb = textureLod(uWeather, ub, max(lodLocal, 0.0));
  float tower = smoothstep(0.6, 0.86, wa.b) * smoothstep(0.45, 0.8, wb.g);
  float cov = uCoverage + (wa.r - 0.5) * 0.85 + (wb.g - 0.5) * 0.55 + tower * 0.08;
  Weather w;
  // Never let coverage approach 1: then the 2D map, not the 3D noise, would shape the clouds.
  w.coverage = clamp(cov, 0.0, 0.72);
  w.top = mix(2600.0, 5600.0, tower) + (wb.a - 0.5) * 700.0;
  return w;
}

// detail: 0 = base shape only, 1 = detail erosion, 2 = detail plus a finer octave (close range).
float densityAt(vec3 p, Weather w, float lodB, float lodD, int detail, out float h) {
  float alt = altitudeAt(p);
  h = (alt - CLOUD_BOTTOM) / max(w.top - CLOUD_BOTTOM, 200.0);
  if (h <= 0.0 || h >= 1.0 || w.coverage <= 0.0) return 0.0;
  // Flat condensation level at the base; rounded tops.
  float profile = smoothstep(0.0, 0.05, h) * (1.0 - smoothstep(0.4, 1.0, h));
  // Slightly squashed vertically so thresholded features do not stretch into spikes.
  vec3 bp = (p + uBaseOffset) * vec3(1.0, BASE_Y_SCALE, 1.0) / BASE_PERIOD;
  vec2 n = textureLod(uBaseNoise, bp, lodB).rg;
  float d = clamp(remap(n.r * profile, 1.0 - w.coverage, 1.0, 0.0, 1.0), 0.0, 1.0) * w.coverage;
  if (d <= 0.0) return 0.0;
  // Medium billows: erode between Worley cells, mostly at the thin edges.
  d = clamp(remap(d, (1.0 - n.g) * 0.3, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (detail == 0 || d <= 0.0) return d;
  vec3 q = (p + uDetailOffset) / DETAIL_PERIOD;
  vec3 dn = textureLod(uDetailNoise, q, lodD).rgb;
  float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  if (detail > 1) {
    // Integer frequency multiple keeps the wrapped detail offset continuous.
    vec3 dn2 = textureLod(uDetailNoise, q * 3.0, lodD + 1.585).rgb;
    dfbm = dfbm * 0.72 + (dn2.r * 0.625 + dn2.g * 0.25 + dn2.b * 0.125) * 0.28;
  }
  // Wispy near the base, billowy towards the top.
  float erosion = mix(dfbm, 1.0 - dfbm, clamp(h * 5.0, 0.0, 1.0));
  return clamp(remap(d, erosion * 0.42, 1.0, 0.0, 1.0), 0.0, 1.0);
}

// Optical depth towards the sun with exponentially growing steps.
float lightDepth(vec3 p, Weather w, float lodB, float lodD, bool near) {
  float od = 0.0;
  float prev = 0.0;
  float d = 30.0;
  float h;
  for (int j = 0; j < 7; j++) {
    float seg = d - prev;
    vec3 q = p + uSunDir * (prev + 0.5 * seg);
    od += densityAt(q, w, lodB + float(j) * 0.5, lodD + float(j) * 0.5, (near && j < 2) ? 1 : 0, h) * seg;
    prev = d;
    d *= 2.1;
  }
  return od * uDensityScale;
}

float cloudPhase(float c, float k) {
  return mix(hgPhase(0.85 * k, c), hgPhase(-0.25 * k, c), 0.22);
}

float stepAt(float t) {
  return clamp(t * 0.016, 28.0, 650.0) * uStepScale;
}

// Fraction of sunlight reaching a point on the sea through the clouds.
float seaShadow(vec3 p, float jitter) {
  float sy = max(uSunDir.y, 0.08);
  float s0 = CLOUD_BOTTOM / sy;
  float s1 = CLOUD_TOP_MAX / sy;
  const int N = 8;
  float ds = (s1 - s0) / float(N);
  float od = 0.0;
  float h;
  for (int i = 0; i < N; i++) {
    vec3 q = p + uSunDir * (s0 + (float(i) + jitter) * ds);
    Weather w = weatherAt(q.xz, 2.0, 1.0);
    od += densityAt(q, w, 2.0, 0.0, 0, h) * ds;
  }
  return exp(-od * uDensityScale * 0.45);
}

vec3 shadeSea(vec3 dir, float tSea, float rCamKm, vec3 skyAvg, float jitter) {
  vec3 p = vec3(0.0, uCamAlt, 0.0) + dir * tSea;
  vec3 n = normalize(vec3(p.x, RG_M, p.z));
  vec3 v = -dir;
  float NoV = max(dot(n, v), 1e-3);
  float NoL = dot(n, uSunDir);
  vec3 Esun = uSunIlluminance * transmittanceToSun(uTransmittance, RG + 0.001, NoL) * seaShadow(p, jitter);
  // Wind patches: the sea is rougher in some places than others, so the glitter is mottled.
  vec2 wp = WEATHER_ROT * p.xz + uWeatherOffsetB;
  // Periods divide the weather periods exactly, so wrapped offsets stay continuous.
  float patchA = textureLod(uWeather, wp / (WEATHER_PERIOD_B / 4.0), 0.0).g;
  float patchB = textureLod(uWeather, (p.xz + uWeatherOffsetA) / (WEATHER_PERIOD_A / 60.0), 0.0).a;
  float roughness = mix(0.55, 1.6, patchA * 0.65 + patchB * 0.35);

  vec3 R = reflect(dir, n);
  R = normalize(vec3(R.x, max(R.y, 0.015), R.z));
  vec3 skyR = skyLookup(uSkyView, R, uSunDir, rCamKm);
  float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

  // Sun glitter from a Cox-Munk slope distribution (wind about 6 m/s).
  vec3 hv = normalize(uSunDir + v);
  float NoH = max(dot(n, hv), 1e-3);
  float sigma2 = (0.003 + 0.00512 * 6.0) * roughness;
  float cos2 = NoH * NoH;
  float D = exp(-(1.0 - cos2) / (cos2 * sigma2)) / (PI * sigma2 * cos2 * cos2);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(v, hv), 0.0), 5.0);
  vec3 glint = Esun * Fh * D / (4.0 * NoV) * step(0.0, NoL);

  vec3 Ed = Esun * max(NoL, 0.0) + PI * skyAvg;
  vec3 body = vec3(0.0009, 0.0042, 0.0105) * Ed * (1.0 - F);
  return skyR * F + glint + body;
}

void main() {
  vec3 dir = cameraRay(vUv, uCamRight, uCamUp, uCamForward, uTanHalf);
  float rCamKm = RG + uCamAlt * 1e-3;
  float pixelAngle = 2.0 * uTanHalf.y / uResolution.y;
  float cosTheta = dot(dir, uSunDir);
  float ph0 = cloudPhase(cosTheta, 1.0);
  float ph1 = cloudPhase(cosTheta, 0.6);
  float ph2 = cloudPhase(cosTheta, 0.36);
  float ph3 = cloudPhase(cosTheta, 0.2);
  float powderAmount = 0.55 * (1.0 - smoothstep(-0.2, 0.75, cosTheta));

  vec3 sunAtClouds = uSunIlluminance * transmittanceToSun(uTransmittance, RG + 3.0, uSunDir.y);
  vec3 skyZen = skyLookup(uSkyView, vec3(0.0, 1.0, 0.0), uSunDir, rCamKm);
  vec3 skyHor = skyLookup(uSkyView, normalize(vec3(-uSunDir.x, 0.1, -uSunDir.z) + vec3(1e-4)), uSunDir, rCamKm);
  vec3 skyAvg = skyZen * 0.55 + skyHor * 0.45;
  vec3 ambTop = skyAvg * 0.55;
  vec3 ambBottom = skyAvg * 0.18;

  float tSea = seaHit(uCamAlt, dir);
  float t0;
  float t1;
  bool hasLayer = cloudInterval(uCamAlt, dir, t0, t1);
  if (tSea > 0.0) t1 = min(t1, tSea);

  vec3 L = vec3(0.0);
  float T = 1.0;
  float dsum = 0.0;
  float wsum = 0.0;
  // Per-pixel noise, advanced along a golden-ratio sequence every frame.
  float jitter = fract(interleavedGradientNoise(gl_FragCoord.xy, 0.0) + 0.61803398875 * mod(uFrame, 1024.0));
  if (hasLayer && t1 > t0) {
    float t = t0 + stepAt(t0) * jitter;
    bool fine = false;
    int emptyRun = 0;
    for (int i = 0; i < 512; i++) {
      if (i >= uMaxSteps || t >= t1 || T < 0.01) break;
      float dt = stepAt(t);
      vec3 p = vec3(0.0, uCamAlt, 0.0) + dir * t;
      float fp = max(t * pixelAngle, 1.0);
      Weather w = weatherAt(p.xz, log2(fp / (WEATHER_PERIOD_B / 512.0)), log2(fp / (WEATHER_PERIOD_A / 512.0)));
      if (w.coverage < 0.02) {
        fine = false;
        t += dt * 2.5;
        continue;
      }
      float lodB = max(log2(fp / (BASE_PERIOD / 128.0)), 0.0);
      float lodD = max(log2(fp / (DETAIL_PERIOD / 32.0)), 0.0);
      float h;
      if (!fine) {
        // Coarse search through empty air with the cheap base shape only.
        float probe = densityAt(p, w, lodB + 0.5, lodD, 0, h);
        if (probe > 0.0) {
          fine = true;
          emptyRun = 0;
          t = max(t - dt * 1.6, t0);
        } else {
          t += dt * 2.0;
        }
        continue;
      }
      int detail = t < 2500.0 ? 2 : (t < DETAIL_DIST ? 1 : 0);
      float dens = densityAt(p, w, lodB, lodD, detail, h);
      if (dens > 0.001) {
        emptyRun = 0;
        float sigma = dens * uDensityScale;
        float od = lightDepth(p, w, lodB, lodD, t < 6000.0);
        // Single scattering plus an energy-preserving approximation of multiple scattering.
        float sun = ph0 * exp(-od)
                  + 1.2 * (0.85 * ph1 * exp(-od * 0.25)
                         + 0.65 * ph2 * exp(-od * 0.0625)
                         + 0.40 * ph3 * exp(-od * 0.021));
        // "Powder": thin edges and crevices hold less multiply scattered light, so they read
        // darker from the lit side. Fades out when looking towards the sun to keep silver linings.
        float powder = 1.0 - exp(-sigma * 140.0);
        sun *= mix(1.0, powder, powderAmount);
        vec3 amb = mix(ambBottom, ambTop, clamp(h, 0.0, 1.0));
        vec3 S = (sunAtClouds * sun + amb) * ALBEDO;
        float tr = exp(-sigma * dt);
        float absorbed = T * (1.0 - tr);
        L += S * absorbed;
        dsum += t * absorbed;
        wsum += absorbed;
        T *= tr;
      } else if (++emptyRun > 6) {
        fine = false;
      }
      t += dt;
    }
  }

  vec3 radiance = vec3(0.0);
  float depthKm = -1.0;
  vec3 camKm = vec3(0.0, rCamKm, 0.0);
  if (wsum > 1e-5) {
    float depth = dsum / wsum;
    vec3 apT;
    vec3 apL = integrateScattering(uTransmittance, uMultiScatter, camKm, dir, uSunDir, uSunIlluminance,
                                   depth * 1e-3, 8, apT);
    radiance = L * apT + apL * (1.0 - T);
    depthKm = depth * 1e-3;
  }
  float visibility = T;
  if (tSea > 0.0) {
    if (T > 0.003) {
      vec3 seaL = shadeSea(dir, tSea, rCamKm, skyAvg, jitter);
      vec3 apT;
      vec3 apL = integrateScattering(uTransmittance, uMultiScatter, camKm, dir, uSunDir, uSunIlluminance,
                                     tSea * 1e-3, 12, apT);
      radiance += T * (seaL * apT + apL);
    }
    visibility = 0.0;
    if (depthKm < 0.0) depthKm = tSea * 1e-3;
  }
  outScene = vec4(radiance, visibility);
  outDepth = vec4(depthKm, 0.0, 0.0, 1.0);
}
