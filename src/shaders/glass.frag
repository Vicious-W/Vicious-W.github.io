// The view through the cockpit glass. The outside (the finished image) is refracted by
// raindrops that the airflow drives back over the bubble from the point straight ahead; hail
// strikes it; St. Elmo's fire crawls along the frame and across the glass; the instrument glow
// reflects faintly in it. Then the cockpit itself goes on top (linear light, tone-mapped here
// the same way as the outside).
// Bubble, frame planes: defines from cockpit.js. Aircraft frame: -z ahead, +y up.

uniform sampler2D uOutside;  // display-referred image of the outside
uniform sampler2D uCockpit;  // cockpit layer: linear radiance and coverage
uniform vec3 uHeadRight;     // head basis in the aircraft frame
uniform vec3 uHeadUp;
uniform vec3 uHeadForward;
uniform vec2 uTanHalf;
uniform vec3 uEye;
uniform float uTime;
uniform float uRain;
uniform float uHail;
uniform float uElmo;
uniform float uFlash;        // brightness of the current flash at the aircraft
uniform float uPanelGlow;
uniform float uExposure;
uniform vec2 uScreen;
out vec4 outColor;

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

// Drops on a grid of cells over p (cell units): the highest drop over p as (slope.xy, height).
// stretch < 1 draws them out along y, the direction they run.
// Distance to the nearest edge of a cellular pattern with drifting points: the edges form
// connected, branching lines, like the filaments of an electric discharge.
float cellEdge(vec2 p, float t) {
  vec2 cell = floor(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      vec2 o = h22(c);
      o = 0.5 + 0.42 * sin(t * (1.5 + 3.0 * o) + 6.2831 * o);
      vec2 r = c + o - p;
      float d = dot(r, r);
      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  return sqrt(d2) - sqrt(d1);
}

vec3 drops(vec2 p, float density, float stretch) {
  vec2 cell = floor(p);
  vec3 best = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(float(i), float(j));
      if (h21(c + 17.0) > density) continue;
      vec2 centre = c + 0.2 + 0.6 * h22(c);
      float radius = 0.14 + 0.3 * h21(c + 5.0);
      vec2 d = (p - centre) * vec2(1.0, stretch);
      float q = dot(d, d) / (radius * radius);
      if (q < 1.0) {
        float hgt = sqrt(1.0 - q);
        if (hgt > best.z) best = vec3(d / (radius * max(hgt, 0.2)), hgt);
      }
    }
  }
  return best;
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
  float t = (-b + sqrt(max(b * b - a * c, 0.0))) / a;
  vec3 g = uEye + dir * t;

  vec3 col = texture(uOutside, vUv).rgb;
  if (g.z < BACK_Z) {
    vec3 s = normalize(g - BUBBLE_C);
    vec3 n = normalize((g - BUBBLE_C) / (BUBBLE_R * BUBBLE_R));
    float theta = acos(clamp(-s.z, -1.0, 1.0)); // angle from straight ahead
    float phi = atan(s.y, s.x);
    float sinT = max(sin(theta), 0.05);
    // Surface coordinates in metres: around the nose, and back along the flow.
    vec2 surf = vec2(phi * sinT, theta) * 1.2;

    // Rain: small beads that cling, and drops that the airflow drives back over the glass,
    // faster towards the sides.
    vec3 drop = vec3(0.0);
    if (uRain > 0.0) {
      vec3 bead = drops(surf / 0.016, 0.55 * uRain, 1.0);
      float speed = 0.35 + 0.9 * sinT;
      vec2 run = vec2(surf.x / 0.04, (surf.y - uTime * speed) / 0.12);
      vec3 runner = drops(run, 0.45 * uRain, 0.45);
      drop = runner.z > bead.z ? runner : bead;
    }
    if (drop.z > 0.0) {
      // Each drop is a small lens: it shows the scene behind displaced (and dims at its rim).
      vec2 shift = drop.xy * 0.025 * vec2(uScreen.y / uScreen.x, 1.0);
      vec3 seen = texture(uOutside, vUv - shift).rgb;
      float rim = smoothstep(0.0, 0.35, drop.z);
      vec3 dcol = seen * (0.8 + 0.2 * rim);
      // Glints: a flash or the instrument glow catching the drop.
      dcol += vec3(0.8, 0.86, 1.0) * min(uFlash, 2.0) * 0.3 * pow(drop.z, 6.0);
      dcol += vec3(0.5, 0.3, 0.12) * 0.03 * uPanelGlow * pow(drop.z, 6.0) * smoothstep(0.0, -0.6, dir.y);
      col = mix(col, dcol, smoothstep(0.0, 0.08, drop.z));
    }

    // Hail: brief white strikes, seen mostly when a flash lights them.
    if (uHail > 0.0) {
      float slot = floor(uTime * 12.0);
      vec2 hp = surf / 0.05;
      vec2 hc = floor(hp);
      float hh = h21(hc + slot * 7.13);
      if (hh < uHail * 0.12) {
        vec2 at = hc + 0.2 + 0.6 * h22(hc + slot);
        float rs = length(hp - at) * 0.05; // metres
        float age = fract(uTime * 12.0);
        float fleck = smoothstep(0.009, 0.002, rs) * (1.0 - age) * (1.0 - age);
        col += vec3(0.85, 0.9, 1.0) * fleck * (0.12 + 0.5 * min(uFlash, 1.5));
      }
    }

    // St. Elmo's fire: fine branching filaments that grow out from the frame members across the
    // glass, crackling, over a faint violet halo along the frame.
    if (uElmo > 0.0) {
      float dF = abs(g.z - FRONT_HOOP_Z);
      float dR = abs(g.z - REAR_HOOP_Z);
      float dB = g.y > BUBBLE_C.y + 0.3 ? abs(g.x) : 1.0;
      float dBase = abs(g.y - BASE_Y);
      float dist = min(min(dF, dR), min(dB, dBase));
      float halo = exp(-dist / 0.012) * (0.5 + 0.5 * vnoise(vec2(phi * 10.0 + theta * 6.0, uTime * 20.0)));
      // How far the discharge reaches out varies along the frame and over time.
      float reach = 0.03 + 0.2 * pow(vnoise(vec2(phi * 3.0 + theta * 4.0, uTime * 1.3)), 2.0);
      float tick = floor(uTime * 24.0);
      float e1 = cellEdge(surf * 34.0, uTime * 3.0 + tick * 0.37);
      float e2 = cellEdge(surf * 85.0 + 7.0, uTime * 5.0 + tick * 0.61);
      float threads = exp(-e1 / 0.025) + 0.5 * exp(-e2 / 0.04);
      float alive = step(0.6, h21(floor(surf * 12.0) + tick));
      float filaments = threads * alive * exp(-dist / reach);
      float glow = (0.18 * halo + 0.8 * filaments) * uElmo;
      col += vec3(0.42, 0.5, 1.0) * glow + vec3(0.9, 0.92, 1.0) * glow * glow * 0.25;
    }

    // Faint reflections of the instrument glow in the lower glass.
    float cosI = abs(dot(dir, n));
    float F = 0.04 + 0.96 * pow(1.0 - cosI, 5.0);
    vec3 r = reflect(dir, n);
    float towardsPanel = smoothstep(-0.1, -0.6, r.y) * smoothstep(0.2, -0.4, r.z);
    col += vec3(0.55, 0.32, 0.12) * 0.05 * uPanelGlow * F * towardsPanel;
    col *= 0.95;
  }

  // The cockpit on top.
  vec4 ck = texture(uCockpit, vUv);
  vec3 ckCol = linearToSrgb(agx(ck.rgb * uExposure));
  col = mix(col, ckCol, clamp(ck.a, 0.0, 1.0));
  outColor = vec4(col, 1.0);
}
