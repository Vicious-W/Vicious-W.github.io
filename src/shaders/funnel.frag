// A tornado under the storm's southern base (night/moments.js): a funnel of cloud that hangs
// from the base, leaning and bowed, narrowing down towards the sea, with the wall cloud it
// comes out of and the spray it whips up where it meets the water. Its surface turns, faster low
// down. It is dark against the dark sea until lightning lights it. Drawn over the finished image
// of the outside (the cloud march does not reach below the base): rgb = its light (exposed),
// a = how much of what lies behind shows through. Clouds in front of it hide it.

uniform sampler2D uTransmittance;
uniform sampler2D uSkyView;
uniform sampler3D uBaseNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uBlueNoise;
uniform vec3 uBaseOffset;
uniform vec3 uDetailOffset;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamAlt;
uniform vec2 uResolution;
uniform float uFrame;
uniform vec3 uSunDir;         // the moon
uniform vec3 uSunIlluminance;
uniform float uDensityScale;
uniform float uExposure;
uniform float uStormGlow;
uniform vec3 uFlashPos[3];    // relative to the camera (m; y is altitude)
uniform vec3 uFlashWeight;
uniform float uFlashPower;
uniform vec3 uFlashColor;
uniform float uFlashDepth;
uniform vec3 uFlickPos;
uniform float uFlickPower;
uniform vec3 uFlickColor;
uniform float uFlickDepth;
uniform vec4 uFunnel;         // its foot at the sea, relative to the camera (x, z); w: 1 when it is there
uniform float uFunnelTop;     // the height of the base it hangs from (m)
uniform float uFunnelSpin;    // how far it has turned (radians)
uniform sampler2D uSceneDepth; // the clouds' depth (r, km; -1 open sky)
out vec4 outColor;

const float ALBEDO = 0.97;
const float SIGMA = 0.03;     // its densest cloud (1/m): a few tens of metres hide what is behind
const float REACH = 760.0;    // around the middle of its lean, where any of it can be (m)
const int STEPS = 96;

float altitudeAt(vec3 p) {
  return p.y + dot(p.xz, p.xz) * (0.5 / RG_M);
}

// @storm (storm.glsl goes here)

float blueNoise(vec2 fragCoord, float frame) {
  float v = texelFetch(uBlueNoise, ivec2(mod(floor(fragCoord), 64.0)), 0).r;
  return fract(v + 0.61803398875 * mod(frame, 1024.0));
}

// Its axis at height h, from its foot: it leans away and bows, and sways slowly.
vec2 funnelAxis(float h) {
  float u = h / uFunnelTop;
  return vec2(180.0 * u * u + 25.0 * sin(3.1 * u + 0.05 * uFunnelSpin), -90.0 * u + 18.0 * sin(4.3 * u + 1.0 + 0.04 * uFunnelSpin));
}

// Its cloud at p, 0..1: the funnel, widening into the wall cloud at the top; at the foot, the
// spray. Positions relative to the camera, y the height.
float funnelDensity(vec3 p) {
  float h = p.y;
  if (h < -5.0 || h > uFunnelTop + 60.0) return 0.0;
  float u = clamp(h / uFunnelTop, 0.0, 1.0);
  vec2 q = p.xz - uFunnel.xz - funnelAxis(h);
  float rho = length(q);
  float R = (40.0 + 380.0 * pow(u, 2.2)) * (1.0 + 1.0 * smoothstep(uFunnelTop - 520.0, uFunnelTop + 40.0, h));
  if (rho > R * 1.3 && h > 200.0) return 0.0;
  // The surface turns: its texture read in a frame that spins, faster low down; stretched along
  // the turn, so it shows as bands that wind around it.
  float a = atan(q.y, q.x) + uFunnelSpin * (1.0 + 0.8 * (1.0 - u));
  vec3 s = vec3(cos(a) * rho, h * 1.3, sin(a) * rho) / 70.0;
  float e = 0.7 * textureLod(uMistNoise, s, 1.0).r + 0.3 * textureLod(uMistNoise, s * 2.7 + 0.37, 1.0).r;
  float d = clamp((1.0 - rho / R) * 2.6 - (1.0 - e) * 1.1, 0.0, 1.0);
  // The lowest stretch is thin and ragged: the cloud does not always reach down.
  d *= mix(0.35 + 0.65 * smoothstep(0.35, 0.75, e), 1.0, smoothstep(60.0, 380.0, h));
  float spray = 0.0;
  if (h < 160.0) {
    float ks = length(p.xz - uFunnel.xz) / (110.0 + 1.2 * h);
    spray = clamp((1.0 - ks) * 1.8 - (1.0 - e) * 0.9, 0.0, 1.0) * (1.0 - h / 160.0) * 0.45;
  }
  return max(d, spray);
}

