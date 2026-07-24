// 独立轻水体积：高度场波动、光学、切伦科夫辉光与浮力/阻力耦合。
// 空间关系与验收见 docs/engineering/SOURCE_SCENE.md §6；池内热耦合见
// docs/engineering/REACTOR_POOL_SYSTEM.md §5。
//
// 求解层级（REALTIME_PROXY，标注于 REACTOR_POOL_SYSTEM.md §8）：
//   - 水面用固定子步长的二维阻尼波动方程（有限差分高度场）近似浅水表现；
//   - 刚体（玻璃碎片）仍由 cannon-es 三维求解，浮力/阻力通过高度场采样耦合；
//   - 自然对流羽流是由 fuel/pool 温度差驱动的着色强度代理，不做流体温度场；
//   - 切伦科夫辉光位于水体几何内部，强度由 powerProxy / pulsePowerProxy 驱动。

import * as THREE from "three";

const GLOW_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const GLOW_FRAG = `
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uCore;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d);
  float halo = exp(-r * r * 2.4);
  float core = exp(-r * r * 9.0) * uCore;
  float a = clamp((halo + core) * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(uColor * (halo + core) * uIntensity, a);
}`;

const WATER_VERT = `
varying vec3 vWorldPos;
varying vec3 vNormalW;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const WATER_FRAG = `
precision highp float;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uOpacity;
uniform vec3 uCamPos;
varying vec3 vWorldPos;
varying vec3 vNormalW;
void main() {
  vec3 viewDir = normalize(uCamPos - vWorldPos);
  float fresnel = pow(1.0 - clamp(dot(viewDir, vNormalW), 0.0, 1.0), 2.2);
  vec3 col = mix(uDeep, uShallow, fresnel * 0.8 + 0.15);
  gl_FragColor = vec4(col, uOpacity);
}`;

const CHERENKOV = new THREE.Color(0.45, 0.72, 1.0);

export function createWaterSystem({ poolRadius, poolDepth, surfaceY, corePosition, reduceMotion }) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // —— 高度场网格（固定子步长有限差分波动方程）——
  const N = 40; // 网格边长（覆盖池径外接正方形）
  const half = poolRadius * 1.02;
  const dx = (half * 2) / N;
  const size = (N + 1) * (N + 1);
  const h = new Float32Array(size);
  const v = new Float32Array(size); // 高度变化速度场
  const WAVE_C2 = 5.0;   // 波速平方代理（REALTIME_PROXY：数值波速约 0.39 世界单位/s，
                         // 远慢于浅水波 sqrt(g·h)，为的是让水面扰动在网页上看得清）
  const DAMP = 0.985;    // 每子步速度阻尼，保证能量输入停止后波动衰减
  // 高度回复：只阻尼速度场不足以回到静水面——一次入水/脉冲冲量会让水体留下一个被
  // 拉普拉斯算子摊平、但不为零的残余水位偏移，反复脉冲还会累积。这里给高度场一个
  // 很弱的回复系数（约 5.5 s 的 e 折时间），保证“能量输入停止后回到静水平衡”，
  // 同时不会把可见的波纹提前吃掉。
  const HEIGHT_RELAX = 0.998;
  const FIXED_STEP = 1 / 90;
  let accumulator = 0;

  const idx = (i, j) => j * (N + 1) + i;
  const worldToGrid = (x, z) => {
    const gi = (x + half) / dx;
    const gj = (z + half) / dx;
    return [THREE.MathUtils.clamp(gi, 0, N), THREE.MathUtils.clamp(gj, 0, N)];
  };

  function stepWave() {
    // 拉普拉斯算子 → 速度 → 高度，边界钳制为静水（池壁反射由钳制近似）
    for (let j = 1; j < N; j++) {
      for (let i = 1; i < N; i++) {
        const k = idx(i, j);
        const lap = h[idx(i + 1, j)] + h[idx(i - 1, j)] + h[idx(i, j + 1)] + h[idx(i, j - 1)] - 4 * h[k];
        v[k] += WAVE_C2 * lap * FIXED_STEP;
      }
    }
    for (let k = 0; k < size; k++) {
      v[k] *= DAMP;
      h[k] = (h[k] + v[k] * FIXED_STEP) * HEIGHT_RELAX;
    }
  }

  function addImpulse(x, z, strength, radius = 0.35) {
    const [gi, gj] = worldToGrid(x, z);
    const gr = Math.max(1, Math.round(radius / dx));
    for (let dj = -gr; dj <= gr; dj++) {
      for (let di = -gr; di <= gr; di++) {
        const i = Math.round(gi) + di;
        const j = Math.round(gj) + dj;
        if (i < 0 || i > N || j < 0 || j > N) continue;
        const d = Math.hypot(di, dj) / gr;
        if (d > 1) continue;
        const falloff = 1 - d;
        v[idx(i, j)] -= strength * falloff * 6;
      }
    }
  }

  function heightAt(x, z) {
    const [gi, gj] = worldToGrid(x, z);
    const i0 = Math.floor(gi), j0 = Math.floor(gj);
    const i1 = Math.min(N, i0 + 1), j1 = Math.min(N, j0 + 1);
    const fx = gi - i0, fz = gj - j0;
    const h00 = h[idx(i0, j0)], h10 = h[idx(i1, j0)], h01 = h[idx(i0, j1)], h11 = h[idx(i1, j1)];
    const hx0 = h00 * (1 - fx) + h10 * fx;
    const hx1 = h01 * (1 - fx) + h11 * fx;
    return surfaceY + (hx0 * (1 - fz) + hx1 * fz);
  }

  // —— 可见水面网格（CPU 端按高度场逐帧更新顶点，域为方形，圆外用 shader 裁切）——
  const surfGeo = track(new THREE.PlaneGeometry(half * 2, half * 2, N, N));
  surfGeo.rotateX(-Math.PI / 2);
  const posAttr = surfGeo.attributes.position;
  const waterMat = track(new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    uniforms: {
      uDeep: { value: new THREE.Color(0.02, 0.08, 0.16) },
      uShallow: { value: new THREE.Color(0.25, 0.55, 0.85) },
      uOpacity: { value: 0.72 },
      uCamPos: { value: new THREE.Vector3() }
    }
  }));
  const surfaceMesh = new THREE.Mesh(surfGeo, waterMat);
  surfaceMesh.position.y = surfaceY;
  group.add(surfaceMesh);

  // 圆形裁切：把方形网格边角挪到半径之外收拢（近似圆盘轮廓，避免方形水面穿帮）
  for (let v2 = 0; v2 <= N; v2++) {
    for (let u = 0; u <= N; u++) {
      const px = posAttr.getX(idx(u, v2));
      const pz = posAttr.getZ(idx(u, v2));
      const r = Math.hypot(px, pz);
      if (r > poolRadius) {
        const s = poolRadius / r;
        posAttr.setX(idx(u, v2), px * s);
        posAttr.setZ(idx(u, v2), pz * s);
      }
    }
  }

  // —— 水体体积：透明侧壁 + 池底吸收，表达深度而非一张平面 ——
  const bodyMat = track(new THREE.MeshPhysicalMaterial({
    color: 0x0a2233, metalness: 0, roughness: 0.15, transmission: 0.55,
    thickness: poolRadius, ior: 1.33, attenuationColor: new THREE.Color(0.05, 0.35, 0.55),
    attenuationDistance: 5.5, transparent: true, opacity: 0.9, side: THREE.DoubleSide
  }));
  const bodyMesh = new THREE.Mesh(
    track(new THREE.CylinderGeometry(poolRadius * 0.995, poolRadius * 0.995, surfaceY - (-poolDepth), 48, 1, true)),
    bodyMat
  );
  bodyMesh.position.y = (surfaceY + (-poolDepth)) / 2;
  group.add(bodyMesh);

  // —— 切伦科夫辉光（水体内部）——
  const glowMat = track(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: { uColor: { value: CHERENKOV.clone() }, uIntensity: { value: 0.0 }, uCore: { value: 1.4 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const glowDisc = new THREE.Mesh(track(new THREE.PlaneGeometry(poolRadius * 1.3, poolRadius * 1.3)), glowMat);
  glowDisc.rotation.x = -Math.PI / 2;
  glowDisc.position.y = corePosition.y + 0.2;
  group.add(glowDisc);

  const haloMat = track(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: { uColor: { value: new THREE.Color(0.2, 0.42, 0.85) }, uIntensity: { value: 0.0 }, uCore: { value: 0.2 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const halo = new THREE.Mesh(track(new THREE.PlaneGeometry(poolRadius * 2, poolRadius * 2)), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = corePosition.y + 0.05;
  group.add(halo);

  // —— 自然对流羽流（温差驱动的竖向淡色代理）——
  const plumeMat = track(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: { uColor: { value: new THREE.Color(0.5, 0.65, 0.7) }, uIntensity: { value: 0 }, uCore: { value: 0.5 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const plumeGeo = track(new THREE.PlaneGeometry(1.4, 1.4));
  const plume = new THREE.Mesh(plumeGeo, plumeMat);
  plume.rotation.x = -Math.PI / 2;
  plume.position.set(0, surfaceY - 0.05, 0);
  group.add(plume);

  const update = (dt, sessionState) => {
    accumulator = Math.min(accumulator + dt, FIXED_STEP * 6);
    while (accumulator >= FIXED_STEP) {
      stepWave();
      accumulator -= FIXED_STEP;
    }
    if (!reduceMotion) {
      posAttr.needsUpdate = true;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const k = idx(i, j);
          posAttr.setY(k, h[k]);
        }
      }
    }

    const flash = sessionState ? Math.min(1, sessionState.powerProxy + sessionState.pulsePowerProxy * (reduceMotion ? 0.15 : 0.75)) : 0;
    glowMat.uniforms.uIntensity.value = flash > 0.001 ? 0.15 + flash * 1.4 : 0;
    haloMat.uniforms.uIntensity.value = flash > 0.001 ? 0.08 + flash * 0.45 : 0;

    if (sessionState) {
      const diff = THREE.MathUtils.clamp(sessionState.fuelTemperatureProxy - sessionState.poolTemperatureProxy, 0, 1);
      plumeMat.uniforms.uIntensity.value = diff * (reduceMotion ? 0.15 : 0.4);
      waterMat.uniforms.uShallow.value.lerp(new THREE.Color(0.25 + diff * 0.1, 0.55, 0.85 - diff * 0.1), 0.02);
    }
  };

  const setCamera = camPos => { waterMat.uniforms.uCamPos.value.copy(camPos); };

  const dispose = () => {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  };

  return {
    group,
    update,
    setCamera,
    dispose,
    addImpulse,
    heightAt,
    surfaceY,
    poolRadius
  };
}
