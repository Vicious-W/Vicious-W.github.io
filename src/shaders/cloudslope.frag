// Second pass over the cloud placement map: stores the slope of the envelope height in alpha.
// The cloud shader divides the height above a sample by sqrt(1 + slope^2) to get roughly the
// distance to the surface along its normal, so noise displaces the sides of a cloud sideways,
// just as it displaces the top upwards; otherwise the sides would be smooth vertical walls.

uniform sampler2D uMap;
out vec4 outColor;

void main() {
  ivec2 size = textureSize(uMap, 0);
  ivec2 c = ivec2(gl_FragCoord.xy);
  // The map tiles, so neighbours wrap around.
  float ex1 = texelFetch(uMap, ivec2((c.x + 1) % size.x, c.y), 0).r;
  float ex0 = texelFetch(uMap, ivec2((c.x + size.x - 1) % size.x, c.y), 0).r;
  float ez1 = texelFetch(uMap, ivec2(c.x, (c.y + 1) % size.y), 0).r;
  float ez0 = texelFetch(uMap, ivec2(c.x, (c.y + size.y - 1) % size.y), 0).r;
  vec2 grad = vec2(ex1 - ex0, ez1 - ez0) / (2.0 * TEXEL_METRES);
  vec4 m = texelFetch(uMap, c, 0);
  outColor = vec4(m.rgb, min(length(grad), 12.0));
}
