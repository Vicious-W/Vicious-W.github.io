// Shared constants and helpers.
// Atmosphere math uses kilometres; clouds and the sea use metres.

#define PI 3.14159265358979

const float RG = 6360.0;          // planet radius, km
const float RT = 6460.0;          // top of atmosphere, km
const float RG_M = 6360000.0;     // planet radius, m

const vec3  RAYLEIGH_SCATTERING = vec3(5.802e-3, 13.558e-3, 33.1e-3); // 1/km
const float RAYLEIGH_HEIGHT = 8.0;
const float MIE_SCALE = 2.2;                       // a little marine haze
const float MIE_SCATTERING = 3.996e-3 * MIE_SCALE;
const float MIE_EXTINCTION = 4.440e-3 * MIE_SCALE;
const float MIE_HEIGHT = 1.2;
const float MIE_G = 0.8;
const vec3  OZONE_ABSORPTION = vec3(0.650e-3, 1.881e-3, 0.085e-3);
const float SUN_ANGULAR_RADIUS = 0.004675;
const float GROUND_ALBEDO = 0.12;

const vec2 TRANSMITTANCE_SIZE = vec2(256.0, 64.0);
const vec2 MULTISCATTER_SIZE = vec2(32.0, 32.0);
const vec2 SKYVIEW_SIZE = vec2(192.0, 108.0);

float safeSqrt(float x) { return sqrt(max(x, 0.0)); }
float clamp01(float x) { return clamp(x, 0.0, 1.0); }

// Texel-centre mapping: texel i of n stores the unit value i / (n - 1).
float unitToTexel(float u, float n) { return (u * (n - 1.0) + 0.5) / n; }
float texelToUnit(float v, float n) { return (v * n - 0.5) / (n - 1.0); }

// ---------------------------------------------------------------- medium

struct Medium {
  vec3 scatRay;
  float scatMie;
  vec3 extinction;
};

Medium sampleMedium(float hKm) {
  float h = max(hKm, 0.0);
  float dR = exp(-h / RAYLEIGH_HEIGHT);
  float dM = exp(-h / MIE_HEIGHT);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  Medium m;
  m.scatRay = RAYLEIGH_SCATTERING * dR;
  m.scatMie = MIE_SCATTERING * dM;
  m.extinction = m.scatRay + vec3(MIE_EXTINCTION * dM) + OZONE_ABSORPTION * dO;
  return m;
}

// ---------------------------------------------------------------- phases
// cosTheta is the cosine between the view ray and the direction towards the sun.

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }

float cornetteShanksPhase(float g, float c) {
  float k = 3.0 / (8.0 * PI) * (1.0 - g * g) / (2.0 + g * g);
  return k * (1.0 + c * c) / pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5);
}

float hgPhase(float g, float c) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// ---------------------------------------------------------------- spheres (km)

float distanceToTop(float r, float mu) {
  float disc = r * r * (mu * mu - 1.0) + RT * RT;
  return max(0.0, -r * mu + safeSqrt(disc));
}

float distanceToBottom(float r, float mu) {
  float disc = r * r * (mu * mu - 1.0) + RG * RG;
  return max(0.0, -r * mu - safeSqrt(disc));
}

bool rayIntersectsGround(float r, float mu) {
  return mu < 0.0 && r * r * (mu * mu - 1.0) + RG * RG >= 0.0;
}

// ---------------------------------------------------------------- transmittance LUT

vec2 transmittanceUnitUv(float r, float mu) {
  float H = sqrt(RT * RT - RG * RG);
  float rho = safeSqrt(r * r - RG * RG);
  float d = distanceToTop(r, mu);
  float dMin = RT - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(dMax - dMin, 1e-6), rho / H);
}

vec3 transmittanceToTop(sampler2D lut, float r, float mu) {
  vec2 uv = transmittanceUnitUv(r, mu);
  uv = vec2(unitToTexel(clamp01(uv.x), TRANSMITTANCE_SIZE.x), unitToTexel(clamp01(uv.y), TRANSMITTANCE_SIZE.y));
  return textureLod(lut, uv, 0.0).rgb;
}

