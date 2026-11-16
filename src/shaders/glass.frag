// The finished frame of the night journey: the outside seen through the cockpit's glass, what
// the glass and the air just outside it add, the cockpit over it, then tone mapping.
//
// - Rain and hail rush past the canopy. Unlit they are unseen; lightning and the aircraft's own
//   lights catch them as streaks radiating from the point ahead they all come from.
// - Water runs back over the glass in rivulets from the nose: it bends the view behind it, and
//   its rims catch the light.
// - In cloud, the red beacons and the wing-tip lights glow in the cloud all around.
// - Hail splashes on the glass; the instruments are mirrored faintly in it; St. Elmo's fire
//   leaves a violet corona where its discharges cling.
// Cabin frame: the eye near the origin, -z ahead, +y up (m). The outside arrives exposed; light
// added here is in scene units and exposed with uExposure. The cockpit layer holds
// premultiplied scene light and coverage.

uniform sampler2D uOutside;
uniform sampler2D uCockpit;
uniform sampler2D uAtlas;     // the instruments' face
uniform vec3 uHeadRight;      // the head, in the cabin frame
uniform vec3 uHeadUp;
uniform vec3 uHeadForward;
uniform vec2 uTanHalf;
uniform vec3 uEye;
uniform float uTime;
uniform float uRain;
uniform float uHail;
uniform float uCloud;         // in cloud, 0..1
uniform float uHaze;          // in the rain and haze of the storm, 0..1
uniform vec3 uWindAxis;       // where the drops go, relative to the cabin
uniform float uWindSpeed;     // how fast (m/s)
uniform vec3 uLight[2];       // lightning at the aircraft: the flash and the flicker
uniform vec3 uBeaconPos[2];
uniform vec3 uBeacon;         // the beacons' intensity now (they flash)
uniform vec3 uNavPos[2];
uniform vec3 uNav[2];
uniform vec3 uFacePos;        // the instruments' face: centre, axes, half size
uniform vec3 uFaceU;
uniform vec3 uFaceV;
uniform vec2 uFaceHalf;
uniform float uFaceGain;
uniform vec3 uShieldPos;      // the glare shield over it
uniform vec3 uShieldU;
uniform vec3 uShieldV;
uniform vec2 uShieldHalf;
uniform vec4 uGlow[GLOWS];    // St. Elmo's fire: where a discharge clings (xyz), how bright (w)
uniform float uExposure;
uniform vec2 uScreen;
uniform float uFrame;
out vec4 outColor;

