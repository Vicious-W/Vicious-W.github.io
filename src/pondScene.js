import * as THREE from "three";
import pondLandscapeUrl from "./assets/pond/pond-base-landscape.webp";
import pondPortraitUrl from "./assets/pond/pond-base-portrait.webp";
import fishMedakaUrl from "./assets/pond/fish-medaka-v2.webp";

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
    vec3 landscape = texture2D(uLandscape, landscapeUv).rgb;
    vec3 portrait = texture2D(uPortrait, portraitUv).rgb;
    return mix(landscape, portrait, uPortraitMix);
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

    slope += d1 * cos(dot(p, d1) * 27.0 + time * 0.42) * 0.007;
    slope += d2 * cos(dot(p, d2) * 53.0 + time * 0.31) * 0.0045;
    slope += d3 * cos(dot(p, d3) * 96.0 + time * 0.68) * 0.0022;
    return slope;
  }

  vec2 evadePointer(vec2 center, float amount) {
    vec2 delta = center - uPointer;
    delta.x *= uResolution.x / max(uResolution.y, 1.0);
    float distanceToPointer = length(delta);
    vec2 away = normalize(delta + vec2(0.0007, 0.0003));
    away.x /= uResolution.x / max(uResolution.y, 1.0);
    float force = (1.0 - smoothstep(0.0, 0.2, distanceToPointer)) * uPointerActive;
    return center + away * force * amount;
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
    center = evadePointer(center, fishLength * 0.75);
    float aspect = uResolution.x / max(uResolution.y, 1.0);
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
    fishUv.y += sin(uTime * 5.2 + phase + fishUv.x * 8.0) * tailInfluence * 0.035;
    vec4 fish = texture2D(uFish, fishUv);
    fish.rgb = mix(fish.rgb, vec3(0.055, 0.22, 0.18), 0.06);
    fish.rgb *= 0.98;
    fish.a *= opacity;
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

    float edgeA = smoothstep(0.0, 0.08, progressA) * (1.0 - smoothstep(0.92, 1.0, progressA));
    float edgeB = smoothstep(0.0, 0.08, progressB) * (1.0 - smoothstep(0.92, 1.0, progressB));

    vec2 centerA = vec2(mix(0.04, 0.43, progressA), 0.25 + sin(time * 0.34) * 0.025);
    vec2 centerB = vec2(mix(0.44, 0.06, progressB), 0.34 + sin(time * 0.27 + 2.1) * 0.026);

    vec4 fishA = fishSprite(uv, centerA, 0.066, 0.08 * cos(time * 0.34), 0.0, edgeA * 0.68 * uFishDensity);
    vec4 fishB = fishSprite(uv, centerB, 0.052, 3.14159 - 0.09 * cos(time * 0.27 + 2.1), 2.2, edgeB * 0.54 * uFishDensity);

    vec4 combined = alphaOver(vec4(0.0), fishA);
    combined = alphaOver(combined, fishB);
    return combined;
  }

  void main() {
    vec2 uv = vUv;
    float time = mix(uTime, 19.0, uReduceMotion);
    vec2 interaction = rippleGradient(uv);
    vec2 wind = windSlope(uv, time);
    vec2 slope = wind + interaction * 0.38;

    float viewportAspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 physicalWind = vec2(wind.x / viewportAspect, wind.y);
    vec2 physicalInteraction = vec2(interaction.x / viewportAspect, interaction.y);
    vec2 refractedUv = clamp(
      uv + physicalWind * 0.04 + physicalInteraction * 0.022,
      vec2(0.001),
      vec2(0.999)
    );
    vec3 color = samplePond(refractedUv);

    vec4 fish = fishLayer(refractedUv, time);
    color = mix(color, fish.rgb, fish.a);

    vec3 normal = normalize(vec3(-slope.x * 3.0, -slope.y * 3.0, 1.0));
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float rightSide = smoothstep(0.42, 0.82, uv.x);
    float upperWater = smoothstep(0.4, 0.82, uv.y);
    float reflectionCue = smoothstep(0.28, 0.68, luminance) * rightSide * upperWater;
    float fresnel = 0.025 + pow(1.0 - max(normal.z, 0.0), 2.0) * 0.36;
    vec3 reflectedTint = color * vec3(0.92, 1.0, 1.1) + vec3(0.012, 0.026, 0.045);
    color = mix(color, reflectedTint, reflectionCue * (0.05 + fresnel));

    vec3 halfLight = normalize(vec3(-0.13, 0.08, 1.0));
    float specular = pow(max(dot(normal, halfLight), 0.0), 150.0) * 0.14;
    float rippleLight = dot(interaction, normalize(vec2(0.74, -0.42)));
    color += specular * vec3(0.82, 0.94, 1.0);
    color += max(rippleLight, 0.0) * vec3(0.34, 0.52, 0.58) * 0.12;
    color *= 1.0 - max(-rippleLight, 0.0) * 0.09;

    float edgeShade = 1.0 - smoothstep(0.2, 0.72, distance(uv, vec2(0.5)));
    color *= 0.96 + edgeShade * 0.04;
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
    loadTexture(loader, fishMedakaUrl)
  ]).then(([landscapeTexture, portraitTexture, fishTexture]) => {
    if (destroyed) {
      landscapeTexture.dispose();
      portraitTexture.dispose();
      fishTexture.dispose();
      return;
    }

    [landscapeTexture, portraitTexture].forEach(texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
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
      uFishDensity: { value: mobileQuery.matches ? 0 : 1 },
      uLandscape: { value: landscapeTexture },
      uPortrait: { value: portraitTexture },
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
      const radius = 2;

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
          rippleNext[index] = Math.max(-1, Math.min(1, (average * 2 - ripplePrevious[index]) * 0.982));
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
      uniforms.uFishDensity.value = portrait || mobileQuery.matches ? 0 : 1;
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
      queueImpulse(event.clientX, event.clientY, event.pointerType === "touch" ? 0.23 : 0.17);
      lastPointer = { x: event.clientX, y: event.clientY, time: performance.now() * 0.001 };
    };

    const onPointerMove = event => {
      if (event.pointerType !== "mouse") return;
      const now = performance.now() * 0.001;

      if (!lastPointer) {
        queueImpulse(event.clientX, event.clientY, 0.1);
        lastPointer = { x: event.clientX, y: event.clientY, time: now };
        return;
      }

      const dx = event.clientX - lastPointer.x;
      const dy = event.clientY - lastPointer.y;
      const segmentLength = Math.hypot(dx, dy);
      const elapsed = Math.max(0.008, now - lastPointer.time);
      const strength = Math.min(0.14, 0.055 + segmentLength / elapsed / 40000);
      const spacing = 42;
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
