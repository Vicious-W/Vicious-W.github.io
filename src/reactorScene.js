// 第一页底层：核反应堆重水池（切伦科夫辉光）。
// 原生 WebGL1 单通道 shader，不依赖 Three.js —— 第一页在首屏，必须即刻可渲染。
// 刻意使用最保守的 WebGL1 + 顶点缓冲写法：WebGL2 attributeless 绘制在
// Windows ANGLE/D3D11 上有兼容性问题（无头 SwiftShader 测试发现不了）。
//
// 表层玻璃**不在这里**。它曾经是这个 shader 里用屏幕空间分格画出来的，
// 那条路根本走不通：在一整块画面上"划分"格子，永远得不到一个个独立的物体。
// 现在玻璃是 glassCubes.js 里真实的三维立方体（各自有体积、有刚体、可拖动堆叠），
// 这块画布则退为：① 首屏瞬开的即时画面 ② Three.js 不可用时的兜底。

import { REACTOR_GLSL } from "./reactorShader.js";

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;

${REACTOR_GLSL}

void main() {
  vec2 frag = gl_FragCoord.xy;
  float minDim = min(uRes.x, uRes.y);
  vec2 sp = (frag - 0.5 * uRes) / minDim;

  vec3 col = poolColor(sp, uTime);

  // 暗角
  vec2 vc = (frag - 0.5 * uRes) / uRes;
  col *= 1.0 - smoothstep(0.35, 0.78, length(vc)) * 0.50;

  // 抖动去色带
  col += (hash12(frag + fract(uTime) * 100.0) - 0.5) * (2.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}`;

export function createReactorScene({ section, canvas, reduceMotion }) {
  const contextOptions = {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false
  };
  const gl = canvas.getContext("webgl", contextOptions)
          || canvas.getContext("experimental-webgl", contextOptions);
  if (!gl) {
    console.error("reactorScene: WebGL context unavailable");
    return null;
  }

  let program = null;
  let uniforms = null;
  let buffer = null;
  let raf = 0;
  let running = false;
  let time = 7.0;
  let last = 0;
  let disposed = false;

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("reactorScene shader:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const setup = () => {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("reactorScene link:", gl.getProgramInfoLog(program));
      return false;
    }
    gl.useProgram(program);
    // 覆盖全屏的大三角形
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    uniforms = {
      res: gl.getUniformLocation(program, "uRes"),
      time: gl.getUniformLocation(program, "uTime")
    };
    return true;
  };

  const isNarrow = () => matchMedia("(max-width: 640px)").matches;

  const resize = () => {
    const cssW = canvas.clientWidth || section.clientWidth;
    const cssH = canvas.clientHeight || section.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(window.devicePixelRatio || 1, isNarrow() ? 1.8 : 1.6);
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.uniform2f(uniforms.res, w, h);
  };

  const draw = () => {
    gl.uniform1f(uniforms.time, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = now => {
    if (!running || disposed) return;
    time += Math.min((now - last) / 1000, 0.05);
    last = now;
    draw();
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running || disposed || reduceMotion) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  if (!setup()) return null;
  resize();
  draw();
  section.classList.add("reactor-ready");

  let observer = null;
  if (!reduceMotion && "IntersectionObserver" in window) {
    observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !document.hidden) start();
      else stop();
    }, { threshold: 0 });
    observer.observe(section);
  } else {
    start();
  }

  const onVisibility = () => {
    if (document.hidden) stop();
    else if (section.getBoundingClientRect().bottom > 0) start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  let resizeObserver = null;
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      resize();
      if (!running) draw();
    });
    resizeObserver.observe(section);
  } else {
    window.addEventListener("resize", () => {
      resize();
      if (!running) draw();
    });
  }

  const onContextLost = event => {
    event.preventDefault();
    stop();
    section.classList.remove("reactor-ready");
  };
  const onContextRestored = () => {
    if (disposed) return;
    if (setup()) {
      resize();
      draw();
      section.classList.add("reactor-ready");
      start();
    }
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  return {
    // 玻璃立方体层接管画面后调用：底层不再需要逐帧重绘，省一份 GPU 开销
    suspend() { stop(); },
    dispose() {
      disposed = true;
      stop();
      observer && observer.disconnect();
      resizeObserver && resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
    }
  };
}
