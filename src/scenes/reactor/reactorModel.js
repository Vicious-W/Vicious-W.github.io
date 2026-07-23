// 唯一页面场景中的三维开放式水池研究堆原型。
// 主要系统分别拥有 Three.js 几何、材质、状态和更新逻辑；当前真实性边界与开放
// 差距见 docs/engineering/REACTOR_MODEL.md。
//
// 构型基线：**Pavia TRIGA Mark II 开放式轻水池研究堆**。选它是因为
// 它的构图恰好是「从水池正上方俯视堆芯」，而且公开资料充分：
//   · 堆芯是圆柱形，燃料元件使用同心圆形阵列，而不是压水堆的方形组件棋盘。
//   · 圆柱形 UZrH 燃料元件（约 3.76 cm 直径），上下各一块铝制栅格板夹持。
//   · Pavia 构型使用 SHIM、REG、TRANS 三根控制棒，插入/抽出改变反应性。
//   · 当前连续石墨反射体环是待资料校正的网页近似。
//   · 开放水池，切伦科夫辉光集中在燃料棒正上方，偏蓝白/带紫。
//
// 公开资料来源：
//   · General Atomics TRIGA 产品页 https://www.ga.com/fission-energy-systems/triga-products-technologies/
//   · Pavia TRIGA Mark II 稳态表征 https://arxiv.org/pdf/1503.00873
//     （堆芯直径 44.6 cm、五个同心燃料环、三根控制棒）
//   · Oregon State 1.1 MW TRIGA Mark II
//     https://engineering.oregonstate.edu/NSE/research-innovation/facilities/11-mw-triga-mark-ii-pulsing-research-reactor
//   · U.S. DOE 切伦科夫辐射说明 https://www.energy.gov/ne/articles/cherenkov-radiation-explained
//
// 刻意的抽象（为网页表达服务，不声称工程精度）：
//   · 当前环位置数按 6n 规则（1+6+12+18+24+30=91）生成，与 Pavia 五环构型不一致；
//   · 当前四根控制棒是暂定视觉构型，与 Pavia 三棒构型不一致；
//   · 栅格板不做逐孔布尔运算，用薄板+棒顶穿出表示；
//   · 尺度做了统一归一（以玻璃立方体边长为基准单位），非真实厘米数；
//   · 切伦科夫辉光用加性发光盘 + 点光源 + 燃料自发光的组合近似，不做体积光追。
//
// 当前视觉状态链（可解释，但不是反应堆动力学计算）：
//   控制棒缓慢抽出/插入(rodInsertion) → 堆芯功率代理(power) 带迟滞跟随 →
//   燃料自发光 + 切伦科夫辉光 + 池壁照明点光源 + 桥上功率指示条 同步响应。

import * as THREE from "three";

// —— 归一化尺度（世界单位，1 = 玻璃立方体边长）——
const POOL_RADIUS = 3.4;     // 水池内衬半径
const POOL_DEPTH = 6.5;      // 水面(y=0)到池底
const CORE_RING_F = 1.15;    // 最外燃料环(F)半径
const PITCH = CORE_RING_F / 5;
const ROD_R = 0.085;         // 燃料元件半径
const CORE_TOP = -0.42;      // 燃料活性段顶
const CORE_H = 1.72;         // 燃料活性段高
const GRID_Y = -0.5;         // 上栅格板顶面
const REFL_IN = 1.32;        // 石墨反射体内半径
const REFL_OUT = 1.68;       // 石墨反射体外半径
const CTRL_TRAVEL = 1.45;    // 控制棒行程

// 环定义：{ n: 环序, count: 位置数 }
const RINGS = [
  { n: 0, count: 1 },
  { n: 1, count: 6 },
  { n: 2, count: 12 },
  { n: 3, count: 18 },
  { n: 4, count: 24 },
  { n: 5, count: 30 }
];

const CHERENKOV = new THREE.Color(0.45, 0.72, 1.0);

