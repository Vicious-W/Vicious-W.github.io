// The thunderstorm's cloud, shared by the cloud march (clouds.frag) and the mist around the
// aircraft (mist.frag). Its baked shape (night/storm.js, a distance field, one voxel is 250 m)
// is roughened by the billows of the base noise and by the edge detail, and its edge is mist.
// Needs: uBaseNoise, uDetailNoise, uBaseOffset, uDetailOffset, uDensityScale, uSunDir (the
// moon), uFlashPos, uFlashWeight, altitudeAt(), BASE_PERIOD, BASE_Y_SCALE, DETAIL_PERIOD,
// CLOUD_BOTTOM and the STORM_* defines.

uniform sampler3D uStorm;
uniform vec2 uStormCam;     // camera position in the storm volume, from its corner (m)
uniform sampler3D uMistNoise;
// Scud and veils of mist on the journey's way, and pockets of thinner air in the rear tower
// (journey.js), nearest first: ellipsoids turned to the path. Unused slots come last, size.w 0.
#define SCUD_MAX 8
const float SCUD_THIN = 0.28;
uniform vec4 uScudPos[SCUD_MAX];  // centre relative to the camera (y: altitude)
uniform vec4 uScudSize[SCUD_MAX]; // radii across, up, along (m); w: how deep in mist its middle is (< 0: a pocket)
uniform vec2 uScudTurn[SCUD_MAX]; // the path's right there (world x, z)
uniform vec3 uMistOffset;   // where the mist noise is (m, wrapped): it drifts with the air

// The edge of the storm is not a surface. From the outer edge of its shape the cloud thickens
// over FRINGE metres into the core, eaten away by turbulent mist at every scale down to a
// couple of metres: wisps and veils at first, then lumps with clear air between them, then
// cloud with holes, then the core.
const float FRINGE = 320.0;
// How much of the fringe the mist can eat away (0..1), how sharp the edge of a wisp is (in
// units of the fringe's depth), and how dense the wisps at its outer edge are.
const float ERODE = 0.85;
const float MIST_EDGE = 0.32;
const float MIST_THIN = 0.3;
const float MIST_PERIOD = 256.0; // one tile of the mist noise (2 m texels)
// The light marches see the storm's average: it turns opaque over this depth (m), starting
// LIGHT_START metres inside the outer edge of its shape. Light spreads through the eaten-away
// fringe, so the mist in it is lit nearly alike, holes and all.
const float LIGHT_RAMP = 420.0;
const float LIGHT_START = 110.0;

float stormSD(vec3 suv, float lod) {
  return (textureLod(uStorm, suv, lod).r * 2.0 - 1.0) * STORM_RANGE;
}

vec3 stormUv(vec3 p, float alt) {
  return vec3(p.x + uStormCam.x, alt, p.z + uStormCam.y) / STORM_SIZE;
}

bool inStormBox(vec3 suv) {
  return all(greaterThan(suv, vec3(0.0))) && all(lessThan(suv, vec3(1.0)));
}

// The storm's billows: the same noise as every other cloud, at the scale of its towers. The
// anvil is a smoother shelf.
float stormBillows(vec4 n, float alt) {
  return mix(1.0, 0.3, smoothstep(10000.0, 11500.0, alt)) * (650.0 * (n.r - 0.5) + 220.0 * (n.g - 0.5));
}

vec4 baseNoiseAt(vec3 p, float lodB) {
  return textureLod(uBaseNoise, (p + uBaseOffset) * vec3(1.0, BASE_Y_SCALE, 1.0) / BASE_PERIOD, lodB);
}

// The stretch of the current ray that passes within reach of any scud or pocket, worked out
// once per ray (scudSpan); samples elsewhere skip them. gT: where along the ray the current
// sample is (-1 for samples off the ray, such as light marches: they ignore the scud).
float gScudT0 = 1e9;
float gScudT1 = -1e9;
float gT = -1.0;
// Where the ray enters and leaves each one's reach (t), worked out once per ray.
vec2 gSpan[SCUD_MAX];

