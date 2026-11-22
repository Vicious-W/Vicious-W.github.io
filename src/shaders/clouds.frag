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

#ifdef NIGHT
// The night journey's thunderstorm (its cloud is in storm.glsl, see night/storm.js) and its
// lightning.
uniform float uNearDist;    // the mist pass (mist.frag) draws the storm up to here (m); 0: off
uniform vec3 uFlashPos[3];  // sources of the flash, relative to the camera (m; y is altitude)
uniform vec3 uFlashWeight;  // share of the flash at each source
uniform float uFlashOn;     // 1 while a flash lights the scene
uniform float uFlashDepth;  // how deep in its cloud the flash is (m)
uniform vec3 uFlickPos;     // the flicker: lesser lightning somewhere else in the storm
uniform float uFlickOn;
uniform float uFlickDepth;
uniform float uFog;         // rain and haze in the air of the storm, 0..1
uniform float uStormGlow;   // the storm's own faint glow around the aircraft, 0..1
uniform float uSlabBottom;  // the lowest a cloud can be (m): the storm's base, or in the abyss its last deck
// Light of the flash (r) and of the flicker (g) per unit of their power; their flicker in time
// is applied in composite.frag, so the temporal filter never smears it.
layout(location = 2) out vec4 outFlash;

// Set by densityAt: a distance along any direction that is certainly free of cloud (m), for
// the march to skip (only the storm knows one: its baked shape is a distance field), and
// whether the density it returned belongs to the storm.
float gSafe = 0.0;
// The view ray, for skipping to the abyss's decks along it (alongToDeck): how fast its altitude
// rises per metre, and how much faster still as the planet curves away beneath it.
float gRise = 0.0;
float gCurve = 0.0;
bool gStorm = false;
// Set by densityAt: the sample belongs to a deck of the abyss (storm.glsl).
bool gDeck = false;
// Set by densityAt when the storm's density is zero: how far in the cloud is likely to begin
// (m; the mist eats away the outer part of its fringe, so that can be well inside its shape).
float gGap = 0.0;
// Set by densityAt: the sample belongs to thin scud rather than the storm itself.
bool gScud = false;

// Sky light on the storm, against the measured sky: a film's night, dark but readable.
const float NIGHT_SKYLIGHT = 2.6;
// Rain and haze between the towers: extinction (1/m), and how brightly lightning shows in it.
const float HAZE_SIGMA = 1.6e-4;
const float HAZE_GLOW = 0.06;
#endif

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

#ifdef NIGHT
// @storm (storm.glsl goes here)
#endif

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
#ifdef NIGHT
  float bottom = uSlabBottom;
#else
  float bottom = CLOUD_BOTTOM;