// 加性辉光盘：从正上方看到的切伦科夫泛光。alpha 按半径高斯衰减，强度由功率驱动。
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
uniform float uCore;   // 内核更亮的比例
varying vec2 vUv;
void main() {
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d);
  float halo = exp(-r * r * 2.4);
  float core = exp(-r * r * 9.0) * uCore;
  float a = clamp((halo + core) * uIntensity, 0.0, 1.0);
  gl_FragColor = vec4(uColor * (halo + core) * uIntensity, a);
}`;

function ringPositions(n, count) {
  const out = [];
  const radius = n * PITCH;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (n % 2) * 0.25;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

export function createReactorModel({ reduceMotion }) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // ——————————————————————————— 材质 ———————————————————————————
  const linerMat = track(new THREE.MeshStandardMaterial({
    color: 0x2a4a63, metalness: 0.65, roughness: 0.42, side: THREE.BackSide
  }));
  const floorMat = track(new THREE.MeshStandardMaterial({
    color: 0x16303f, metalness: 0.5, roughness: 0.6
  }));
  const deckMat = track(new THREE.MeshStandardMaterial({
    color: 0x1c2733, metalness: 0.4, roughness: 0.82
  }));
  const gridMat = track(new THREE.MeshStandardMaterial({
    color: 0x8fa6b4, metalness: 0.85, roughness: 0.36
  }));
  const graphiteMat = track(new THREE.MeshStandardMaterial({
    color: 0x14171b, metalness: 0.15, roughness: 0.92
  }));
  const nozzleMat = track(new THREE.MeshStandardMaterial({
    color: 0x6f8391, metalness: 0.85, roughness: 0.4
  }));
  const absorberMat = track(new THREE.MeshStandardMaterial({
    color: 0x0e1013, metalness: 0.6, roughness: 0.5
  }));
  const steelMat = track(new THREE.MeshStandardMaterial({
    color: 0x59636d, metalness: 0.8, roughness: 0.45
  }));
  const bridgeMat = track(new THREE.MeshStandardMaterial({
    color: 0x323b44, metalness: 0.7, roughness: 0.55
  }));
  const thimbleMat = track(new THREE.MeshStandardMaterial({
    color: 0x44525c, metalness: 0.75, roughness: 0.5
  }));

  // 燃料自发光分三档，制造「一束束独立发光棒」的亮度差；发光强度逐帧随功率更新。
  const fuelTierMats = [0.62, 0.92, 1.3].map(() => track(new THREE.MeshStandardMaterial({
    color: 0x1a2a3a, metalness: 0.35, roughness: 0.45,
    emissive: new THREE.Color(0.5, 0.74, 1.0), emissiveIntensity: 0.5
  })));
  const fuelTierBase = [0.62, 0.92, 1.3];

  // ——————————————————————————— 池体 / 内衬 / 甲板 ———————————————————————————
  const liner = new THREE.Mesh(
    track(new THREE.CylinderGeometry(POOL_RADIUS, POOL_RADIUS, POOL_DEPTH, 64, 1, true)),
    linerMat);
  liner.position.y = -POOL_DEPTH / 2;
  group.add(liner);

  const poolFloor = new THREE.Mesh(
    track(new THREE.CircleGeometry(POOL_RADIUS, 64)), floorMat);
  poolFloor.rotation.x = -Math.PI / 2;
  poolFloor.position.y = -POOL_DEPTH;
  group.add(poolFloor);

  // 甲板：水面高度的大环形平台，中间开口露出水池。玻璃立方体就落在这一层上。
  const deck = new THREE.Mesh(
    track(new THREE.RingGeometry(POOL_RADIUS, 42, 96, 1)), deckMat);
  deck.rotation.x = -Math.PI / 2;
  deck.position.y = -0.001;
  group.add(deck);

  // 池口内圈一道井唇（略高的金属环），让开口边缘有立体厚度
  const curb = new THREE.Mesh(
    track(new THREE.CylinderGeometry(POOL_RADIUS, POOL_RADIUS, 0.16, 64, 1, true)),
    steelMat);
  curb.position.y = -0.08;
  group.add(curb);

  // ——————————————————————————— 石墨反射体环 ———————————————————————————
  const reflector = new THREE.Mesh(
    track(new THREE.CylinderGeometry(REFL_OUT, REFL_OUT, CORE_H + 0.5, 48, 1, true)),
    graphiteMat);
  reflector.position.y = CORE_TOP - (CORE_H + 0.5) / 2 + 0.1;
  group.add(reflector);
  const reflectorIn = new THREE.Mesh(
    track(new THREE.CylinderGeometry(REFL_IN, REFL_IN, CORE_H + 0.5, 48, 1, true)),
    graphiteMat);
  reflectorIn.position.copy(reflector.position);
  reflectorIn.scale.x = -1; // 内壁朝里
  group.add(reflectorIn);
  // 反射体顶环盖住内外壁之间的空腔
  const reflectorTop = new THREE.Mesh(
    track(new THREE.RingGeometry(REFL_IN, REFL_OUT, 48, 1)), graphiteMat);
  reflectorTop.rotation.x = -Math.PI / 2;
  reflectorTop.position.y = CORE_TOP + 0.1;
  group.add(reflectorTop);

  // ——————————————————————————— 栅格板 ———————————————————————————
  const gridPlate = new THREE.Mesh(
    track(new THREE.CylinderGeometry(REFL_IN + 0.02, REFL_IN + 0.02, 0.09, 48)), gridMat);
  gridPlate.position.y = GRID_Y - 0.045;
  group.add(gridPlate);
  const bottomPlate = new THREE.Mesh(
    track(new THREE.CylinderGeometry(REFL_IN + 0.02, REFL_IN + 0.02, 0.09, 48)), gridMat);
  bottomPlate.position.y = CORE_TOP - CORE_H - 0.05;
  group.add(bottomPlate);

  // ——————————————————————————— 生成堆芯位置 ———————————————————————————
  // 先算出所有格位，再挑 4 个作控制棒（D 环，90° 对称），其余放燃料。
  const lattice = [];
  RINGS.forEach(({ n, count }) => {
    ringPositions(n, count).forEach(([x, z], i) => {
      lattice.push({ x, z, ring: n, idx: i, angle: Math.atan2(z, x) });
    });
  });
  // 控制棒：D 环(n=3) 里最接近 0/90/180/270° 的 4 个格位
  const ctrlTargets = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const ctrlSet = new Set();
  ctrlTargets.forEach(target => {
    let best = null, bestD = 1e9;
    lattice.forEach((p, i) => {
      if (p.ring !== 3 || ctrlSet.has(i)) return;
      let d = Math.abs(((p.angle - target + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== null) ctrlSet.add(best);
  });

  const fuelCells = [];
  const ctrlCells = [];
  lattice.forEach((p, i) => {
    if (ctrlSet.has(i)) ctrlCells.push(p);
    else if (p.ring === 0) fuelCells.push(p); // 中心也放一根（近似中央燃料/实验位）
    else fuelCells.push(p);
  });

  // ——————————————————————————— 燃料元件（InstancedMesh × 3 档）———————————————————————————
  const rodGeo = track(new THREE.CylinderGeometry(ROD_R, ROD_R, CORE_H, 12));
  const nozzleGeo = track(new THREE.CylinderGeometry(ROD_R * 1.15, ROD_R * 1.15, 0.14, 12));
  const tierCells = [[], [], []];
  fuelCells.forEach((p, i) => {
    // 稳定的伪随机档位分配
    const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    tierCells[h < 0.4 ? 0 : h < 0.75 ? 1 : 2].push(p);
  });
  const fuelMeshes = [];
  const nozzleMeshes = [];
  const dummy = new THREE.Object3D();
  tierCells.forEach((cells, t) => {
    if (!cells.length) return;
    const im = new THREE.InstancedMesh(rodGeo, fuelTierMats[t], cells.length);
    const nm = new THREE.InstancedMesh(nozzleGeo, nozzleMat, cells.length);
    cells.forEach((p, k) => {
      dummy.position.set(p.x, CORE_TOP - CORE_H / 2, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      im.setMatrixAt(k, dummy.matrix);
      dummy.position.set(p.x, CORE_TOP + 0.03, p.z);
      dummy.updateMatrix();
      nm.setMatrixAt(k, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    nm.instanceMatrix.needsUpdate = true;
    group.add(im); group.add(nm);
    fuelMeshes.push(im); nozzleMeshes.push(nm);
  });

  // ——————————————————————————— 控制棒 + 驱动机构 ———————————————————————————
  // 每根控制棒是一个可上下移动的组：吸收体 + 连接杆，套在固定的导向套管里。
  const ctrlAssemblies = [];
  const absGeo = track(new THREE.CylinderGeometry(ROD_R * 1.35, ROD_R * 1.35, CORE_H + 0.2, 14));
  const shaftGeo = track(new THREE.CylinderGeometry(0.05, 0.05, 4.2, 10));
  const housingGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 1.25, 16));
  ctrlCells.forEach(p => {
    const asm = new THREE.Group();
    const absorber = new THREE.Mesh(absGeo, absorberMat);
    absorber.position.set(p.x, CORE_TOP - (CORE_H + 0.2) / 2, p.z);
    asm.add(absorber);
    const shaft = new THREE.Mesh(shaftGeo, steelMat);
    shaft.position.set(p.x, CORE_TOP + 2.0, p.z); // 上端伸进套管
    asm.add(shaft);
    group.add(asm);
    // 固定导向套管（不随棒移动，遮住连接杆上段）
    const housing = new THREE.Mesh(housingGeo, steelMat);
    housing.position.set(p.x, 2.05, p.z);
    group.add(housing);
    ctrlAssemblies.push(asm);
  });

  // 驱动桥：跨过水池的细金属桁架，控制棒套管挂在上面。做细、做暗，只是支撑结构，
  // 不能读成一根盖住画面的粗横梁。
  const bridge = new THREE.Mesh(
    track(new THREE.BoxGeometry(POOL_RADIUS * 2 + 0.6, 0.14, 0.2)), bridgeMat);
  bridge.position.set(0, 2.7, 0);
  group.add(bridge);
  const bridge2 = new THREE.Mesh(
    track(new THREE.BoxGeometry(0.2, 0.14, POOL_RADIUS * 2 + 0.6)), bridgeMat);
  bridge2.position.set(0, 2.7, 0);
  group.add(bridge2);

  // ——————————————————————————— 冷却 / 仪器结构 ———————————————————————————
  // 两根伸进水池的辐照/束流导管（细长金属管）+ 一段沿壁的冷却回路管。
  const thimbleGeo = track(new THREE.CylinderGeometry(0.11, 0.11, 5.4, 16));
  [[2.0, 1.1], [-1.7, -1.6]].forEach(([tx, tz]) => {
    const th = new THREE.Mesh(thimbleGeo, thimbleMat);
    th.position.set(tx, -2.5, tz);
    group.add(th);
  });
  // 沿池壁下行的冷却管（竖管 + 一段横管）
  const coolVert = new THREE.Mesh(
    track(new THREE.CylinderGeometry(0.14, 0.14, POOL_DEPTH - 1.0, 16)), thimbleMat);
  coolVert.position.set(POOL_RADIUS - 0.25, -(POOL_DEPTH) / 2, 0);
  group.add(coolVert);
  const coolElbow = new THREE.Mesh(
    track(new THREE.CylinderGeometry(0.14, 0.14, 1.4, 16)), thimbleMat);
  coolElbow.rotation.z = Math.PI / 2;
  coolElbow.position.set(POOL_RADIUS - 0.9, -POOL_DEPTH + 0.5, 0);
  group.add(coolElbow);

  // ——————————————————————————— 功率指示条（仪器活动）———————————————————————————
  // 桥上一排小段，随功率点亮数量增加，绿→琥珀。这是控制链末端可见的仪器响应。
  const SEG_TOTAL = 12;
  const segMats = [];
  const segGeo = track(new THREE.BoxGeometry(0.09, 0.05, 0.12));
  for (let i = 0; i < SEG_TOTAL; i++) {
    const m = track(new THREE.MeshStandardMaterial({
      color: 0x0a141b, emissive: new THREE.Color(0, 0, 0), emissiveIntensity: 1
    }));
    const seg = new THREE.Mesh(segGeo, m);
    seg.position.set(-0.66 + i * 0.12, 2.78, POOL_RADIUS + 0.1);
    group.add(seg);
    segMats.push(m);
  }

  // ——————————————————————————— 切伦科夫辉光 ———————————————————————————
  const glowMat = track(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: CHERENKOV.clone() },
      uIntensity: { value: 0.6 },
      uCore: { value: 1.4 }
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const glowDisc = new THREE.Mesh(track(new THREE.PlaneGeometry(REFL_OUT * 2.1, REFL_OUT * 2.1)), glowMat);
  glowDisc.rotation.x = -Math.PI / 2;
  glowDisc.position.y = CORE_TOP + 0.16;
  group.add(glowDisc);
  // 更大更淡的一圈池水泛蓝
  const haloMat = track(new THREE.ShaderMaterial({
    vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(0.2, 0.42, 0.85) },
      uIntensity: { value: 0.3 },
      uCore: { value: 0.2 }
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
  }));
  const halo = new THREE.Mesh(track(new THREE.PlaneGeometry(POOL_RADIUS * 2, POOL_RADIUS * 2)), haloMat);
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = CORE_TOP + 0.06;
  group.add(halo);

  // 池壁照明：核心处一盏蓝色点光，强度随功率变化，把池壁/反射体/甲板照亮
  const coreLight = new THREE.PointLight(0x8fc0ff, 6, 14, 1.8);
  coreLight.position.set(0, CORE_TOP - 0.4, 0);
  group.add(coreLight);

  // ——————————————————————————— 状态 / 运行链 ———————————————————————————
  const state = { t: 0, rodInsertion: 0.55, power: 0.45 };

  const applyStatic = (power, insertion) => {
    // 控制棒位置：insertion=1 全插入(最低)，=0 抽出(上移 CTRL_TRAVEL)
    const lift = (1 - insertion) * CTRL_TRAVEL;
    ctrlAssemblies.forEach(a => { a.position.y = lift; });
    // 燃料自发光
    fuelMeshes.forEach((im, t) => { fuelTierMats[t].emissiveIntensity = fuelTierBase[t] * power; });
    // 辉光
    glowMat.uniforms.uIntensity.value = 0.25 + power * 1.5;
    haloMat.uniforms.uIntensity.value = 0.12 + power * 0.5;
    coreLight.intensity = 1.2 + power * 15;
    // 指示条：绿(低)→琥珀(高)
    const lit = Math.round(power * SEG_TOTAL);
    segMats.forEach((m, i) => {
      if (i < lit) {
        const f = i / SEG_TOTAL;
        m.emissive.setRGB(0.2 + f * 0.9, 0.9 - f * 0.35, 0.15);
        m.emissiveIntensity = 1.1;
      } else {
        m.emissive.setRGB(0, 0, 0);
      }
    });
  };

  applyStatic(state.power, state.rodInsertion);

  const update = (dt, time) => {
    if (reduceMotion) return; // 静止模式：保持已应用的静帧
    state.t += dt;
    // 控制棒缓慢抽出/插入（机械迟滞）
    const target = 0.5 - 0.42 * Math.sin(state.t * 0.10);
    state.rodInsertion += (target - state.rodInsertion) * Math.min(dt * 0.5, 1);
    // 功率代理带迟滞跟随反应性（抽出越多功率越高）
    const targetPower = THREE.MathUtils.clamp(1 - state.rodInsertion, 0.05, 1);
    state.power += (targetPower - state.power) * Math.min(dt * 0.8, 1);
    // 中子通量的细碎闪烁（切伦科夫由大量独立粒子事件构成）
    const flick = 1 + 0.05 * Math.sin(time * 6.3) + 0.03 * Math.sin(time * 17.0 + 1.3);
    applyStatic(state.power * flick, state.rodInsertion);
  };

  const setScale = shortExtent => {
    const s = THREE.MathUtils.clamp(shortExtent / 8, 0.55, 1.2);
    group.scale.setScalar(s);
  };

  const dispose = () => {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  };

  return { group, update, setScale, dispose, getState: () => state };
}
