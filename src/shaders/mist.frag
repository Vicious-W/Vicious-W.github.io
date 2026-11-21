// The mist around the aircraft: the storm's cloud within uNear metres of the eye, at full
// detail and without the temporal filter of the cloud pass (mist streaming past at 68 m/s
// cannot be reprojected from the last frame), lit by lightning, the moon, the storm's own glow
// and the aircraft's lamps. The cloud pass (clouds.frag) starts where this one ends; the glass
// pass lays this over it.
// Output 0: rgb = light gathered along the way (exposed), a = how much of what lies beyond shows.
// Output 1: r = the mist's representative depth (m), for the temporal resolve (misttemporal.frag).

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
uniform float uNear;          // how far the mist pass reaches (m)
uniform vec3 uSunDir;         // the moon
uniform vec3 uSunIlluminance;
uniform float uMoonSeen;      // the moon past the far parts of the storm, at the aircraft (0..1)
uniform vec2 uOpen;           // how open the air above the aircraft is (see skyOpen)
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
uniform vec3 uLampPos[8];     // lamps, relative to the eye in world axes (m): the aircraft's
uniform vec3 uLamp[8];        // four, then another's (moments.js); and their intensities
uniform vec3 uTurbA;          // where the two layers of turbulence are (m, wrapped)
uniform vec3 uTurbB;
uniform vec3 uShutter;        // how far the aircraft flies while the eye takes a frame in (world, m)
uniform float uAirMist;       // rain and mist in the storm's air around the aircraft (0..1)
layout(location = 0) out vec4 outMist;
layout(location = 1) out vec4 outDepth;

const float ALBEDO = 0.985;
const float NIGHT_SKYLIGHT = 2.6;
const float START = 0.9;      // the glass
const int STEPS = 48;
const float AIR_MIST = 0.018; // the densest veils of the air's own mist (in the storm's density units)

float altitudeAt(vec3 p) {
  return p.y + dot(p.xz, p.xz) * (0.5 / RG_M);
}

// @storm (storm.glsl goes here)

float blueNoise(vec2 fragCoord, float frame) {
  float v = texelFetch(uBlueNoise, ivec2(mod(floor(fragCoord), 64.0)), 0).r;
  return fract(v + 0.61803398875 * mod(frame, 1024.0));
}

// Turbulence of the air close by, which the mist swirls in: a displacement (m) of where the
// mist noise is read, from two layers of eddies (about 40 and 13 m) sweeping past each other, so
// the mist curls, stretches and changes shape within seconds. It fades out by the reach of this
// pass: further on the cloud pass draws the mist, still (from there its swirling would hardly show).
vec3 turbulence(vec3 p, float t) {
  float k = 1.0 - smoothstep(110.0, 220.0, t);
  vec3 d = vec3(0.0);
  if (k > 0.0) {
    vec3 a = (p + uTurbA) / MIST_PERIOD;
    vec3 b = (p + uTurbB) * (3.0 / MIST_PERIOD);
    vec3 va = vec3(textureLod(uMistNoise, a, 1.0).r, textureLod(uMistNoise, a + vec3(0.31, 0.57, 0.13), 1.0).r, textureLod(uMistNoise, a + vec3(0.71, 0.19, 0.43), 1.0).r);
    vec3 vb = vec3(textureLod(uMistNoise, b, 1.0).r, textureLod(uMistNoise, b + vec3(0.47, 0.83, 0.29), 1.0).r, textureLod(uMistNoise, b + vec3(0.11, 0.37, 0.69), 1.0).r);
    d = k * (22.0 * (va - 0.5) + 9.0 * (vb - 0.5));
  }
  return d;
}

// Set by mistDensity for the light taps next to the sample: the flow and mip level it used.
vec2 gFlow = vec2(0.5);
float gLodM = 0.0;
float gThin = 1.0;
vec3 gTurb = vec3(0.0);

