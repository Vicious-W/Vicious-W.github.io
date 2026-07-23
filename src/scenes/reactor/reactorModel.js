// 唯一页面场景中的三维 Pavia TRIGA Mark II 反应堆池系统。
// 完整系统边界、部件清单和运行程序见 docs/engineering/REACTOR_POOL_SYSTEM.md；
// 堆芯格位、资料事实分类和差距清单见 docs/engineering/REACTOR_MODEL.md；
// 场景级拓扑、耦合和重置规则见 docs/engineering/SOURCE_SCENE.md。
//
// 本模块只负责几何、材质与状态到视觉的映射；连续运行的状态本身由
// sessionController.js 计算，轻水由 waterSystem.js 独立求解，玻璃与损伤由
// physicalScene.js / glassDamage.js 处理。
//
// 每个主要部件都标注对应的 RP-* ID（见 REACTOR_POOL_SYSTEM.md §3）。资料标签：
//   SOURCE_VERIFIED  直接来自 Pavia/IAEA/General Atomics 资料；
//   TRIGA_ANALOGUE   来自不冲突的同型 TRIGA 设施；
//   REALTIME_PROXY   网页实时表达的明确近似；
//   TUNED_PRESENTATION 只调整可观察性，不改变因果顺序。

import * as THREE from "three";

// —— 归一化尺度（世界单位，1 = 玻璃立方体边长）—— REALTIME_PROXY 统一比例尺
export const POOL_RADIUS = 3.4;       // RP-002 水箱内衬半径
export const POOL_DEPTH = 6.5;        // 水面到池底
export const WATER_SURFACE_Y = -0.35; // 轻水自由液面（格栅之下，留出可见的池口空气层）
const CORE_RING_F = 1.15;             // 最外燃料环(F)半径
const PITCH = CORE_RING_F / 5;
const ROD_R = 0.085;                  // 燃料元件半径，SOURCE_VERIFIED 比例（直径约 3.76 cm）换算
const CORE_TOP = -1.9;                // 燃料活性段顶（堆芯浸没于水面之下）
const CORE_H = 1.72;                  // 燃料活性段高
const GRID_Y = CORE_TOP + 0.08;       // 上栅格板顶面
const REFL_IN = 1.32;                 // 石墨反射体内半径
const REFL_OUT = 1.68;                // 石墨反射体外半径
const CTRL_TRAVEL = 1.55;             // 控制棒视觉行程，从堆芯顶部升到桥架

const WALK_R = 4.05;                  // RP-001 上部作业面外半径
const SHIELD_R = 4.9;                 // RP-001 生物屏蔽八角外半径
const SHIELD_TOP = 1.3;               // 屏蔽体上沿（高于池口甲板）
const SHIELD_BOTTOM = -POOL_DEPTH - 0.5;
const BRIDGE_Y = 2.55;                // RP-003 桥架高度

// 环定义：{ n: 环序, count: 位置数 }。n=0 为中央 A 位（辐照套管，不计入 90）；
// n=1..5 依次是 B–F 五环，合计 90 个元件位置（SOURCE_VERIFIED，arXiv:1503.00873）。
const RINGS = [
  { n: 0, count: 1 },
  { n: 1, count: 6 },
  { n: 2, count: 12 },
  { n: 3, count: 18 },
  { n: 4, count: 24 },
  { n: 5, count: 30 }
];

function ringPositions(n, count) {
  const out = [];
  const radius = n * PITCH;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (n % 2) * 0.25;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  return out;
}

