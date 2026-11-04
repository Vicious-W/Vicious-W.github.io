// Transmittance from a point (r, mu) to the top of the atmosphere (Bruneton parameterisation).

out vec4 outColor;

void main() {
  vec2 unit = vec2(texelToUnit(vUv.x, TRANSMITTANCE_SIZE.x), texelToUnit(vUv.y, TRANSMITTANCE_SIZE.y));
  unit = clamp(unit, 0.0, 1.0);
  float H = sqrt(RT * RT - RG * RG);
  float rho = H * unit.y;
  float r = sqrt(rho * rho + RG * RG);
  float dMin = RT - r;
  float dMax = rho + H;
  float d = dMin + unit.x * (dMax - dMin);
  float mu = d <= 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);

  const int STEPS = 48;
  float dist = distanceToTop(r, mu);
  float dt = dist / float(STEPS);
  vec3 opticalDepth = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) * dt;
    float rr = sqrt(r * r + t * t + 2.0 * r * mu * t);
    opticalDepth += sampleMedium(rr - RG).extinction * dt;
  }
  outColor = vec4(exp(-opticalDepth), 1.0);
}
