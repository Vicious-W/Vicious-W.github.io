// Tileable procedural noise, baked once at startup.
// Mode 0: cloud base shape (Perlin-Worley + Worley FBMs), 3D.
// Mode 1: cloud detail erosion (Worley FBMs), 3D.
// Mode 2: weather map (coverage, clumps, tower regions, top variation), 2D.
// 3D volumes are rendered as stacks of slices: x = column, y = row within slice + slice * size.

uniform int uMode;
uniform float uSize;
uniform float uZ0;
uniform float uDepth;
out vec4 outColor;

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

vec3 hash33(vec3 cell, uint seed) {
  uvec3 h = pcg3d(uvec3(ivec3(cell)) + uvec3(seed * 1013u, seed * 7919u, seed * 104729u));
  return vec3(h) * (1.0 / 4294967295.0);
}

float remap(float v, float l0, float h0, float l1, float h1) {
  return l1 + (v - l0) * (h1 - l1) / (h0 - l0);
}

// Distance to the nearest feature point, in cell units. freq = cells per tile.
float worley(vec3 p, float freq, uint seed) {
  vec3 q = p * freq;
  vec3 id = floor(q);
  vec3 f = q - id;
  float best = 8.0;
  for (int z = -1; z <= 1; z++) {
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 o = vec3(float(x), float(y), float(z));
        vec3 c = mod(id + o, vec3(freq));
        vec3 d = o + hash33(c, seed) - f;
        best = min(best, dot(d, d));
      }
    }
  }
  return sqrt(best);
}

float worleyInv(vec3 p, float freq, uint seed) {
  return 1.0 - clamp(worley(p, freq, seed), 0.0, 1.0);
}

vec3 gradientAt(vec3 c, float freq, uint seed) {
  return normalize(hash33(mod(c, vec3(freq)), seed) * 2.0 - 1.0 + 1e-5);
}

float perlin(vec3 p, float freq, uint seed) {
  vec3 q = p * freq;
  vec3 i0 = floor(q);
  vec3 f = q - i0;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(gradientAt(i0 + vec3(0.0, 0.0, 0.0), freq, seed), f - vec3(0.0, 0.0, 0.0));
  float n100 = dot(gradientAt(i0 + vec3(1.0, 0.0, 0.0), freq, seed), f - vec3(1.0, 0.0, 0.0));
  float n010 = dot(gradientAt(i0 + vec3(0.0, 1.0, 0.0), freq, seed), f - vec3(0.0, 1.0, 0.0));
  float n110 = dot(gradientAt(i0 + vec3(1.0, 1.0, 0.0), freq, seed), f - vec3(1.0, 1.0, 0.0));
  float n001 = dot(gradientAt(i0 + vec3(0.0, 0.0, 1.0), freq, seed), f - vec3(0.0, 0.0, 1.0));
  float n101 = dot(gradientAt(i0 + vec3(1.0, 0.0, 1.0), freq, seed), f - vec3(1.0, 0.0, 1.0));
  float n011 = dot(gradientAt(i0 + vec3(0.0, 1.0, 1.0), freq, seed), f - vec3(0.0, 1.0, 1.0));
  float n111 = dot(gradientAt(i0 + vec3(1.0, 1.0, 1.0), freq, seed), f - vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// Fractal Perlin noise remapped to roughly [0, 1].
float perlinFbm(vec3 p, float freq, int octaves, uint seed) {
  float sum = 0.0;
  float amp = 1.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += perlin(p, freq, seed + uint(i) * 17u) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
  }
  return clamp((sum / norm) * 0.85 + 0.5, 0.0, 1.0);
}

float contrast(float v, float k) {
  return clamp((v - 0.5) * k + 0.5, 0.0, 1.0);
}

void main() {
  if (uMode == 2) {
    // Smooth, low-frequency noises only. Anything finer than a cloud is extruded vertically
    // through the whole cloud and shows up as walls or curtains; fine detail belongs to 3D noise.
    vec3 p = vec3(vUv, 0.0);
    float regional = perlinFbm(p, 3.0, 3, 31u);
    float clumps = perlinFbm(p, 6.0, 2, 41u);
    float towers = perlinFbm(p, 2.0, 2, 61u);
    float tops = perlinFbm(p, 6.0, 2, 71u);
    outColor = vec4(regional, clumps, towers, tops);
    return;
  }

  float x = gl_FragCoord.x - 0.5;
  float yAll = gl_FragCoord.y - 0.5;
  float slice = floor(yAll / uSize);
  float y = yAll - slice * uSize;
  vec3 p = (vec3(x, y, uZ0 + slice) + 0.5) / vec3(uSize, uSize, uDepth);

  if (uMode == 0) {
    float pf = contrast(perlinFbm(p, 4.0, 4, 1u), 1.5);
    float w1 = worleyInv(p, 4.0, 11u);
    float w2 = worleyInv(p, 8.0, 12u);
    float w3 = worleyInv(p, 16.0, 13u);
    float w4 = worleyInv(p, 32.0, 14u);
    float w5 = worleyInv(p, 64.0, 15u);
    float wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    float perlinWorley = remap(pf, 0.0, 1.0, wfbm, 1.0);
    // R: low-frequency Perlin-Worley body. Eroding the whole body with higher frequencies here
    //    turns tall towers into vertical flutes, so medium billows are applied only at edges.
    // G: medium Worley FBM used for edge billows. Both are equalised on the CPU.
    float g = w2 * 0.625 + w3 * 0.25 + w4 * 0.125;
    outColor = vec4(perlinWorley, g, w3 * 0.625 + w4 * 0.25 + w5 * 0.125, w4 * 0.75 + w5 * 0.25);
  } else {
    float w1 = worleyInv(p, 2.0, 21u);
    float w2 = worleyInv(p, 4.0, 22u);
    float w3 = worleyInv(p, 8.0, 23u);
    float w4 = worleyInv(p, 16.0, 24u);
    outColor = vec4(w1 * 0.625 + w2 * 0.25 + w3 * 0.125,
                    w2 * 0.625 + w3 * 0.25 + w4 * 0.125,
                    w3 * 0.75 + w4 * 0.25,
                    1.0);
  }
}