#endif
  int nb = quadRoots(a, d.y, y0 - bottom, rb);
  int nt = quadRoots(a, d.y, y0 - CLOUD_TOP_MAX, rt);
  // A miss leaves t0 = t1 = -1. One exit only: Direct3D's shader compiler (Chrome on Windows)
  // warns of an uninitialized result when a nested branch returns early.
  t0 = -1.0;
  t1 = -1.0;
  if (y0 >= bottom && y0 <= CLOUD_TOP_MAX) {
    t0 = 0.0;
    t1 = nt > 0 ? rt.y : MAX_DIST;
    if (nb >= 1 && rb.x > 0.0) t1 = min(t1, rb.x);
  } else if (y0 < bottom) {
    if (nb > 0 && rb.y > 0.0) {
      t0 = rb.y;
      t1 = nt > 0 ? rt.y : MAX_DIST;
    }
  } else if (nt >= 2 && rt.y > 0.0) {
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

#ifdef NIGHT
// The decks are flat: how far along the view ray, from a sample at alt t metres along it, until
// it comes within reach of one (m; 0 when it is within reach already). Its altitude goes as
// alt + rate s + gCurve s^2 / 2 from there.
float alongToDeck(float alt, float t) {
  float rate = gRise + gCurve * t;
  float best = 1e9;
  for (int i = 0; i < DECKS; i++) {
    float lo = DECK[i].x - DECK[i].y - 700.0;
    float hi = DECK[i].x + DECK[i].y + 700.0;
    if (alt >= lo && alt <= hi) {
      best = 0.0;
    } else if (lo > alt) {
      float dA = lo - alt;
      best = min(best, 2.0 * dA / (rate + sqrt(rate * rate + 2.0 * gCurve * dA)));
    } else if (rate < 0.0) {
      float dA = alt - hi;
      float disc = rate * rate - 2.0 * gCurve * dA;
      if (disc >= 0.0) best = min(best, 2.0 * dA / (-rate + sqrt(disc)));
    }
  }
  return best;
}
#endif

// detail: -1 = coarse probe (inflated), 0 = shape only, 1 = edge detail, 2 = detail plus a
// finer octave (close range). soft: the least depth (m) over which the surface turns opaque.
// Far away it is about half a march step, so a step landing in the edge gets part of the
// density instead of all or nothing, which would flicker. lodM: mip level of the storm's mist.
float densityAt(vec3 p, Weather w, float lodB, float lodD, float lodM, int detail, float soft, out float h) {
  float alt = altitudeAt(p);
  float z = alt - CLOUD_BOTTOM;
  h = 1.0;
#ifdef NIGHT
  // Under the cloud base there is only the abyss's decks (storm.glsl), when there is the abyss.
  if (z < 0.0 && (!IN_ABYSS || deckSlab(alt) < -900.0)) return 0.0;
#else
  if (z < 0.0) return 0.0;
#endif

  // Heaped clouds are looked up in cloud-map space: rotated, drifting with the wind, warped so
  // footprints are irregular and change with height, and leaning downwind with height (wind
  // shear). The fine part of the warp comes from the 3D noise further down.
  vec2 mp = CLOUDMAP_ROT * (p.xz + w.warp - vec2(0.12, -0.05) * z) + uCloudMapOffset;

#ifdef NIGHT
  gSafe = 0.0;
  gStorm = false;
  gDeck = false;
  gGap = 0.0;
  gScud = false;
  // Fair-weather clouds keep away from the storms, so around them none of their look-ups are needed.
  float calm = stormCalm(p) * (1.0 - uAlien);
  bool fair = calm > 0.0 && z >= 0.0;
#else
  const float calm = 1.0;
  const bool fair = true;
#endif
  // Cheap tests first: most samples are in clear air and the 3D noise is the expensive part.
  // A coarse map level (320 m texels) is non-zero wherever a cloud is within reach of the
  // fine warp. Giants: at most one per grid cell, tested against its shape box.
  bool mapNear = fair && z < 4000.0 && textureLod(uCloudMap, mp / CLOUDMAP_PERIOD, max(lodB, 3.0)).r > 0.05;
  vec2 gp = mod(mp, CLOUDMAP_PERIOD);
  ivec2 gc = min(ivec2(gp / GIANT_CELL), ivec2(GIANT_GRID - 1));
  vec4 ga = vec4(0.0);
  vec4 gb = vec4(0.0);
  if (fair) {
    ga = texelFetch(uGiants, ivec2(gc.x * 2, gc.y), 0);
    gb = texelFetch(uGiants, ivec2(gc.x * 2 + 1, gc.y), 0);
  }
  float gr = max(ga.z, 1.0);
  vec2 rel = (gp - ga.xy) / gr;
  float qy = z / max(ga.w, 1.0);
  bool giantNear = ga.z > 0.0 && max(abs(rel.x), abs(rel.y)) < GIANT_EXTENT * 1.42 && qy < 1.0;
  bool sheetNear = fair && w.sheet > 0.02 && z < 700.0;
  bool altoNear = fair && w.alto > 0.02 && alt > ALTO_BOTTOM && alt < ALTO_TOP;
  bool stormNear = false;
#ifdef NIGHT
  // The storm volume, tested at a coarse level first (its distances are clamped, so anything
  // above the floor means the storm is within reach).
  bool inBox = z >= 0.0 && inAStorm(p, alt);
  bool stormBox = inBox;
  float coarse = inBox ? stormField(p, alt, 2.0) : -STORM_RANGE;
  float stormSkip = inBox ? max(-coarse - 1000.0, 0.0) : 1e9;
  // The abyss's decks (their holes can only take cloud away; the billows add a little). Along
  // the view ray the next one may be much further off than straight up or down.
  float deckSkip = 1e9;
  if (IN_ABYSS) {
    coarse = max(coarse, deckSlab(alt) + 200.0);
    inBox = true;
    deckSkip = gT >= 0.0 ? alongToDeck(alt, gT) : max(-deckSlab(alt) - 700.0, 0.0);
  }
  stormNear = coarse > -STORM_RANGE + 60.0;
  // Near the storm no other cloud can be in the way, so its distance bounds a safe skip,
  // less the most that noise, detail and the soft surface could add (the coarse level is an
  // average over about a kilometre, so it keeps a wider margin). No skip past scud, though.
  float scudSafe = scudReach(p);
  stormNear = stormNear || scudSafe <= 0.0;
  if (!fair && inBox && coarse < -1000.0) gSafe = min(-coarse - 1000.0, max(scudSafe, 0.0));
  if (!fair && IN_ABYSS) gSafe = max(gSafe, min(min(stormSkip, deckSkip), max(scudSafe, 0.0)));
#endif
  if (!(mapNear || giantNear || sheetNear || altoNear || stormNear)) {
    h = -1.0; // nothing within reach: the caller may take a longer step
    return 0.0;
  }

  // Slightly squashed vertically so features do not stretch into spikes. The altocumulus
  // layer alone does not need this sample.
  vec3 bp = (p + uBaseOffset) * vec3(1.0, BASE_Y_SCALE, 1.0) / BASE_PERIOD;
  vec4 n = (mapNear || giantNear || sheetNear || stormNear) ? textureLod(uBaseNoise, bp, lodB) : vec4(0.5);
  vec2 fineWarp = CLOUDMAP_ROT * ((n.ba - 0.5) * 700.0);
  float d = 0.0;
  float shape = -1e4; // metres inside the surface, negative outside
  float edge = 55.0;  // amplitude of the fine edge detail (m)
  float thick = 1.0;
  float softEdge = 0.0; // least depth over which this cloud's surface turns opaque (m)

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
      thick = cm.g * calm;
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
        thick = gb.w * calm;
        h = clamp(qy * 1.3, 0.0, 1.0);
      }
    }
  }

