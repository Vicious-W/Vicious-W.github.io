// 独立轻水体积：高度场波动、光学（清晰度 / 折射 / 反射 / 焦散 / 水下衰减）与
// 浮力/阻力耦合。空间关系与验收见 docs/engineering/SOURCE_SCENE.md §6，光学重构
// 要求见 docs/engineering/SOURCE_LAB_OPTICS.md §7（WTR-001…WTR-003）。
//
// 求解层级（REALTIME_PROXY，标注于 REACTOR_POOL_SYSTEM.md §8 与 WTR-G01）：
//   - 水面用固定子步长的二维阻尼波动方程（有限差分高度场）近似浅水表现；
//   - 水面法线由该高度场的中心差分求得，不使用与动力学无关的滚动噪声；
//   - 水面材质是真实的 transmission 折射玻璃质材（ior 1.333），因此从池口能直接
//     看到堆芯、控制棒、反射体和池底结构（WTR-001「清澈」）；
//   - 深度吸收/散射：水上由 transmission 的 attenuation（光程 = 厚度）承担，水下由
//     场景指数雾承担（physicalScene 依据相机是否在水面之下切换），两者共用同一组
//     衰减色，跨越水面时连续；
//   - 焦散是由**同一个高度场**的曲率驱动的投影强度，随水面法线和被照物深度变化；
//   - 自然对流羽流是 fuel/pool 温差驱动的折射强度代理，不做流体温度场；
//   - 切伦科夫辉光已迁到 cherenkov.js（附着堆芯活性段），水体本身不自发蓝光。

import * as THREE from "three";

const ADD_VERT = `
varying vec2 vUv;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const PLUME_FRAG = `
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

// 焦散：直接采样高度场纹理，用中心差分得到水面曲率（拉普拉斯）。会聚的水面
// （负曲率）在池底形成亮纹，发散处变暗——强度随水面法线变化，也随被照物深度
// （uDepth：水面到该面的光程）指数衰减。
const CAUSTIC_FRAG = `
precision highp float;
uniform sampler2D uHeight;
uniform float uIntensity;
uniform float uDepth;
uniform float uTexel;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d);
  if (r > 1.0) discard;
  float h  = texture2D(uHeight, vUv).r;
  float hx = texture2D(uHeight, vUv + vec2(uTexel, 0.0)).r
           + texture2D(uHeight, vUv - vec2(uTexel, 0.0)).r;
  float hz = texture2D(uHeight, vUv + vec2(0.0, uTexel)).r
           + texture2D(uHeight, vUv - vec2(0.0, uTexel)).r;
  float lap = (hx + hz - 4.0 * h);
  // 会聚 → 亮；发散 → 暗（下限 0，焦散只做加法）
  float focus = clamp(-lap * 900.0, 0.0, 1.0);
  float edge = 1.0 - smoothstep(0.86, 1.0, r);
  float depthAtten = exp(-uDepth * 0.16);
  float g = focus * edge * depthAtten * uIntensity;
  if (g < 0.003) discard;
  gl_FragColor = vec4(uColor * g, g);
}`;

// 水下体积衰减色：与水上 transmission 的 attenuationColor 同源，跨越水面连续
export const WATER_ATTENUATION = new THREE.Color(0.16, 0.55, 0.72);
export const UNDERWATER_FOG_COLOR = new THREE.Color(0.020, 0.086, 0.132);