// How far out (in units of its radii) a scud or pocket can still change the cloud: the billows
// and edge detail reach up to about 170 m past a scud's shape, which in its scaled inside is
// 170 / (FRINGE * how deep in mist its middle is); a pocket's wall has the fringe.
float scudReachK(vec4 r) {
  return r.w > 0.0 ? clamp(1.0 + 170.0 / (FRINGE * r.w), 1.3, 2.4) : 1.0 + 1.2 * FRINGE / min(r.x, min(r.y, r.z));
}

void scudSpan(vec3 origin, vec3 dir) {
  gScudT0 = 1e9;
  gScudT1 = -1e9;
  for (int i = 0; i < SCUD_MAX; i++) {
    gSpan[i] = vec2(1e9, -1e9);
    vec4 r = uScudSize[i];
    if (r.w == 0.0) continue;
    // In the scud's own frame, scaled by its radii, its reach is a sphere.
    vec2 a = uScudTurn[i];
    vec3 oc = origin - uScudPos[i].xyz;
    vec3 o = vec3(dot(oc.xz, a), oc.y, a.y * oc.x - a.x * oc.z) / r.xyz;
    vec3 v = vec3(dot(dir.xz, a), dir.y, a.y * dir.x - a.x * dir.z) / r.xyz;
    float k = scudReachK(r);
    float va = dot(v, v);
    float b = dot(o, v);
    float disc = b * b - va * (dot(o, o) - k * k);
    if (disc < 0.0) continue;
    float sq = sqrt(disc);
    float t1 = (-b + sq) / va;
    if (t1 < 0.0) continue;
    gSpan[i] = vec2(max((-b - sq) / va, 0.0), t1);
    gScudT0 = min(gScudT0, gSpan[i].x);
    gScudT1 = max(gScudT1, t1);
  }
}

bool inScudSpan() {
  return gT >= gScudT0 && gT <= gScudT1;
}

// How far along the ray the reach of the next scud or pocket begins (m): 0 within one, far when
// none is ahead (or for samples off the ray).
float scudReach(vec3 p) {
  if (gT < 0.0 || gT > gScudT1) return 1e9;
  if (gT < gScudT0) return gScudT0 - gT;
  float ahead = 1e9;
  for (int i = 0; i < SCUD_MAX; i++) {
    vec2 sp = gSpan[i];
    if (gT <= sp.y) ahead = min(ahead, max(sp.x - gT, 0.0));
  }
  return ahead;
}

// The storm's shape (metres inside its outer edge) with the scud and pockets at p; n: the base
// noise there. A scud's inside is scaled to the storm's fringe, so the mist eats its edge away
// like the storm's; its middle is as deep in mist as its size.w says. edgeK: how much of the
// storm's large edge detail applies (less to a fragment); thin: its density against the
// storm's (scud is thin: one sees through it, wisp behind wisp).
float withScud(vec3 p, vec4 n, float shape, out float edgeK, out float thin) {
  edgeK = 1.0;
  thin = 1.0;
  if (!inScudSpan()) return shape;
  for (int i = 0; i < SCUD_MAX; i++) {
    // Only those whose reach this ray is in.
    if (gT < gSpan[i].x || gT > gSpan[i].y) continue;
    vec4 r = uScudSize[i];
    vec3 d = p - uScudPos[i].xyz;
    vec2 a = uScudTurn[i];
    float k = length(vec3(dot(d.xz, a), d.y, a.y * d.x - a.x * d.z) / r.xyz);
    if (r.w > 0.0) {
      float s = (1.0 - k) * FRINGE * r.w + (n.r - 0.5) * 150.0 + (n.g - 0.5) * 70.0;
      if (s > shape) {
        shape = s;
        edgeK = 0.35;
        thin = SCUD_THIN;
      }
    } else {
      // A pocket: the cloud gives way around it, and its walls get the fringe of mist.
      shape = min(shape, (k - 1.0) * FRINGE * 1.2);
    }
  }
  return shape;
}