#ifdef NIGHT
  // The thunderstorm: its baked shape (one voxel is 250 m) roughened by the billows, with the
  // scud and pockets on the journey's way.
  float edgeK = 1.0;
  float thin = 1.0;
  if (stormNear) {
    float sdFine = z < 0.0 ? -STORM_RANGE : stormField(p, alt, max(lodB - 3.0, 0.0));
    // (The decks bound the skip too: a slab's distance is how far above or below it p is, and
    // along the view ray it can be far more.)
    float reach = IN_ABYSS ? max(sdFine, deckSlab(alt) + 200.0) : sdFine;
    if (!fair && reach < -900.0) gSafe = min(-reach - 900.0, max(scudSafe, 0.0));
    if (!fair && IN_ABYSS) {
      float storm = stormBox ? max(-sdFine - 900.0, 0.0) : 1e9;
      gSafe = max(gSafe, min(min(storm, deckSkip), max(scudSafe, 0.0)));
    }
    float sshape = withScud(p, n, sdFine + stormBillows(n, alt), edgeK, thin);
    if (IN_ABYSS && deckSlab(alt) > -900.0) {
      float dshape = deckShape(p, alt, lodB) + 0.4 * stormBillows(n, alt);
      if (dshape > sshape) {
        sshape = dshape;
        gDeck = true;
        edgeK = 1.0;
        thin = 1.0;
      }
    }
    if (sshape > shape) {
      shape = sshape;
      edge = 90.0;
      thick = 1.0;
      h = clamp(z / 9000.0, 0.0, 1.0);
      gStorm = true;
    }
  }
#endif

  if (shape > -1e3) {
    if (detail < 0) shape += edge * 2.6 + soft;
#ifdef NIGHT
    if (gStorm) {
      // The storm: its edge detail, then the fringe of mist (storm.glsl). Where the mist is
      // smaller than a pixel only its average is left, which needs no look-up.
      // (one level smoother than the pixel: its creases drew thin veins over the faces)
      // (Far off, a deck's edge detail is lost in the dark: not worth its look-ups.)
      if (detail > 0 && shape > -2.2 * edge && !(gDeck && gT > 9000.0)) shape += stormEdge(p, gDeck ? 1000.0 : z, lodD + 1.2, detail > 1) * edgeK;
      float e = 0.5;
      // The mist's tangle belongs to the air close by (the mist pass draws it in full): from a few
      // hundred metres on a cloud's surface is its rounded bulges alone, smooth (the tangle, even
      // faded, mottled every face like a stain). Its average stays, so the cloud keeps its size.
      float tangle = 1.0 - smoothstep(200.0, 900.0, gT);
      if (detail > 0 && shape > 0.0 && shape < FRINGE && tangle > 0.0) {
        e = mix(0.5, mistNoise(p, n.ba, lodM, detail > 1 && lodM < 1.5), tangle);
      }
      // The search probe takes all the fringe; the surface search (detail 0) its average, so it
      // finds the surface where the mist has left it, not the outer edge of the shape.
      d = detail > 0 ? stormMist(shape, e) : (detail == 0 ? stormMist(shape, 0.5) : clamp(shape / max(FRINGE, soft), 0.0, 1.0));
      d *= (gDeck ? 1.0 : smoothstep(0.0, 30.0, z)) * (detail < 0 ? 1.0 : thin);
      gScud = thin < 1.0;
      if (d <= 0.0) gGap = ERODE * e * FRINGE - shape;
      // (the surface search's average: stormMist(shape, 0.5) starts at 0.425 of the fringe)
    } else
#endif
    {
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
      float ramp = max(max(35.0 + 0.4 * (edge - 55.0), soft), softEdge);
      d = clamp(shape / ramp, 0.0, 1.0) * smoothstep(0.0, 30.0, z) * thick;
    }
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
    od += densityAt(q, w, lodB + 1.0 + float(j) * lodStep, lodD + 1.0 + float(j) * lodStep, 8.0, 0, 0.0, h) * seg;
    prev = d;
    d *= growth;
  }
  return od * uDensityScale;
}

