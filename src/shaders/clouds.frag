// Volumetric cumulus over the sea, one ray per pixel at reduced resolution. Each frame renders
// half the pixels in a checkerboard that alternates every frame (the target is half as wide;
// temporal.frag rebuilds the full image), which halves the cost.
// Output 0: rgb = radiance of clouds and sea (aerial perspective included), a = sky visibility.
// Output 1: r = representative depth in km, or -1 when the ray only sees sky; g = cloud opacity.
// Periods, cloud layer bounds and the giant grid come from defines (see sky.js).

uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform sampler2D uSkyView;
uniform sampler3D uBaseNoise;
uniform sampler3D uDetailNoise;
uniform sampler2D uWeather;
uniform sampler2D uBlueNoise;

uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform float uCamAlt;
uniform vec3 uSunDir;
uniform vec3 uSunIlluminance;
uniform float uFrame;
uniform vec2 uResolution; // full cloud resolution (the target is half as wide)
uniform int uParity;      // which half of the checkerboard this frame renders
uniform vec3 uBaseOffset;
uniform vec3 uDetailOffset;
uniform vec2 uWeatherOffsetA;
uniform vec2 uWeatherOffsetB;
uniform vec2 uWeatherOffsetC;
uniform sampler2D uCloudMap;
uniform vec2 uCloudMapOffset;
uniform sampler3D uGiantShape;
uniform sampler2D uGiants; // GIANT_GRID^2 records, two texels each (see cumulus.js)
uniform float uDensityScale;
uniform int uMaxSteps;
uniform float uStepScale;

layout(location = 0) out vec4 outScene;
layout(location = 1) out vec4 outDepth;

const float MAX_DIST = 64000.0;
const float ALBEDO = 0.985;
const mat2 WEATHER_ROT = mat2(0.8, 0.6, -0.6, 0.8);
const mat2 WEATHER_ROT2 = mat2(0.28, 0.96, -0.96, 0.28);
const mat2 CLOUDMAP_ROT = mat2(0.96, 0.28, -0.28, 0.96);
const float ALTO_BOTTOM = 6000.0;
const float ALTO_TOP = 6700.0;

// Blue noise in [0, 1), animated by a golden-ratio shift: each pixel walks a low-discrepancy
// sequence over time, so temporal accumulation converges quickly and leftovers are fine grain.
float blueNoise(vec2 fragCoord, float frame) {
  float v = texelFetch(uBlueNoise, ivec2(mod(floor(fragCoord), 64.0)), 0).r;
  return fract(v + 0.61803398875 * mod(frame, 1024.0));
}

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
  float sheet;   // 0..1: flat stratocumulus sheets in this region
  float alto;    // 0..1: patches of the thin altocumulus layer
  vec2 warp;     // smooth large-scale warp of the cloud placement (m)
};

Weather weatherAt(vec2 xz, float lodLocal, float lodRegional) {
  vec2 ua = (xz + uWeatherOffsetA) / WEATHER_PERIOD_A;
  vec2 uc = (WEATHER_ROT2 * xz + uWeatherOffsetC) / WEATHER_PERIOD_C;
  vec4 wa = textureLod(uWeather, ua, max(lodRegional, 0.0));
  vec4 wc = textureLod(uWeather, uc, max(lodRegional + 1.3, 0.0));
  Weather w;
  w.sheet = smoothstep(0.66, 0.86, wa.a);
  w.alto = smoothstep(0.8, 0.94, wc.b);
  w.warp = (wc.rg - 0.5) * 1600.0;
  return w;
}

