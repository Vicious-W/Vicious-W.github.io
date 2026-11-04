// Multiple-scattering contribution (Hillaire 2020, "A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"): x = cos(sun zenith), y = altitude.

uniform sampler2D uTransmittance;
out vec4 outColor;

void main() {
  vec2 unit = clamp(vec2(texelToUnit(vUv.x, MULTISCATTER_SIZE.x), texelToUnit(vUv.y, MULTISCATTER_SIZE.y)), 0.0, 1.0);
  float muS = unit.x * 2.0 - 1.0;
  vec3 sunDir = vec3(safeSqrt(1.0 - muS * muS), muS, 0.0);
  float r = RG + clamp(unit.y, 0.0005, 0.9995) * (RT - RG);
  vec3 pos = vec3(0.0, r, 0.0);

  const int SQRT_DIRS = 8;
  const int STEPS = 20;
  const float ISO_PHASE = 1.0 / (4.0 * PI);
  vec3 lumSum = vec3(0.0);
  vec3 fmsSum = vec3(0.0);

  for (int a = 0; a < SQRT_DIRS; a++) {
    for (int b = 0; b < SQRT_DIRS; b++) {
      float u = (float(a) + 0.5) / float(SQRT_DIRS);
      float v = (float(b) + 0.5) / float(SQRT_DIRS);
      float theta = 2.0 * PI * u;
      float cosPhi = 1.0 - 2.0 * v;
      float sinPhi = safeSqrt(1.0 - cosPhi * cosPhi);
      vec3 dir = vec3(cos(theta) * sinPhi, cosPhi, sin(theta) * sinPhi);

      float mu = dir.y;
      bool ground = rayIntersectsGround(r, mu);
      float tMax = ground ? distanceToBottom(r, mu) : distanceToTop(r, mu);
      float dt = tMax / float(STEPS);
      vec3 T = vec3(1.0);
      vec3 L = vec3(0.0);
      vec3 F = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        float t = (float(i) + 0.3) * dt;
        vec3 P = pos + dir * t;
        float rr = length(P);
        Medium m = sampleMedium(rr - RG);
        float muSp = dot(P / rr, sunDir);
        vec3 tSun = transmittanceToSun(uTransmittance, rr, muSp);
        vec3 scat = m.scatRay + vec3(m.scatMie);
        vec3 stepT = exp(-m.extinction * dt);
        vec3 ext = max(m.extinction, vec3(1e-7));
        vec3 S = tSun * scat * ISO_PHASE;
        L += T * (S - S * stepT) / ext;
        F += T * (scat - scat * stepT) / ext;
        T *= stepT;
      }
      if (ground) {
        vec3 P = pos + dir * tMax;
        vec3 n = normalize(P);
        float muSg = dot(n, sunDir);
        L += T * transmittanceToSun(uTransmittance, RG, muSg) * max(muSg, 0.0) * GROUND_ALBEDO / PI;
      }
      lumSum += L;
      fmsSum += F;
    }
  }
  float invCount = 1.0 / float(SQRT_DIRS * SQRT_DIRS);
  vec3 L2 = lumSum * invCount;
  vec3 fms = fmsSum * invCount;
  outColor = vec4(L2 / max(vec3(1.0) - fms, vec3(1e-4)), 1.0);
}