const float CLOUD_SIGMA = 0.12; // extinction of the storm cloud around the aircraft (1/m)

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 h22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Light falling on a point p just outside the aircraft: lightning (the same over these few
// metres) and the aircraft's own lamps.
vec3 lightAround(vec3 p) {
  vec3 e = uLight[0] + uLight[1];
  for (int i = 0; i < 2; i++) {
    vec3 b = uBeaconPos[i] - p;
    vec3 n = uNavPos[i] - p;
    e += uBeacon / (dot(b, b) + 0.05) + uNav[i] / (dot(n, n) + 0.05);
  }
  return e;
}

// A lamp at b (intensity I) seen through a medium of extinction sigma, along the view ray from
// the glass (s0) on: single scattering along the ray (closed form for a point source), and a
// softer share that many scatterings spread all around a lamp buried in thick cloud.
vec3 lampGlow(vec3 b, vec3 I, vec3 dir, float s0, float sigma) {
  vec3 rel = b - uEye;
  float sc = dot(rel, dir);
  float hd = max(length(rel - dir * sc), 0.2);
  float f = (1.5707963 - atan((s0 - sc) / hd)) / hd;
  float far = length(rel);
  float single = f / (4.0 * PI) * exp(-sigma * (hd + max(sc, s0)));
  float multiple = 0.008 * exp(-0.3 * sigma * far);
  return I * sigma * (single + multiple);
}

// Drops (or hailstones) rushing past, in layers at growing distance from the line along which
// they come. Each one lit is a short streak: the way it covers while the eye takes it in. Far
// away and close to the point they come from they are too small and too many to see one by one.
vec3 streaks(vec3 dir, float tGlass, float amount, bool hail, float sigma) {
  vec3 ax = -uWindAxis;
  vec3 e1 = normalize(cross(ax, abs(ax.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(ax, e1);
  float ca = dot(dir, ax);
  float sa = sqrt(max(1.0 - ca * ca, 1e-6));
  float around = atan(dot(dir, e2), dot(dir, e1)) / (2.0 * PI) + 0.5;
  float pix = 2.0 * uTanHalf.y / uScreen.y;
  float travel = uWindSpeed / 80.0;
  float size = hail ? 0.006 : 0.0015;
  float spacing = hail ? 1.2 : 0.3;
  float lenZ = hail ? 7.0 : 3.0;
  vec3 sum = vec3(0.0);
  for (int k = 0; k < 4; k++) {
    float fk = float(k) + (hail ? 9.0 : 0.0);
    float rho = 1.4 * pow(1.8, float(k));
    float dist = rho / sa;
    if (dist < tGlass + 0.1) continue;
    float cells = max(floor(2.0 * PI * rho / spacing), 3.0);
    float cellAngle = 2.0 * PI * rho / cells / dist;
    float resolved = smoothstep(2.5, 6.0, cellAngle / pix);
    if (resolved <= 0.0) continue;
    float z = ca / sa * rho;
    float zz = (z + uWindSpeed * uTime) / lenZ + fk * 0.37;
    float fx = around * cells;
    vec2 cell = vec2(floor(fx), floor(zz));
    if (h21(cell + vec2(fk * 13.1, 7.7)) > amount) continue;
    vec2 r = h22(cell + vec2(fk * 3.3, 1.9));
    float across = (fract(fx) - 0.2 - 0.6 * r.x) * (2.0 * PI * rho / cells) / dist; // radians
    float along = (fract(zz) - 0.05 - 0.4 * r.y) * lenZ; // metres behind the drop's head
    float w = max(size / dist, 0.6 * pix);
    float cov = exp(-across * across / (w * w)) * min(size / dist / (0.6 * pix), 1.0);
    float on = smoothstep(-0.05, 0.08, along) * (1.0 - smoothstep(travel - 0.3, travel, along));
    if (cov * on < 0.001) continue;
    // A drop's light is spread along its streak: the longer the streak looks, the fainter.
    float sweep = travel * sa / dist;
    float dwell = min(1.0, 3.0 * pix / sweep);
    sum += lightAround(uEye + dir * dist) * (cov * on * resolved * dwell * exp(-sigma * dist));
  }
  return sum * (hail ? 0.6 : 0.25);
}

// Height of the water on the glass (about mm), s: the direction of the point from the bubble's
// centre. Rivulets run back from the nose in columns around it, meandering and thickening into
// drops, faster the further they get; near the nose, where the air barely moves the water,
// small beads come and go.
float water(vec3 s, float t) {
  float sinT = length(s.xy);
  float theta = atan(sinT, -s.z);
  float around = atan(s.y, s.x) / (2.0 * PI) + 0.5;
  float y = theta * 1.2; // metres from the nose over the glass
  float h = 0.0;
  const float M = 72.0;
  float colWidth = 2.0 * PI * 1.1 * max(sinT, 0.05) / M; // metres
  float Y = log(y + 0.1) * 4.0 - t * 2.4;
  for (int k = 0; k < 2; k++) {
    float x = around * M + float(k) * 0.5;
    float cid = mod(floor(x), M) + float(k) * 101.0;
    float seg = floor(Y * 0.6 + h21(vec2(cid, 3.0)) * 7.0);
    if (h21(vec2(cid, seg)) > 0.06 + 0.14 * uRain) continue;
    float c = 0.5 + 0.32 * (vnoise(vec2(cid * 1.7, Y * 1.6)) * 2.0 - 1.0) + 0.06 * (vnoise(vec2(cid * 3.1, Y * 6.0)) * 2.0 - 1.0);
    float w = clamp(0.0025 / colWidth, 0.015, 0.3);
    float q = (fract(x) - c) / w;
    float beads = 0.55 + 0.45 * sin(Y * 9.0 + cid * 2.3);
    h = max(h, sqrt(max(1.0 - q * q, 0.0)) * (0.35 + 0.4 * beads));
  }
  h *= smoothstep(0.12, 0.4, theta);
  if (theta < 0.5) {
    vec2 p = s.xy * (1.1 / 0.007);
    vec2 cell = floor(p);
    float life = floor(t * 1.5 + h21(cell) * 9.0);
    if (h21(cell + life * 7.31) < 0.3 * uRain) {
      vec2 at = 0.3 + 0.4 * h22(cell + life);
      float r = 0.18 + 0.2 * h21(cell + 4.1);
      float qq = length(fract(p) - at) / r;
      h = max(h, sqrt(max(1.0 - qq * qq, 0.0)) * 0.6 * (1.0 - smoothstep(0.3, 0.5, theta)));
    }
  }
  return h;
}

// Hailstones striking the glass: a brief splash of shattered ice each.
float hailImpacts(vec3 s) {
  float sinT = length(s.xy);
  float theta = atan(sinT, -s.z);
  float around = atan(s.y, s.x) / (2.0 * PI) + 0.5;
  vec2 q = vec2(around * 220.0, theta * 1.2 / 0.035);
  float slot = floor(uTime * 30.0);
  vec2 cell = floor(q);
  if (h21(cell + slot * 3.17) > uHail * 0.015 * sinT) return 0.0;
  vec2 at = 0.25 + 0.5 * h22(cell + slot * 1.13);
  float age = fract(uTime * 30.0);
  // A splash: a bright core and a few fragments flung out along the flow.
  vec2 r = fract(q) - at;
  float core = smoothstep(0.14, 0.02, length(r));
  float spray = smoothstep(0.05, 0.0, abs(r.x)) * smoothstep(0.0, 0.05, r.y) * smoothstep(0.45, 0.1, r.y);
  return (core + 0.5 * spray) * (1.0 - age) * (1.0 - age);
}

// The instruments seen in the glass along the reflected ray rd from g, unless the glare shield
// is in the way.
vec3 reflectInstruments(vec3 g, vec3 rd) {
  vec3 sn = cross(uShieldU, uShieldV);
  float ds = dot(uShieldPos - g, sn) / dot(rd, sn);
  if (ds > 0.0) {
    vec3 q = g + rd * ds - uShieldPos;
    if (abs(dot(q, uShieldU)) < uShieldHalf.x && abs(dot(q, uShieldV)) < uShieldHalf.y) return vec3(0.0);
  }
  vec3 fn = cross(uFaceU, uFaceV);
  float dn = dot(rd, fn);
  if (dn >= 0.0) return vec3(0.0); // only the face's lit side
  float df = dot(uFacePos - g, fn) / dn;
  if (df <= 0.0) return vec3(0.0);
  vec3 q = g + rd * df - uFacePos;
  vec2 uv = vec2(dot(q, uFaceU), dot(q, uFaceV)) / uFaceHalf;
  if (abs(uv.x) > 1.0 || abs(uv.y) > 1.0) return vec3(0.0);
  return textureLod(uAtlas, uv * 0.5 + 0.5, 2.0).rgb * uFaceGain;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uHeadForward + ndc.x * uTanHalf.x * uHeadRight + ndc.y * uTanHalf.y * uHeadUp);
  // Where the ray leaves the bubble.
  vec3 o = (uEye - BUBBLE_C) / BUBBLE_R;
  vec3 d = dir / BUBBLE_R;
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - 1.0;
  float tGlass = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  vec3 g = uEye + dir * tGlass;
  vec3 s = normalize((g - BUBBLE_C) / BUBBLE_R);
  vec3 n = normalize((g - BUBBLE_C) / (BUBBLE_R * BUBBLE_R));
  float pix = 2.0 * uTanHalf.y / uScreen.y;

  // Water: worked out everywhere, as its slope comes from neighbouring pixels.
  float hw = uRain > 0.0 ? water(s, uTime) : 0.0;
  vec2 slope = vec2(dFdx(hw), dFdy(hw)) * 1e-3 / max(tGlass * pix, 1e-5);

  vec3 col = texture(uOutside, vUv).rgb;
  if (g.z < BACK_Z) {
    float steep = length(slope);
    if (hw > 0.0) {
      // Each run of water is a small lens: the view behind it is shifted, and its steep rims
      // reflect the dark cabin rather than let the outside through.
      vec2 shift = 0.15 * slope / (2.0 * uTanHalf);
      col = texture(uOutside, vUv - shift).rgb * (1.0 - 0.3 * smoothstep(0.5, 1.6, steep));
    }
    float cosI = abs(dot(dir, n));
    float F = 0.04 + 0.96 * pow(1.0 - cosI, 5.0);
    col *= (1.0 - F) * 0.97;

    vec3 add = vec3(0.0);
    // The aircraft's lamps light the cloud and the rain around it.
    float sigma = CLOUD_SIGMA * uCloud + 0.003 * uRain * uHaze;
    if (sigma > 0.0) {
      for (int i = 0; i < 2; i++) {
        add += lampGlow(uBeaconPos[i], uBeacon, dir, tGlass, sigma);
        add += lampGlow(uNavPos[i], uNav[i], dir, tGlass, sigma);
      }
    }
    // Rain and hail rushing past.
    if (uRain > 0.0) add += streaks(dir, tGlass, 0.18 * uRain, false, sigma);
    if (uHail > 0.0) add += streaks(dir, tGlass, 0.04 * uHail, true, sigma);
    // Water on the glass catches the light at its rims; hail splashes on it.
    vec3 around = lightAround(g);
    if (hw > 0.0) add += around * 0.03 * smoothstep(0.3, 1.2, steep);
    if (uHail > 0.0) add += (around + 0.002) * 0.04 * hailImpacts(s);
    // Lightning makes the wet, scratched glass glow faintly.
    add += (uLight[0] + uLight[1]) * 0.0012 * (0.4 + uRain);
    // St. Elmo's fire: a violet corona where the discharges cling.
    float elmo = 0.0;
    for (int i = 0; i < GLOWS; i++) {
      vec4 gl = uGlow[i];
      if (gl.w <= 0.0) continue;
      float dd = length(g - gl.xyz);
      elmo += gl.w * (exp(-dd / 0.02) * 0.02 + exp(-dd / 0.15) * 0.002);
    }
    add += vec3(0.45, 0.45, 1.0) * elmo;
    // The instruments, mirrored in the glass.
    add += F * reflectInstruments(g, reflect(dir, n));
    col += add * uExposure;
  }

  // The cockpit on top.
  vec4 ck = texture(uCockpit, vUv);
  col = col * (1.0 - clamp(ck.a, 0.0, 1.0)) + ck.rgb * uExposure;
  col = linearToSrgb(agx(col));
  float dither = (h21(gl_FragCoord.xy + mod(uFrame, 16.0) * 7.31) + h21(gl_FragCoord.yx * 1.37 + 3.1) - 1.0) / 255.0;
  outColor = vec4(col + dither, 1.0);
}
