import * as THREE from "three";
import pondLandscapeUrl from "../../assets/pond/pond-base-landscape.webp";
import pondPortraitUrl from "../../assets/pond/pond-base-portrait.webp";
import fishMedakaUrl from "../../assets/pond/fish-medaka-v2.webp";
import skyLandscapeUrl from "../../assets/pond/sky-reflection-landscape.webp";
import skyPortraitUrl from "../../assets/pond/sky-reflection-portrait.webp";

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
  uniform vec2 uLandscapeSize;
  uniform vec2 uPortraitSize;
  uniform float uPortraitMix;
  uniform float uTime;
  uniform float uReduceMotion;
  uniform float uFishDensity;
  uniform sampler2D uLandscape;
  uniform sampler2D uPortrait;
  uniform sampler2D uSkyLandscape;
  uniform sampler2D uSkyPortrait;
  uniform sampler2D uFish;
  uniform sampler2D uRipple;
  uniform vec2 uRippleTexel;
  uniform vec2 uPointer;
  uniform float uPointerActive;

  varying vec2 vUv;

  mat2 rotation(float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return mat2(c, -s, s, c);
  }

  vec2 coverUv(vec2 uv, vec2 imageSize) {
    float viewportAspect = uResolution.x / max(uResolution.y, 1.0);
    float imageAspect = imageSize.x / max(imageSize.y, 1.0);
    vec2 scale = vec2(1.0);

    if (viewportAspect > imageAspect) {
      scale.y = imageAspect / viewportAspect;
    } else {
      scale.x = viewportAspect / imageAspect;
    }

    return (uv - 0.5) * scale + 0.5;
  }

  vec3 samplePond(vec2 uv) {
    vec2 landscapeUv = clamp(coverUv(uv, uLandscapeSize), vec2(0.001), vec2(0.999));
    vec2 portraitUv = clamp(coverUv(uv, uPortraitSize), vec2(0.001), vec2(0.999));
    if (uPortraitMix < 0.5) {
      return texture2D(uLandscape, landscapeUv).rgb;
    }
    return texture2D(uPortrait, portraitUv).rgb;
  }

  vec3 sampleSkyTexture(vec2 uv) {
    vec2 landscapeUv = coverUv(uv, uLandscapeSize);
    vec2 portraitUv = coverUv(uv, uPortraitSize);
    if (uPortraitMix < 0.5) {
      return texture2D(uSkyLandscape, landscapeUv).rgb;
    }
    return texture2D(uSkyPortrait, portraitUv).rgb;
  }

  float cloudMask(vec3 skySample) {
    float brightest = max(max(skySample.r, skySample.g), skySample.b);
    float darkest = min(min(skySample.r, skySample.g), skySample.b);
    float chroma = brightest - darkest;
    float luminance = dot(skySample, vec3(0.2126, 0.7152, 0.0722));
    return smoothstep(0.16, 0.66, luminance - chroma * 0.68);
  }

  vec3 reflectedSky(vec2 uv, float time) {
    float motion = 1.0 - uReduceMotion;
    vec2 slowDrift = vec2(
      time * 0.0022 + sin(time * 0.026) * 0.012,
      time * 0.00035 + cos(time * 0.021) * 0.006
    ) * motion;
    vec2 cloudSoftness = vec2(0.0045, -0.0032);
    vec3 cloudSharp = sampleSkyTexture(uv + slowDrift);
    vec3 cloudNeighbour = sampleSkyTexture(uv + slowDrift + cloudSoftness);
    vec3 cloudSource = mix(cloudSharp, cloudNeighbour, 0.32);
    float mainCloud = cloudMask(cloudSource);

    float vertical = smoothstep(0.0, 1.0, uv.y);
    vec3 clearBlue = mix(
      vec3(0.025, 0.25, 0.52),
      vec3(0.09, 0.43, 0.72),
      0.28 + vertical * 0.72
    );
    clearBlue += vec3(0.012, 0.028, 0.04) * sin((uv.x + uv.y) * 3.14159);

    float cloudLuminance = dot(cloudSource, vec3(0.2126, 0.7152, 0.0722));
    vec3 neutralCloud = mix(vec3(cloudLuminance), cloudSource, 0.34);
    neutralCloud *= vec3(0.82, 0.9, 0.98);
    neutralCloud = mix(neutralCloud, vec3(0.9, 0.94, 0.96), pow(mainCloud, 2.6) * 0.13);
    return mix(clearBlue, neutralCloud, mainCloud * 0.78);
  }

  vec2 rippleGradient(vec2 uv) {
    float left = texture2D(uRipple, uv - vec2(uRippleTexel.x, 0.0)).r * 2.0 - 1.0;
    float right = texture2D(uRipple, uv + vec2(uRippleTexel.x, 0.0)).r * 2.0 - 1.0;
    float down = texture2D(uRipple, uv - vec2(0.0, uRippleTexel.y)).r * 2.0 - 1.0;
    float up = texture2D(uRipple, uv + vec2(0.0, uRippleTexel.y)).r * 2.0 - 1.0;
    return vec2(right - left, up - down);
  }

  vec2 windSlope(vec2 uv, float time) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y);
    vec2 slope = vec2(0.0);
    vec2 d1 = normalize(vec2(1.0, 0.24));
    vec2 d2 = normalize(vec2(-0.38, 1.0));
    vec2 d3 = normalize(vec2(0.82, -0.57));
    vec2 d4 = normalize(vec2(-0.72, -0.3));

    slope += d1 * cos(dot(p, d1) * 24.0 + time * 0.4) * 0.01;
    slope += d2 * cos(dot(p, d2) * 49.0 + time * 0.3) * 0.0062;
    slope += d3 * cos(dot(p, d3) * 91.0 + time * 0.64) * 0.003;
    slope += d4 * cos(dot(p, d4) * 12.0 + time * 0.18) * 0.004;
    return slope;
  }

  float causticLight(vec2 uv, float time) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y) * 17.0;
    float warpA = sin(p.x * 0.73 + sin(p.y * 0.61 - time * 0.36));
    float warpB = sin(p.y * 0.81 + sin(p.x * 0.49 + time * 0.29));
    float warpC = sin((p.x + p.y) * 0.52 - time * 0.22);
    float ridge = 1.0 - abs((warpA + warpB + warpC) / 3.0);
    return pow(smoothstep(0.42, 0.96, ridge), 3.2);
  }

  vec2 dripSlope(vec2 uv, vec2 center, float age, float amplitude) {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 delta = uv - center;
    delta.x *= aspect;
    float distanceFromDrop = length(delta);
    vec2 direction = normalize(delta + vec2(0.0006, 0.0004));
    direction.x /= aspect;

    float waveFront = 0.012 + age * 0.24;
    float distanceFromFront = distanceFromDrop - waveFront;
    float envelope = exp(-abs(distanceFromFront) * 48.0);
    envelope *= 1.0 - smoothstep(0.62, 1.0, age);
    float rings = cos(distanceFromFront * 150.0);
    return direction * rings * envelope * amplitude;
  }

  vec2 ambientRippleSlope(vec2 uv, float time) {
    float motion = 1.0 - uReduceMotion;
    vec2 slope = vec2(0.0);
    slope += dripSlope(uv, vec2(0.78, 0.72), fract(time * 0.13 + 0.16), 0.0065);
    slope += dripSlope(uv, vec2(0.58, 0.27), fract(time * 0.097 + 0.61), 0.0052);
    slope += dripSlope(uv, vec2(0.91, 0.46), fract(time * 0.081 + 0.34), 0.0046);
    return slope * motion;
  }

  float rippleHeight(vec2 uv) {
    return texture2D(uRipple, clamp(uv, vec2(0.001), vec2(0.999))).r * 2.0 - 1.0;
  }

  vec4 fishSprite(
    vec2 uv,
    vec2 center,
    float fishLength,
    float angle,
    float phase,
    float opacity
  ) {
    if (opacity <= 0.001) return vec4(0.0);
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 pointerDelta = center - uPointer;
    pointerDelta.x *= aspect;
    float pointerDistance = length(pointerDelta);
    vec2 away = normalize(pointerDelta + vec2(0.0007, 0.0003));
    away.x /= aspect;

    float pointerForce = (1.0 - smoothstep(0.035, 0.24, pointerDistance)) * uPointerActive;
    float localWave = abs(rippleHeight(center));
    float waveForce = smoothstep(0.035, 0.23, localWave) * step(-0.01, uPointer.x);
    float escapeForce = clamp(max(pointerForce, waveForce * 0.72), 0.0, 1.0);
    center += away * fishLength * (0.3 + escapeForce * 0.55) * escapeForce;

    float escapeAngle = atan(away.y, away.x * aspect);
    angle = mix(angle, escapeAngle, escapeForce * 0.82);
    vec2 local = vec2((uv.x - center.x) * aspect, uv.y - center.y);
    local = rotation(-angle) * local;

    const float fishAspect = 3.25;
    vec2 fishUv = vec2(
      local.x / fishLength + 0.5,
      local.y / (fishLength / fishAspect) + 0.5
    );

    if (fishUv.x <= 0.0 || fishUv.x >= 1.0 || fishUv.y <= 0.0 || fishUv.y >= 1.0) {
      return vec4(0.0);
    }

    float tailInfluence = 1.0 - smoothstep(0.12, 0.62, fishUv.x);
    float tailRate = 5.2 + escapeForce * 9.0;
    fishUv.y += sin(uTime * tailRate + phase + fishUv.x * 8.0) * tailInfluence * (0.035 + escapeForce * 0.024);
    vec4 fish = texture2D(uFish, fishUv);
    fish.rgb = mix(fish.rgb, vec3(0.035, 0.17, 0.19), 0.16);
    fish.rgb *= 0.92 + escapeForce * 0.06;
    fish.a *= opacity * (0.86 + escapeForce * 0.12);
    return fish;
  }

  vec4 alphaOver(vec4 below, vec4 above) {
    float alpha = above.a + below.a * (1.0 - above.a);
    vec3 premultiplied = above.rgb * above.a + below.rgb * below.a * (1.0 - above.a);
    return vec4(premultiplied / max(alpha, 0.0001), alpha);
  }

  vec4 fishLayer(vec2 uv, float time) {
    float progressA = fract(time * 0.018 + 0.06);
    float progressB = fract(time * 0.014 + 0.53);
    float progressC = fract(time * 0.011 + 0.31);

    float edgeA = smoothstep(0.0, 0.08, progressA) * (1.0 - smoothstep(0.92, 1.0, progressA));
    float edgeB = smoothstep(0.0, 0.08, progressB) * (1.0 - smoothstep(0.92, 1.0, progressB));
    float edgeC = smoothstep(0.0, 0.08, progressC) * (1.0 - smoothstep(0.92, 1.0, progressC));

    vec2 centerA = vec2(mix(-0.04, 1.04, progressA), 0.24 + sin(time * 0.34) * 0.028);
    vec2 centerB = vec2(mix(1.04, -0.04, progressB), 0.53 + sin(time * 0.27 + 2.1) * 0.031);
    vec2 centerC = vec2(mix(-0.04, 1.04, progressC), 0.72 + sin(time * 0.21 + 4.2) * 0.024);

    vec4 fishA = fishSprite(uv, centerA, 0.064, 0.08 * cos(time * 0.34), 0.0, edgeA * 0.5 * uFishDensity);
    vec4 fishB = fishSprite(uv, centerB, 0.052, 3.14159 - 0.09 * cos(time * 0.27 + 2.1), 2.2, edgeB * 0.42 * uFishDensity);
    vec4 fishC = fishSprite(uv, centerC, 0.045, 0.05 * cos(time * 0.21 + 4.2), 4.6, edgeC * 0.32 * uFishDensity);

    vec4 combined = alphaOver(vec4(0.0), fishA);
    combined = alphaOver(combined, fishB);
    combined = alphaOver(combined, fishC);
    return combined;
  }

  void main() {
    vec2 uv = vUv;
    float time = mix(uTime, 19.0, uReduceMotion);
    vec2 interaction = rippleGradient(uv);
    vec2 wind = windSlope(uv, time);
    vec2 ambientRipple = ambientRippleSlope(uv, time);
    vec2 slope = wind + ambientRipple + interaction * 0.78;

    float viewportAspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 physicalSlope = vec2(slope.x / viewportAspect, slope.y);
    vec2 refractedUv = clamp(
      uv - physicalSlope * 0.032,
      vec2(0.001),
      vec2(0.999)
    );
    vec2 reflectedUv = uv + physicalSlope * 0.058;

    vec3 pondSharp = samplePond(refractedUv);
    float firstLuminance = dot(pondSharp, vec3(0.2126, 0.7152, 0.0722));
    float preliminaryDepth = 1.0 - smoothstep(0.075, 0.39, firstLuminance);
    vec2 bottomBlur = vec2(0.0016 + preliminaryDepth * 0.0028, -0.0012 - preliminaryDepth * 0.0019);
    vec3 pondSoft = 0.5 * (
      samplePond(refractedUv + bottomBlur) +
      samplePond(refractedUv - bottomBlur)
    );
    vec3 pond = mix(pondSharp, pondSoft, 0.22 + preliminaryDepth * 0.42);
    float pondBrightest = max(max(pond.r, pond.g), pond.b);
    float pondDarkest = min(min(pond.r, pond.g), pond.b);
    float pondChroma = pondBrightest - pondDarkest;
    float pondLuminance = dot(pond, vec3(0.2126, 0.7152, 0.0722));
    float bakedCloud = smoothstep(0.43, 0.78, pondLuminance) * (1.0 - smoothstep(0.08, 0.24, pondChroma));
    pond = mix(pond, pond * vec3(0.46, 0.58, 0.61), bakedCloud * 0.78);

    pondLuminance = dot(pond, vec3(0.2126, 0.7152, 0.0722));
    float inferredDepth = 1.0 - smoothstep(0.075, 0.39, pondLuminance);
    vec3 pondNatural = mix(vec3(pondLuminance), pond, 1.12);
    pondNatural *= vec3(0.82, 1.03, 0.9);
    pondNatural *= 0.94 + (1.0 - inferredDepth) * 0.18;

    vec3 deepWater = vec3(0.012, 0.105, 0.125);
    float waterColumnAmount = 0.12 + inferredDepth * 0.4;
    vec3 underwater = mix(pondNatural, deepWater, waterColumnAmount);
    float caustic = causticLight(refractedUv - physicalSlope * 0.5, time);
    underwater += caustic * (1.0 - inferredDepth * 0.7) * vec3(0.075, 0.105, 0.07);

    vec4 fish = fishLayer(refractedUv, time);
    underwater = mix(underwater, fish.rgb, fish.a);

    vec3 normal = normalize(vec3(-slope.x * 4.0, -slope.y * 4.0, 1.0));
    vec3 viewDirection = normalize(vec3(0.0, mix(-0.22, -0.72, uv.y), mix(1.0, 0.62, uv.y)));
    float facing = clamp(dot(normal, viewDirection), 0.0, 1.0);
    float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
    float surfaceRoughness = clamp(length(wind) * 28.0 + abs(rippleHeight(uv)) * 0.35, 0.0, 1.0);
    vec2 reflectionBlur = vec2(0.0023, -0.0015) * (0.55 + surfaceRoughness);
    vec3 reflection = 0.5 * (
      reflectedSky(reflectedUv + reflectionBlur, time) +
      reflectedSky(reflectedUv - reflectionBlur, time)
    );
    reflection = mix(reflection, vec3(0.035, 0.255, 0.37), surfaceRoughness * 0.1);
    reflection *= vec3(0.76, 0.87, 0.94);

    float distanceReflection = smoothstep(0.04, 0.96, uv.y);
    float reflectionStrength = mix(0.31, 0.64, distanceReflection);
    reflectionStrength += fresnel * 0.32;
    reflectionStrength -= (1.0 - inferredDepth) * 0.055;
    reflectionStrength = clamp(reflectionStrength, 0.27, 0.76);
    vec3 color = mix(underwater, reflection, reflectionStrength);
    color = mix(color, vec3(0.025, 0.22, 0.29), 0.035 + surfaceRoughness * 0.045);

    vec3 halfLight = normalize(vec3(-0.24, 0.16, 1.0));
    float specular = pow(max(dot(normal, halfLight), 0.0), 190.0) * 0.17;
    float rippleLight = dot(interaction + ambientRipple * 5.5, normalize(vec2(0.74, -0.42)));
    vec2 curvatureTexel = vec2(2.5 / max(uResolution.x, 1.0), 2.5 / max(uResolution.y, 1.0));
    vec2 windDx = windSlope(uv + vec2(curvatureTexel.x, 0.0), time);
    vec2 windDy = windSlope(uv + vec2(0.0, curvatureTexel.y), time);
    float curvature = clamp((length(windDx - wind) + length(windDy - wind)) * 260.0, 0.0, 1.0);
    float movingCrest = smoothstep(0.13, 0.72, curvature) * (0.35 + distanceReflection * 0.65);
    color += specular * vec3(0.86, 0.96, 1.0);
    color += movingCrest * vec3(0.12, 0.18, 0.2) * 0.052;
    color += max(rippleLight, 0.0) * vec3(0.48, 0.66, 0.72) * 0.16;
    color *= 1.0 - max(-rippleLight, 0.0) * 0.12;

    float waterGrain = sin((uv.x * viewportAspect * 113.0 + uv.y * 137.0) + time * 0.22) * 0.003;
    color += waterGrain * vec3(0.45, 0.68, 0.76);

    float edgeShade = 1.0 - smoothstep(0.2, 0.72, distance(uv, vec2(0.5)));
    color *= 0.965 + edgeShade * 0.035;
    color = max(color, vec3(0.0));

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

const loadTexture = (loader, url) => loader.loadAsync(url);

export function createPondScene({ section, canvas, reduceMotion }) {
  let renderer;

  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance"
    });
  } catch {
    canvas.hidden = true;
    return () => {};
  }

  renderer.setClearColor(0x082f35, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  let destroyed = false;
  let cleanupScene = () => renderer.dispose();
  const loader = new THREE.TextureLoader();

  Promise.all([
    loadTexture(loader, pondLandscapeUrl),
    loadTexture(loader, pondPortraitUrl),
    loadTexture(loader, skyLandscapeUrl),
    loadTexture(loader, skyPortraitUrl),
    loadTexture(loader, fishMedakaUrl)
  ]).then(([landscapeTexture, portraitTexture, skyLandscapeTexture, skyPortraitTexture, fishTexture]) => {
    if (destroyed) {
      landscapeTexture.dispose();
      portraitTexture.dispose();
      skyLandscapeTexture.dispose();
      skyPortraitTexture.dispose();
      fishTexture.dispose();
      return;
    }

    [landscapeTexture, portraitTexture, skyLandscapeTexture, skyPortraitTexture].forEach(texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    });
    [skyLandscapeTexture, skyPortraitTexture].forEach(texture => {
      texture.wrapS = THREE.MirroredRepeatWrapping;
      texture.wrapT = THREE.MirroredRepeatWrapping;
    });
    fishTexture.colorSpace = THREE.SRGBColorSpace;
    fishTexture.minFilter = THREE.LinearFilter;
    fishTexture.magFilter = THREE.LinearFilter;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mobileQuery = matchMedia("(max-width: 640px), (pointer: coarse)");
    const rippleShortSide = mobileQuery.matches ? 112 : 160;

    const rippleDimensions = bounds => {
      const aspect = bounds.width / Math.max(bounds.height, 1);
      if (aspect >= 1) {
        const idealWidth = rippleShortSide * aspect;
        const width = Math.min(288, Math.round(idealWidth / 4) * 4);
        return {
          width,
          height: Math.max(48, Math.round(width / aspect / 4) * 4)
        };
      }
      const idealHeight = rippleShortSide / aspect;
      const height = Math.min(288, Math.round(idealHeight / 4) * 4);
      return {
        width: Math.max(48, Math.round(height * aspect / 4) * 4),
        height
      };
    };

    const createRippleState = (width, height) => {
      const pixels = new Uint8Array(width * height);
      pixels.fill(128);
      const texture = new THREE.DataTexture(
        pixels,
        width,
        height,
        THREE.RedFormat,
        THREE.UnsignedByteType
      );
      texture.colorSpace = THREE.NoColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      return {
        width,
        height,
        current: new Float32Array(width * height),
        previous: new Float32Array(width * height),
        next: new Float32Array(width * height),
        pixels,
        texture
      };
    };

    const initialRippleSize = rippleDimensions(section.getBoundingClientRect());
    let rippleState = createRippleState(initialRippleSize.width, initialRippleSize.height);
    let rippleWidth = rippleState.width;
    let rippleHeight = rippleState.height;
    let rippleCurrent = rippleState.current;
    let ripplePrevious = rippleState.previous;
    let rippleNext = rippleState.next;
    let ripplePixels = rippleState.pixels;
    let rippleTexture = rippleState.texture;

    const uniforms = {
      uResolution: { value: new THREE.Vector2(1, 1) },
      uLandscapeSize: { value: new THREE.Vector2(1586, 992) },
      uPortraitSize: { value: new THREE.Vector2(941, 1672) },
      uPortraitMix: { value: 0 },
      uTime: { value: 0 },
      uReduceMotion: { value: reduceMotion ? 1 : 0 },
      uFishDensity: { value: mobileQuery.matches ? 0.58 : 1 },
      uLandscape: { value: landscapeTexture },
      uPortrait: { value: portraitTexture },
      uSkyLandscape: { value: skyLandscapeTexture },
      uSkyPortrait: { value: skyPortraitTexture },
      uFish: { value: fishTexture },
      uRipple: { value: rippleTexture },
      uRippleTexel: { value: new THREE.Vector2(1 / rippleWidth, 1 / rippleHeight) },
      uPointer: { value: new THREE.Vector2(-10, -10) },
      uPointerActive: { value: 0 }
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false
    });
    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    let visible = false;
    let rafId = 0;
    let lastFrameTime = null;
    let lastPaintTime = 0;
    let simulationAccumulator = 0;
    let lastPointer = null;
    let lastPointerInteraction = -10000;
    let trailRemainder = 0;
    let hasRendered = false;
    const impulses = [];
    const frameInterval = mobileQuery.matches ? 1000 / 30 : 1000 / 60;

    const resizeRippleField = bounds => {
      const dimensions = rippleDimensions(bounds);
      if (dimensions.width === rippleWidth && dimensions.height === rippleHeight) return;

      const oldTexture = rippleTexture;
      rippleState = createRippleState(dimensions.width, dimensions.height);
      rippleWidth = rippleState.width;
      rippleHeight = rippleState.height;
      rippleCurrent = rippleState.current;
      ripplePrevious = rippleState.previous;
      rippleNext = rippleState.next;
      ripplePixels = rippleState.pixels;
      rippleTexture = rippleState.texture;
      uniforms.uRipple.value = rippleTexture;
      uniforms.uRippleTexel.value.set(1 / rippleWidth, 1 / rippleHeight);
      impulses.length = 0;
      simulationAccumulator = 0;
      oldTexture.dispose();
    };

    const applyImpulse = (u, v, strength) => {
      const cx = Math.round(u * (rippleWidth - 1));
      const cy = Math.round(v * (rippleHeight - 1));
      const radius = 3;

      for (let y = -radius; y <= radius; y++) {
        const sy = cy + y;
        if (sy <= 1 || sy >= rippleHeight - 2) continue;
        for (let x = -radius; x <= radius; x++) {
          const sx = cx + x;
          if (sx <= 1 || sx >= rippleWidth - 2) continue;
          const distance = Math.hypot(x, y) / radius;
          if (distance >= 1) continue;
          const falloff = Math.cos(distance * Math.PI * 0.5);
          rippleCurrent[sy * rippleWidth + sx] += strength * falloff;
        }
      }
    };

    const stepRipples = () => {
      while (impulses.length) {
        const impulse = impulses.shift();
        applyImpulse(impulse.u, impulse.v, impulse.strength);
      }

      rippleNext.fill(0);
      for (let y = 1; y < rippleHeight - 1; y++) {
        const row = y * rippleWidth;
        for (let x = 1; x < rippleWidth - 1; x++) {
          const index = row + x;
          const orthogonal = rippleCurrent[index - 1] + rippleCurrent[index + 1] +
            rippleCurrent[index - rippleWidth] + rippleCurrent[index + rippleWidth];
          const diagonal = rippleCurrent[index - rippleWidth - 1] + rippleCurrent[index - rippleWidth + 1] +
            rippleCurrent[index + rippleWidth - 1] + rippleCurrent[index + rippleWidth + 1];
          const average = orthogonal * 0.2 + diagonal * 0.05;
          rippleNext[index] = Math.max(-1, Math.min(1, (average * 2 - ripplePrevious[index]) * 0.986));
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
      if (u < 0 || u > 1 || v < 0 || v > 1) return;

      uniforms.uPointer.value.set(u, v);
      uniforms.uPointerActive.value = 1;
      lastPointerInteraction = performance.now();
      impulses.push({ u, v, strength });
      if (impulses.length > 48) impulses.splice(0, impulses.length - 48);
    };

    const resize = () => {
      const bounds = section.getBoundingClientRect();
      const portrait = bounds.width / Math.max(bounds.height, 1) <= 0.8;
      const pixelRatioCap = portrait || mobileQuery.matches ? 1.1 : 1.35;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, pixelRatioCap);
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));

      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(bounds.width, bounds.height, false);
      resizeRippleField(bounds);
      uniforms.uResolution.value.set(width, height);
      uniforms.uPortraitMix.value = portrait ? 1 : 0;
      uniforms.uFishDensity.value = portrait || mobileQuery.matches ? 0.58 : 1;
      visible = bounds.bottom > 0 && bounds.top < window.innerHeight;

      if (reduceMotion && visible) renderStill();
    };

    const paint = timestamp => {
      uniforms.uTime.value = timestamp * 0.001;
      renderer.render(scene, camera);
      if (!hasRendered) {
        hasRendered = true;
        section.classList.add("pond-ready");
      }
    };

    function renderStill() {
      uniforms.uTime.value = 19;
      renderer.render(scene, camera);
      if (!hasRendered) {
        hasRendered = true;
        section.classList.add("pond-ready");
      }
    }

    const render = timestamp => {
      rafId = 0;
      if (!visible || document.hidden || destroyed) return;

      if (lastFrameTime === null) lastFrameTime = timestamp;
      const delta = Math.min(66, timestamp - lastFrameTime);
      lastFrameTime = timestamp;
      simulationAccumulator += delta;

      let steps = 0;
      while (simulationAccumulator >= 33.333 && steps < 2) {
        stepRipples();
        simulationAccumulator -= 33.333;
        steps++;
      }
      if (steps) uploadRipples();

      if (timestamp - lastPointerInteraction > 500 && uniforms.uPointerActive.value > 0) {
        uniforms.uPointerActive.value *= Math.exp(-delta / 310);
        if (uniforms.uPointerActive.value < 0.015) uniforms.uPointerActive.value = 0;
      }

      if (timestamp - lastPaintTime >= frameInterval - 1) {
        paint(timestamp);
        lastPaintTime = timestamp;
      }
      rafId = requestAnimationFrame(render);
    };

    const startLoop = () => {
      if (reduceMotion) {
        if (visible) renderStill();
        return;
      }
      if (!rafId && visible && !document.hidden) {
        lastFrameTime = null;
        rafId = requestAnimationFrame(render);
      }
    };

    const stopLoop = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lastFrameTime = null;
    };

    const onPointerDown = event => {
      queueImpulse(event.clientX, event.clientY, event.pointerType === "touch" ? 0.38 : 0.3);
      lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() * 0.001 };
    };

    const onPointerMove = event => {
      if (event.pointerType !== "mouse") return;
      const now = performance.now() * 0.001;

      if (!lastPointer) {
        queueImpulse(event.clientX, event.clientY, 0.18);
        lastPointer = { x: event.clientX, y: event.clientY, time: now };
        return;
      }

      const dx = event.clientX - lastPointer.x;
      const dy = event.clientY - lastPointer.y;
      const segmentLength = Math.hypot(dx, dy);
      const elapsed = Math.max(0.008, now - lastPointer.time);
      const strength = Math.min(0.24, 0.12 + segmentLength / elapsed / 36000);
      const spacing = 30;
      let sampleDistance = spacing - trailRemainder;

      while (sampleDistance <= segmentLength && segmentLength > 0) {
        const ratio = sampleDistance / segmentLength;
        queueImpulse(lastPointer.x + dx * ratio, lastPointer.y + dy * ratio, strength);
        sampleDistance += spacing;
      }

      trailRemainder = (trailRemainder + segmentLength) % spacing;
      lastPointer = { x: event.clientX, y: event.clientY, time: now };
    };

    const clearPointer = () => {
      lastPointer = null;
      trailRemainder = 0;
      uniforms.uPointer.value.set(-10, -10);
      uniforms.uPointerActive.value = 0;
    };

    const onVisibilityChange = () => {
      if (document.hidden) stopLoop();
      else startLoop();
    };

    const onContextLost = () => {
      stopLoop();
      canvas.hidden = true;
      section.classList.remove("pond-ready");
      if (!destroyed) {
        destroyed = true;
        cleanupScene();
      }
    };

    const intersectionObserver = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      if (visible) startLoop();
      else stopLoop();
    }, { threshold: 0.02 });
    const resizeObserver = new ResizeObserver(resize);

    section.addEventListener("pointerdown", onPointerDown, { passive: true });
    section.addEventListener("pointermove", onPointerMove, { passive: true });
    section.addEventListener("pointerleave", clearPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    canvas.addEventListener("webglcontextlost", onContextLost);
    intersectionObserver.observe(section);
    resizeObserver.observe(section);
    resize();
    startLoop();

    cleanupScene = () => {
      stopLoop();
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
      section.removeEventListener("pointerdown", onPointerDown);
      section.removeEventListener("pointermove", onPointerMove);
      section.removeEventListener("pointerleave", clearPointer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      section.classList.remove("pond-ready");
      geometry.dispose();
      material.dispose();
      rippleTexture.dispose();
      landscapeTexture.dispose();
      portraitTexture.dispose();
      skyLandscapeTexture.dispose();
      skyPortraitTexture.dispose();
      fishTexture.dispose();
      renderer.dispose();
    };
  }).catch(() => {
    canvas.hidden = true;
    renderer.dispose();
  });

  return () => {
    if (destroyed) return;
    destroyed = true;
    cleanupScene();
  };
}
