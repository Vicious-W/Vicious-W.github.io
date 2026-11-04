// Cloud placement map, baked once. Individual heaped clouds are scattered on four nested
// jittered grids, from large cumulus to many small fragments, clustered by a regional field
// and gathered around the giants (which are separate 3D shapes, see cumulus.js).
// Each cloud is a flat-based superellipse dome. The union of domes is stored per texel:
// r = envelope height above the cloud base (m), g = thickness (density multiplier),
// b = height of the dominant cloud (m, sets the scale of its noise), a = 1.
// The map tiles seamlessly: cell hashes use coordinates wrapped by the tile.

uniform float uTile;
uniform vec4 uGiantA[GIANT_COUNT];
out vec4 outColor;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec4 hash4(vec2 cell, uint level) {
  uvec3 a = pcg3d(uvec3(uint(cell.x), uint(cell.y), level * 7919u + 13u));
  uvec3 b = pcg3d(a ^ uvec3(0x9E3779B9u, 0x85EBCA6Bu, 0xC2B2AE35u));
  return vec4(vec3(a), float(b.x)) * (1.0 / 4294967295.0);
}

// Tileable value noise on [0,1)^2 with an integer frequency.
float valueNoise(vec2 uv, float freq, uint seed) {
  vec2 q = uv * freq;
  vec2 i0 = floor(q);
  vec2 f = q - i0;
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash4(mod(i0, freq), seed).x;
  float b = hash4(mod(i0 + vec2(1.0, 0.0), freq), seed).x;
  float c = hash4(mod(i0 + vec2(0.0, 1.0), freq), seed).x;
  float d = hash4(mod(i0 + vec2(1.0, 1.0), freq), seed).x;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float regionField(vec2 uv, uint seed) {
  return valueNoise(uv, 3.0, seed) * 0.55 + valueNoise(uv, 7.0, seed + 1u) * 0.3 + valueNoise(uv, 16.0, seed + 2u) * 0.15;
}

// Per level: cell size (m), base probability, radius range (fraction of the cell),
// height-to-radius range, minimum thickness.
const float CELL[4] = float[4](4096.0, 2048.0, 1024.0, 512.0);
const float PROB[4] = float[4](0.30, 0.34, 0.34, 0.26);
const float RMIN[4] = float[4](0.27, 0.24, 0.22, 0.20);
const float RMAX[4] = float[4](0.43, 0.40, 0.38, 0.36);
const float AMIN[4] = float[4](0.65, 0.55, 0.45, 0.35);
const float AMAX[4] = float[4](1.10, 0.95, 0.85, 0.70);
const float TMIN[4] = float[4](0.85, 0.55, 0.35, 0.22);

void main() {
  vec2 uv = vUv;
  vec2 p = uv * uTile;
  // Shifted so the start sits in open air with groups of cumulus and a giant ahead.
  float cluster = regionField(uv + vec2(0.12, 0.4), 101u);

  // Convection gathers around the giants: more cumulus nearby; no large dome inside one.
  float nearGiant = 0.0;
  float inGiant = 0.0;
  for (int g = 0; g < GIANT_COUNT; g++) {
    vec4 ga = uGiantA[g];
    if (ga.z <= 0.0) continue;
    vec2 dd = p - ga.xy;
    dd -= uTile * round(dd / uTile);
    float r = length(dd) / ga.z;
    nearGiant = max(nearGiant, 1.0 - smoothstep(0.8, 2.6, r));
    inGiant = max(inGiant, 1.0 - smoothstep(0.45, 0.8, r));
  }
  // Strong regional contrast: wide clear areas, dense groups, giants inside the groups.
  float regional = max(smoothstep(0.36, 0.72, cluster), nearGiant * 0.85);

  // Cloud streets in some regions: rows along the wind (about -7 degrees in map space),
  // about 4.3 km apart, wavy. Integer wave numbers keep the pattern tileable.
  float streets = smoothstep(0.56, 0.74, regionField(uv, 307u));
  float wave = 6.2831853 * (2.0 * uv.x + 19.0 * uv.y) + 5.0 * valueNoise(uv, 9.0, 401u);
  float rows = mix(1.0, 0.15 + 1.7 * pow(0.5 + 0.5 * sin(wave), 2.0), streets);

  float envelope = 0.0;
  float thickness = 0.0;
  float scaleH = 0.0;

  for (int L = 0; L < 4; L++) {
    float cell = CELL[L];
    float cellsPerTile = uTile / cell;
    vec2 id = floor(p / cell);
    // Large clouds keep to the groups; small fragments are also scattered through clear air.
    float spread = L >= 2 ? max(regional, 0.22) : regional;
    float density = spread * rows * 2.1 * (L == 0 ? 1.0 - inGiant : 1.0);
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 c = id + vec2(float(i), float(j));
        vec2 cw = mod(c, cellsPerTile);
        vec4 h = hash4(cw, uint(L) + 2u);
        if (h.x > PROB[L] * density) continue;
        vec2 center = (c + 0.18 + 0.64 * h.yz) * cell;
        float radius = mix(RMIN[L], RMAX[L], h.w) * cell;
        float dist = length(p - center) / radius;
        // Larger clouds carry extra lobes, so reach further than one radius.
        if (dist >= (L <= 1 ? 1.85 : 1.3)) continue;
        vec4 h2 = hash4(cw + 37.0, uint(L) + 12u);
        float height = clamp(radius * mix(AMIN[L], AMAX[L], h2.x), 70.0, 2400.0);
        // Steep sides, rounded top, and a low skirt so noise can push edges outwards.
        float dome = dist < 1.0 ? pow(1.0 - pow(dist, 2.4), 1.0 / 2.4) : 0.0;
        float skirt = 0.16 * (1.0 - smoothstep(0.8, 1.3, dist));
        float e = height * max(dome, skirt);
        // Larger clouds are clusters: four lobes of varied size and height around the main
        // dome break up the round footprint and give several turrets.
        for (int k = 0; k < 4; k++) {
          if (L > 1) break;
          vec4 hk = hash4(cw + vec2(float(k) * 13.0 + 101.0, 7.0), uint(L) + 32u);
          float angle = (float(k) + hk.x * 0.8) * 1.5707963;
          vec2 lc = center + vec2(cos(angle), sin(angle)) * mix(0.35, 0.8, hk.y) * radius;
          float lr = mix(0.4, 0.7, hk.z) * radius;
          float ld = length(p - lc) / lr;
          if (ld >= 1.3) continue;
          float lh = height * mix(0.45, 0.95, hk.w);
          float ldome = ld < 1.0 ? pow(1.0 - pow(ld, 2.4), 1.0 / 2.4) : 0.0;
          e = max(e, lh * max(ldome, 0.16 * (1.0 - smoothstep(0.8, 1.3, ld))));
        }
        if (e > envelope) {
          envelope = e;
          thickness = mix(TMIN[L], 1.0, h2.y);
          scaleH = height;
        }
      }
    }
  }
  outColor = vec4(envelope, thickness, scaleH, 1.0);
}