function pickNearest(lattice, ring, targetAngle, taken) {
  let best = null, bestD = Infinity;
  lattice.forEach((p, i) => {
    if (p.ring !== ring || taken.has(i)) return;
    const d = Math.abs(((p.angle - targetAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best !== null) taken.add(best);
  return best;
}

export function createReactorModel({ reduceMotion }) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };

  // ——————————————————————————— 材质 ———————————————————————————
  const linerMat = track(new THREE.MeshStandardMaterial({ color: 0x2a4a63, metalness: 0.65, roughness: 0.42, side: THREE.BackSide }));
  const linerOuterMat = track(new THREE.MeshStandardMaterial({ color: 0x3a5f7d, metalness: 0.7, roughness: 0.35 }));
  const floorMat = track(new THREE.MeshStandardMaterial({ color: 0x16303f, metalness: 0.5, roughness: 0.6 }));
  const deckMat = track(new THREE.MeshStandardMaterial({ color: 0x1c2733, metalness: 0.4, roughness: 0.82 }));
  const shieldMat = track(new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.05, roughness: 0.95 }));
  const railMat = track(new THREE.MeshStandardMaterial({ color: 0x8a95a0, metalness: 0.8, roughness: 0.4 }));
  const gridMat = track(new THREE.MeshStandardMaterial({ color: 0x8fa6b4, metalness: 0.85, roughness: 0.36 }));
  const graphiteMat = track(new THREE.MeshStandardMaterial({ color: 0x14171b, metalness: 0.15, roughness: 0.92 }));
  const dummyMat = track(new THREE.MeshStandardMaterial({ color: 0x1b1e22, metalness: 0.1, roughness: 0.9 }));
  const sourceMat = track(new THREE.MeshStandardMaterial({ color: 0x8a5a1e, metalness: 0.5, roughness: 0.5, emissive: 0x1a0f00, emissiveIntensity: 0.4 }));
  const nozzleMat = track(new THREE.MeshStandardMaterial({ color: 0x6f8391, metalness: 0.85, roughness: 0.4 }));
  const absorberMat = track(new THREE.MeshStandardMaterial({ color: 0x0e1013, metalness: 0.6, roughness: 0.5 }));
  const transAbsorberMat = track(new THREE.MeshStandardMaterial({ color: 0x241014, metalness: 0.55, roughness: 0.5 }));
  const steelMat = track(new THREE.MeshStandardMaterial({ color: 0x59636d, metalness: 0.8, roughness: 0.45 }));
  const bridgeMat = track(new THREE.MeshStandardMaterial({ color: 0x323b44, metalness: 0.7, roughness: 0.55 }));
  const thimbleMat = track(new THREE.MeshStandardMaterial({ color: 0x44525c, metalness: 0.75, roughness: 0.5 }));
  const pneumaticMat = track(new THREE.MeshStandardMaterial({ color: 0x4a4038, metalness: 0.6, roughness: 0.5 }));
  const cableMat = track(new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.1, roughness: 0.7 }));
  const conduitMat = track(new THREE.MeshStandardMaterial({ color: 0x6a7078, metalness: 0.75, roughness: 0.4 }));
  const gratingBarMat = track(new THREE.MeshStandardMaterial({ color: 0x9fb0bb, metalness: 0.85, roughness: 0.32 }));
  const gratingBackingMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xbfe0ff, metalness: 0, roughness: 0.15, transmission: 0.85, thickness: 0.08,
    ior: 1.46, transparent: true, opacity: 0.55, depthWrite: false
  }));

  const fuelTierMats = [0.62, 0.92, 1.3].map(() => track(new THREE.MeshStandardMaterial({
    color: 0x1a2a3a, metalness: 0.35, roughness: 0.45,
    emissive: new THREE.Color(0.5, 0.74, 1.0), emissiveIntensity: 0.5
  })));
  const fuelTierBase = [0.62, 0.92, 1.3];

  // ——————————————————————————— RP-002 铝制水箱 ———————————————————————————
  const liner = new THREE.Mesh(track(new THREE.CylinderGeometry(POOL_RADIUS, POOL_RADIUS, POOL_DEPTH, 64, 1, true)), linerMat);
  liner.position.y = -POOL_DEPTH / 2;
  group.add(liner);
  const linerOuter = new THREE.Mesh(track(new THREE.CylinderGeometry(POOL_RADIUS + 0.12, POOL_RADIUS + 0.12, POOL_DEPTH * 0.18, 64, 1, true)), linerOuterMat);
  linerOuter.position.y = -0.1 - (POOL_DEPTH * 0.18) / 2;
  group.add(linerOuter); // 池口段外壁厚度可见

  const poolFloor = new THREE.Mesh(track(new THREE.CircleGeometry(POOL_RADIUS, 64)), floorMat);
  poolFloor.rotation.x = -Math.PI / 2;
  poolFloor.position.y = -POOL_DEPTH;
  group.add(poolFloor);

  const curb = new THREE.Mesh(track(new THREE.CylinderGeometry(POOL_RADIUS, POOL_RADIUS, 0.16, 64, 1, true)), steelMat);
  curb.position.y = -0.08;
  group.add(curb);

  // 上部作业面（RP-001）：池口与屏蔽体之间的环形走道
  const walkway = new THREE.Mesh(track(new THREE.RingGeometry(POOL_RADIUS, WALK_R, 64, 1)), deckMat);
  walkway.rotation.x = -Math.PI / 2;
  walkway.position.y = -0.02;
  group.add(walkway);

  // ——————————————————————————— RP-001 生物屏蔽 ———————————————————————————
  const shieldBody = new THREE.Mesh(track(new THREE.CylinderGeometry(SHIELD_R, SHIELD_R, SHIELD_TOP - SHIELD_BOTTOM, 8, 1, true)), shieldMat);
  shieldBody.position.y = (SHIELD_TOP + SHIELD_BOTTOM) / 2;
  shieldBody.rotation.y = Math.PI / 8;
  group.add(shieldBody);
  const shieldTopCap = new THREE.Mesh(track(new THREE.RingGeometry(WALK_R, SHIELD_R, 8, 1)), shieldMat);
  shieldTopCap.rotation.x = -Math.PI / 2;
  shieldTopCap.rotation.z = Math.PI / 8;
  shieldTopCap.position.y = SHIELD_TOP;
  group.add(shieldTopCap);

  // 栏杆：立柱 InstancedMesh + 顶部圆环
  const railPostGeo = track(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 6));
  const RAIL_N = 40;
  const railPosts = new THREE.InstancedMesh(railPostGeo, railMat, RAIL_N);
  const dummyObj = new THREE.Object3D();
  for (let i = 0; i < RAIL_N; i++) {
    const a = (i / RAIL_N) * Math.PI * 2;
    dummyObj.position.set(Math.cos(a) * (WALK_R - 0.08), 0.3, Math.sin(a) * (WALK_R - 0.08));
    dummyObj.rotation.set(0, 0, 0);
    dummyObj.updateMatrix();
    railPosts.setMatrixAt(i, dummyObj.matrix);
  }
  railPosts.instanceMatrix.needsUpdate = true;
  group.add(railPosts);
  const railTop = new THREE.Mesh(track(new THREE.TorusGeometry(WALK_R - 0.08, 0.03, 8, 48)), railMat);
  railTop.rotation.x = Math.PI / 2;
  railTop.position.y = 0.56;
  group.add(railTop);

  // 简化楼梯：一侧从走道降到大厅地面的踏步
  const stepGeo = track(new THREE.BoxGeometry(0.6, 0.09, 0.28));
  const STEP_N = 6;
  const stairs = new THREE.InstancedMesh(stepGeo, deckMat, STEP_N);
  for (let i = 0; i < STEP_N; i++) {
    const a = Math.PI * 1.05;
    const r = WALK_R + 0.3 + i * 0.32;
    dummyObj.position.set(Math.cos(a) * r, -0.1 - i * 0.22, Math.sin(a) * r);
    dummyObj.rotation.set(0, -a, 0);
    dummyObj.updateMatrix();
    stairs.setMatrixAt(i, dummyObj.matrix);
  }
  stairs.instanceMatrix.needsUpdate = true;
  group.add(stairs);

  // ——————————————————————————— RP-004 石墨反射体 ———————————————————————————
  const reflector = new THREE.Mesh(track(new THREE.CylinderGeometry(REFL_OUT, REFL_OUT, CORE_H + 0.5, 48, 1, true)), graphiteMat);
  reflector.position.y = CORE_TOP - (CORE_H + 0.5) / 2 + 0.1;
  group.add(reflector);
  const reflectorIn = new THREE.Mesh(track(new THREE.CylinderGeometry(REFL_IN, REFL_IN, CORE_H + 0.5, 48, 1, true)), graphiteMat);
  reflectorIn.position.copy(reflector.position);
  reflectorIn.scale.x = -1;
  group.add(reflectorIn);
  const reflectorTop = new THREE.Mesh(track(new THREE.RingGeometry(REFL_IN, REFL_OUT, 48, 1)), graphiteMat);
  reflectorTop.rotation.x = -Math.PI / 2;
  reflectorTop.position.y = CORE_TOP + 0.1;
  group.add(reflectorTop);

  // 栅格板 + 池底支承腿
  const gridPlate = new THREE.Mesh(track(new THREE.CylinderGeometry(REFL_IN + 0.02, REFL_IN + 0.02, 0.09, 48)), gridMat);
  gridPlate.position.y = GRID_Y - 0.045;
  group.add(gridPlate);
  const bottomPlate = new THREE.Mesh(track(new THREE.CylinderGeometry(REFL_IN + 0.02, REFL_IN + 0.02, 0.09, 48)), gridMat);
  bottomPlate.position.y = CORE_TOP - CORE_H - 0.05;
  group.add(bottomPlate);
  const legGeo = track(new THREE.CylinderGeometry(0.05, 0.05, (CORE_TOP - CORE_H - 0.05) - (-POOL_DEPTH), 8));
  [0, 1, 2, 3].forEach(i => {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const leg = new THREE.Mesh(legGeo, steelMat);
    const legLen = (CORE_TOP - CORE_H - 0.1) - (-POOL_DEPTH);
    leg.position.set(Math.cos(a) * REFL_IN * 0.8, -POOL_DEPTH + legLen / 2, Math.sin(a) * REFL_IN * 0.8);
    group.add(leg);
  });

  // ——————————————————————————— 堆芯格位分配 ———————————————————————————
  const lattice = [];
  RINGS.forEach(({ n, count }) => {
    ringPositions(n, count).forEach(([x, z], i) => {
      lattice.push({ x, z, ring: n, idx: i, angle: Math.atan2(z, x) });
    });
  });
  const taken = new Set();
  // 中央 A：辐照套管，不参与燃料/控制棒分配
  const centralIdx = lattice.findIndex(p => p.ring === 0);
  taken.add(centralIdx);
  // RP-005 三根控制棒：SHIM(C环=ring2)、TRANS(D环=ring3)、REG(E环=ring4)
  const shimIdx = pickNearest(lattice, 2, 0, taken);
  const transIdx = pickNearest(lattice, 3, Math.PI * 2 / 3, taken);
  const regIdx = pickNearest(lattice, 4, Math.PI * 4 / 3, taken);
  // Ra-Be 中子源：D 环内、TRANS 对面（近似位置，未锁定 Pavia 精确装载图）
  const sourceIdx = pickNearest(lattice, 3, Math.PI * 2 / 3 + Math.PI, taken);
  // 石墨哑元：F 环四个对称位置（近似，标注为待 Pavia 装载图关闭的差距）
  const dummyIdxs = [0, 1, 2, 3].map(i => pickNearest(lattice, 5, (i / 4) * Math.PI * 2 + 0.5, taken));

  const central = lattice[centralIdx];
  const shimCell = lattice[shimIdx];
  const transCell = lattice[transIdx];
  const regCell = lattice[regIdx];
  const sourceCell = lattice[sourceIdx];
  const dummyCells = dummyIdxs.map(i => lattice[i]);

  const fuelCells = lattice.filter((p, i) => i !== centralIdx && i !== shimIdx && i !== transIdx &&
    i !== regIdx && i !== sourceIdx && !dummyIdxs.includes(i));

  // 中央辐照套管（RP-006 中央套管）
  const thimbleTubeGeo = track(new THREE.CylinderGeometry(ROD_R * 1.6, ROD_R * 1.6, CORE_H + 1.8, 16, 1, true));
  const centralThimble = new THREE.Mesh(thimbleTubeGeo, thimbleMat);
  centralThimble.position.set(central.x, CORE_TOP - CORE_H / 2 + 0.4, central.z);
  group.add(centralThimble);

  // 石墨哑元元件
  const dummyGeo = track(new THREE.CylinderGeometry(ROD_R, ROD_R, CORE_H, 12));
  dummyCells.forEach(p => {
    const m = new THREE.Mesh(dummyGeo, dummyMat);
    m.position.set(p.x, CORE_TOP - CORE_H / 2, p.z);
    group.add(m);
  });
  // Ra–Be 中子源
  const sourceGeo = track(new THREE.CylinderGeometry(ROD_R * 0.8, ROD_R * 0.8, CORE_H * 0.6, 10));
  const sourceMesh = new THREE.Mesh(sourceGeo, sourceMat);
  sourceMesh.position.set(sourceCell.x, CORE_TOP - CORE_H * 0.3, sourceCell.z);
  group.add(sourceMesh);

  // ——————————————————————————— 燃料元件（InstancedMesh × 3 档）———————————————————————————
  const rodGeo = track(new THREE.CylinderGeometry(ROD_R, ROD_R, CORE_H, 12));
  const nozzleGeo = track(new THREE.CylinderGeometry(ROD_R * 1.15, ROD_R * 1.15, 0.14, 12));
  const tierCells = [[], [], []];
  fuelCells.forEach((p, i) => {
    const h = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    tierCells[h < 0.4 ? 0 : h < 0.75 ? 1 : 2].push(p);
  });
  const fuelMeshes = [];
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
    fuelMeshes.push(im);
  });

  // ——————————————————————————— RP-005 控制棒与驱动 ———————————————————————————
  const absGeo = track(new THREE.CylinderGeometry(ROD_R * 1.35, ROD_R * 1.35, CORE_H + 0.2, 14));
  const shaftGeo = track(new THREE.CylinderGeometry(0.05, 0.05, CTRL_TRAVEL + CORE_H + 1.4, 10));
  const motorGeo = track(new THREE.BoxGeometry(0.32, 0.24, 0.22));
  const pneumaticHousingGeo = track(new THREE.CylinderGeometry(0.16, 0.16, 0.7, 16));
  const housingGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 1.25, 16));

  function buildRodDrive(cell, kind, mat) {
    const asm = new THREE.Group();
    const absorber = new THREE.Mesh(absGeo, mat);
    absorber.position.set(cell.x, CORE_TOP - (CORE_H + 0.2) / 2, cell.z);
    asm.add(absorber);
    const shaft = new THREE.Mesh(shaftGeo, steelMat);
    shaft.position.set(cell.x, CORE_TOP + shaftGeo.parameters.height / 2 - 0.3, cell.z);
    asm.add(shaft);
    group.add(asm);
    // 固定导向套管
    const housing = new THREE.Mesh(housingGeo, steelMat);
    housing.position.set(cell.x, BRIDGE_Y - 0.4, cell.z);
    group.add(housing);
    // 驱动机构：TRANS 用气动缸外形，SHIM/REG 用电机+齿条外形
    if (kind === "pneumatic") {
      const cyl = new THREE.Mesh(pneumaticHousingGeo, pneumaticMat);
      cyl.position.set(cell.x, BRIDGE_Y + 0.55, cell.z);
      group.add(cyl);
    } else {
      const mo = new THREE.Mesh(motorGeo, steelMat);
      mo.position.set(cell.x, BRIDGE_Y + 0.5, cell.z);
      group.add(mo);
    }
    return asm;
  }

  const shimAsm = buildRodDrive(shimCell, "motor", absorberMat);
  const transAsm = buildRodDrive(transCell, "pneumatic", transAbsorberMat);
  const regAsm = buildRodDrive(regCell, "motor", absorberMat);

  // ——————————————————————————— RP-003 桥架 + 安全格栅 ———————————————————————————
  const bridge = new THREE.Mesh(track(new THREE.BoxGeometry(POOL_RADIUS * 2 + 0.9, 0.16, 0.22)), bridgeMat);
  bridge.position.set(0, BRIDGE_Y, 0);
  group.add(bridge);
  const bridge2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.22, 0.16, POOL_RADIUS * 2 + 0.9)), bridgeMat);
  bridge2.position.set(0, BRIDGE_Y, 0);
  group.add(bridge2);
  // 桥架支腿：落在屏蔽体上沿
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => {
    const legH = BRIDGE_Y - SHIELD_TOP;
    const leg = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, legH, 0.12)), bridgeMat);
    leg.position.set(sx * (SHIELD_R - 0.3), SHIELD_TOP + legH / 2, sz * (SHIELD_R - 0.3));
    group.add(leg);
  });

  // 安全格栅：正交排列的实心杆件 + 透明下衬（RP-003：网孔与透明下衬均需真实建模）
  const GRATE_Y = 0;
  const gratingGroup = new THREE.Group();
  gratingGroup.position.y = GRATE_Y;
  const barSpan = POOL_RADIUS * 2 * 0.98;
  const barGeoX = track(new THREE.BoxGeometry(barSpan, 0.05, 0.045));
  const BAR_N = 21;
  const barsX = new THREE.InstancedMesh(barGeoX, gratingBarMat, BAR_N);
  const barsZ = new THREE.InstancedMesh(barGeoX, gratingBarMat, BAR_N);
  for (let i = 0; i < BAR_N; i++) {
    const off = -POOL_RADIUS + (i + 0.5) * (POOL_RADIUS * 2 / BAR_N);
    dummy.position.set(0, 0, off); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    barsX.setMatrixAt(i, dummy.matrix);
    dummy.position.set(0, 0.001, off); dummy.rotation.set(0, Math.PI / 2, 0); dummy.updateMatrix();
    barsZ.setMatrixAt(i, dummy.matrix);
  }
  barsX.instanceMatrix.needsUpdate = true;
  barsZ.instanceMatrix.needsUpdate = true;
  gratingGroup.add(barsX, barsZ);
  const gratingBacking = new THREE.Mesh(track(new THREE.CylinderGeometry(POOL_RADIUS * 0.99, POOL_RADIUS * 0.99, 0.05, 48)), gratingBackingMat);
  gratingBacking.position.y = -0.06;
  gratingGroup.add(gratingBacking);
  const gratingRim = new THREE.Mesh(track(new THREE.CylinderGeometry(POOL_RADIUS, POOL_RADIUS, 0.1, 48, 1, true)), steelMat);
  gratingRim.position.y = -0.02;
  gratingGroup.add(gratingRim);
  group.add(gratingGroup);

  // ——————————————————————————— RP-006 实验设施 ———————————————————————————
  // Rabbit 气动传输管：从 F 环外侧穿出屏蔽体
  const rabbitStart = { x: CORE_RING_F * Math.cos(2.3), z: CORE_RING_F * Math.sin(2.3) };
  const rabbitCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(rabbitStart.x, CORE_TOP, rabbitStart.z),
    new THREE.Vector3(rabbitStart.x * 2.2, CORE_TOP + 0.6, rabbitStart.z * 2.2),
    new THREE.Vector3(rabbitStart.x * 3.4, 0.4, rabbitStart.z * 3.4),
    new THREE.Vector3(SHIELD_R * Math.cos(2.3), SHIELD_TOP * 0.6, SHIELD_R * Math.sin(2.3))
  ]);
  const rabbitTube = new THREE.Mesh(track(new THREE.TubeGeometry(rabbitCurve, 32, 0.06, 8, false)), conduitMat);
  group.add(rabbitTube);

  // Lazy Susan 旋转载样架：反射体内的样品环
  const lazySusan = new THREE.Mesh(track(new THREE.TorusGeometry((REFL_IN + REFL_OUT) / 2, 0.05, 8, 40)), steelMat);
  lazySusan.rotation.x = Math.PI / 2;
  lazySusan.position.y = CORE_TOP - CORE_H * 0.3;
  group.add(lazySusan);
  const sampleGeo = track(new THREE.CylinderGeometry(0.045, 0.045, 0.14, 8));
  const SAMPLE_N = 12;
  const samples = new THREE.InstancedMesh(sampleGeo, thimbleMat, SAMPLE_N);
  for (let i = 0; i < SAMPLE_N; i++) {
    const a = (i / SAMPLE_N) * Math.PI * 2;
    const r = (REFL_IN + REFL_OUT) / 2;
    dummy.position.set(Math.cos(a) * r, CORE_TOP - CORE_H * 0.3, Math.sin(a) * r);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    samples.setMatrixAt(i, dummy.matrix);
  }
  samples.instanceMatrix.needsUpdate = true;
  group.add(samples);

  // 热柱：径向穿出屏蔽体的大截面石墨柱塞
  const thermalColumn = new THREE.Mesh(track(new THREE.BoxGeometry(1.1, 0.9, SHIELD_R - REFL_OUT + 0.4)), graphiteMat);
  thermalColumn.position.set(0, CORE_TOP + 0.1, -(REFL_OUT + (SHIELD_R - REFL_OUT + 0.4) / 2 - 0.2));
  group.add(thermalColumn);

  // 水平实验/束流通道：径向贯穿屏蔽体的管道
  const beamPort = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, SHIELD_R - REFL_OUT + 0.6, 16)), steelMat);
  beamPort.rotation.z = Math.PI / 2;
  beamPort.position.set(REFL_OUT + (SHIELD_R - REFL_OUT + 0.6) / 2 - 0.3, CORE_TOP - 0.2, 0);
  group.add(beamPort);

  // ——————————————————————————— RP-007 池内仪器 ———————————————————————————
  const probeGeo = track(new THREE.CylinderGeometry(0.045, 0.045, CORE_H + 2.6, 10));
  const probeHeadGeo = track(new THREE.SphereGeometry(0.08, 10, 8));
  function buildProbe(x, z, len) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(probeGeo, thimbleMat);
    shaft.scale.y = len / probeGeo.parameters.height;
    shaft.position.set(x, CORE_TOP - CORE_H / 2 + 0.3, z);
    g.add(shaft);
    const head = new THREE.Mesh(probeHeadGeo, steelMat);
    head.position.set(x, CORE_TOP - CORE_H / 2, z);
    g.add(head);
    group.add(g);
    return head;
  }
  const startupDetector = buildProbe(CORE_RING_F * 1.35 * Math.cos(0.5), CORE_RING_F * 1.35 * Math.sin(0.5), CORE_H + 2.6);
  const fuelTempProbe = buildProbe(CORE_RING_F * 1.35 * Math.cos(3.6), CORE_RING_F * 1.35 * Math.sin(3.6), CORE_H + 2.2);
  const poolTempProbe = buildProbe(POOL_RADIUS * 0.7, POOL_RADIUS * 0.2, POOL_DEPTH * 0.4);

  // 安全联锁/SCRAM 状态灯（非文字状态灯，机械对象）
  const statusLampGeo = track(new THREE.SphereGeometry(0.07, 10, 8));
  const statusLampMat = track(new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x003300, emissiveIntensity: 1 }));
  const statusLamp = new THREE.Mesh(statusLampGeo, statusLampMat);
  statusLamp.position.set(POOL_RADIUS + 0.4, BRIDGE_Y, POOL_RADIUS + 0.4);
  group.add(statusLamp);

  // ——————————————————————————— RP-008 冷却系统 ———————————————————————————
  const coolVert = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, POOL_DEPTH - 1.0, 16)), thimbleMat);
  coolVert.position.set(POOL_RADIUS - 0.25, -(POOL_DEPTH) / 2, 0);
  group.add(coolVert);
  const coolElbow = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, 1.4, 16)), thimbleMat);
  coolElbow.rotation.z = Math.PI / 2;
  coolElbow.position.set(POOL_RADIUS - 0.9, -POOL_DEPTH + 0.5, 0);
  group.add(coolElbow);
  // 一回路泵：泵体发光环随 coolantFlowProxy 变化，代表运行状态（非文字仪表）
  const pumpMat = track(new THREE.MeshStandardMaterial({ color: 0x596066, metalness: 0.7, roughness: 0.4, emissive: 0x0c2a3a, emissiveIntensity: 0 }));
  const pump1 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 16)), pumpMat);
  pump1.rotation.z = Math.PI / 2;
  pump1.position.set(POOL_RADIUS + 1.3, SHIELD_BOTTOM + 0.6, 0);
  group.add(pump1);
  // 换热器 1（一回路/中间回路）
  const hxMat1 = track(new THREE.MeshStandardMaterial({ color: 0x596066, metalness: 0.7, roughness: 0.4, emissive: 0x0c2a3a, emissiveIntensity: 0 }));
  const hx1 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.4, 0.4, 1.6, 20)), hxMat1);
  hx1.position.set(SHIELD_R + 0.9, SHIELD_BOTTOM + 1.2, 1.2);
  group.add(hx1);
  // 中间回路管
  const midPipe = new THREE.Mesh(track(new THREE.CylinderGeometry(0.1, 0.1, 2.4, 12)), thimbleMat);
  midPipe.rotation.z = Math.PI / 2;
  midPipe.position.set(SHIELD_R + 2.2, SHIELD_BOTTOM + 1.2, 1.2);
  group.add(midPipe);
  // 换热器 2（中间回路/三回路）
  const hxMat2 = track(new THREE.MeshStandardMaterial({ color: 0x596066, metalness: 0.7, roughness: 0.4, emissive: 0x0c2a3a, emissiveIntensity: 0 }));
  const hx2 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.36, 0.36, 1.4, 20)), hxMat2);
  hx2.position.set(SHIELD_R + 3.6, SHIELD_BOTTOM + 1.2, 1.2);
  group.add(hx2);
  // 三回路管（终止于法兰盘，不悬空）
  const tertiaryPipe = new THREE.Mesh(track(new THREE.CylinderGeometry(0.11, 0.11, 1.2, 12)), thimbleMat);
  tertiaryPipe.rotation.z = Math.PI / 2;
  tertiaryPipe.position.set(SHIELD_R + 4.6, SHIELD_BOTTOM + 1.2, 1.2);
  group.add(tertiaryPipe);
  const tertiaryFlange = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 16)), steelMat);
  tertiaryFlange.rotation.z = Math.PI / 2;
  tertiaryFlange.position.set(SHIELD_R + 5.2, SHIELD_BOTTOM + 1.2, 1.2);
  group.add(tertiaryFlange);

  // ——————————————————————————— RP-009 电气/气动/连接 ———————————————————————————
  const cableTray = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.06, POOL_RADIUS * 2 + 0.9)), cableMat);
  cableTray.position.set(0, BRIDGE_Y - 0.12, 0);
  group.add(cableTray);
  const junctionBox = new THREE.Mesh(track(new THREE.BoxGeometry(0.4, 0.3, 0.3)), track(new THREE.MeshStandardMaterial({ color: 0x33383d, metalness: 0.5, roughness: 0.6 })));
  junctionBox.position.set(WALK_R + 0.2, 0.3, WALK_R + 0.2);
  group.add(junctionBox);
  const airCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(WALK_R, 0.3, WALK_R),
    new THREE.Vector3(WALK_R * 0.6, BRIDGE_Y * 0.6, WALK_R * 0.6),
    new THREE.Vector3(transCell.x * 0.6, BRIDGE_Y - 0.2, transCell.z * 0.6),
    new THREE.Vector3(transCell.x, BRIDGE_Y + 0.5, transCell.z)
  ]);
  const airLine = new THREE.Mesh(track(new THREE.TubeGeometry(airCurve, 24, 0.035, 6, false)), pneumaticMat);
  group.add(airLine);
  // 探测器/仪器信号线（柔性电缆，区别于刚性导管）
  [startupDetector, fuelTempProbe, poolTempProbe].forEach(head => {
    const p0 = head.position;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(p0.x, p0.y, p0.z),
      new THREE.Vector3(p0.x * 0.6, BRIDGE_Y * 0.5, p0.z * 0.6),
      new THREE.Vector3(0, BRIDGE_Y - 0.1, 0)
    ]);
    const cable = new THREE.Mesh(track(new THREE.TubeGeometry(curve, 20, 0.02, 6, false)), cableMat);
    group.add(cable);
  });

  // ——————————————————————————— 核心照明（切伦科夫主体见 waterSystem）———————————————————————————
  const coreLight = new THREE.PointLight(0x8fc0ff, 6, 14, 1.8);
  coreLight.position.set(0, CORE_TOP - 0.4, 0);
  group.add(coreLight);

  // ——————————————————————————— 更新 ———————————————————————————
  const applyStatic = (sessionState) => {
    const { rod, powerProxy, pulsePowerProxy, coolantFlowProxy, gratingLocked } = sessionState;
    shimAsm.position.y = rod.SHIM.pos * CTRL_TRAVEL;
    transAsm.position.y = rod.TRANS.pos * CTRL_TRAVEL;
    regAsm.position.y = rod.REG.pos * CTRL_TRAVEL;

    const flashPower = Math.min(1, powerProxy + pulsePowerProxy * 0.6);
    fuelMeshes.forEach((im, t) => { fuelTierMats[t].emissiveIntensity = fuelTierBase[t] * (0.15 + flashPower * 0.9); });
    coreLight.intensity = 1.2 + flashPower * 15;

    // 泵/换热器运行状态（几何不转，用材质发光强度代表流量，避免装饰性无因动画）
    pumpMat.emissiveIntensity = coolantFlowProxy * 1.4;
    hxMat1.emissiveIntensity = coolantFlowProxy * 1.1;
    hxMat2.emissiveIntensity = coolantFlowProxy * 0.9;
    statusLampMat.emissive.setRGB(gratingLocked ? 0.0 : 0.5, gratingLocked ? 0.55 : 0.0, 0);
  };

  const update = (dt, sessionState) => {
    applyStatic(sessionState);
  };

  const setScale = shortExtent => {
    const s = THREE.MathUtils.clamp(shortExtent / 8, 0.55, 1.2);
    group.scale.setScalar(s);
  };

  const dispose = () => {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  };

  return {
    group,
    update,
    setScale,
    dispose,
    grating: { radius: POOL_RADIUS, y: GRATE_Y, thickness: 0.16, visual: gratingGroup, restY: GRATE_Y },
    bridgeAnchor: { y: BRIDGE_Y },
    corePosition: { x: 0, y: CORE_TOP, z: 0 },
    poolBounds: { radius: POOL_RADIUS, depth: POOL_DEPTH, surfaceY: WATER_SURFACE_Y, floorY: -POOL_DEPTH },
    controlRods: {
      SHIM: { x: shimCell.x, z: shimCell.z },
      TRANS: { x: transCell.x, z: transCell.z },
      REG: { x: regCell.x, z: regCell.z }
    }
  };
}