// Edge detail (80 to 320 m bulges) added to shape (metres inside the outer edge); ragged near
// the cloud base. fine adds a finer octave (close range).
float stormEdge(vec3 p, float z, float lodD, bool fine) {
  vec3 dq = (p + uDetailOffset) / DETAIL_PERIOD;
  vec3 dn = textureLod(uDetailNoise, dq, lodD).rgb;
  float dfbm = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  if (fine) {
    // Integer frequency multiple keeps the wrapped detail offset continuous.
    vec3 dn2 = textureLod(uDetailNoise, dq * 3.0, lodD + 1.585).rgb;
    dfbm = dfbm * 0.72 + (dn2.r * 0.625 + dn2.g * 0.25 + dn2.b * 0.125) * 0.28;
  }
  float ragged = mix(1.7, 1.0, smoothstep(0.0, 140.0, z));
  return 90.0 * ragged * (dfbm - 0.5) * 2.0;
}

// The mist at p: low where the edge of the cloud keeps its mist, high where it is eaten away
// (0..1, evenly spread). flow: the smooth part of the base noise there (its blue and alpha),
// which displaces the mist; as the two drift apart the mist curls and stirs. lodM: mip level of
// the mist noise for the pixel's footprint; fine adds an octave four times finer (2 m), for
// close range.
float mistNoise(vec3 p, vec2 flow, float lodM, bool fine) {
  vec2 f = flow - 0.5;
  vec3 q = (p + uMistOffset + vec3(f.x, 0.6 * (f.x - f.y), f.y) * 24.0) / MIST_PERIOD;
  float e = textureLod(uMistNoise, q, lodM).r;
  if (fine) {
    // Integer multiple: the wrapped offset stays continuous.
    e = e * 0.6 + textureLod(uMistNoise, q * 4.0, lodM + 2.0).r * 0.4;
    // Mixing two noises bunches values towards the middle; spread them out again.
    e = clamp((e - 0.5) * 1.35 + 0.5, 0.0, 1.0);
  }
  return e;
}

// Density of the storm's cloud (0..1) at shape metres inside the outer edge of its shape, where
// the mist noise is e. Going in, more and more of the air holds mist (the mist noise decides
// where), until the holes close; each wisp has a clear edge and is fairly dense already, so
// near the outer edge the fringe is wisps with clear air between them, not a thin fog.
float stormMist(float shape, float e) {
  float prof = shape / FRINGE;
  float inWisp = smoothstep(0.0, MIST_EDGE, prof - ERODE * e);
  return inWisp * mix(MIST_THIN, 1.0, clamp(prof, 0.0, 1.0));
}

// ---- lighting of the storm. Near the storm there is no other cloud, so its light marches use
// the storm alone (two fetches a sample), not the full density function.

// Metres inside the storm's surface at p: the baked distance plus the billows.
float stormShape(vec3 p, float lodB) {
  float alt = altitudeAt(p);
  vec3 suv = stormUv(p, alt);
  if (alt < CLOUD_BOTTOM || any(lessThan(suv, vec3(0.0))) || any(greaterThan(suv, vec3(1.0)))) return -STORM_RANGE;
  float sd = stormSD(suv, max(lodB - 3.0, 0.0));
  if (sd < -700.0) return sd; // the billows could not reach
  vec4 n = textureLod(uBaseNoise, (p + uBaseOffset) * vec3(1.0, BASE_Y_SCALE, 1.0) / BASE_PERIOD, lodB);
  return sd + stormBillows(n, alt);
}

// Optical depth of the storm from p along l, in growing steps up to reach.
float stormDepth(vec3 p, vec3 l, float first, float growth, int steps, float reach, float lodB, float jitter) {
  float od = 0.0;
  float prev = 0.0;
  float d = first * (0.7 + 0.6 * jitter);
  for (int j = 0; j < 6; j++) {
    if (j >= steps) break;
    float next = min(d, reach);
    float seg = next - prev;
    if (seg <= 0.0) break;
    float inside = stormShape(p + l * (prev + 0.5 * seg), lodB + 1.0 + float(j) * 0.6);
    od += clamp((inside - LIGHT_START) / LIGHT_RAMP, 0.0, 1.0) * seg;
    prev = next;
    d *= growth;
  }
  return od * uDensityScale;
}