// detail: -1 = coarse probe (inflated), 0 = shape only, 1 = edge detail, 2 = detail plus a
// finer octave (close range). soft: the least depth (m) over which the surface turns opaque.
// Far away it is about half a march step, so a step landing in the edge gets part of the
// density instead of all or nothing, which would flicker.
float densityAt(vec3 p, Weather w, float lodB, float lodD, int detail, float soft, out float h) {
  float alt = altitudeAt(p);
  float z = alt - CLOUD_BOTTOM;
  h = 1.0;
  if (z < 0.0) return 0.0;

  // Heaped clouds are looked up in cloud-map space: rotated, drifting with the wind, warped so
  // footprints are irregular and change with height, and leaning downwind with height (wind
  // shear). The fine part of the warp comes from the 3D noise further down.
  vec2 mp = CLOUDMAP_ROT * (p.xz + w.warp - vec2(0.12, -0.05) * z) + uCloudMapOffset;

  // Cheap tests first: most samples are in clear air and the 3D noise is the expensive part.
  // A coarse map level (320 m texels) is non-zero wherever a cloud is within reach of the
  // fine warp. Giants: at most one per grid cell, tested against its shape box.
  bool mapNear = z < 4000.0 && textureLod(uCloudMap, mp / CLOUDMAP_PERIOD, max(lodB, 3.0)).r > 0.05;
  vec2 gp = mod(mp, CLOUDMAP_PERIOD);
  ivec2 gc = min(ivec2(gp / GIANT_CELL), ivec2(GIANT_GRID - 1));
  vec4 ga = texelFetch(uGiants, ivec2(gc.x * 2, gc.y), 0);
  vec4 gb = texelFetch(uGiants, ivec2(gc.x * 2 + 1, gc.y), 0);
  float gr = max(ga.z, 1.0);
  vec2 rel = (gp - ga.xy) / gr;
  float qy = z / max(ga.w, 1.0);
  bool giantNear = ga.z > 0.0 && max(abs(rel.x), abs(rel.y)) < GIANT_EXTENT * 1.42 && qy < 1.0;
  bool sheetNear = w.sheet > 0.02 && z < 700.0;
  bool altoNear = w.alto > 0.02 && alt > ALTO_BOTTOM && alt < ALTO_TOP;
  if (!(mapNear || giantNear || sheetNear || altoNear)) {
    h = -1.0; // nothing within reach: the caller may take a longer step
    return 0.0;
  }

  // Slightly squashed vertically so features do not stretch into spikes. The altocumulus
  // layer alone does not need this sample.
  vec3 bp = (p + uBaseOffset) * vec3(1.0, BASE_Y_SCALE, 1.0) / BASE_PERIOD;
  vec4 n = (mapNear || giantNear || sheetNear) ? textureLod(uBaseNoise, bp, lodB) : vec4(0.5);
  vec2 fineWarp = CLOUDMAP_ROT * ((n.ba - 0.5) * 700.0);
  float d = 0.0;
  float shape = -1e4; // metres inside the surface, negative outside
  float edge = 55.0;  // amplitude of the fine edge detail (m)
  float thick = 1.0;

  // Small to large cumulus from the placement map: flat-based domes roughened by noise whose
  // amplitude follows the size of the cloud.
  if (mapNear) {
    vec4 cm = textureLod(uCloudMap, (mp + fineWarp) / CLOUDMAP_PERIOD, lodB);
    if (cm.r > 1.0 && z < cm.r + 1400.0) {
      float size = max(cm.b, 80.0);
      // Inside a dome, the height below its surface becomes roughly the distance along the
      // surface normal (the slope is in alpha), so the noise carves the sides as well as the
      // top instead of leaving smooth vertical walls. Above the surface the plain height is
      // kept: there the slope says nothing about how far the cloud is.
      float below = cm.r - z;
      shape = (below > 0.0 ? below * inversesqrt(1.0 + cm.a * cm.a) : below)
            + min(0.46 * size, 2300.0) * (n.r - 0.5)
            + (0.26 * size + 40.0) * (n.g - 0.5);
      edge = 55.0 + 0.03 * size;
      thick = cm.g;
      h = clamp(z / max(cm.r, 1.0), 0.0, 1.0);
    }
  }

  // Rare giants: towering cumulus from the baked 3D shapes. Their sides bulge and overhang,
  // which no height field can do. Each giant sits inside its cell with room for the warp.
  if (giantNear) {
    vec2 r2 = rel + fineWarp / gr;
    vec2 q = vec2(gb.x * r2.x + gb.y * r2.y, gb.x * r2.y - gb.y * r2.x);
    if (max(abs(q.x), abs(q.y)) < GIANT_EXTENT) {
      // One voxel is 1/40 of the footprint radius.
      float lodG = max(lodB + log2(BASE_PERIOD / 128.0 * 40.0 / gr), 0.0);
      vec3 uvw = vec3(q.x * (0.5 / GIANT_EXTENT) + 0.5, qy, q.y * (0.5 / GIANT_EXTENT) + 0.5);
      vec4 s4 = textureLod(uGiantShape, uvw, lodG);
      float sd = (dot(s4, vec4(equal(vec4(gb.z), vec4(0.0, 1.0, 2.0, 3.0)))) * 2.0 - 1.0) * GIANT_RANGE;
      float gshape = gr * (sd + 0.13 * (n.r - 0.5) + 0.09 * (n.g - 0.5));
      if (gshape > shape) {
        shape = gshape;
        edge = 0.022 * gr;
        thick = gb.w;
        h = clamp(qy * 1.3, 0.0, 1.0);
      }
    }
  }

  if (shape > -1e3) {
    if (detail < 0) shape += edge * 2.6 + soft;
    if (detail > 0 && shape > -2.2 * edge) {
      vec3 dq = (p + uDetailOffset) / DETAIL_PERIOD;
      vec3 dn = textureLod(uDetailNoise, dq, lodD).rgb;
      float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
      if (detail > 1) {
        // Integer frequency multiple keeps the wrapped detail offset continuous.
        vec3 dn2 = textureLod(uDetailNoise, dq * 3.0, lodD + 1.585).rgb;
        dfbm = dfbm * 0.72 + (dn2.r * 0.625 + dn2.g * 0.25 + dn2.b * 0.125) * 0.28;
      }
      // Billowy towards the top, ragged near the base; thin clouds are frayed more.
      float ragged = mix(1.7, 1.0, smoothstep(0.0, 140.0, z)) * mix(1.5, 1.0, thick);
      shape += edge * ragged * (dfbm - 0.5) * 2.0;
    }
    float ramp = max(35.0 + 0.4 * (edge - 55.0), soft);
    d = clamp(shape / ramp, 0.0, 1.0) * smoothstep(0.0, 30.0, z) * thick;
  }

  // Flat stratocumulus sheets in some regions: cells from the base noise within a low slab.
  if (sheetNear) {
    float hs = z / 700.0;
    float prof = smoothstep(0.0, 0.2, hs) * (1.0 - smoothstep(0.45, 1.0, hs));
    float cov = 0.3 + w.sheet * 0.42;
    float ds = clamp(remap(n.r * prof, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
    ds = clamp(remap(ds, (1.0 - n.g) * 0.3, 1.0, 0.0, 1.0), 0.0, 1.0);
    d = max(d, ds * 0.55);
  }

  // Thin altocumulus in patches: inside a patch, a layer of many small translucent cloudlets
  // with gaps between them, thinning out towards the patch edge.
  if (altoNear) {
    float ha = (alt - ALTO_BOTTOM) / (ALTO_TOP - ALTO_BOTTOM);
    float prof = smoothstep(0.0, 0.3, ha) * (1.0 - smoothstep(0.45, 0.9, ha));
    vec2 na = textureLod(uBaseNoise, bp * 4.0, lodB + 2.0).rg;
    float cover = 0.62 * w.alto;
    float da = clamp(remap(na.r * prof, 1.0 - cover, 1.0, 0.0, 1.0), 0.0, 1.0);
    da = clamp(remap(da, (1.0 - na.g) * 0.2, 1.0, 0.0, 1.0), 0.0, 1.0);
    d = max(d, da * 0.02);
  }
  return d;
}

// Optical depth towards the sun with exponentially growing steps. For distant clouds, five
// longer steps cover about the same distance (4.8 km) as seven. The density is sampled one
// level smoother than the view ray sees it: light diffuses inside a cloud, so small bulges
// do not cast sharp shadows of their own (which made clouds look like piles of balls).
float lightDepth(vec3 p, Weather w, float lodB, float lodD, bool far, float jitter) {
  float od = 0.0;
  float prev = 0.0;
  int steps = far ? 5 : 7;
  float growth = far ? 2.9 : 2.1;
  float lodStep = far ? 0.75 : 0.5;
  float d = (far ? 45.0 : 30.0) * (0.7 + 0.6 * jitter);
  float h;
  for (int j = 0; j < 7; j++) {
    if (j >= steps) break;
    float seg = d - prev;
    vec3 q = p + uSunDir * (prev + 0.5 * seg);
    od += densityAt(q, w, lodB + 1.0 + float(j) * lodStep, lodD + 1.0 + float(j) * lodStep, 0, 0.0, h) * seg;
    prev = d;
    d *= growth;
  }
  return od * uDensityScale;
}

float cloudPhase(float c, float k) {
  return mix(hgPhase(0.85 * k, c), hgPhase(-0.25 * k, c), 0.22);
}

float stepAt(float t) {
  return clamp(t * 0.016, 28.0, 650.0) * uStepScale;
}

// Fraction of sunlight reaching a point on the sea through the clouds. Eight samples along
// the sun ray, denser low down where most clouds are (quadratic spacing). Shadows on the sea
// are soft, so the clouds are smoothed here (edges about half a sample deep): sharp ones are
// hit by a sample in some frames and missed in others, which speckles the glitter.
float seaShadow(vec3 p, float jitter) {
  float sy = max(uSunDir.y, 0.08);
  float s0 = CLOUD_BOTTOM / sy;
  float span = (CLOUD_TOP_MAX - CLOUD_BOTTOM) / sy;
  const int N = 8;
  float od = 0.0;
  float h;
  for (int i = 0; i < N; i++) {
    float u = (float(i) + jitter) / float(N);
    float ds = span * 2.0 * u / float(N);
    vec3 q = p + uSunDir * (s0 + span * u * u);
    Weather w = weatherAt(q.xz, 2.0, 1.0);
    od += densityAt(q, w, 3.0, 0.0, 0, max(0.5 * ds, 150.0), h) * ds;
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
  ivec2 fc = ivec2(gl_FragCoord.xy);
  vec2 pixel = vec2(float(fc.x * 2 + ((fc.y + uParity) & 1)), float(fc.y)) + 0.5;
  vec3 dir = cameraRay(pixel / uResolution, uCamRight, uCamUp, uCamForward, uTanHalf);
  float rCamKm = RG + uCamAlt * 1e-3;
  float pixelAngle = 2.0 * uTanHalf.y / uResolution.y;
  float cosTheta = dot(dir, uSunDir);
  float ph0 = cloudPhase(cosTheta, 1.0);
  float ph1 = cloudPhase(cosTheta, 0.6);
  float ph2 = cloudPhase(cosTheta, 0.36);
  float ph3 = cloudPhase(cosTheta, 0.2);
  float powderAmount = 0.35 * (1.0 - smoothstep(-0.2, 0.75, cosTheta));

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
  float jitter = blueNoise(pixel, uFrame);
  if (hasLayer && t1 > t0) {
    // The march is a small state machine with one density evaluation per iteration (the
    // density function is large, and every call site is a copy of it in the compiled shader):
    // SEARCH strides through clear air with an inflated shape; MARCH steps through cloud;
    // REFINE bisects for the surface when MARCH enters a cloud with a long step, so the cloud
    // is shaded at its surface rather than at a random depth, which shows as speckles and
    // shimmer on distant clouds.
    const int SEARCH = 0;
    const int MARCH = 1;
    const int REFINE = 2;
    int mode = SEARCH;
    float t = t0 + stepAt(t0) * jitter;
    bool inside = false;  // the previous MARCH sample had density
    bool settled = false; // t sits on a surface just found by REFINE
    int shortSteps = 0;
    int emptyRun = 0;
    int refineLeft = 0;
    float ra = 0.0;
    float rb = 0.0;
    vec3 origin = vec3(0.0, uCamAlt, 0.0);
    for (int i = 0; i < 512; i++) {
      float ts = mode == REFINE ? 0.5 * (ra + rb) : t;
      if (i >= uMaxSteps || ts >= t1 || T < 0.01) break;
      float dt = stepAt(ts);
      // Near clouds the march takes finer steps far away, and the surface is softened to half a
      // step: edges thinner than a step would otherwise be hit in some frames and missed in others.
      float dtF = min(dt, 28.0 + 0.008 * ts);
      vec3 p = origin + dir * ts;
      float fp = max(ts * pixelAngle, 1.0);
      Weather w = weatherAt(p.xz, log2(fp / (WEATHER_PERIOD_B / 512.0)), log2(fp / (WEATHER_PERIOD_A / 512.0)));
      float lodB = max(log2(fp / (BASE_PERIOD / 128.0)), 0.0);
      float lodD = max(log2(fp / (DETAIL_PERIOD / 32.0)), 0.0);
      // Edge detail at every distance, so far clouds have the same character as near ones; its
      // mip levels fade it out where it becomes smaller than a pixel. SEARCH uses the shape
      // inflated by the most that detail could add, so thin fringes are never skipped.
      int detail = mode == SEARCH ? -1 : (mode == REFINE ? 0 : (ts < 2500.0 ? 2 : 1));
      float h;
      float dens = densityAt(p, w, mode == SEARCH ? lodB + 0.5 : lodB, lodD, detail,
                             mode == SEARCH ? 0.5 * dt : 0.5 * dtF, h);

      if (mode == SEARCH) {
        if (dens > 0.0) {
          mode = MARCH;
          inside = false;
          emptyRun = 0;
          t = max(t - dt * 1.6, t0);
        } else {
          // Longer strides where no cloud is within reach at all.
          t += dt * (h < 0.0 ? 2.6 : 2.0);
        }
        continue;
      }
      if (mode == REFINE) {
        if (dens > 0.001) {
          rb = ts;
        } else {
          ra = ts;
        }
        if (--refineLeft == 0) {
          mode = MARCH;
          t = rb;
          settled = true;
          shortSteps = 6;
        }
        continue;
      }

      if (dens > 0.001) {
        if (!inside && !settled && dtF > 40.0) {
          mode = REFINE;
          ra = max(t - dtF, t0);
          rb = t;
          refineLeft = 3;
          continue;
        }
        settled = false;
        inside = true;
        emptyRun = 0;
        // Short steps through the dense outer layer, where nearly all the light we see comes
        // from; thin cloud keeps the long steps.
        float dtIn = (shortSteps > 0 || dens > 0.05) ? min(dtF, 12.0 + 0.002 * t) : dtF;
        shortSteps--;
        float sigma = dens * uDensityScale;
        float od = lightDepth(p, w, lodB, lodD, t > 9000.0, fract(jitter + 0.37));
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
        float tr = exp(-sigma * dtIn);
        float absorbed = T * (1.0 - tr);
        L += S * absorbed;
        dsum += t * absorbed;
        wsum += absorbed;
        T *= tr;
        t += dtIn;
      } else {
        settled = false;
        inside = false;
        if (++emptyRun > 6) mode = SEARCH;
        t += dtF;
      }
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
      vec3 seaL = shadeSea(dir, tSea, rCamKm, skyAvg, fract(jitter + 0.5));
      vec3 apT;
      vec3 apL = integrateScattering(uTransmittance, uMultiScatter, camKm, dir, uSunDir, uSunIlluminance,
                                     tSea * 1e-3, 12, apT);
      radiance += T * (seaL * apT + apL);
    }
    visibility = 0.0;
    if (depthKm < 0.0) depthKm = tSea * 1e-3;
  }
  outScene = vec4(radiance, visibility);
  outDepth = vec4(depthKm, 1.0 - T, 0.0, 1.0); // g: how much of the pixel is cloud
}
