// 切伦科夫体积与粒子表现（CHR-001 / CHR-002 / CHR-003，见 SOURCE_LAB_OPTICS.md §8）。
//
// 资料：
//   - DOE「Cherenkov Radiation, Explained」：带电粒子在透明介质中传播产生的蓝紫色光；
//   - IAEA：高纯池水中随功率增强的蓝色辉光；
//   - REACTOR_POOL_SYSTEM.md §4.7：Pavia 稳态辉光约 100 kW 以上逐渐可见。
//
// 四层互相一致的表现（CHR-002），全部由同一个 intensity 驱动：
//   1. 堆芯活性段体积本身的局部发光（附着燃料几何，不附着水面或相机）；
//   2. 水中的体积散射壳层，强度随离堆芯的距离与水中光程衰减；
//   3. `TUNED_PRESENTATION` 点精灵粒子：光在水中传播/散射的视觉代理，
//      不是电子/中子的逐粒子模拟，不碰撞、不产生浮力、不发声、不扣耐久；
//   4. 有界曝光：峰值软压缩 + 带时间常数的恢复，让脉冲可见但不过曝整屏。
//
// 粒子随机数只用于稳定采样分布，使用固定种子（同一次会话每次加载分布一致）。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

// 切伦科夫色（蓝紫，DOE 描述的可见表现）
export const CHERENKOV_COLOR = new THREE.Color(0.42, 0.68, 1.0);

// 曝光：raw 超过 knee 后进入软压缩，峰值有界（CHR-003「不过曝整屏」）
export const EXPOSURE = { knee: 0.85, headroom: 0.65, attack: 0.09, release: 0.75 };

// 水体消光系数（1/世界单位，`TUNED_PRESENTATION`）：辉光穿过 L 个单位的水后
// 剩余 exp(-L × WATER_ABSORB)。取值让堆芯→水面（约 5 单位）仍在 0.8 以上——
// 250 kW 默认取景清楚可见——同时贴近堆芯与横穿池水之间有可测的层次差。
export const WATER_ABSORB = 0.045;

// 相机到某点之间位于水面以下的光程（CPU 端，与 GLSL 里 waterTransmittance 同一套判据）
export function waterPathLength(from, to, surfaceY) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return 0;
  const lo = Math.min(from.y, to.y);
  const hi = Math.max(from.y, to.y);
  if (hi <= surfaceY) return len;              // 两端都在水下
  if (lo >= surfaceY) return 0;                // 两端都在水上
  return len * ((surfaceY - lo) / (hi - lo));  // 跨水面：只算水下那一段
}

// 有界曝光增益：raw 是四层共同的原始强度，返回 <= 1 的增益。
// 膝点以上做**软饱和**而不是简单反比——反比会让更强的脉冲反而更暗（非单调），
// 这里让显示值渐近到 knee + headroom：峰值有界，但"更强仍然更亮"。
export function exposureGain(raw, knee = EXPOSURE.knee, headroom = EXPOSURE.headroom) {
  if (raw <= knee) return 1;
  const over = raw - knee;
  const shown = knee + (over * headroom) / (over + headroom);
  return shown / raw;
}

// 固定种子 PRNG（mulberry32）：粒子分布可复现，不是每帧的不受控随机
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 统一水体光程（CHR-002 / WTR-002）——
// 辉光要穿过多少水才到达相机，只由三个共享量决定：片元世界位置、相机世界位置、
// 名义水面高度。片元与相机连线中位于水面**之下**的那一段就是水中光程；
// 相机在水上时，只有从辉光到水面的那一段算数。透过率 = exp(-光程 × 吸收系数)。
//
// 吸收系数是 `TUNED_PRESENTATION`：纯水对蓝光的真实衰减极小，这里取一个能在
// 网页尺度上读出"近处强、远处渐弱"层次、同时保证 250 kW 默认取景清楚可见的值。
const WATER_PATH_GLSL = `
uniform vec3 uCamera;
uniform float uSurfaceY;
uniform float uAbsorb;
uniform float uSubmersion;
float waterTransmittance(vec3 worldPos) {
  vec3 d = uCamera - worldPos;
  float len = length(d);
  float yF = worldPos.y;
  float yC = uCamera.y;
  float below;                                  // 该线段位于水面之下的比例
  if (yF <= uSurfaceY && yC <= uSurfaceY) below = 1.0;
  else if (yF > uSurfaceY && yC > uSurfaceY) below = 0.0;
  else below = (uSurfaceY - min(yF, yC)) / max(abs(yC - yF), 1e-4);
  float path = len * clamp(below, 0.0, 1.0);
  // 相机在水中时前向散射把更多光送进镜头：受同一个 submersion 权重约束，有界
  return exp(-path * uAbsorb) * (1.0 + 0.18 * uSubmersion);
}`;