float stepAt(float t) {
  return clamp(t * 0.016, 28.0, 650.0) * uStepScale;
}

// Fraction of sunlight reaching a point on the sea through the clouds. Eight samples along
// the sun ray, denser low down where most clouds are (quadratic spacing). Shadows on the sea
// are soft, so the clouds are smoothed here (edges about half a sample deep): sharp ones are
// hit by a sample in some frames and missed in others, which speckles the glitter.
float seaShadow(vec3 p, float jitter) {
  // One exit only (see cloudInterval).
  float lit;
#ifdef NIGHT
  // Under the storm its shadow is all there is, and it is wide and soft: a few coarse taps
  // of the baked shape along the moonlight, instead of the full march.
  if (nearAStorm(p)) {
    lit = 1.0;
    for (int i = 0; i < 6; i++) {
      float alt = CLOUD_BOTTOM + 400.0 + 1900.0 * (float(i) + jitter);
      lit *= 1.0 - stormBlock(p + uSunDir * (alt / max(uSunDir.y, 0.08)), 2.0);
    }
  } else
#endif
  {
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
      od += densityAt(q, w, 3.0, 0.0, 8.0, 0, max(0.5 * ds, 150.0), h) * ds;
    }
    lit = exp(-od * uDensityScale * 0.45);
  }
  return lit;
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

#ifdef NIGHT
// ---- the creature (night/moments.js): something vast in the abyss, seen only as an outline when
// lightning lights the cloud behind it. A broad flat body, longer than wide, its rim rippling,
// and long tendrils hanging from its underside, swaying, thinning to threads. It sends back no
// light: it only hides what lies beyond it.
uniform vec4 uCreature;      // its centre: x, z relative to the camera, y its height (m); w its size (0: none)
uniform vec2 uCreatureTurn;  // cos and sin of its heading
uniform float uCreaturePhase; // how far its ripples and sway have gone

// Its shape (m, outside positive; a bound, not the exact distance) in its own frame: x along
// it, y up, z across. A broad wing, thin at its rim and swelling into a long hump along its
// back, its rim rippling up and down in slow waves that run back along it; long tendrils hang
// from the back half of its underside, thinning to threads and curling as they sway.
float creatureSD(vec3 q) {
  vec2 e = q.xz / vec2(1800.0, 1250.0);
  float rr = length(e); // 0 at its middle, 1 at its rim
  float a = atan(q.z, q.x);
  float mid = 150.0 * rr * rr * sin(2.0 * a + 3.0 * rr - uCreaturePhase) + 50.0 * rr * sin(5.0 * a - 1.3 * uCreaturePhase);
  float thick = 35.0 + 230.0 * max(1.0 - rr * rr, 0.0);
  vec2 h = q.xz / vec2(800.0, 280.0);
  float hump = 300.0 * exp(-dot(h, h));
  float dy = q.y - mid;
  float dv = dy > 0.0 ? dy - thick - hump : -dy - 0.6 * thick;
  float d = max(0.6 * dv, (rr - 1.0) * 1250.0);
  if (dy < 0.0) {
    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      // Rooted over the back half of the body.
      vec2 root = vec2(-0.1 - 0.75 * fract(fi * 0.618 + 0.13), 0.8 * (fract(fi * 0.382 + 0.41) * 2.0 - 1.0)) * vec2(1800.0, 1250.0);
      float len = 1100.0 + 1300.0 * fract(fi * 0.737 + 0.29);
      float y = mid - 0.3 * thick - q.y; // how far below the body
      float u = clamp(y / len, 0.0, 1.0);
      float sway = 420.0 * u * u;
      vec2 axis = root + vec2(sin(y / (180.0 + 60.0 * fi) + fi * 1.7 + 0.6 * uCreaturePhase) - 0.6 * u, cos(y / (230.0 + 40.0 * fi) + fi * 2.3 + 0.5 * uCreaturePhase)) * sway;
      float dt = 0.55 * (length(q.xz - axis) - mix(34.0, 4.0, u));
      d = min(d, max(dt, max(-y, y - len)));
    }
  }
  return d;
}