vec3 transmittanceToSun(sampler2D lut, float r, float muS) {
  float sinH = RG / r;
  float cosH = -safeSqrt(1.0 - sinH * sinH);
  float visible = smoothstep(-sinH * SUN_ANGULAR_RADIUS, sinH * SUN_ANGULAR_RADIUS, muS - cosH);
  return transmittanceToTop(lut, r, muS) * visible;
}

vec3 getMultiScatter(sampler2D lut, float r, float muS) {
  vec2 uv = vec2(clamp01(muS * 0.5 + 0.5), clamp01((r - RG) / (RT - RG)));
  uv = vec2(unitToTexel(uv.x, MULTISCATTER_SIZE.x), unitToTexel(uv.y, MULTISCATTER_SIZE.y));
  return textureLod(lut, uv, 0.0).rgb;
}

// ---------------------------------------------------------------- sky-view LUT
// Hillaire 2020 parameterisation: denser texels near the horizon, azimuth relative to the sun.

vec2 skyViewUv(float r, float viewZenithCos, float lightViewCos, bool intersectGround) {
  float vHorizon = safeSqrt(r * r - RG * RG);
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = PI - beta;
  float zenith = acos(clamp(viewZenithCos, -1.0, 1.0));
  float v;
  if (!intersectGround) {
    float coord = 1.0 - safeSqrt(1.0 - clamp01(zenith / zenithHorizonAngle));
    v = coord * 0.5;
  } else {
    float coord = safeSqrt(clamp01((zenith - zenithHorizonAngle) / beta));
    v = coord * 0.5 + 0.5;
  }
  float u = safeSqrt(-lightViewCos * 0.5 + 0.5);
  return vec2(unitToTexel(u, SKYVIEW_SIZE.x), unitToTexel(v, SKYVIEW_SIZE.y));
}

vec3 skyLookup(sampler2D lut, vec3 dir, vec3 sunDir, float r) {
  vec2 dh = dir.xz;
  vec2 sh = sunDir.xz;
  float ld = length(dh);
  float ls = length(sh);
  float lightViewCos = (ld > 1e-5 && ls > 1e-5) ? dot(dh, sh) / (ld * ls) : 1.0;
  bool ground = rayIntersectsGround(r, dir.y);
  return textureLod(lut, skyViewUv(r, dir.y, lightViewCos, ground), 0.0).rgb;
}

// ---------------------------------------------------------------- in-scattering along a ray (km)

vec3 integrateScattering(sampler2D transLut, sampler2D msLut, vec3 pos, vec3 dir, vec3 sunDir,
                         vec3 sunIlluminance, float tMax, int steps, out vec3 transmittance) {
  float cosTheta = dot(dir, sunDir);
  float phR = rayleighPhase(cosTheta);
  float phM = cornetteShanksPhase(MIE_G, cosTheta);
  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  float dt = tMax / float(steps);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float t = (float(i) + 0.3) * dt;
    vec3 P = pos + dir * t;
    float r = length(P);
    Medium m = sampleMedium(r - RG);
    float muS = dot(P / r, sunDir);
    vec3 tSun = transmittanceToSun(transLut, r, muS);
    vec3 ms = getMultiScatter(msLut, r, muS);
    vec3 S = sunIlluminance * (tSun * (m.scatRay * phR + m.scatMie * phM) + ms * (m.scatRay + m.scatMie));
    vec3 stepT = exp(-m.extinction * dt);
    L += T * (S - S * stepT) / max(m.extinction, vec3(1e-7));
    T *= stepT;
  }
  transmittance = T;
  return L;
}

// ---------------------------------------------------------------- camera rays

vec3 cameraRay(vec2 uv, vec3 right, vec3 up, vec3 forward, vec2 tanHalf) {
  vec2 ndc = uv * 2.0 - 1.0;
  return normalize(forward + ndc.x * tanHalf.x * right + ndc.y * tanHalf.y * up);
}

float interleavedGradientNoise(vec2 pixel, float frame) {
  pixel += 5.588238 * mod(frame, 64.0);
  return fract(52.9829189 * fract(0.06711056 * pixel.x + 0.00583715 * pixel.y));
}
