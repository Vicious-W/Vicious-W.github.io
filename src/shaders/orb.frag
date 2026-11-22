// The orb (night/moments.js): a ball of light a metre and a half across that keeps pace with the
// aircraft for a while under the second storm. Drawn over the finished image of the outside:
// rgb = its light (exposed), a = 1 (it only adds light). What it shows: the ball itself (light
// from all through it, white-hot at its heart, stirring), the glow it makes in the rain and haze
// around it, the glare it leaves in the eye, and the light it casts on cloud close to it (the
// clouds' depth says where their surface is). In cloud the ball is hidden: only its light
// comes out, spread through the cloud.

uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform vec2 uTanHalf;
uniform vec2 uResolution;
uniform float uExposure;
uniform float uTime;
uniform vec4 uOrb;            // centre relative to the camera (world axes, m); w: radius (m)
uniform vec3 uOrbLight;       // intensity (rgb, scene units per steradian)
uniform float uOrbInside;     // how deep in cloud it is (m)
uniform float uHaze;          // rain in the air around it, 0..1
uniform sampler2D uSceneDepth; // the clouds' depth (r, km; -1 open sky), g: how much of the pixel is cloud
uniform sampler3D uDetailNoise;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec3 dir = cameraRay(uv, uCamRight, uCamUp, uCamForward, uTanHalf);
  vec3 c = uOrb.xyz;
  float R = uOrb.w;
  float dc = length(c);
  float tc = dot(c, dir);
  float b = sqrt(max(dc * dc - tc * tc, 0.0)); // how far the ray passes from its centre
  float I = max(uOrbLight.r, max(uOrbLight.g, uOrbLight.b));
  vec2 cloud = texture(uSceneDepth, uv).rg;
  float surface = cloud.r * 1000.0; // where the clouds' light comes from along the ray (m)

  // In cloud the ball itself is hidden; clouds in front of it hide it too.
  float hidden = 1.0 - exp(-uOrbInside / 10.0);
  float front = cloud.r > 0.0 && surface < dc - R ? cloud.g : 0.0;
  float seen = (1.0 - hidden) * (1.0 - front);

  vec3 L = vec3(0.0);
  vec3 tint = uOrbLight / max(I, 1e-6); // its colour
  if (I > 0.0 && tc > 0.0) {
    // The ball: light from all through it (more where the ray crosses more of it, its rim soft,
    // a glow rather than a surface), white-hot at its heart; its light stirs and turns. (Seen
    // far dimmer than the light it casts would make it: a plain disc of white otherwise.)
    float x = b / R;
    float chord = sqrt(max(1.0 - x * x, 0.0));
    vec3 q = (dir * tc - c) / R;
    float a = uTime * 0.9;
    q.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * q.xz;
    float stir = 0.6 * texture(uDetailNoise, q * 0.31 + vec3(0.0, uTime * 0.17, 0.0)).r
               + 0.4 * texture(uDetailNoise, q.zxy * 0.73 - vec3(uTime * 0.23, 0.0, 0.0)).r;
    float body = smoothstep(1.12, 0.75, x) * (0.25 + 0.75 * chord) * (0.3 + 1.6 * stir * stir);
    float heart = exp(-x * x / 0.06);
    float corona = x > 1.0 ? exp(-(x - 1.0) / 0.3) * 0.12 : 0.12;
    vec3 ball = I / (PI * R * R) * (0.016 * (body + corona) * tint + 0.15 * heart * mix(tint, vec3(1.0), 0.6));
    L += ball * seen;

    // The glare it leaves in the eye: a halo that falls off with the angle from it (the eye's
    // own scatter, strong for a bright light in the dark).
    float theta = max(b / tc, 0.5 * R / dc); // rad
    float e = I / (dc * dc); // its light at the eye
    L += tint * e * (2.0e-4 / (theta * theta + 1.0e-4) + 0.01 * exp(-theta / 0.06)) * seen;
  }

  // Its light in the rain and haze along the ray (a point source seen through scattering air:
  // the light scattered towards the eye from all along the ray, up to the clouds).
  if (I > 0.0) {
    float sigma = 2.0e-4 + 2.0e-3 * uHaze;
    float bb = max(b, R);
    float far = cloud.r > 0.0 ? surface : 1e5;
    float span = atan((far - tc) / bb) + atan(tc / bb);
    L += uOrbLight * (sigma / (4.0 * PI) * span / bb) * (1.0 - hidden);
  }

  // The cloud it lights: the cloud's surface along this ray, by its distance from the ball. In
  // cloud its light comes out spread over the surface around it, a glow in the dark of it.
  if (cloud.r > 0.0 && I > 0.0) {
    vec3 p = dir * surface;
    vec3 l = c - p;
    // (Cloud loses almost none of it: what goes in comes out, mostly near it, about half of it
    // from the side it is nearest; and it is brighter than it looks, as said above.)
    float soft = 30.0 + 0.8 * uOrbInside;
    L += uOrbLight * cloud.g * 3.5 * exp(-uOrbInside / 250.0) / (dot(l, l) + R * R + soft * soft);
  }

  outColor = vec4(L * uExposure, 1.0);
}