// How much of what lies beyond the creature shows through along dir (soft at its edges, over
// the width of a pixel), and how far along the ray it begins (1e9: not on this ray).
void creatureMarch(vec3 dir, float pixelAngle, out float through, out float at) {
  through = 1.0;
  at = 1e9;
  float s = uCreature.w;
  if (s > 0.0) {
    vec3 c = vec3(uCreature.x, uCreature.y - uCamAlt, uCreature.z);
    float b = dot(c, dir);
    float disc = b * b - dot(c, c) + (3400.0 * s) * (3400.0 * s);
    if (disc > 0.0) {
      float sq = sqrt(disc);
      float t = max(b - sq, 0.0);
      for (int i = 0; i < 64; i++) {
        if (t > b + sq || through < 0.01) break;
        vec3 p = dir * t - c;
        vec3 q = vec3(uCreatureTurn.x * p.x + uCreatureTurn.y * p.z, p.y, -uCreatureTurn.y * p.x + uCreatureTurn.x * p.z) / s;
        float d = creatureSD(q) * s;
        float w = max(t * pixelAngle, 1.0);
        float k = clamp(d / w, 0.0, 1.0);
        if (k < 1.0 && at > 1e8) at = t;
        through = min(through, k);
        t += max(d, 0.5 * w + 2.0);
      }
    }
  }
}
#endif

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
#ifdef NIGHT
  // In the abyss the light comes from the deep, from straight below (deepLight, storm.glsl).
  float cosD = -dir.y;
  vec4 phD = vec4(cloudPhase(cosD, 1.0), cloudPhase(cosD, 0.6), cloudPhase(cosD, 0.36), cloudPhase(cosD, 0.2));
#endif

  vec3 sunAtClouds = uSunIlluminance * transmittanceToSun(uTransmittance, RG + 3.0, uSunDir.y);
  vec3 skyZen = skyLookup(uSkyView, vec3(0.0, 1.0, 0.0), uSunDir, rCamKm);
  vec3 skyHor = skyLookup(uSkyView, normalize(vec3(-uSunDir.x, 0.1, -uSunDir.z) + vec3(1e-4)), uSunDir, rCamKm);
  vec3 skyAvg = skyZen * 0.55 + skyHor * 0.45;
  vec3 ambTop = skyAvg * 0.55;
  vec3 ambBottom = skyAvg * 0.18;

  float tSea = seaHit(uCamAlt, dir);
#ifdef NIGHT
  if (uAlien > 0.5) tSea = -1.0;
#endif
  float t0;
  float t1;
  bool hasLayer = cloudInterval(uCamAlt, dir, t0, t1);
  if (tSea > 0.0) t1 = min(t1, tSea);
#ifdef NIGHT
  // Up to uNearDist the storm is drawn by the mist pass, at full detail.
  t0 = max(t0, uNearDist);
  // In the abyss the haze hides everything beyond a few dozen kilometres.
  if (uAlien > 0.5) t1 = min(t1, 1.1 * ABYSS_HAZE);
#endif

  vec3 L = vec3(0.0);
  float T = 1.0;
#ifdef NIGHT
  vec2 Lf = vec2(0.0); // light of the flash and of the flicker, per unit of their power
  // The storm's light at the last sample where it was worked out, and where that was.
  float litAt = -1e9;
  float litMoon = 0.0;
  float litOd = 0.0;
  vec2 litOpen = vec2(0.0);
  vec2 litFlash = vec2(0.0);
  float litDeep = 200.0; // a deck's optical depth down to the deep's light
#endif
  float dsum = 0.0;
  float wsum = 0.0;
  // Per-pixel noise, advanced along a golden-ratio sequence every frame.
  float jitter = blueNoise(pixel, uFrame);
#ifdef NIGHT
  gRise = dir.y;
  gCurve = (1.0 - dir.y * dir.y) / RG_M;
  // The creature: what lies beyond it is hidden, from where it begins along the ray.
  float cThrough;
  float cAt;
#ifdef ABYSS
  creatureMarch(dir, pixelAngle, cThrough, cAt);