// 切伦科夫辉光强度（0..1）。
//
// 稳态通道按资料基线软起辉：REACTOR_POOL_SYSTEM.md §4.7「切伦科夫在超过约 100 kW
// 后逐渐可见，不瞬间开灯」。本项目标度 powerProxy 1.0 = 250 kW，100 kW 对应 0.4，
// 因此用 smoothstep(0.3, 0.6) 做连续过渡：0.3 以下严格为 0，越过阈值后平滑增长，
// 没有任何阶跃基值。脉冲通道是独立标度（1.0 = 250 MW），毫秒级强闪单独叠加，
// 因此低功率下的历史脉冲照样把池水照亮。
export function cherenkovIntensity(powerProxy = 0, pulsePowerProxy = 0, reduceMotion = false) {
  const steady = THREE.MathUtils.smoothstep(powerProxy, 0.3, 0.6);
  const burst = THREE.MathUtils.clamp(pulsePowerProxy * (reduceMotion ? 0.15 : 0.75), 0, 1);
  return Math.min(1, steady + burst);
}

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

  // 相机相对**实际**水面（含波动）的浸没深度 → 连续权重（CAM-003 / WTR-002）。
  // 水上/水下不是二选一：在水面上下各 SUBMERGE_BAND 的过渡带里线性混合，池口边缘
  // 也按半径羽化，因此相机横向掠出池口时同样不会整帧跳色。
  const SUBMERGE_BAND = 0.35;
  const clamp = THREE.MathUtils.clamp;
  function submersionAt(camPos) {
    if (!camPos) return 0;
    const r = Math.hypot(camPos.x, camPos.z);
    // 池壁外没有水体：从 0.94R 到 1.02R 连续收敛到 0
    const radial = 1 - clamp((r - poolRadius * 0.94) / (poolRadius * 0.08), 0, 1);
    if (radial <= 0) return 0;
    const depth = heightAt(camPos.x, camPos.z) - camPos.y;   // >0 = 在水面之下
    return clamp((depth + SUBMERGE_BAND) / (SUBMERGE_BAND * 2), 0, 1) * radial;
  }
  // 布尔判据保留给"当前是否算在水下"的离散消费者；连续光学一律用 submersion。
  function isUnderwater(camPos) {
    return submersionAt(camPos) > 0.5;
  }

  // —— 可见水面网格（CPU 端按高度场逐帧更新顶点与法线，域为方形，边角收拢成圆）——
  const surfGeo = track(new THREE.PlaneGeometry(half * 2, half * 2, N, N));
  surfGeo.rotateX(-Math.PI / 2);
  const posAttr = surfGeo.attributes.position;
  const normAttr = surfGeo.attributes.normal;

  // WTR-001：轻水是**透明折射介质**，不是一层高不透明的蓝色薄膜。
  // transmission = 1 + ior 1.333 让池内几何真实地经水面折射进入视野；
  // attenuationColor/Distance 给出随光程增长的吸收（近处清晰、深处渐蓝）。
  const waterMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.045,
    transmission: 1, thickness: Math.min(poolDepth * 0.55, 3.6), ior: 1.333,
    attenuationColor: WATER_ATTENUATION.clone(), attenuationDistance: 7.5,
    specularIntensity: 1, envMapIntensity: 1.25,
    transparent: true, side: THREE.DoubleSide, depthWrite: false
  }));
  const surfaceMesh = new THREE.Mesh(surfGeo, waterMat);
  surfaceMesh.position.y = surfaceY;
  surfaceMesh.renderOrder = 2;
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

  // —— 深度吸收代理：贴着池底的一层径向/深度渐变盘 ——
  // 水体不再用一个 transmission 圆柱去糊住内部（那正是 WTR-001 禁止的做法）。
  // 从水面往下的吸收由 transmission 的 attenuation 承担；这里只补上"池底最远处
  // 逐渐吃掉光"的那一段，让深度可读而不遮挡池内结构。REALTIME_PROXY。
  const depthMat = track(new THREE.MeshBasicMaterial({
    color: 0x05121c, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide
  }));
  const depthPlate = new THREE.Mesh(
    track(new THREE.CircleGeometry(poolRadius * 0.995, 48)), depthMat);
  depthPlate.rotation.x = -Math.PI / 2;
  depthPlate.position.y = -poolDepth + 0.02;
  depthPlate.renderOrder = 1;
  group.add(depthPlate);

  // —— 焦散：高度场纹理 → 池底投影（强度随水面法线/曲率与深度变化）——
  const causticTex = track(new THREE.DataTexture(
    new Float32Array(size), N + 1, N + 1, THREE.RedFormat, THREE.FloatType));
  causticTex.minFilter = THREE.LinearFilter;
  causticTex.magFilter = THREE.LinearFilter;
  causticTex.wrapS = causticTex.wrapT = THREE.ClampToEdgeWrapping;
  causticTex.needsUpdate = true;
  const causticMat = track(new THREE.ShaderMaterial({
    vertexShader: ADD_VERT, fragmentShader: CAUSTIC_FRAG,
    uniforms: {
      uHeight: { value: causticTex },
      uIntensity: { value: reduceMotion ? 0.35 : 0.8 },
      uDepth: { value: surfaceY + poolDepth },
      uTexel: { value: 1 / (N + 1) },
      uColor: { value: new THREE.Color(0.55, 0.82, 1.0) }
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const caustics = new THREE.Mesh(track(new THREE.PlaneGeometry(poolRadius * 2, poolRadius * 2)), causticMat);
  caustics.rotation.x = -Math.PI / 2;
  caustics.position.y = -poolDepth + 0.05;
  caustics.renderOrder = 2;
  group.add(caustics);

  // —— 自然对流羽流（温差驱动的竖向淡色折射代理）——
  const plumeMat = track(new THREE.ShaderMaterial({
    vertexShader: ADD_VERT, fragmentShader: PLUME_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(0.5, 0.65, 0.7) },
      uIntensity: { value: 0 }, uCore: { value: 0.5 }
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const plumeGeo = track(new THREE.PlaneGeometry(1.4, 1.4));
  const plume = new THREE.Mesh(plumeGeo, plumeMat);
  plume.rotation.x = -Math.PI / 2;
  plume.position.set(corePosition.x, surfaceY - 0.05, corePosition.z);
  plume.renderOrder = 2;
  group.add(plume);

  const causticData = causticTex.image.data;
  let submersion = 0;

  const update = (dt, sessionState) => {
    accumulator = Math.min(accumulator + dt, FIXED_STEP * 6);
    while (accumulator >= FIXED_STEP) {
      stepWave();
      accumulator -= FIXED_STEP;
    }
    if (!reduceMotion) {
      // 顶点高度
      for (let k = 0; k < size; k++) posAttr.setY(k, h[k]);
      posAttr.needsUpdate = true;
      // 法线来自实际波场的中心差分（WTR-002：不用无关的滚动噪声）
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const im = Math.max(0, i - 1), ip = Math.min(N, i + 1);
          const jm = Math.max(0, j - 1), jp = Math.min(N, j + 1);
          const dhx = (h[idx(ip, j)] - h[idx(im, j)]) / ((ip - im) * dx);
          const dhz = (h[idx(i, jp)] - h[idx(i, jm)]) / ((jp - jm) * dx);
          const inv = 1 / Math.hypot(dhx, 1, dhz);
          normAttr.setXYZ(idx(i, j), -dhx * inv, inv, -dhz * inv);
        }
      }
      normAttr.needsUpdate = true;
      causticData.set(h);
      causticTex.needsUpdate = true;
    }

    if (sessionState) {
      const diff = THREE.MathUtils.clamp(
        sessionState.fuelTemperatureProxy - sessionState.poolTemperatureProxy, 0, 1);
      plumeMat.uniforms.uIntensity.value = diff * (reduceMotion ? 0.15 : 0.4);
      // 热羽流让局部水面粗糙度略升（折射被搅动），仍然是读状态、不回写状态
      waterMat.roughness = 0.045 + diff * 0.05;
    }
    // 水面从内侧被看到时反射变弱、焦散变强。按 submersion **连续**插值，跨越水面
    // 的过渡带里不会出现"双重表面"或整帧跳变（WTR-002 / CAM-003）。
    waterMat.envMapIntensity = 1.25 + (0.5 - 1.25) * submersion;
    causticMat.uniforms.uIntensity.value =
      (reduceMotion ? 0.35 : 0.8) * (1 + 0.35 * submersion);
  };

  // 相机跨越水面（CAM-003）：只改变光学权重，不新建水体/会话
  const setCamera = camPos => { submersion = submersionAt(camPos); };

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
    isUnderwater,
    submersionAt,
    get submersion() { return submersion; },
    get underwater() { return submersion > 0.5; },
    surfaceY,
    poolRadius,
    poolDepth
  };
}
