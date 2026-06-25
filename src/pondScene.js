import * as THREE from "three";

const vertexShader = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform sampler2D uRipple;
  uniform vec2 uRippleTexel;
  uniform vec2 uPointer;
  uniform float uPointerActive;
  uniform float uReduceMotion;

  varying vec2 vUv;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 74.7);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rotate = mat2(0.82, -0.57, 0.57, 0.82);
    for (int i = 0; i < 6; i++) {
      value += noise(p) * amplitude;
      p = rotate * p * 2.04 + vec2(19.4, -7.3);
      amplitude *= 0.5;
    }
    return value;
  }

  float cloudCore(vec2 p, float time) {
    vec2 wind = vec2(time * 0.018, time * 0.004);
    vec2 warp = vec2(
      fbm(p * 0.72 + wind),
      fbm(p * 0.65 - wind * 0.6 + vec2(8.0, -5.0))
    ) - 0.5;
    float tower = fbm(p * 0.42 + warp * 1.8 + wind * 0.55);
    float billow = fbm(p * 1.22 + warp * 1.15 - wind * 0.22);
    float erosion = fbm(p * 4.4 + wind * 0.1);
    float density = tower * 0.83 + billow * 0.44 - erosion * 0.22;
    return smoothstep(0.47, 0.69, density);
  }

  vec3 skyColor(vec2 uv, float time) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.43) * 3.15;

    float cloud = cloudCore(p, time);
    float lit = cloudCore(p + vec2(-0.08, 0.12), time);
    float shade = clamp((cloud - lit) * 3.1 + cloud * (0.12 + uv.y * 0.2), 0.0, 0.55);
    float rim = smoothstep(0.02, 0.45, cloud) * (1.0 - smoothstep(0.55, 0.9, cloud));

    vec3 horizon = vec3(0.64, 0.84, 0.97);
    vec3 zenith = vec3(0.06, 0.39, 0.78);
    vec3 blue = mix(horizon, zenith, smoothstep(0.0, 1.0, uv.y));
    blue += vec3(0.06, 0.08, 0.09) * (1.0 - uv.y);

    vec3 cloudLight = vec3(1.0, 0.99, 0.94);
    vec3 cloudMiddle = vec3(0.78, 0.84, 0.88);
    vec3 cloudShade = vec3(0.47, 0.56, 0.64);
    vec3 cloudColor = mix(cloudLight, cloudMiddle, shade * 0.62);
    cloudColor = mix(cloudColor, cloudShade, smoothstep(0.35, 0.82, shade));
    cloudColor += rim * vec3(0.1, 0.1, 0.08);

    return mix(blue, cloudColor, cloud * 0.98);
  }

  vec2 rippleGradient(vec2 uv) {
    float left = texture2D(uRipple, uv - vec2(uRippleTexel.x, 0.0)).r * 2.0 - 1.0;
    float right = texture2D(uRipple, uv + vec2(uRippleTexel.x, 0.0)).r * 2.0 - 1.0;
    float down = texture2D(uRipple, uv - vec2(0.0, uRippleTexel.y)).r * 2.0 - 1.0;
    float up = texture2D(uRipple, uv + vec2(0.0, uRippleTexel.y)).r * 2.0 - 1.0;
    return vec2(right - left, up - down);
  }

  vec2 windWave(vec2 uv, float time) {
    vec2 g = vec2(0.0);
    vec2 d1 = normalize(vec2(1.0, 0.22));
    vec2 d2 = normalize(vec2(-0.34, 1.0));
    vec2 d3 = normalize(vec2(0.78, -0.62));
    vec2 d4 = normalize(vec2(-0.92, -0.39));
    g += d1 * cos(dot(uv, d1) * 34.0 + time * 0.46) * 0.010;
    g += d2 * cos(dot(uv, d2) * 64.0 + time * 0.31) * 0.006;
    g += d3 * cos(dot(uv, d3) * 124.0 + time * 0.76) * 0.0036;
    g += d4 * cos(dot(uv, d4) * 220.0 + time * 1.08) * 0.0018;
    vec2 small = vec2(
      fbm(uv * vec2(24.0, 11.0) + vec2(time * 0.08, 3.0)),
      fbm(uv * vec2(17.0, 21.0) - vec2(2.0, time * 0.07))
    ) - 0.5;
    return g + small * 0.008;
  }

  vec2 fishEvade(vec2 center, vec2 pointer, float activeAmount, float radius, float amount) {
    vec2 diff = center - pointer;
    diff.x *= uResolution.x / max(uResolution.y, 1.0);
    float d = length(diff);
    vec2 away = normalize(diff + vec2(0.001, 0.0007));
    away.x /= uResolution.x / max(uResolution.y, 1.0);
    float force = smoothstep(radius, 0.0, d) * activeAmount;
    return center + away * force * amount;
  }

  float ellipseShape(vec2 p, vec2 radius) {
    float d = dot(p / radius, p / radius);
    return 1.0 - smoothstep(0.78, 1.05, d);
  }

  float leafShape(vec2 p, vec2 radius, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    vec2 q = mat2(c, -s, s, c) * p;
    float leaf = ellipseShape(q, radius);
    float crease = 1.0 - smoothstep(0.004, 0.014, abs(q.x));
    return leaf * (0.74 + crease * 0.26);
  }

  vec3 blendLayer(vec3 base, vec3 layerColor, float mask) {
    return mix(base, layerColor, clamp(mask, 0.0, 1.0));
  }

  vec2 plantDrift(vec2 p, float phase, float time) {
    vec2 drift = vec2(
      sin(time * 0.55 + phase + p.y * 4.0),
      cos(time * 0.42 + phase * 1.3 + p.x * 3.0)
    );
    return p + drift * 0.0035;
  }

  float stemPlant(vec2 p, vec2 center, float scale, float phase, float time) {
    vec2 q = plantDrift((p - center) / scale, phase, time);
    q.x += sin(q.y * 5.2 + phase + time * 0.7) * 0.08;
    float stem = (1.0 - smoothstep(0.018, 0.04, abs(q.x))) *
      smoothstep(-1.05, -0.78, q.y) * (1.0 - smoothstep(0.9, 1.08, q.y));
    float leaves = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float y = -0.7 + fi * 0.28;
      float side = mod(fi, 2.0) * 2.0 - 1.0;
      vec2 node = vec2(side * (0.1 + fi * 0.018), y);
      float angle = side * (0.7 + fi * 0.06) + sin(time * 0.6 + phase + fi) * 0.08;
      leaves += leafShape(q - node, vec2(0.048, 0.13), angle);
      leaves += leafShape(q - vec2(-node.x * 0.68, y + 0.06), vec2(0.036, 0.095), -angle * 0.85);
    }
    return clamp(stem * 0.42 + leaves, 0.0, 1.0);
  }

  float featherPlant(vec2 p, vec2 center, float scale, float phase, float time) {
    vec2 q = plantDrift((p - center) / scale, phase, time);
    q.x += sin(q.y * 3.8 + phase + time * 0.5) * 0.06;
    float axis = (1.0 - smoothstep(0.012, 0.032, abs(q.x))) *
      smoothstep(-1.0, -0.74, q.y) * (1.0 - smoothstep(0.92, 1.05, q.y));
    float needles = 0.0;
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      float y = -0.78 + fi * 0.23;
      float fan = 0.16 * (1.0 - abs(fi - 3.5) / 5.2);
      needles += leafShape(q - vec2(fan, y), vec2(0.014, 0.115), -0.72);
      needles += leafShape(q - vec2(-fan, y + 0.015), vec2(0.014, 0.115), 0.72);
    }
    return clamp(axis * 0.35 + needles, 0.0, 1.0);
  }

  float floatingCluster(vec2 p, vec2 center, float scale, float phase) {
    vec2 q = (p - center) / scale;
    float pads = 0.0;
    for (int i = 0; i < 7; i++) {
      float fi = float(i);
      float a = fi * 2.399 + phase;
      float r = 0.12 + 0.13 * hash(vec2(fi, phase));
      vec2 c = vec2(cos(a), sin(a)) * r;
      pads += ellipseShape(q - c, vec2(0.11, 0.095));
    }
    pads += ellipseShape(q, vec2(0.13, 0.11));
    return clamp(pads, 0.0, 1.0);
  }

  float bigPad(vec2 p, vec2 center, float scale, float phase) {
    vec2 q = (p - center) / scale;
    float pad = ellipseShape(q, vec2(0.34, 0.28));
    float notch = 1.0 - ellipseShape(q - vec2(0.24, 0.03), vec2(0.16, 0.1));
    float vein = 1.0 - smoothstep(0.01, 0.04, abs(atan(q.y, q.x) - phase));
    return pad * notch * (0.85 + vein * 0.15);
  }

  float tinyBloom(vec2 p, vec2 center, float scale, float phase) {
    vec2 q = (p - center) / scale;
    float flower = 0.0;
    for (int i = 0; i < 5; i++) {
      float a = float(i) * 1.256 + phase;
      flower += ellipseShape(q - vec2(cos(a), sin(a)) * 0.12, vec2(0.055, 0.035));
    }
    return clamp(flower, 0.0, 1.0);
  }

  float microLeafField(vec2 p, float time) {
    float field = 0.0;
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 grid = vec2(12.0 + fi * 4.0, 9.0 + fi * 3.0);
      vec2 g = p * grid + vec2(fi * 7.1, fi * 3.3);
      vec2 cell = floor(g);
      vec2 f = fract(g);
      float r = hash(cell + fi);
      vec2 c = vec2(hash(cell + vec2(2.0, fi)), hash(cell + vec2(fi, 5.0))) * 0.62 + 0.19;
      float angle = r * 6.283 + sin(time * 0.25 + r * 4.0) * 0.12;
      float leaf = leafShape(f - c, vec2(0.045, 0.105), angle);
      leaf += leafShape(f - c - vec2(0.08, -0.045), vec2(0.034, 0.08), angle + 1.1);
      field += leaf * smoothstep(0.18, 0.92, r);
    }
    return clamp(field, 0.0, 1.0);
  }

  vec4 fishRender(vec2 p, vec2 center, float scale, float direction, float time, float phase, vec3 bodyColor) {
    center = fishEvade(center, uPointer, uPointerActive, 0.24, scale * 3.0);

    vec2 local = p - center;
    local.x *= direction;
    float swim = sin(time * 6.5 + phase);
    local.y += sin(time * 4.2 + phase + local.x * 16.0) * 0.004;

    vec2 q = local / scale;
    float bodyMetric = (q.x * q.x) / (1.08 * 1.08) + (q.y * q.y) / (0.34 * 0.34);
    float body = 1.0 - smoothstep(0.82, 1.02, bodyMetric);
    float belly = smoothstep(-0.22, 0.18, -q.y) * body;

    vec2 tailQ = q - vec2(-1.03 + swim * 0.08, 0.0);
    float tail = 1.0 - smoothstep(0.24, 0.4, abs(tailQ.x) + abs(tailQ.y) * 1.25);
    tail *= smoothstep(-0.28, -0.75, q.x);

    float stripe = (1.0 - smoothstep(0.012, 0.045, abs(q.y + 0.015 + sin(q.x * 6.0 + phase) * 0.012))) * body;
    float gill = (1.0 - smoothstep(0.03, 0.075, abs(q.x - 0.48))) * body * smoothstep(0.22, -0.12, abs(q.y));
    float eye = 1.0 - smoothstep(0.036, 0.07, length((q - vec2(0.86, 0.08)) * vec2(1.0, 1.2)));

    float alpha = clamp(max(body, tail * 0.82), 0.0, 1.0);
    vec3 color = mix(bodyColor * 0.62, bodyColor * 1.22, smoothstep(-0.28, 0.22, q.y));
    color = mix(color, vec3(0.88, 0.72, 0.42), belly * 0.32);
    color = mix(color, vec3(0.06, 0.09, 0.055), stripe * 0.28 + gill * 0.22);
    color = mix(color, bodyColor * 0.45, tail * 0.36);
    color = mix(color, vec3(0.015, 0.014, 0.01), eye);
    return vec4(color, alpha);
  }

  vec3 underwater(vec2 uv, vec2 refractUv, float time) {
    vec2 p = refractUv;
    float depth = smoothstep(0.0, 1.0, uv.y);
    float murk = fbm(p * vec2(4.0, 3.0) + vec2(time * 0.012, -time * 0.006));
    vec3 color = mix(vec3(0.25, 0.42, 0.16), vec3(0.05, 0.2, 0.14), depth * 0.72);
    color += (murk - 0.5) * vec3(0.06, 0.08, 0.025);

    float carpet = fbm(p * vec2(12.0, 9.0) + vec2(0.0, time * 0.01));
    float carpetMask = smoothstep(0.28, 0.68, carpet);
    color = blendLayer(color, vec3(0.34, 0.62, 0.13), carpetMask * 0.48);
    float microLeaves = microLeafField(p + vec2(sin(time * 0.15) * 0.006, 0.0), time);
    color = blendLayer(color, vec3(0.5, 0.78, 0.16), microLeaves * 0.42);

    float stems = 0.0;
    float feathers = 0.0;
    for (int i = 0; i < 22; i++) {
      float fi = float(i);
      vec2 c = vec2(fract(fi * 0.381 + hash(vec2(fi, 1.0)) * 0.22), fract(fi * 0.217 + hash(vec2(fi, 4.0)) * 0.18));
      float scale = 0.062 + hash(vec2(fi, 8.0)) * 0.06;
      stems += stemPlant(p, c, scale, fi * 1.7, time);
      if (i < 12) {
        vec2 fc = vec2(fract(fi * 0.271 + 0.13), fract(fi * 0.367 + 0.08));
        feathers += featherPlant(p, fc, scale * 1.15, fi * 2.2, time);
      }
    }
    stems = clamp(stems, 0.0, 1.0);
    feathers = clamp(feathers, 0.0, 1.0);
    color = blendLayer(color, vec3(0.43, 0.72, 0.15), stems * 0.52);
    color = blendLayer(color, vec3(0.31, 0.58, 0.17), feathers * 0.48);

    float floaters = 0.0;
    float pads = 0.0;
    float blooms = 0.0;
    for (int i = 0; i < 10; i++) {
      float fi = float(i);
      vec2 c = vec2(fract(fi * 0.191 + 0.08 + hash(vec2(fi, 11.0)) * 0.15), fract(fi * 0.139 + 0.12 + hash(vec2(fi, 13.0)) * 0.12));
      c = mix(c, vec2(0.78 + hash(vec2(fi, 2.0)) * 0.2, 0.16 + hash(vec2(fi, 3.0)) * 0.72), step(6.0, fi));
      float s = 0.045 + hash(vec2(fi, 9.0)) * 0.03;
      floaters += floatingCluster(p, c, s, fi);
      blooms += tinyBloom(p, c + vec2(0.02, -0.015), s * 1.15, fi);
      if (i < 5) {
        pads += bigPad(p, vec2(0.78 + hash(vec2(fi, 5.0)) * 0.23, 0.12 + hash(vec2(fi, 6.0)) * 0.72), 0.095 + hash(vec2(fi, 7.0)) * 0.045, fi);
      }
    }
    floaters = clamp(floaters, 0.0, 1.0);
    pads = clamp(pads, 0.0, 1.0);
    blooms = clamp(blooms, 0.0, 1.0);
    color = blendLayer(color, vec3(0.67, 0.82, 0.24), floaters * 0.9);
    color = blendLayer(color, vec3(0.56, 0.78, 0.24), pads * 0.84);
    color += blooms * vec3(0.34, 0.42, 0.3);

    float fishX1 = fract(time * 0.045 + 0.12);
    float fishX2 = 1.0 - fract(time * 0.036 + 0.52);
    float fishX3 = fract(time * 0.026 + 0.74);
    vec4 fishA = fishRender(p, vec2(fishX1, 0.28 + sin(time * 0.42) * 0.08), 0.038, 1.0, time, 0.0, vec3(0.98, 0.34, 0.08));
    vec4 fishB = fishRender(p, vec2(fishX2, 0.58 + sin(time * 0.31 + 2.0) * 0.07), 0.032, -1.0, time, 2.4, vec3(0.74, 0.78, 0.62));
    vec4 fishC = fishRender(p, vec2(fishX3, 0.18 + sin(time * 0.26 + 4.0) * 0.05), 0.03, 1.0, time, 5.1, vec3(0.9, 0.45, 0.12));
    color = mix(color, fishA.rgb, fishA.a * 0.82);
    color = mix(color, fishB.rgb, fishB.a * 0.74);
    color = mix(color, fishC.rgb, fishC.a * 0.7);

    float glassGlow = smoothstep(0.0, 0.12, p.x) * (1.0 - smoothstep(0.12, 0.2, p.x));
    color += glassGlow * vec3(0.08, 0.2, 0.08);
    color = mix(color, vec3(0.08, 0.26, 0.17), 0.12 + depth * 0.12);
    return color;
  }

  void main() {
    vec2 uv = vUv;
    float time = mix(uTime, 24.0, uReduceMotion);

    vec2 baseWave = windWave(uv, time);
    vec2 interaction = rippleGradient(uv) * 0.14;
    vec2 slope = baseWave + interaction;
    vec3 normal = normalize(vec3(-slope.x * 3.3, -slope.y * 3.3, 1.0));

    vec2 reflectUv = vec2(uv.x, 1.0 - uv.y);
    reflectUv += normal.xy * vec2(0.12, 0.18);
    reflectUv += vec2(fbm(uv * 6.0 + time * 0.018), fbm(uv * 5.0 - time * 0.015)) * 0.018 - 0.009;
    reflectUv = clamp(reflectUv, vec2(0.001), vec2(0.999));

    vec2 refractUv = uv + normal.xy * vec2(0.075, 0.12);
    refractUv = clamp(refractUv, vec2(0.001), vec2(0.999));

    vec3 reflection = skyColor(reflectUv, time);
    vec3 below = underwater(uv, refractUv, time);

    vec3 viewDir = normalize(vec3(0.0, -0.38, 1.0));
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.7);
    float reflectAmount = mix(0.04, 0.24, fresnel);
    reflectAmount += smoothstep(0.72, 1.0, uv.y) * 0.06;
    reflectAmount += smoothstep(0.7, 0.95, uv.x) * smoothstep(0.18, 0.72, uv.y) * 0.08;
    reflectAmount -= (1.0 - smoothstep(0.2, 0.82, uv.y)) * 0.08;

    vec3 waterTint = vec3(0.025, 0.26, 0.34);
    vec3 color = mix(below, reflection, clamp(reflectAmount, 0.0, 0.92));
    color = mix(color, below, 0.58);
    color = mix(color, waterTint, 0.035);

    float caustic = fbm((refractUv + normal.xy * 0.2) * vec2(26.0, 18.0) + vec2(time * 0.06, -time * 0.025));
    caustic = pow(smoothstep(0.58, 0.88, caustic), 2.4) * (1.0 - smoothstep(0.72, 1.0, uv.y));
    color += caustic * vec3(0.11, 0.16, 0.045);

    vec3 halfLight = normalize(vec3(-0.42, 0.24, 1.0));
    float specular = pow(max(dot(normal, halfLight), 0.0), 140.0) * 0.18;
    float rippleLight = dot(interaction, normalize(vec2(0.72, -0.38)));
    float waveLight = dot(baseWave, normalize(vec2(0.72, -0.38)));
    color += specular;
    color += rippleLight * vec3(0.9, 1.0, 1.05);
    color += waveLight * vec3(0.24, 0.32, 0.36);

    float film = noise(uv * vec2(190.0, 130.0) + vec2(time * 0.02, 0.0));
    color *= 0.965 + film * 0.035;
    color = pow(max(color, vec3(0.0)), vec3(0.92));

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function createPondScene({ section, canvas, reduceMotion }) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance"
  });

  renderer.setClearColor(0x0d3143, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const rippleSize = 256;
  let rippleCurrent = new Float32Array(rippleSize * rippleSize);
  let ripplePrevious = new Float32Array(rippleSize * rippleSize);
  let rippleNext = new Float32Array(rippleSize * rippleSize);
  const ripplePixels = new Uint8Array(rippleSize * rippleSize);
  ripplePixels.fill(128);

  const rippleTexture = new THREE.DataTexture(
    ripplePixels,
    rippleSize,
    rippleSize,
    THREE.RedFormat,
    THREE.UnsignedByteType
  );
  rippleTexture.colorSpace = THREE.NoColorSpace;
  rippleTexture.minFilter = THREE.LinearFilter;
  rippleTexture.magFilter = THREE.LinearFilter;
  rippleTexture.wrapS = THREE.ClampToEdgeWrapping;
  rippleTexture.wrapT = THREE.ClampToEdgeWrapping;
  rippleTexture.needsUpdate = true;

  const uniforms = {
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uRipple: { value: rippleTexture },
    uRippleTexel: { value: new THREE.Vector2(1 / rippleSize, 1 / rippleSize) },
    uPointer: { value: new THREE.Vector2(-10, -10) },
    uPointerActive: { value: 0 },
    uReduceMotion: { value: reduceMotion ? 1 : 0 }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(mesh);

  let visible = true;
  let lastPointer = null;
  let lastPointerInteraction = -10000;
  let trailRemainder = 0;
  let lastSimulationTime = null;
  let simulationAccumulator = 0;
  const impulses = [];

  const applyImpulse = (u, v, strength) => {
    const cx = Math.round(u * (rippleSize - 1));
    const cy = Math.round(v * (rippleSize - 1));
    const radius = 6;

    for (let y = -radius; y <= radius; y++) {
      const sy = cy + y;
      if (sy <= 1 || sy >= rippleSize - 2) continue;
      for (let x = -radius; x <= radius; x++) {
        const sx = cx + x;
        if (sx <= 1 || sx >= rippleSize - 2) continue;
        const distance = Math.hypot(x, y) / radius;
        if (distance >= 1) continue;
        const falloff = Math.cos(distance * Math.PI * 0.5);
        rippleCurrent[sy * rippleSize + sx] += strength * falloff;
      }
    }
  };

  const stepRipples = () => {
    while (impulses.length) {
      const impulse = impulses.shift();
      applyImpulse(impulse.u, impulse.v, impulse.strength);
    }

    rippleNext.fill(0);
    for (let y = 1; y < rippleSize - 1; y++) {
      const row = y * rippleSize;
      for (let x = 1; x < rippleSize - 1; x++) {
        const index = row + x;
        const orthogonal = rippleCurrent[index - 1] + rippleCurrent[index + 1] +
          rippleCurrent[index - rippleSize] + rippleCurrent[index + rippleSize];
        const diagonal = rippleCurrent[index - rippleSize - 1] + rippleCurrent[index - rippleSize + 1] +
          rippleCurrent[index + rippleSize - 1] + rippleCurrent[index + rippleSize + 1];
        const average = orthogonal * 0.2 + diagonal * 0.05;
        rippleNext[index] = Math.max(-1, Math.min(1, (average * 2 - ripplePrevious[index]) * 0.985));
      }
    }

    const oldPrevious = ripplePrevious;
    ripplePrevious = rippleCurrent;
    rippleCurrent = rippleNext;
    rippleNext = oldPrevious;
  };

  const uploadRipples = () => {
    for (let i = 0; i < rippleCurrent.length; i++) {
      ripplePixels[i] = Math.max(0, Math.min(255, 128 + rippleCurrent[i] * 112));
    }
    rippleTexture.needsUpdate = true;
  };

  const queueImpulse = (clientX, clientY, strength) => {
    const bounds = section.getBoundingClientRect();
    const u = (clientX - bounds.left) / bounds.width;
    const v = 1 - (clientY - bounds.top) / bounds.height;
    uniforms.uPointer.value.set(u, v);
    uniforms.uPointerActive.value = 1;
    lastPointerInteraction = performance.now();
    impulses.push({
      u,
      v,
      strength
    });
    if (impulses.length > 72) impulses.splice(0, impulses.length - 72);
  };

  const resize = () => {
    const bounds = section.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(bounds.width, bounds.height, false);
    uniforms.uResolution.value.set(width, height);
    visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
  };

  const render = timestamp => {
    if (visible && !document.hidden) {
      const time = timestamp * 0.001;
      if (lastSimulationTime === null) lastSimulationTime = timestamp;
      simulationAccumulator += Math.min(50, timestamp - lastSimulationTime);
      lastSimulationTime = timestamp;

      let steps = 0;
      while (simulationAccumulator >= 16.667 && steps < 3) {
        stepRipples();
        simulationAccumulator -= 16.667;
        steps++;
      }
      if (steps) uploadRipples();

      uniforms.uTime.value = time;
      if (timestamp - lastPointerInteraction > 650 && uniforms.uPointerActive.value > 0) {
        uniforms.uPointerActive.value *= 0.94;
        if (uniforms.uPointerActive.value < 0.02) uniforms.uPointerActive.value = 0;
      }
      renderer.render(scene, camera);
    }

    if (!reduceMotion) requestAnimationFrame(render);
  };

  section.addEventListener("pointermove", event => {
    const now = performance.now() * 0.001;
    if (!lastPointer) {
      queueImpulse(event.clientX, event.clientY, 0.12);
      lastPointer = { x: event.clientX, y: event.clientY, time: now };
      return;
    }

    const dx = event.clientX - lastPointer.x;
    const dy = event.clientY - lastPointer.y;
    const segmentLength = Math.hypot(dx, dy);
    const elapsed = Math.max(0.008, now - lastPointer.time);
    const strength = Math.min(0.28, 0.09 + segmentLength / elapsed / 26000);
    const spacing = 46;
    let sampleDistance = spacing - trailRemainder;

    while (sampleDistance <= segmentLength && segmentLength > 0) {
      const ratio = sampleDistance / segmentLength;
      queueImpulse(lastPointer.x + dx * ratio, lastPointer.y + dy * ratio, strength);
      sampleDistance += spacing;
    }

    trailRemainder = (trailRemainder + segmentLength) % spacing;
    lastPointer = { x: event.clientX, y: event.clientY, time: now };
  }, { passive: true });

  section.addEventListener("pointerleave", () => {
    lastPointer = null;
    trailRemainder = 0;
    uniforms.uPointer.value.set(-10, -10);
    uniforms.uPointerActive.value = 0;
  }, { passive: true });

  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible && reduceMotion) {
      uniforms.uTime.value = 24;
      renderer.render(scene, camera);
    }
  }, { threshold: 0.02 });

  observer.observe(section);
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(render);
}