// The storm's cloud at p with all its detail, 0..1; fp: the pixel's footprint there (m).
// shape: metres inside the outer edge of its shape (very negative far from it).
float mistDensity(vec3 p, float fp, vec3 turb, out float shape) {
  float alt = altitudeAt(p);
  float z = alt - CLOUD_BOTTOM;
  vec3 suv = stormUv(p, alt);
  shape = -STORM_RANGE;
  if (z < 0.0 || !inStormBox(suv)) return 0.0;
  float sd = stormSD(suv, 0.0);
  float reach = scudReach(p);
  // Far from everything: how far, for the march to stop.
  shape = max(sd, -700.0 - max(reach, 0.0));
  if (sd < -700.0 && reach > 0.0) return 0.0;
  float lodB = max(log2(fp / (BASE_PERIOD / 128.0)), 0.0);
  vec4 n = baseNoiseAt(p, lodB);
  float edgeK;
  float thin;
  shape = withScud(p, n, sd + stormBillows(n, alt), edgeK, thin);
  if (shape < -260.0) return 0.0;
  shape += stormEdge(p, z, max(log2(fp / (DETAIL_PERIOD / 32.0)), 0.0) + 1.2, true) * edgeK;
  if (shape <= 0.0) return 0.0;
  gFlow = n.ba;
  gLodM = max(log2(fp / 2.0), 0.0);
  gTurb = turb;
  float e = mistNoise(p + gTurb, n.ba, gLodM, true);
  gThin = thin;
  return stormMist(shape, e) * smoothstep(0.0, 30.0, z) * thin;
}

// Rain and mist in the air between the towers: faint veils, tens of metres across, that stream
// past and swirl in the turbulence. Only close by (further on the storm's haze is even, and the
// veils would not show), and seen only where lightning, the moon or the lamps catch them.
float airMist(vec3 p, float t, vec3 turb) {
  float veil = 0.0;
  if (uAirMist > 0.0) {
    vec3 q = (p + uMistOffset + turb) * (0.5 / MIST_PERIOD) + vec3(0.37, 0.11, 0.73);
    float n = textureLod(uMistNoise, q, 0.0).r;
    veil = uAirMist * (1.0 - smoothstep(140.0, 230.0, t)) * smoothstep(0.45, 0.95, n) * AIR_MIST;
  }
  return veil;
}