// Through the funnel itself towards l from p: it shades its own far side.
float selfDepth(vec3 p, vec3 l) {
  float od = 0.0;
  for (int k = 0; k < 4; k++) od += funnelDensity(p + l * (float(k) + 0.5) * 30.0);
  return od * SIGMA * 30.0;
}

void main() {
  outColor = vec4(0.0, 0.0, 0.0, 1.0);
  if (uFunnel.w <= 0.0) return;
  vec2 pixel = gl_FragCoord.xy;
  vec2 uv = pixel / uResolution;
  vec3 dir = cameraRay(uv, uCamRight, uCamUp, uCamForward, uTanHalf);
  vec3 origin = vec3(0.0, uCamAlt, 0.0);

  // The ray against an upright cylinder around it, between the sea and above the base.
  vec2 c = uFunnel.xz + vec2(95.0, -45.0);
  vec2 oc = origin.xz - c;
  float qa = dot(dir.xz, dir.xz);
  float qb = dot(oc, dir.xz);
  float qc = dot(oc, oc) - REACH * REACH;
  float disc = qb * qb - qa * qc;
  if (disc <= 0.0 || qa < 1e-8) return;
  float sq = sqrt(disc);
  float t0 = (-qb - sq) / qa;
  float t1 = (-qb + sq) / qa;
  float ya = (-5.0 - origin.y) / dir.y;
  float yb = (uFunnelTop + 60.0 - origin.y) / dir.y;
  t0 = max(t0, min(ya, yb));
  t1 = min(t1, max(ya, yb));
  t0 = max(t0, 0.0);
  if (t1 <= t0) return;
  // Clouds in front of it hide it.
  float depthKm = textureLod(uSceneDepth, uv, 0.0).r;
  if (depthKm > 0.0 && depthKm * 1000.0 < t0) return;

  float jitter = blueNoise(pixel, uFrame);
  float dt = (t1 - t0) / float(STEPS);
  // The light at the funnel, worked out once: lightning past whatever stands between, the
  // flicker, the storm's glow, and the moon behind the storm.
  vec3 mid = origin + dir * (0.5 * (t0 + t1));
  vec3 flashLight = vec3(0.0);
  vec3 flashDir = vec3(0.0, 1.0, 0.0);
  if (uFlashPower > 0.0) {
    vec3 src = flashCentre();
    flashDir = normalize(src - mid);
    vec2 path = lightningPath(mid, src, uFlashDepth, 380.0, 3, 1.0, jitter);
    flashLight = uFlashColor * uFlashPower * flashFalloff(mid) * lightningPhase(dot(dir, flashDir), path);
  }
  vec3 flickLight = vec3(0.0);
  vec3 flickDir = vec3(0.0, 1.0, 0.0);
  if (uFlickPower > 0.0) {
    flickDir = normalize(uFlickPos - mid);
    vec2 path = lightningPath(mid, uFlickPos, uFlickDepth, 650.0, 2, 1.0, jitter);
    flickLight = uFlickColor * uFlickPower * sourceFalloff(length(uFlickPos - mid), 0.5) * lightningPhase(dot(dir, flickDir), path);
  }
  float moonOd = 0.0;
  for (int k = 0; k < 6; k++) moonOd += stormBlock(mid + uSunDir * (float(k) + 0.5) * 1800.0, 2.0) * 1800.0;
  vec3 moon = uSunIlluminance * transmittanceToSun(uTransmittance, RG + uCamAlt * 1e-3, uSunDir.y) * exp(-moonOd * uDensityScale) * cloudPhase(dot(dir, uSunDir), 0.6);
  vec3 ambient = vec3(0.0020, 0.0025, 0.0038) * uStormGlow * 0.5;

  vec3 L = vec3(0.0);
  float T = 1.0;
  for (int i = 0; i < STEPS; i++) {
    float t = t0 + (float(i) + jitter) * dt;
    vec3 p = origin + dir * t;
    float d = funnelDensity(p);
    if (d <= 0.0) continue;
    float sigma = d * SIGMA;
    vec3 S = ambient + moon * exp(-selfDepth(p, uSunDir));
    if (uFlashPower > 0.0) S += flashLight * exp(-selfDepth(p, flashDir));
    if (uFlickPower > 0.0) S += flickLight * exp(-selfDepth(p, flickDir));
    float tr = exp(-sigma * dt);
    L += T * (1.0 - tr) * S * ALBEDO;
    T *= tr;
    if (T < 0.01) break;
  }
  outColor = vec4(L * uExposure, T);
}