const VOLUME_VERT = `
varying vec3 vLocal;
varying vec3 vWorld;
void main() {
  vLocal = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// 体积散射层：径向 + 轴向高斯衰减，再乘以到相机的水体光程透过率。
const VOLUME_FRAG = `
precision highp float;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uRadius;
uniform float uHalfH;
uniform float uEdge;
uniform float uAxial;
varying vec3 vLocal;
varying vec3 vWorld;
${WATER_PATH_GLSL}
void main() {
  float r = length(vLocal.xz) / max(uRadius, 1e-3);
  float a = abs(vLocal.y) / max(uHalfH, 1e-3);
  float radial = exp(-r * r * uEdge);
  float axial = exp(-a * a * uAxial);
  float g = radial * axial * uIntensity * waterTransmittance(vWorld);
  if (g < 0.002) discard;
  gl_FragColor = vec4(uColor * g, g);
}`;

const PARTICLE_VERT = `
uniform float uSize;
uniform float uIntensity;
attribute float aAlpha;
attribute float aScale;
varying float vAlpha;
varying vec3 vWorld;
void main() {
  vAlpha = aAlpha * uIntensity;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize * aScale * (1.0 / max(-mv.z, 0.2));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = `
precision highp float;
uniform vec3 uColor;
varying float vAlpha;
varying vec3 vWorld;
${WATER_PATH_GLSL}
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float f = exp(-r2 * 14.0) * waterTransmittance(vWorld);
  gl_FragColor = vec4(uColor * f * vAlpha, f * vAlpha);
}`;

/**
 * @param coreBounds { topY, height, radius }   活性燃料段（reactorModel.coreBounds）
 * @param surfaceY   名义水面高度（粒子在水面下消亡：这是水中的光传播代理）
 * @param intensityOf (state) => 0..1 原始强度（由 waterSystem.cherenkovIntensity 提供，
 *                    保证水与辉光读同一条功率因果）
 */
export function createCherenkov({
  coreBounds, surfaceY, reduceMotion = false, particleBudget = 900, intensityOf
}) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  const coreCenterY = coreBounds.topY - coreBounds.height / 2;
  const coreR = coreBounds.radius;
  const coreH = coreBounds.height;

  // 四层表现共享的水体光学 uniform（同一个相机位置、同一个水面、同一套吸收）
  const viewerPos = { value: new THREE.Vector3(0, surfaceY + 12, 24) };
  const surfaceUniform = { value: surfaceY };
  const absorbUniform = { value: WATER_ABSORB };
  const submersionUniform = { value: 0 };
  const waterUniforms = () => ({
    uCamera: viewerPos, uSurfaceY: surfaceUniform,
    uAbsorb: absorbUniform, uSubmersion: submersionUniform
  });

  // —— 层 1：堆芯活性段的局部发光体积（附着燃料几何）——
  const layers = [];
  const addVolume = (radius, halfH, edge, axial, intensityScale, color) => {
    const mat = track(new THREE.ShaderMaterial({
      vertexShader: VOLUME_VERT, fragmentShader: VOLUME_FRAG,
      uniforms: Object.assign({
        uColor: { value: color.clone() },
        uIntensity: { value: 0 },
        uRadius: { value: radius },
        uHalfH: { value: halfH },
        uEdge: { value: edge },
        uAxial: { value: axial }
      }, waterUniforms()),
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending
    }));
    const mesh = new THREE.Mesh(
      track(new THREE.CylinderGeometry(radius, radius, halfH * 2, 28, 1, true)), mat);
    mesh.position.y = coreCenterY;
    mesh.renderOrder = 3;
    // CAM-001 中心焦点拾取只应命中真实结构；辉光体积是功率驱动的光传播代理
    // （PROJECT_SPEC.md「粒子只作为...代理，不拥有碰撞...」的同一精神），不参与拾取。
    mesh.raycast = () => {};
    group.add(mesh);
    layers.push({ mat, scale: intensityScale });
    return mesh;
  };

  // 堆芯本体：紧贴活性段，边缘很硬（辉光"从燃料里发出来"）
  addVolume(coreR * 1.02, coreH / 2, 2.2, 1.5, 1.00, CHERENKOV_COLOR);
  // 水中散射：三层壳，越远越弱越散，最外层已越过石墨反射体进入自由水体
  addVolume(coreR * 1.75, coreH * 0.72, 2.9, 1.25, 0.46, CHERENKOV_COLOR);
  addVolume(coreR * 2.9, coreH * 1.05, 3.4, 1.05, 0.20, new THREE.Color(0.30, 0.55, 1.0));
  addVolume(coreR * 4.6, coreH * 1.5, 4.0, 0.9, 0.085, new THREE.Color(0.22, 0.42, 0.95));

  // —— 层 4 的可见部分：有界 bloom 代理（面向相机的柔光盘，半径随强度增长）——
  // `TUNED_PRESENTATION`：这不是后期 bloom pass，而是一个受同一曝光增益约束的
  // 柔光代理，因此不会因为叠加而把整屏推到白。
  const bloomMat = track(new THREE.SpriteMaterial({
    color: CHERENKOV_COLOR.clone(), transparent: true, opacity: 0,
    depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const bloom = new THREE.Sprite(bloomMat);
  bloom.position.set(0, coreCenterY, 0);
  bloom.renderOrder = 4;
  bloom.raycast = () => {};
  group.add(bloom);

  // —— 层 3：光传播粒子代理（TUNED_PRESENTATION）——
  // `prefers-reduced-motion: reduce` 下**完全不发射**移动粒子：功率反馈由体积辉光和
  // bloom 承担（两者都是静态强度，不含持续运动），画面因此仍然完整可读。
  const COUNT = reduceMotion ? 0 : Math.max(0, Math.round(particleBudget));
  const rng = makeRng(0x5ce7ab1);
  const pPos = new Float32Array(COUNT * 3);
  const pVel = new Float32Array(COUNT * 3);
  const pAlpha = new Float32Array(COUNT);
  const pScale = new Float32Array(COUNT);
  const pLife = new Float32Array(COUNT);
  const pMax = new Float32Array(COUNT);
  const pGeo = track(new THREE.BufferGeometry());
  pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute("aAlpha", new THREE.BufferAttribute(pAlpha, 1));
  pGeo.setAttribute("aScale", new THREE.BufferAttribute(pScale, 1));
  // 粒子始终在堆芯附近的水体里：给一个固定包围球，避免逐帧重算并防止被错误剔除
  pGeo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, coreCenterY, 0), coreR * 6 + coreH);

  const pMat = track(new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
    uniforms: Object.assign({
      uColor: { value: CHERENKOV_COLOR.clone() },
      uSize: { value: 34 },
      uIntensity: { value: 0 }
    }, waterUniforms()),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const points = new THREE.Points(pGeo, pMat);
  points.renderOrder = 5;
  points.frustumCulled = false;
  points.raycast = () => {};
  if (COUNT > 0) group.add(points);   // reduced-motion：连绘制调用一起省掉

  // 从堆芯发光体积采样起点（CHR-002：起点来自体积，不是水面或相机）
  function spawn(i) {
    const r = coreR * Math.sqrt(rng()) * 0.98;
    const a = rng() * Math.PI * 2;
    const y = coreCenterY + (rng() - 0.5) * coreH;
    pPos[i * 3] = Math.cos(a) * r;
    pPos[i * 3 + 1] = y;
    pPos[i * 3 + 2] = Math.sin(a) * r;
    // 速度表达"光在水中向外传播/散射"的视觉近似：向外为主、略微上浮
    const outward = 0.32 + rng() * 0.5;
    pVel[i * 3] = Math.cos(a) * outward;
    pVel[i * 3 + 1] = 0.18 + rng() * 0.42;
    pVel[i * 3 + 2] = Math.sin(a) * outward;
    pMax[i] = 1.5 + rng() * 1.3;
    pLife[i] = 0;
    pScale[i] = 0.55 + rng() * 0.9;
    pAlpha[i] = 0;
  }
  for (let i = 0; i < COUNT; i++) { spawn(i); pLife[i] = pMax[i]; } // 起始全部处于"已消亡"

  let alive = 0;
  let spawnAcc = 0;
  let exposure = 1;
  let raw = 0;
  let corePath = 0;            // 相机 → 堆芯中心之间的水体光程
  let coreTransmittance = 1;

  const coreCenter = new THREE.Vector3(0, coreCenterY, 0);
  // 相机位置与浸没权重的唯一入口（physicalScene 每帧在 applyCamera 里调用）。
  // 四层表现共享这两个量，因此水面跨越、水体衰减和辉光强度不会各说各话。
  function setViewer(camWorldPos, submersion = 0) {
    viewerPos.value.copy(camWorldPos);
    submersionUniform.value = clamp(submersion, 0, 1);
    corePath = waterPathLength(camWorldPos, coreCenter, surfaceY);
    coreTransmittance = Math.exp(-corePath * WATER_ABSORB) * (1 + 0.18 * submersionUniform.value);
  }

  function update(dt, sessionState) {
    raw = sessionState ? clamp(intensityOf(sessionState), 0, 4) : 0;

    // —— 有界曝光：峰值软压缩 + 非对称时间常数（脉冲后平滑恢复）——
    const wanted = exposureGain(raw);
    const tau = wanted < exposure ? EXPOSURE.attack : (reduceMotion ? EXPOSURE.release * 2 : EXPOSURE.release);
    exposure += (wanted - exposure) * clamp(dt / Math.max(tau, 1e-3), 0, 1);
    const shown = raw * exposure;

    layers.forEach(l => { l.mat.uniforms.uIntensity.value = shown * l.scale; });
    // bloom 是精灵，没有片元世界位置可用：在 CPU 端沿相机→堆芯中心算同一条水体
    // 光程，因此它与体积/粒子读的是同一套水面、相机位置和吸收（CHR-002）。
    bloomMat.opacity = clamp(shown * 0.34 * coreTransmittance, 0, 0.55);
    const bs = coreR * (2.2 + shown * 2.6);
    bloom.scale.set(bs, bs, 1);
    pMat.uniforms.uIntensity.value = shown;

    if (COUNT === 0) return;

    // 发射率由功率状态确定（CHR-002）：停堆 → 不发射，池水里没有蓝点
    const rate = shown > 0.02 ? COUNT * clamp(shown, 0, 1) * 0.55 : 0;
    spawnAcc += rate * dt;
    let budget = Math.min(Math.floor(spawnAcc), Math.ceil(COUNT * 0.08));
    spawnAcc -= budget;

    alive = 0;
    const posAttr = pGeo.attributes.position;
    for (let i = 0; i < COUNT; i++) {
      if (pLife[i] >= pMax[i]) {
        if (budget > 0) { spawn(i); budget--; } else { pAlpha[i] = 0; continue; }
      }
      pLife[i] += dt;
      const k = i * 3;
      pPos[k] += pVel[k] * dt;
      pPos[k + 1] += pVel[k + 1] * dt;
      pPos[k + 2] += pVel[k + 2] * dt;
      // 水面之上没有切伦科夫：粒子在名义水面下消亡（辉光不悬在空气里，CHR-003）
      if (pPos[k + 1] > surfaceY - 0.05) { pLife[i] = pMax[i]; pAlpha[i] = 0; continue; }
      const t = pLife[i] / pMax[i];
      // 起亮 → 沿传播衰减：水中光程越长越暗
      pAlpha[i] = Math.sin(Math.min(t, 1) * Math.PI) * 0.85;
      alive++;
    }
    posAttr.needsUpdate = true;
    pGeo.attributes.aAlpha.needsUpdate = true;
    pGeo.attributes.aScale.needsUpdate = true;
  }

  function snapshot() {
    return {
      raw: +raw.toFixed(4),
      exposure: +exposure.toFixed(4),
      shown: +(raw * exposure).toFixed(4),
      particles: alive,
      budget: COUNT,
      coreCenterY: +coreCenterY.toFixed(3),
      // 统一水体光程状态（CHR-002 / WTR-002）：相机到堆芯中心穿过的水层厚度、
      // 由它得到的透射率、以及与水面/雾共用的连续浸没权重
      corePathLength: +corePath.toFixed(3),
      coreTransmittance: +coreTransmittance.toFixed(4),
      submersion: +submersionUniform.value.toFixed(4)
    };
  }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  return { group, update, setViewer, dispose, snapshot, particleBudget: COUNT };
}