// Optical depth of the mist over the next dozen metres from p towards l: the mist at one point
// along the way, with the shape of the sample itself (it changes little over a few metres). It
// is what makes a wisp bright on the side its light comes from.
float localDepth(vec3 p, vec3 l, float shape) {
  float d = stormMist(shape, mistNoise(p + gTurb + l * 6.0, gFlow, gLodM, true)) * gThin;
  return d * uDensityScale * 6.0;
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  vec3 dir = cameraRay(pixel / uResolution, uCamRight, uCamUp, uCamForward, uTanHalf);
  vec3 origin = vec3(0.0, uCamAlt, 0.0);
  float pixelAngle = 2.0 * uTanHalf.y / uResolution.y;
  float jitter = blueNoise(pixel, uFrame);
  float rCamKm = RG + uCamAlt * 1e-3;

  // Light that changes little over these few hundred metres: once per pixel.
  vec3 moon = uSunIlluminance * transmittanceToSun(uTransmittance, rCamKm, uSunDir.y) * uMoonSeen;
  vec3 skyZen = skyLookup(uSkyView, vec3(0.0, 1.0, 0.0), uSunDir, rCamKm);
  vec3 skyHor = skyLookup(uSkyView, normalize(vec3(-uSunDir.x, 0.1, -uSunDir.z) + vec3(1e-4)), uSunDir, rCamKm);
  vec3 ambTop = (skyZen * 0.55 + skyHor * 0.45) * 0.55;
  vec3 amb = ambTop * NIGHT_SKYLIGHT * mix(0.16, 1.0, uOpen.y)
           + vec3(0.0020, 0.0025, 0.0038) * (uStormGlow * (0.25 + 0.75 * uOpen.x));
  float cosM = dot(dir, uSunDir);
  float ph0 = cloudPhase(cosM, 1.0);
  float ph1 = cloudPhase(cosM, 0.6);
  float ph2 = cloudPhase(cosM, 0.36);
  float ph3 = cloudPhase(cosM, 0.2);
  // Lightning reaches this mist through whatever lies between. Over these few hundred metres
  // that hardly changes, so it is worked out at the aircraft, alike for every pixel (per pixel,
  // the coarse taps of the storm's shape drew straight-edged facets into the mist).
  float flashLit = 0.0;
  float flickLit = 0.0;
  if (uFlashPower > 0.0) {
    vec3 src = flashCentre();
    flashLit = lightningPhase(dot(dir, normalize(src - origin)), lightningPath(origin, src, uFlashDepth, 380.0, 3, 0.5, 0.5));
  }
  if (uFlickPower > 0.0) {
    flickLit = lightningPhase(dot(dir, normalize(uFlickPos - origin)), lightningPath(origin, uFlickPos, uFlickDepth, 650.0, 2, 0.5, 0.5));
  }

  scudSpan(origin, dir);
  vec3 turb = vec3(0.0);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float odSum = 0.0;
  float dsum = 0.0;
  float wsum = 0.0;
  float span = uNear - START;
  for (int i = 0; i < STEPS; i++) {
    // Steps grow with distance: fine where the mist is large on screen.
    float u0 = float(i) / float(STEPS);
    float u1 = float(i + 1) / float(STEPS);
    float t0 = START + span * u0 * u0;
    float t1 = START + span * u1 * u1;
    float dt = t1 - t0;
    float t = t0 + dt * jitter;
    // Seen over the shutter: each sample at its own moment of the last sixtieth of a second.
    vec3 p = origin + dir * t - uShutter * fract(jitter * 7.0 + float(i) * 0.618);
    float shape;
    gT = t;
    // The turbulence changes over metres, not from one step to the next: worked out every
    // fourth step (it is six look-ups).
    if ((i & 3) == 0) turb = turbulence(p, t);
    float d = mistDensity(p, max(t * pixelAngle, 0.02), turb, shape);
    float da = 0.0;
    if (uAirMist > 0.0) da = airMist(p, t, turb);
    if (d + da > 0.0) {
      float sigma = (d + da) * uDensityScale;
      // The moon, past the storm between (its average shape, two taps).
      float od = 0.0;
      if (d > 0.0 && dot(moon, vec3(1.0)) > 0.0) {
        od = (clamp((stormShape(p + uSunDir * 40.0, 1.0) - LIGHT_START) / LIGHT_RAMP, 0.0, 1.0) * 80.0
            + clamp((stormShape(p + uSunDir * 200.0, 2.0) - LIGHT_START) / LIGHT_RAMP, 0.0, 1.0) * 240.0) * uDensityScale;
      }
      float sun = ph0 * exp(-od) + 1.2 * (0.85 * ph1 * exp(-od * 0.25) + 0.65 * ph2 * exp(-od * 0.0625) + 0.40 * ph3 * exp(-od * 0.021));
      // The air's own mist is thin: in the dark between flashes it barely shows (lit by the sky
      // alike, it laid a grey veil over the whole picture); lightning and the lamps bring it out.
      vec3 S = amb * ((d + 0.15 * da) / (d + da));
      if (dot(moon, vec3(1.0)) > 0.0) S += moon * sun * (d > 0.0 ? exp(-localDepth(p, uSunDir, shape)) : 1.0);
      // Lightning.
      if (uFlashPower > 0.0) {
        vec3 lf = normalize(flashCentre() - p);
        S += uFlashColor * (uFlashPower * flashFalloff(p) * flashLit * (d > 0.0 ? mix(1.0, exp(-localDepth(p, lf, shape)), 0.8) : 1.0));
      }
      if (uFlickPower > 0.0) S += uFlickColor * (uFlickPower * sourceFalloff(length(uFlickPos - p), 0.5) * flickLit);
      // The aircraft's lamps, dimmed by the mist between (its average along this ray so far).
      float sigmaBar = 0.5 * (sigma + odSum / max(t, 1.0));
      for (int k = 0; k < 8; k++) {
        if (uLamp[k].r + uLamp[k].g + uLamp[k].b <= 0.0) continue;
        vec3 lp = uLampPos[k] - (p - origin);
        float d2 = dot(lp, lp);
        float dl = sqrt(d2);
        float c = dot(lp, dir) / max(dl, 1e-3); // towards the lamp vs along the view ray
        // Single scattering, and the light that many scatterings spread all around the lamp.
        float ph = mix(cloudPhase(c, 1.0), 1.0 / (4.0 * PI), 0.35);
        S += uLamp[k] * (0.5 * ph * exp(-sigmaBar * dl) / (d2 + 0.04) + 0.005 * exp(-0.3 * sigmaBar * dl) / (d2 * 0.25 + 1.0));
      }
      float tr = exp(-sigma * dt);
      float absorbed = T * (1.0 - tr);
      L += absorbed * S * ALBEDO;
      dsum += t * absorbed;
      wsum += absorbed;
      T *= tr;
      odSum += sigma * dt;
      if (T < 0.004) break;
    } else if (uAirMist <= 0.0 && shape < -700.0 - (span - t)) {
      // Nothing within reach of the rest of the march.
      break;
    }
  }
  outMist = vec4(L * uExposure, T);
  outDepth = vec4(wsum > 1e-4 ? dsum / wsum : uNear, 0.0, 0.0, 1.0);
}