#else
  cThrough = 1.0;
  cAt = 1e9;
#endif
  bool cDone = cAt > 1e8;
#endif
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
#ifdef NIGHT
    scudSpan(origin, dir);
#endif
    for (int i = 0; i < 512; i++) {
      float ts = mode == REFINE ? 0.5 * (ra + rb) : t;
#ifdef NIGHT
      if (!cDone && ts >= cAt) {
        T *= cThrough;
        cDone = true;
      }
      // Far away, what is left behind 3% is not seen (the storm's misty edge is long to cross).
      if (i >= uMaxSteps || ts >= t1 || T < (ts > 3000.0 ? 0.03 : 0.01)) break;
#else
      if (i >= uMaxSteps || ts >= t1 || T < 0.01) break;
#endif
      float dt = stepAt(ts);
      // Near clouds the march takes finer steps far away, and the surface is softened to half a
      // step: edges thinner than a step would otherwise be hit in some frames and missed in others.
      float dtF = min(dt, 28.0 + 0.008 * ts);
      vec3 p = origin + dir * ts;
      float fp = max(ts * pixelAngle, 1.0);
#ifdef NIGHT
      // Around the storm there is no fair-weather cloud: no weather to look up.
      Weather w;
      if (nearAStorm(p)) {
        w.sheet = 0.0;
        w.alto = 0.0;
        w.warp = vec2(0.0);
      } else {
        w = weatherAt(p.xz, log2(fp / (WEATHER_PERIOD_B / 512.0)), log2(fp / (WEATHER_PERIOD_A / 512.0)));
      }
#else
      Weather w = weatherAt(p.xz, log2(fp / (WEATHER_PERIOD_B / 512.0)), log2(fp / (WEATHER_PERIOD_A / 512.0)));
#endif
      float lodB = max(log2(fp / (BASE_PERIOD / 128.0)), 0.0);
      float lodD = max(log2(fp / (DETAIL_PERIOD / 32.0)), 0.0);
      float lodM = max(log2(fp / 2.0) + mix(0.5, 1.6, smoothstep(400.0, 3000.0, ts)), 0.0);
      // Edge detail at every distance, so far clouds have the same character as near ones; its
      // mip levels fade it out where it becomes smaller than a pixel. SEARCH uses the shape
      // inflated by the most that detail could add, so thin fringes are never skipped.
      int detail = mode == SEARCH ? -1 : (mode == REFINE ? 0 : (ts < 2500.0 ? 2 : 1));
      float h;
#ifdef NIGHT
      gT = ts;
#endif
      float dens = densityAt(p, w, mode == SEARCH ? lodB + 0.5 : lodB, lodD, lodM, detail,
                             mode == SEARCH ? 0.5 * dt : 0.5 * dtF, h);

      if (mode == SEARCH) {
        if (dens > 0.0) {
          mode = MARCH;
          inside = false;
          emptyRun = 0;
          t = max(t - dt * 1.6, t0);
        } else {
          // Longer strides where no cloud is within reach at all.
#ifdef NIGHT
          t += max(dt * (h < 0.0 ? 2.6 : 2.0), gSafe);
#else
          t += dt * (h < 0.0 ? 2.6 : 2.0);
#endif
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
#ifdef NIGHT
        // No new surface search after a short gap: a hole in the storm's fringe, not its edge.
        bool search = !inside && !settled && dtF > 40.0 && emptyRun != 1 && emptyRun != 2;
#else
        bool search = !inside && !settled && dtF > 40.0;
#endif
        if (search) {
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
#ifdef NIGHT
        // The storm is lit by its own lean marches; the fair-weather clouds far from it as by
        // day. Along the ray the storm's light changes slowly (light spreads through its misty
        // edge), so it is worked out every few tens of metres and kept for the samples between.
        bool storm = gStorm;
        bool deck = gDeck;
        float moon = 1.0;
        vec2 open = vec2(1.0);
        float od;
        if (storm) {
          // In thin scud the light is kept longer still: the ray crosses a lot of it, and its
          // light changes with the storm around it, not with its own thin mist.
          if (t - litAt > max(1.6 * dtIn, (20.0 + 0.03 * t) * (gScud ? 2.5 : 1.0))) {
            litAt = t;
            // (No moon once the world has turned into the abyss.)
            litMoon = uAlien < 1.0 ? moonFar(p) : 0.0;
            litOd = litMoon > 0.004 ? stormDepth(p, uSunDir, 50.0, 2.2, 6, 3000.0, lodB, fract(jitter + 0.37)) : 200.0;
#ifdef ABYSS
            litDeep = deck ? stormDepth(p, vec3(0.0, -1.0, 0.0), 40.0, 2.2, 6, 2000.0, lodB, fract(jitter + 0.53)) : 200.0;
            // (The abyss has no sky to speak of: its decks need no look at what is over them.)
            litOpen = deck ? vec2(1.0) : skyOpen(p, lodB);
#else
            litOpen = skyOpen(p, lodB);
#endif
            litFlash = vec2(0.0);
            if (uFlashOn > 0.5) litFlash.x = flashFalloff(p) * lightningLit(p, dir, flashCentre(), uFlashDepth, 380.0, 4, lodB, fract(jitter + 0.71));
            if (uFlickOn > 0.5) litFlash.y = sourceFalloff(length(uFlickPos - p), 0.5) * lightningLit(p, dir, uFlickPos, uFlickDepth, 650.0, 3, lodB, fract(jitter + 0.19));
          }
          moon = litMoon;
          od = litOd;
          open = litOpen;
        } else {
          gT = -1.0;
          od = lightDepth(p, w, lodB, lodD, t > 9000.0, fract(jitter + 0.37));
        }
#else
        float od = lightDepth(p, w, lodB, lodD, t > 9000.0, fract(jitter + 0.37));
#endif
        // Single scattering plus an energy-preserving approximation of multiple scattering.
        float sun = ph0 * exp(-od)
                  + 1.2 * (0.85 * ph1 * exp(-od * 0.25)
                         + 0.65 * ph2 * exp(-od * 0.0625)
                         + 0.40 * ph3 * exp(-od * 0.021));
        // "Powder": thin edges and crevices hold less multiply scattered light, so they read
        // darker from the lit side. Fades out when looking towards the sun to keep silver linings.
        float powder = 1.0 - exp(-sigma * 140.0);
#ifdef NIGHT
        // The storm's misty edge holds its light like the rest: no darker rims around every bulge
        // (they drew a dark outline round each of them, a busy texture of small puffs).
        sun *= mix(1.0, powder, storm ? 0.0 : powderAmount);
#else
        sun *= mix(1.0, powder, powderAmount);
#endif
        vec3 amb = mix(ambBottom, ambTop, clamp(h, 0.0, 1.0));
#ifdef NIGHT
        if (storm) {
          sun *= moon;
          // Sky light on the storm: what is open to the sky is lit, what is under cloud is not.
          // And the storm's own glow: lightning never stops somewhere in it, and its light,
          // scattered from tower to tower, reaches everything a little, the tops of bulges most.
          amb = ambTop * NIGHT_SKYLIGHT * mix(0.16, 1.0, open.y)
              + vec3(0.0020, 0.0025, 0.0038) * (uStormGlow * (0.25 + 0.75 * open.x));
#ifdef ABYSS
          // In the abyss, light rises from the deep: it lights the decks from below, shines
          // through where they are thin and round their holes, and lights the undersides of the
          // decks above.
          if (deck) {
            // (Without the sun's widest lobe: a thick deck lets little through, so its thin
            // parts stand out.)
            float deep = phD.x * exp(-litDeep)
                       + 1.2 * (0.85 * phD.y * exp(-litDeep * 0.25)
                              + 0.65 * phD.z * exp(-litDeep * 0.0625)
                              + 0.12 * phD.w * exp(-litDeep * 0.021));
            amb += deepLight(p, altitudeAt(p)) * deep;
          }
#endif
        }
#endif
        vec3 S = (sunAtClouds * sun + amb) * ALBEDO;
        float tr = exp(-sigma * dtIn);
        float absorbed = T * (1.0 - tr);
        L += S * absorbed;
#ifdef NIGHT
        if (storm) {
          Lf += absorbed * litFlash * ALBEDO;
        } else {
          // Far fair-weather clouds only catch a little of it: no march.
          if (uFlashOn > 0.5) Lf.r += absorbed * flashFalloff(p) * (0.09 * ALBEDO);
          if (uFlickOn > 0.5) Lf.g += absorbed * sourceFalloff(length(uFlickPos - p), 0.5) * (0.09 * ALBEDO);
        }
#endif
        dsum += t * absorbed;
        wsum += absorbed;
        T *= tr;
        t += dtIn;
      } else {
        settled = false;
        inside = false;
        if (++emptyRun > 6) mode = SEARCH;
#ifdef NIGHT
        // In the storm's eaten-away fringe the cloud begins further in: half the way there at once.
        t += gStorm ? max(dtF, 0.5 * gGap) : dtF;
#else
        t += dtF;
#endif
      }
    }
  }

#ifdef NIGHT
  if (!cDone) T *= cThrough;
#endif
  vec3 radiance = vec3(0.0);
  float depthKm = -1.0;
  vec3 camKm = vec3(0.0, rCamKm, 0.0);
  if (wsum > 1e-5) {
    float depth = dsum / wsum;
    vec3 apT;
    vec3 apL = integrateScattering(uTransmittance, uMultiScatter, camKm, dir, uSunDir, uSunIlluminance,
                                   depth * 1e-3, 8, apT);
#ifdef NIGHT
    // (The Earth's air, whose model thickens without end below the sea, is not the abyss's.)
    if (uAlien > 0.0) {
      apT = mix(apT, vec3(exp(-depth / ABYSS_HAZE)), uAlien);
      apL *= 1.0 - uAlien;
    }
#endif
    radiance = L * apT + apL * (1.0 - T);
    depthKm = depth * 1e-3;
#ifdef NIGHT
    Lf *= dot(apT, vec3(1.0 / 3.0));
#endif
  }
  float visibility = T;
#ifdef NIGHT
  if (uFog > 0.0) {
    // Rain and haze in the air of the storm: distant walls fade, and lightning lights the haze
    // itself (single scattering of its sources, integrated along the ray).
    float sigmaF = HAZE_SIGMA * uFog;
    float far = wsum > 1e-5 ? dsum / wsum : (tSea > 0.0 ? tSea : 20000.0);
    float Tf = exp(-sigmaF * far);
    radiance *= Tf;
    Lf *= Tf;
    visibility *= exp(-sigmaF * 20000.0);
    if (uFlashOn + uFlickOn > 0.5) {
      float len = min(far, 9000.0);
      vec2 acc = vec2(0.0);
      for (int k = 0; k < 8; k++) {
        float sx = len * (float(k) + fract(jitter + 0.13 * float(k))) / 8.0;
        vec3 q = dir * sx + vec3(0.0, uCamAlt, 0.0);
        float tx = exp(-sigmaF * sx);
        if (uFlashOn > 0.5) acc.x += tx * flashFalloff(q);
        if (uFlickOn > 0.5) acc.y += tx * sourceFalloff(length(uFlickPos - q), 0.5);
      }
      Lf += acc * (len / 8.0 * sigmaF * HAZE_GLOW / (4.0 * PI));
    }
  }
#endif
  if (tSea > 0.0) {
#ifdef NIGHT
    T *= exp(-HAZE_SIGMA * uFog * tSea);
#endif
    if (T > 0.003) {
#ifdef NIGHT
      gT = -1.0; // the sea's shadow march is off the ray
#endif
      vec3 seaL = shadeSea(dir, tSea, rCamKm, skyAvg, fract(jitter + 0.5));
      vec3 apT;
      vec3 apL = integrateScattering(uTransmittance, uMultiScatter, camKm, dir, uSunDir, uSunIlluminance,
                                     tSea * 1e-3, 12, apT);
      radiance += T * (seaL * apT + apL);
#ifdef NIGHT
      if (uFlashOn > 0.5) {
        // The sea under a flash: its dark body, and the flash mirrored in the water.
        vec3 ps = vec3(0.0, uCamAlt, 0.0) + dir * tSea;
        vec3 ns = normalize(vec3(ps.x, RG_M, ps.z));
        float e = 0.0;
        for (int k = 0; k < 3; k++) {
          vec3 l = uFlashPos[k] - ps;
          float dKm = length(l) * 1e-3;
          l = normalize(l);
          vec3 hv = normalize(l - dir);
          float NoH = max(dot(ns, hv), 1e-3);
          float sigma2 = 0.035;
          float cos2 = NoH * NoH;
          float D = exp(-(1.0 - cos2) / (cos2 * sigma2)) / (PI * sigma2 * cos2 * cos2);
          e += uFlashWeight[k] * exp(-dKm / 8.0) / (dKm * dKm + 0.25)
             * (0.004 * max(dot(ns, l), 0.0) + 0.003 * D / (4.0 * max(dot(ns, -dir), 0.05)));
        }
        Lf.r += T * e * apT.g;
      }
#endif
    }
    visibility = 0.0;
    if (depthKm < 0.0) depthKm = tSea * 1e-3;
  }
  outScene = vec4(radiance, visibility);
  outDepth = vec4(depthKm, 1.0 - T, 0.0, 1.0); // g: how much of the pixel is cloud
#ifdef NIGHT
  outFlash = vec4(Lf, 0.0, 1.0);
#endif
}
