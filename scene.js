(() => {
  "use strict";

  const root = document.documentElement;
  const cantorPath = document.querySelector("[data-cantor]");
  const liquidSection = document.querySelector(".contact-section");
  const liquidCanvas = document.querySelector(".liquid-surface");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  requestAnimationFrame(() => root.classList.add("is-ready"));

  if (cantorPath) {
    const points = [];
    const buildCantor = (depth, x0, x1, y0, y1) => {
      if (depth === 0) {
        points.push([x0, y0], [x1, y1]);
        return;
      }
      const third = (x1 - x0) / 3;
      const middle = (y0 + y1) / 2;
      buildCantor(depth - 1, x0, x0 + third, y0, middle);
      points.push([x0 + third * 2, middle]);
      buildCantor(depth - 1, x0 + third * 2, x1, middle, y1);
    };

    buildCantor(5, 0, 1, 0, 1);
    const unique = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1]);
    cantorPath.setAttribute("d", unique.map(([x, y], index) => `${index ? "L" : "M"}${50 + x * 500} ${550 - y * 500}`).join(""));
  }

  if (liquidSection && liquidCanvas) {
    const gl = liquidCanvas.getContext("webgl", { alpha: false, antialias: false, powerPreference: "high-performance" });
    if (gl) {
      const vertexSource = `
        attribute vec2 a_position;
        void main() {
          gl_Position = vec4(a_position, 0.0, 1.0);
        }
      `;
      const fragmentSource = `
        precision highp float;
        uniform vec2 u_resolution;
        uniform float u_time;
        uniform float u_seed;
        uniform sampler2D u_skyPhoto;
        uniform float u_photoReady;
        uniform float u_skyAspect;
        uniform sampler2D u_waveState;
        uniform vec2 u_waveTexel;
        uniform float u_waveEncoded;

        float hash(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
        }

        float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.52;
          mat2 rotation = mat2(0.82, -0.57, 0.57, 0.82);
          for (int i = 0; i < 5; i++) {
            value += noise(p) * amplitude;
            p = rotation * p * 2.03 + vec2(13.7, -9.2);
            amplitude *= 0.48;
          }
          return value;
        }

        float cloudDensity(vec2 p, float time) {
          vec2 wind = vec2(time * 0.024, time * 0.0035);
          vec2 seed = vec2(u_seed * 7.13, u_seed * -4.71);
          float shape = fbm(p * 0.52 + wind + seed);
          vec2 warp = vec2(
            fbm(p * 0.83 + wind * 0.72 + seed.yx),
            fbm(p * 0.76 - wind * 0.18 - seed)
          ) - 0.5;
          vec2 billowP = p + warp * 1.15;
          float billows = fbm(billowP * 1.55 + wind * 0.52 + vec2(8.4, -4.1));
          float erosion = fbm(billowP * 4.8 - wind * 0.24 + vec2(-3.7, 9.2));
          float density = shape * 0.72 + billows * 0.36 - erosion * 0.105;
          return smoothstep(0.435, 0.625, density);
        }

        vec3 skyColor(vec2 uv, float time) {
          float aspect = u_resolution.x / u_resolution.y;
          vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) * 3.65;
          float cloud = cloudDensity(p, time);
          float lit = cloudDensity(p + vec2(-0.09, 0.12), time);
          float shade = clamp((cloud - lit) * 2.8 + cloud * (0.13 + uv.y * 0.08), 0.0, 0.46);
          float silver = smoothstep(0.02, 0.28, cloud) * (1.0 - smoothstep(0.3, 0.86, cloud));
          vec3 zenith = vec3(0.055, 0.31, 0.64);
          vec3 horizon = vec3(0.43, 0.72, 0.91);
          vec3 blue = mix(horizon, zenith, smoothstep(0.05, 0.95, uv.y));
          blue += vec3(0.04, 0.075, 0.1) * (1.0 - uv.y);
          vec3 cloudShadow = vec3(0.48, 0.58, 0.68);
          vec3 cloudLight = vec3(1.0, 0.995, 0.96);
          vec3 cloudColor = mix(cloudLight, cloudShadow, shade);
          cloudColor += silver * vec3(0.09, 0.095, 0.08);
          vec3 proceduralSky = mix(blue, cloudColor, cloud * 0.98);
          float viewAspect = u_resolution.x / u_resolution.y;
          vec2 photoUv = uv;
          if (viewAspect < u_skyAspect) {
            photoUv.x = (uv.x - 0.5) * viewAspect / u_skyAspect + 0.5;
          } else {
            photoUv.y = (uv.y - 0.5) * u_skyAspect / viewAspect + 0.5;
          }
          photoUv.y = photoUv.y * 0.94 + 0.03;
          photoUv.x += sin(time * 0.0024 + u_seed * 2.1) * 0.008;
          photoUv.y += sin(time * 0.0013 + u_seed) * 0.0025;
          photoUv = clamp(photoUv, vec2(0.002), vec2(0.998));
          vec3 photoSky = texture2D(u_skyPhoto, photoUv).rgb;
          photoSky = pow(max(photoSky, 0.0), vec3(0.96));
          photoSky *= vec3(0.985, 1.0, 1.015);
          return mix(proceduralSky, photoSky, u_photoReady);
        }

        vec2 waterGradient(vec2 uv, float time) {
          vec2 gradient = vec2(0.0);
          vec2 d1 = normalize(vec2(1.0, 0.28));
          vec2 d2 = normalize(vec2(-0.32, 1.0));
          vec2 d3 = normalize(vec2(0.76, -0.65));
          vec2 d4 = normalize(vec2(-0.91, -0.42));
          float p1 = dot(uv, d1) * 36.0 + time * 0.3;
          float p2 = dot(uv, d2) * 68.0 + time * 0.21;
          float p3 = dot(uv, d3) * 126.0 + time * 0.47;
          gradient += d1 * cos(p1) * 0.00085;
          gradient += d2 * cos(p2) * 0.00048;
          gradient += d3 * cos(p3) * 0.00024;
          gradient += d4 * cos(dot(uv, d4) * 238.0 + time * 0.73) * 0.00012;
          return gradient;
        }

        vec2 simulatedGradient(vec2 uv) {
          float left = texture2D(u_waveState, uv - vec2(u_waveTexel.x, 0.0)).r;
          float right = texture2D(u_waveState, uv + vec2(u_waveTexel.x, 0.0)).r;
          float down = texture2D(u_waveState, uv - vec2(0.0, u_waveTexel.y)).r;
          float up = texture2D(u_waveState, uv + vec2(0.0, u_waveTexel.y)).r;
          left = mix(left, left * 2.0 - 1.0, u_waveEncoded);
          right = mix(right, right * 2.0 - 1.0, u_waveEncoded);
          down = mix(down, down * 2.0 - 1.0, u_waveEncoded);
          up = mix(up, up * 2.0 - 1.0, u_waveEncoded);
          return vec2(right - left, up - down) * 1.15;
        }

        void main() {
          vec2 uv = gl_FragCoord.xy / u_resolution;
          vec2 baseGradient = waterGradient(uv, u_time);
          vec2 interactionGradient = simulatedGradient(uv);
          vec2 gradient = baseGradient + interactionGradient;
          vec3 normal = normalize(vec3(-gradient.x, -gradient.y, 1.0));
          vec2 reflectedUv = vec2(uv.x, 1.0 - uv.y) + normal.xy * 0.16;
          reflectedUv = clamp(reflectedUv, vec2(0.001), vec2(0.999));
          vec3 reflection = skyColor(reflectedUv, u_time);

          vec3 halfLight = normalize(vec3(-0.42, 0.28, 1.0));
          float specular = pow(max(0.0, dot(normal, halfLight)), 180.0) * 0.22;
          float surface = fbm(uv * vec2(6.0, 4.0) + vec2(u_time * 0.008, 0.0));
          vec3 color = reflection * mix(vec3(0.965, 0.98, 0.99), vec3(0.985, 0.993, 1.0), surface);
          float waterFilm = noise(uv * vec2(137.0, 119.0) + vec2(u_time * 0.003, 0.0));
          color *= 0.955 + waterFilm * 0.018;
          color = mix(color, vec3(0.035, 0.14, 0.24), 0.018);
          color += specular;
          float surfaceLight = dot(baseGradient, normalize(vec2(0.72, -0.38)));
          float rippleLight = dot(interactionGradient, normalize(vec2(0.72, -0.38)));
          color += surfaceLight * vec3(0.38, 0.46, 0.5);
          color += rippleLight * vec3(0.72, 0.88, 0.98);
          color += length(interactionGradient) * vec3(0.08, 0.1, 0.11);
          color = pow(color, vec3(0.94));
          gl_FragColor = vec4(color, 1.0);
        }
      `;

      const compileShader = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        return shader;
      };

      try {
        const program = gl.createProgram();
        gl.attachShader(program, compileShader(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);

        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        const position = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(position);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

        const resolutionUniform = gl.getUniformLocation(program, "u_resolution");
        const timeUniform = gl.getUniformLocation(program, "u_time");
        const waveStateUniform = gl.getUniformLocation(program, "u_waveState");
        const waveTexelUniform = gl.getUniformLocation(program, "u_waveTexel");
        const waveEncodedUniform = gl.getUniformLocation(program, "u_waveEncoded");
        const seedUniform = gl.getUniformLocation(program, "u_seed");
        const photoReadyUniform = gl.getUniformLocation(program, "u_photoReady");
        const skyPhotoUniform = gl.getUniformLocation(program, "u_skyPhoto");
        const skyAspectUniform = gl.getUniformLocation(program, "u_skyAspect");
        const randomSeed = Math.random() * 20 + 1;
        gl.uniform1f(seedUniform, randomSeed);
        gl.uniform1f(photoReadyUniform, 0);

        const skyTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, skyTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([76, 151, 207, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(skyPhotoUniform, 0);

        const waveTexture = gl.createTexture();
        const floatWaveTexture = Boolean(gl.getExtension("OES_texture_float") && gl.getExtension("OES_texture_float_linear"));
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, waveTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.uniform1i(waveStateUniform, 1);
        gl.uniform1f(waveEncodedUniform, floatWaveTexture ? 0 : 1);

        const skyImage = new Image();
        skyImage.decoding = "async";
        skyImage.onload = () => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, skyTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, skyImage);
          gl.uniform1f(skyAspectUniform, skyImage.naturalWidth / skyImage.naturalHeight);
          gl.uniform1f(photoReadyUniform, 1);
        };
        skyImage.src = "sky-cumulus-natural.webp";
        let visible = false;
        let waveWidth = 0;
        let waveHeight = 0;
        let waveCurrent;
        let wavePrevious;
        let waveNext;
        let wavePixels;
        const impulseQueue = [];
        let lastPointer = null;
        let trailRemainder = 0;
        let lastSimulationTime = null;
        let simulationAccumulator = 0;

        const initializeWaveField = bounds => {
          waveWidth = 320;
          waveHeight = Math.max(112, Math.min(240, Math.round(waveWidth * bounds.height / bounds.width)));
          const size = waveWidth * waveHeight;
          waveCurrent = new Float32Array(size);
          wavePrevious = new Float32Array(size);
          waveNext = new Float32Array(size);
          wavePixels = floatWaveTexture ? null : new Uint8Array(size);
          if (wavePixels) wavePixels.fill(128);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, waveTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(
            gl.TEXTURE_2D, 0, gl.LUMINANCE, waveWidth, waveHeight, 0, gl.LUMINANCE,
            floatWaveTexture ? gl.FLOAT : gl.UNSIGNED_BYTE,
            floatWaveTexture ? waveCurrent : wavePixels
          );
          gl.uniform2f(waveTexelUniform, 1 / waveWidth, 1 / waveHeight);
        };

        const queueImpulse = (x, y, strength, bounds) => {
          impulseQueue.push([
            (x - bounds.left) / bounds.width,
            1 - (y - bounds.top) / bounds.height,
            strength
          ]);
          if (impulseQueue.length > 96) impulseQueue.splice(0, impulseQueue.length - 96);
        };

        const applyImpulse = ([u, v, strength]) => {
          const centerX = Math.round(u * (waveWidth - 1));
          const centerY = Math.round(v * (waveHeight - 1));
          const radius = 5;
          for (let y = -radius; y <= radius; y++) {
            const sampleY = centerY + y;
            if (sampleY <= 1 || sampleY >= waveHeight - 2) continue;
            for (let x = -radius; x <= radius; x++) {
              const sampleX = centerX + x;
              if (sampleX <= 1 || sampleX >= waveWidth - 2) continue;
              const distance = Math.hypot(x, y) / radius;
              if (distance >= 1) continue;
              const falloff = (1 - distance) * Math.cos(distance * Math.PI);
              waveCurrent[sampleY * waveWidth + sampleX] += strength * falloff;
            }
          }
        };

        const stepWaveField = () => {
          impulseQueue.splice(0).forEach(applyImpulse);
          waveNext.fill(0);
          for (let y = 1; y < waveHeight - 1; y++) {
            const row = y * waveWidth;
            for (let x = 1; x < waveWidth - 1; x++) {
              const index = row + x;
              const orthogonal = waveCurrent[index - 1] + waveCurrent[index + 1] +
                waveCurrent[index - waveWidth] + waveCurrent[index + waveWidth];
              const diagonal = waveCurrent[index - waveWidth - 1] + waveCurrent[index - waveWidth + 1] +
                waveCurrent[index + waveWidth - 1] + waveCurrent[index + waveWidth + 1];
              const average = orthogonal * 0.2 + diagonal * 0.05;
              waveNext[index] = Math.max(-1, Math.min(1, (average * 2 - wavePrevious[index]) * 0.988));
            }
          }

          const oldPrevious = wavePrevious;
          wavePrevious = waveCurrent;
          waveCurrent = waveNext;
          waveNext = oldPrevious;
        };

        const uploadWaveField = () => {
          if (wavePixels) {
            for (let index = 0; index < waveCurrent.length; index++) {
              wavePixels[index] = Math.max(0, Math.min(255, 128 + waveCurrent[index] * 104));
            }
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, waveTexture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texSubImage2D(
            gl.TEXTURE_2D, 0, 0, 0, waveWidth, waveHeight, gl.LUMINANCE,
            floatWaveTexture ? gl.FLOAT : gl.UNSIGNED_BYTE,
            floatWaveTexture ? waveCurrent : wavePixels
          );
        };

        const resize = () => {
          const bounds = liquidSection.getBoundingClientRect();
          const pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
          liquidCanvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
          liquidCanvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
          gl.viewport(0, 0, liquidCanvas.width, liquidCanvas.height);
          gl.uniform2f(resolutionUniform, liquidCanvas.width, liquidCanvas.height);
          initializeWaveField(bounds);
        };

        const render = timestamp => {
          const time = reduceMotion ? 12 : timestamp * 0.001;
          if (visible && !document.hidden) {
            if (lastSimulationTime === null) lastSimulationTime = timestamp;
            simulationAccumulator += Math.min(50, timestamp - lastSimulationTime);
            lastSimulationTime = timestamp;
            let steps = 0;
            while (simulationAccumulator >= 16.667 && steps < 3) {
              stepWaveField();
              simulationAccumulator -= 16.667;
              steps++;
            }
            if (steps) uploadWaveField();

            gl.uniform1f(timeUniform, time);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, skyTexture);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, waveTexture);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
          if (!reduceMotion) requestAnimationFrame(render);
        };

        liquidSection.addEventListener("pointermove", event => {
          const bounds = liquidSection.getBoundingClientRect();
          const now = performance.now() * 0.001;
          if (!lastPointer) {
            queueImpulse(event.clientX, event.clientY, 0.026, bounds);
            lastPointer = { x: event.clientX, y: event.clientY, time: now };
            return;
          }

          const dx = event.clientX - lastPointer.x;
          const dy = event.clientY - lastPointer.y;
          const segmentLength = Math.hypot(dx, dy);
          const elapsed = Math.max(0.008, now - lastPointer.time);
          const strength = Math.min(0.075, 0.024 + segmentLength / elapsed / 42000);
          const spacing = 72;
          let sampleDistance = spacing - trailRemainder;

          while (sampleDistance <= segmentLength && segmentLength > 0) {
            const ratio = sampleDistance / segmentLength;
            queueImpulse(
              lastPointer.x + dx * ratio,
              lastPointer.y + dy * ratio,
              strength,
              bounds
            );
            sampleDistance += spacing;
          }

          trailRemainder = (trailRemainder + segmentLength) % spacing;
          lastPointer = { x: event.clientX, y: event.clientY, time: now };
        }, { passive: true });

        liquidSection.addEventListener("pointerleave", () => {
          lastPointer = null;
          trailRemainder = 0;
        }, { passive: true });

        new IntersectionObserver(entries => {
          visible = entries[0].isIntersecting;
          if (visible && reduceMotion) render(12000);
        }, { threshold: 0.02 }).observe(liquidSection);
        addEventListener("resize", resize);
        resize();
        requestAnimationFrame(render);
      } catch (error) {
        console.error("Water shader failed:", error);
      }
    }
  }

  const revealItems = document.querySelectorAll(".section__header, .lead, .prose, .project, .contact-grid");
  revealItems.forEach(item => item.classList.add("reveal"));

  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealItems.forEach(item => item.classList.add("is-visible"));
    return;
  }

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12 });

  revealItems.forEach(item => observer.observe(item));
})();
