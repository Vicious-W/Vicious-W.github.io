// Sky in-scattering seen from the camera altitude, as a latitude/longitude LUT around the sun.

uniform sampler2D uTransmittance;
uniform sampler2D uMultiScatter;
uniform float uCamR;
uniform vec3 uSunDir;
uniform vec3 uSunIlluminance;
out vec4 outColor;

void main() {
  vec2 unit = clamp(vec2(texelToUnit(vUv.x, SKYVIEW_SIZE.x), texelToUnit(vUv.y, SKYVIEW_SIZE.y)), 0.0, 1.0);
  float r = uCamR;
  float vHorizon = safeSqrt(r * r - RG * RG);
  float beta = acos(clamp(vHorizon / r, -1.0, 1.0));
  float zenithHorizonAngle = PI - beta;

  float viewZenithCos;
  if (unit.y < 0.5) {
    float coord = 1.0 - 2.0 * unit.y;
    coord = 1.0 - coord * coord;
    viewZenithCos = cos(zenithHorizonAngle * coord);
  } else {
    float coord = unit.y * 2.0 - 1.0;
    viewZenithCos = cos(zenithHorizonAngle + beta * coord * coord);
  }
  float lightViewCos = -(unit.x * unit.x * 2.0 - 1.0);
  float sinZ = safeSqrt(1.0 - viewZenithCos * viewZenithCos);

  // Local frame: y up, sun azimuth along +x.
  float muS = uSunDir.y;
  vec3 sunDir = vec3(safeSqrt(1.0 - muS * muS), muS, 0.0);
  vec3 dir = vec3(sinZ * lightViewCos, viewZenithCos, sinZ * safeSqrt(1.0 - lightViewCos * lightViewCos));

  bool ground = rayIntersectsGround(r, dir.y);
  float tMax = ground ? distanceToBottom(r, dir.y) : distanceToTop(r, dir.y);
  vec3 T;
  vec3 L = integrateScattering(uTransmittance, uMultiScatter, vec3(0.0, r, 0.0), dir, sunDir,
                               uSunIlluminance, tMax, 40, T);
  outColor = vec4(L, 1.0);
}