// How much of the storm lies at q, 0..1, from a coarse level of the baked shape: soft, for
// shadows cast from far away.
float stormBlock(vec3 q, float lod) {
  return clamp(stormSD(stormUv(q, altitudeAt(q)), lod) / 600.0 + 0.4, 0.0, 1.0);
}

// The moon as seen from p past the far parts of the storm (other towers, the anvil): 0..1.
float moonFar(vec3 p) {
  return (1.0 - stormBlock(p + uSunDir * 4200.0, 2.0)) * (1.0 - stormBlock(p + uSunDir * 9500.0, 3.0));
}

// How open the air is above p: x for the few hundred metres just above (the tops of bulges are
// open, walls half, undersides closed), y for the sky itself (closed under the anvil or an
// overhang). They shade the storm's unlit side into shape.
vec2 skyOpen(vec3 p, float lodB) {
  float near = 1.0 - clamp(stormShape(p + vec3(0.0, 420.0, 0.0), lodB + 2.0) / 420.0 + 0.5, 0.0, 1.0);
  float far = 1.0 - clamp(stormSD(stormUv(p + vec3(0.0, 1900.0, 0.0), altitudeAt(p) + 1900.0), 2.0) / 900.0 + 0.5, 0.0, 1.0);
  return vec2(near, near * (0.3 + 0.7 * far));
}

// Falloff of light from a source at distance d (m) per unit of its power (power = irradiance
// at 1 km in clear air): inverse square, a little lost to rain and haze.
float sourceFalloff(float d, float soft) {
  float dKm = d * 1e-3;
  return exp(-dKm / 8.0) / (dKm * dKm + soft);
}

float flashFalloff(vec3 p) {
  float e = 0.0;
  for (int k = 0; k < 3; k++) e += uFlashWeight[k] * sourceFalloff(length(uFlashPos[k] - p), 0.12);
  return e;
}

vec3 flashCentre() {
  return uFlashPos[0] * uFlashWeight.x + uFlashPos[1] * uFlashWeight.y + uFlashPos[2] * uFlashWeight.z;
}

// Light scattered towards the viewer (along -dir) at p of the storm, from lightning at src that
// sits depth metres inside its cloud; without the falloff. Lightning is buried in cloud: its
// light spreads through the cloud, so the cloud around it glows, less the more cloud lies
// between; what gets out crosses the open air and lights the clouds that face it like a lamp:
// their bulges shadow each other (a few fine steps), and whatever stands in the way further on
// shadows them too (coarse taps of the baked shape along the whole way, which cost little).
float lightningLit(vec3 p, vec3 dir, vec3 src, float depth, float spreadLength, int taps, float lodB, float jitter) {
  vec3 lc = src - p;
  float dl = length(lc);
  vec3 l = lc / max(dl, 1.0);
  float nearReach = min(dl, 420.0);
  float od = stormDepth(p, l, 30.0, 3.0, 3, nearReach, lodB + 0.5, 0.5 + 0.5 * jitter);
  float through = od / uDensityScale;
  float span = dl - depth - nearReach;
  if (span > 0.0) {
    float seg = span / float(taps);
    float lod = clamp(log2(max(seg, 1.0) / 250.0), 0.5, 3.0);
    float cloud = 0.0;
    for (int k = 0; k < 4; k++) {
      if (k >= taps) break;
      cloud += stormBlock(p + l * (nearReach + seg * (float(k) + 0.5)), lod);
    }
    through += cloud * seg;
  }
  // Shadows of what stands between; the shell of cloud around the lightning itself does not
  // shadow, it spreads the light.
  float odAll = through * uDensityScale;
  through += min(depth, max(dl - nearReach, 0.0));
  float spread = 1.0 + through / spreadLength;
  float cosF = dot(dir, l);
  // The light comes from a glowing stretch of cloud, not from a point: the forward peak of the
  // phase function is spread out (a sharp one would make every wisp before it sparkle).
  float direct = cloudPhase(cosF, 0.6) * exp(-odAll)
               + 1.1 * (0.85 * cloudPhase(cosF, 0.36) * exp(-odAll * 0.25) + 0.65 * cloudPhase(cosF, 0.2) * exp(-odAll * 0.0625));
  return (0.8 / (4.0 * PI) + direct) / (spread * spread);
}
