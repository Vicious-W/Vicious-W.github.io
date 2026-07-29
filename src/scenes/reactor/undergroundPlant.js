// 地下设备层（LAB-003 / LAB-004，见 docs/engineering/SOURCE_LAB_OPTICS.md §3）。
//
// 真实功能拓扑来自 Pavia/LENA 与不冲突的同型 TRIGA 资料：池水一回路取水/回水、
// 闭式中间回路（泵 + 缓冲容积 + 两台换热器）、三回路冷源接口、去离子净化支路、
// 排水/集水/泄漏收集、TRANS 压缩空气、电缆管廊、样品气动传输管段。
//
// 资料标签：
//   SOURCE_VERIFIED   Pavia 有公开事实（三回路 + 两换热器、地下气动传输系统）；
//   TRIGA_ANALOGUE    同型设施通用部件（净化柱、集水坑、储气罐）；
//   REALTIME_PROXY    **本层的逐台坐标和外形**——Pavia 没有公开竣工图，位置为
//                     网页空间重新组织，功能上下游关系保持不变（LAB-G01）。
//
// 运作规则（LAB-004）：这里没有无因循环。泵轴、阀杆、流向光珠、储气罐压力表、
// 集水泵和净化支路全部读取 sessionController 的连续状态；流量为零时几何真的停住。

import * as THREE from "three";
import { wrap01 } from "./timeStep.js";

const clamp = THREE.MathUtils.clamp;

// 地下厂房净空（世界单位，与地面共用坐标系）。地面玻璃砖顶面在 -0.06，
// 透明承托层底面约 -0.38，因此设备层从 -0.45 向下。
export const UNDERGROUND_BOUNDS = {
  ceilingY: -0.45,
  floorY: -9.2,
  half: 19.5,          // 混凝土挡土墙内表面
  shieldClearR: 5.35   // 生物屏蔽外皮，设备必须在此半径之外
};

// 设备清单：id / 资料标签 / 上游 / 下游。测试与实现报告据此检查“管道不在半空结束”。
export const PLANT_COMPONENTS = [
  { id: "UG-P01", tag: "SOURCE_VERIFIED", name: "poolSuction", up: "pool", down: "UG-V01" },
  { id: "UG-V01", tag: "TRIGA_ANALOGUE", name: "primaryIsolationValve", up: "UG-P01", down: "UG-H01" },
  { id: "UG-H01", tag: "SOURCE_VERIFIED", name: "heatExchanger1", up: "UG-V01", down: "UG-P02" },
  { id: "UG-P02", tag: "SOURCE_VERIFIED", name: "poolReturn", up: "UG-H01", down: "pool" },
  { id: "UG-K01", tag: "SOURCE_VERIFIED", name: "intermediatePumpA", up: "UG-H01", down: "UG-T01" },
  { id: "UG-K02", tag: "SOURCE_VERIFIED", name: "intermediatePumpB", up: "UG-H01", down: "UG-T01" },
  { id: "UG-T01", tag: "TRIGA_ANALOGUE", name: "surgeTank", up: "UG-K01", down: "UG-H02" },
  { id: "UG-H02", tag: "SOURCE_VERIFIED", name: "heatExchanger2", up: "UG-T01", down: "UG-V02" },
  { id: "UG-V02", tag: "TRIGA_ANALOGUE", name: "tertiaryValve", up: "UG-H02", down: "UG-X01" },
  { id: "UG-X01", tag: "REALTIME_PROXY", name: "tertiaryWallPenetration", up: "UG-V02", down: "site" },
  { id: "UG-F01", tag: "TRIGA_ANALOGUE", name: "purificationFilter", up: "UG-V01", down: "UG-F02" },
  { id: "UG-F02", tag: "TRIGA_ANALOGUE", name: "ionExchangeColumnA", up: "UG-F01", down: "UG-F03" },
  { id: "UG-F03", tag: "TRIGA_ANALOGUE", name: "ionExchangeColumnB", up: "UG-F02", down: "UG-P02" },
  { id: "UG-S01", tag: "TRIGA_ANALOGUE", name: "sampleLine", up: "UG-F03", down: "UG-S02" },
  { id: "UG-S02", tag: "REALTIME_PROXY", name: "sampleCabinet", up: "UG-S01", down: "site" },
  { id: "UG-D01", tag: "TRIGA_ANALOGUE", name: "drainTrench", up: "floorDrains", down: "UG-D02" },
  { id: "UG-D02", tag: "TRIGA_ANALOGUE", name: "sumpPit", up: "UG-D01", down: "UG-D03" },
  { id: "UG-D03", tag: "TRIGA_ANALOGUE", name: "sumpPump", up: "UG-D02", down: "UG-X01" },
  { id: "UG-A01", tag: "SOURCE_VERIFIED", name: "transAirReceiver", up: "compressor", down: "UG-A02" },
  { id: "UG-A02", tag: "TRIGA_ANALOGUE", name: "transRegulatorManifold", up: "UG-A01", down: "UG-A03" },
  { id: "UG-A03", tag: "SOURCE_VERIFIED", name: "transAirRiser", up: "UG-A02", down: "bridge" },
  { id: "UG-E01", tag: "REALTIME_PROXY", name: "cableGallery", up: "switchgear", down: "hallRisers" },
  { id: "UG-E02", tag: "TRIGA_ANALOGUE", name: "groundingBar", up: "UG-E01", down: "earth" },
  { id: "UG-R01", tag: "SOURCE_VERIFIED", name: "rabbitTransferTube", up: "core", down: "UG-R02" },
  { id: "UG-R02", tag: "SOURCE_VERIFIED", name: "hotCellTransferRun", up: "UG-R01", down: "site" }
];

export function createUndergroundPlant({ reduceMotion } = {}) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const mat = (color, opts = {}) => track(new THREE.MeshStandardMaterial(Object.assign({
    color, metalness: 0.35, roughness: 0.6
  }, opts)));

  const { ceilingY, floorY, half } = UNDERGROUND_BOUNDS;

  // ——— 材质 ———
  const concrete = mat(0x2b3038, { roughness: 0.96, metalness: 0.04 });
  const steel = mat(0x59636d, { metalness: 0.78, roughness: 0.42 });
  const painted = mat(0x35707f, { metalness: 0.45, roughness: 0.5 });
  const pumpBody = mat(0x2f6f5a, { metalness: 0.5, roughness: 0.45 });
  const vesselMat = mat(0x8a9199, { metalness: 0.6, roughness: 0.38 });
  const pipeCold = mat(0x5a7f96, { metalness: 0.68, roughness: 0.36 });
  const pipeHotMat = mat(0x7d5b52, { metalness: 0.68, roughness: 0.36 });
  const insulation = mat(0xb9c2c8, { metalness: 0.05, roughness: 0.9 });
  const boltMat = mat(0x8f979e, { metalness: 0.85, roughness: 0.3 });
  const airMat = mat(0x4a4038, { metalness: 0.6, roughness: 0.5 });
  const cableMat = mat(0x2c3138, { metalness: 0.3, roughness: 0.62 });
  const copperMat = mat(0xa9642c, { metalness: 0.8, roughness: 0.35 });

  // ——— 结构外壳（混凝土地坑：底板 + 四面挡土墙 + 设备基础）———
  const base = new THREE.Mesh(track(new THREE.BoxGeometry(half * 2, 0.4, half * 2)), concrete);
  base.position.set(0, floorY - 0.2, 0);
  group.add(base);
  [[0, -half], [0, half], [-half, 0], [half, 0]].forEach(([x, z]) => {
    const w = x === 0 ? half * 2 : 0.4;
    const d = x === 0 ? 0.4 : half * 2;
    const wall = new THREE.Mesh(track(new THREE.BoxGeometry(w, ceilingY - floorY, d)), concrete);
    wall.position.set(x + (x === 0 ? 0 : Math.sign(x) * 0.2), (ceilingY + floorY) / 2, z + (z === 0 ? 0 : Math.sign(z) * 0.2));
    group.add(wall);
  });

  // 设备基础（可见的混凝土墩，每台转动设备都真的坐在墩子上）
  const plinthGeo = track(new THREE.BoxGeometry(2.4, 0.35, 1.9));
  const plinths = new THREE.InstancedMesh(plinthGeo, concrete, 7);
  const dummy = new THREE.Object3D();
  const PLINTH_AT = [[-9.4, 2.2], [-9.4, 4.6], [-12.6, 0], [8.6, -3.2], [8.6, 0.4], [11.8, 4.4], [-6.2, -9.4]];
  PLINTH_AT.forEach(([x, z], i) => {
    dummy.position.set(x, floorY + 0.175, z);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    plinths.setMatrixAt(i, dummy.matrix);
  });
  plinths.instanceMatrix.needsUpdate = true;
  group.add(plinths);

  // ——— 几何 helpers ———
  const FLANGE_GEO = track(new THREE.CylinderGeometry(0.001, 0.001, 1, 3)); // 占位，避免未用
  const boltRingGeo = track(new THREE.CylinderGeometry(0.028, 0.028, 0.06, 6));

  // 法兰 + 螺栓圈（LAB-010 精细化：主要设备端口都有真实连接端）
  function flange(x, y, z, r, axis = "y") {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 1.45, r * 1.45, 0.06, 20)), boltMat);
    g.add(disc);
    const n = 8;
    const bolts = new THREE.InstancedMesh(boltRingGeo, boltMat, n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      dummy.position.set(Math.cos(a) * r * 1.2, 0.04, Math.sin(a) * r * 1.2);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bolts.setMatrixAt(i, dummy.matrix);
    }
    bolts.instanceMatrix.needsUpdate = true;
    g.add(bolts);
    if (axis === "x") g.rotation.z = Math.PI / 2;
    if (axis === "z") g.rotation.x = Math.PI / 2;
    g.position.set(x, y, z);
    group.add(g);
    return g;
  }

  // 直管段（带端部法兰），沿 x/y/z 轴
  function pipe(from, to, r, material, withFlanges = true) {
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);
    const len = a.distanceTo(b);
    if (len < 1e-4) return null;
    const m = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, len, 14)), material);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    group.add(m);
    if (withFlanges && len > 1.0) {
      const dir = b.clone().sub(a).normalize();
      [[a, 0.12], [b, -0.12]].forEach(([p, s]) => {
        const q = p.clone().add(dir.clone().multiplyScalar(s));
        const f = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 1.5, r * 1.5, 0.05, 16)), boltMat);
        f.position.copy(q);
        f.quaternion.copy(m.quaternion);
        group.add(f);
      });
    }
    return m;
  }

  // 弯头（90°，用小球近似过渡，避免管子在半空断开）
  function elbow(at, r, material) {
    const m = new THREE.Mesh(track(new THREE.SphereGeometry(r * 1.12, 12, 10)), material);
    m.position.set(at[0], at[1], at[2]);
    group.add(m);
    return m;
  }

  // 管支承（每根长管都有吊架/支墩，不悬空）
  function hanger(x, y, z, h) {
    const m = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, h, 0.08)), steel);
    m.position.set(x, y - h / 2, z);
    group.add(m);
    const clampM = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.03, 6, 12)), steel);
    clampM.position.set(x, y, z);
    clampM.rotation.y = Math.PI / 2;
    group.add(clampM);
  }

  // 手动/自动阀：阀体 + 阀杆 + 手轮，阀杆高度由状态驱动（LAB-004）
  function valve(x, y, z, r, color = 0x9a3b2f) {
    const g = new THREE.Group();
    const bodyM = new THREE.Mesh(track(new THREE.SphereGeometry(r * 1.9, 14, 12)), mat(color, { metalness: 0.55, roughness: 0.45 }));
    g.add(bodyM);
    const bonnet = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 0.8, r * 1.1, r * 1.6, 12)), steel);
    bonnet.position.y = r * 1.9;
    g.add(bonnet);
    const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 0.22, r * 0.22, r * 2.2, 8)), boltMat);
    stem.position.y = r * 3.2;
    g.add(stem);
    const wheel = new THREE.Mesh(track(new THREE.TorusGeometry(r * 1.15, r * 0.17, 8, 16)), mat(0x1d2228));
    wheel.position.y = r * 4.1;
    wheel.rotation.x = Math.PI / 2;
    g.add(wheel);
    g.position.set(x, y, z);
    group.add(g);
    return { group: g, stem, wheel };
  }

  // 离心泵：底座 + 蜗壳 + 电机 + **真实转动的轴/风扇**（转速 = 流量代理）
  function pump(x, y, z, scale = 1) {
    const g = new THREE.Group();
    const skid = new THREE.Mesh(track(new THREE.BoxGeometry(1.7 * scale, 0.2, 1.2 * scale)), steel);
    skid.position.y = 0.1;
    g.add(skid);
    const volute = new THREE.Mesh(track(new THREE.CylinderGeometry(0.42 * scale, 0.42 * scale, 0.46 * scale, 18)), vesselMat);
    volute.position.set(-0.45 * scale, 0.45 * scale, 0);
    volute.rotation.x = Math.PI / 2;
    g.add(volute);
    const motorM = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3 * scale, 0.3 * scale, 1.0 * scale, 16)), pumpBody);
    motorM.rotation.z = Math.PI / 2;
    motorM.position.set(0.42 * scale, 0.45 * scale, 0);
    g.add(motorM);
    // 联轴器护罩里的轴：转速由流量驱动
    const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07 * scale, 0.07 * scale, 0.5 * scale, 8)), boltMat);
    shaft.rotation.z = Math.PI / 2;
    shaft.position.set(-0.08 * scale, 0.45 * scale, 0);
    g.add(shaft);
    const fan = new THREE.Mesh(track(new THREE.BoxGeometry(0.05 * scale, 0.5 * scale, 0.5 * scale)), mat(0x1d2228));
    fan.position.set(0.95 * scale, 0.45 * scale, 0);
    g.add(fan);
    const lampMat = track(new THREE.MeshStandardMaterial({ color: 0x101418, emissive: 0x27c6e0, emissiveIntensity: 0, roughness: 0.3 }));
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 10, 8)), lampMat);
    lamp.position.set(0.42 * scale, 0.82 * scale, 0.24 * scale);
    g.add(lamp);
    g.position.set(x, y, z);
    group.add(g);
    return { group: g, shaft, fan, lampMat };
  }

  // 立式压力容器（过滤器 / 离子交换柱 / 缓冲罐）：封头 + 裙座 + 接管
  function vessel(x, y, z, r, h, material = vesselMat) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, h, 20)), material);
    shell.position.y = h / 2;
    g.add(shell);
    [0, h].forEach(yy => {
      const cap = new THREE.Mesh(track(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)), material);
      cap.position.y = yy;
      if (yy === 0) cap.rotation.x = Math.PI;
      g.add(cap);
    });
    const skirt = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 0.92, r * 1.05, 0.4, 16, 1, true)), steel);
    skirt.position.y = -0.2;
    g.add(skirt);
    g.position.set(x, y, z);
    group.add(g);
    return g;
  }

  // 换热器：壳体 + 两端封头 + 鞍座 + 壳温着色（回路温差驱动）
  function heatExchanger(x, y, z, r, len) {
    const g = new THREE.Group();
    const shellMat = track(new THREE.MeshStandardMaterial({ color: 0x8a9199, metalness: 0.6, roughness: 0.38, emissive: 0x2a1206, emissiveIntensity: 0 }));
    const shell = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, len, 22)), shellMat);
    shell.rotation.z = Math.PI / 2;
    g.add(shell);
    [-1, 1].forEach(s => {
      const head = new THREE.Mesh(track(new THREE.SphereGeometry(r, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)), vesselMat);
      head.position.x = s * len / 2;
      head.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      g.add(head);
      const saddle = new THREE.Mesh(track(new THREE.BoxGeometry(0.35, r + 0.3, r * 2.1)), steel);
      saddle.position.set(s * len * 0.3, -(r + 0.3) / 2 - r * 0.15, 0);
      g.add(saddle);
    });
    g.position.set(x, y, z);
    group.add(g);
    return { group: g, shellMat };
  }

  // 流向光珠：沿管线等间距的小球，发光强度随流量、相位随流向前进（流量 0 → 静止）
  function flowBeads(points, count, color) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    const beadMat = track(new THREE.MeshStandardMaterial({
      color: 0x0a1018, emissive: color, emissiveIntensity: 0, roughness: 0.3, transparent: true, opacity: 0.9
    }));
    const im = new THREE.InstancedMesh(track(new THREE.SphereGeometry(0.075, 8, 6)), beadMat, count);
    im.frustumCulled = false;
    group.add(im);
    return { im, curve, count, beadMat, phase: 0 };
  }
  function updateBeads(b, flow, dt) {
    const f = Number.isFinite(flow) ? clamp(flow, 0, 1) : 0;
    b.beadMat.emissiveIntensity = f * 1.8;
    // 相位必须留在 [0,1)：`%` 会保留负号，负参数会让 getPointAt 索引到 points[-1]。
    if (f > 1e-3) b.phase = wrap01(b.phase + dt * f * 0.22);
    for (let i = 0; i < b.count; i++) {
      const t = wrap01(i / b.count + b.phase);
      b.curve.getPointAt(t, dummy.position);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.6 + flow * 0.6);
      dummy.updateMatrix();
      b.im.setMatrixAt(i, dummy.matrix);
    }
    b.im.instanceMatrix.needsUpdate = true;
  }

  // ——————————————————————————— UG-P01/V01/H01/P02 一回路 ———————————————————————————
  const POOL_PEN_Y = -6.0;
  // 池水取水：从屏蔽体穿出 → 隔离阀 → 换热器 1
  pipe([5.35, POOL_PEN_Y, -1.1], [9.0, POOL_PEN_Y, -1.1], 0.17, pipeHotMat);
  flange(5.45, POOL_PEN_Y, -1.1, 0.17, "x");
  elbow([9.0, POOL_PEN_Y, -1.1], 0.17, pipeHotMat);
  pipe([9.0, POOL_PEN_Y, -1.1], [9.0, floorY + 1.5, -1.1], 0.17, pipeHotMat);
  hanger(9.0, POOL_PEN_Y + 0.9, -1.1, 0.6);
  const primaryValve = valve(9.0, floorY + 1.5, -1.1, 0.18);
  elbow([9.0, floorY + 1.5, -1.1], 0.17, pipeHotMat);
  pipe([9.0, floorY + 1.5, -1.1], [9.0, floorY + 1.5, -3.2], 0.17, pipeHotMat);
  const hx1 = heatExchanger(8.6, floorY + 1.5, -3.2, 0.55, 3.2);
  // 换热器 1 出口 → 回池
  pipe([8.6, floorY + 1.05, -4.9], [8.6, floorY + 1.05, 1.4], 0.16, pipeCold);
  hanger(8.6, floorY + 1.05, -0.4, 0.5);
  elbow([8.6, floorY + 1.05, 1.4], 0.16, pipeCold);
  pipe([8.6, floorY + 1.05, 1.4], [8.6, POOL_PEN_Y + 0.6, 1.4], 0.16, pipeCold);
  elbow([8.6, POOL_PEN_Y + 0.6, 1.4], 0.16, pipeCold);
  pipe([8.6, POOL_PEN_Y + 0.6, 1.4], [5.35, POOL_PEN_Y + 0.6, 1.4], 0.16, pipeCold);
  flange(5.45, POOL_PEN_Y + 0.6, 1.4, 0.16, "x");
  const primaryBeads = flowBeads([
    [5.5, POOL_PEN_Y, -1.1], [8.9, POOL_PEN_Y, -1.1], [9.0, floorY + 1.6, -1.5],
    [8.7, floorY + 1.5, -3.2], [8.6, floorY + 1.05, -1.0], [8.6, POOL_PEN_Y + 0.6, 1.4], [5.5, POOL_PEN_Y + 0.6, 1.4]
  ], 14, 0x4ad0ff);

  // ——————————————————————————— UG-K01/K02/T01/H02 中间回路 ———————————————————————————
  const pumpA = pump(-9.4, floorY + 0.35, 2.2, 1.0);
  const pumpB = pump(-9.4, floorY + 0.35, 4.6, 1.0);
  const surgeTank = vessel(-12.6, floorY + 0.35, 0, 0.75, 2.4);
  const hx2 = heatExchanger(-9.0, floorY + 2.6, -3.0, 0.5, 3.0);
  // 换热器 1（+X 侧）→ 中间回路泵（-X 侧）：贯穿池下的中间回路总管
  pipe([7.0, floorY + 2.0, -3.2], [-7.4, floorY + 2.0, -3.2], 0.14, painted);
  [4.0, 0.0, -4.0].forEach(x => hanger(x, floorY + 2.0, -3.2, 0.55));
  elbow([-7.4, floorY + 2.0, -3.2], 0.14, painted);
  pipe([-7.4, floorY + 2.0, -3.2], [-7.4, floorY + 0.8, -3.2], 0.14, painted);
  elbow([-7.4, floorY + 0.8, -3.2], 0.14, painted);
  pipe([-7.4, floorY + 0.8, -3.2], [-7.4, floorY + 0.8, 2.2], 0.14, painted);
  pipe([-7.4, floorY + 0.8, 2.2], [-8.5, floorY + 0.8, 2.2], 0.12, painted);
  pipe([-7.4, floorY + 0.8, 4.6], [-8.5, floorY + 0.8, 4.6], 0.12, painted);
  // 泵出口 → 缓冲容积 → 换热器 2
  pipe([-10.3, floorY + 0.8, 2.2], [-12.6, floorY + 0.8, 2.2], 0.12, painted);
  pipe([-10.3, floorY + 0.8, 4.6], [-12.6, floorY + 0.8, 4.6], 0.12, painted);
  pipe([-12.6, floorY + 0.8, 4.6], [-12.6, floorY + 0.8, 0.9], 0.12, painted);
  elbow([-12.6, floorY + 0.8, 0.9], 0.12, painted);
  pipe([-12.6, floorY + 2.6, 0], [-12.6, floorY + 2.6, -3.0], 0.13, painted);
  elbow([-12.6, floorY + 2.6, -3.0], 0.13, painted);
  pipe([-12.6, floorY + 2.6, -3.0], [-10.6, floorY + 2.6, -3.0], 0.13, painted);
  hanger(-11.6, floorY + 2.6, -3.0, 0.5);
  const interBeads = flowBeads([
    [6.9, floorY + 2.0, -3.2], [-7.3, floorY + 2.0, -3.2], [-7.4, floorY + 0.8, 2.2],
    [-10.4, floorY + 0.8, 3.4], [-12.6, floorY + 1.5, 1.4], [-12.6, floorY + 2.6, -2.9], [-10.7, floorY + 2.6, -3.0]
  ], 12, 0x35c9a8);

  // ——————————————————————————— UG-V02/X01 三回路冷源接口 ———————————————————————————
  pipe([-7.4, floorY + 2.6, -3.0], [-7.4, floorY + 2.6, -7.0], 0.13, insulation);
  elbow([-7.4, floorY + 2.6, -7.0], 0.13, insulation);
  const tertiaryValve = valve(-7.4, floorY + 2.6, -8.2, 0.16, 0x2f6f9a);
  pipe([-7.4, floorY + 2.6, -7.0], [-7.4, floorY + 2.6, -9.4], 0.13, insulation);
  pipe([-7.4, floorY + 2.6, -9.4], [-7.4, floorY + 2.6, -half + 0.45], 0.13, insulation);
  // 穿墙：真实的套管 + 法兰，不在半空结束
  const sleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.9, 16)), concrete);
  sleeve.rotation.x = Math.PI / 2;
  sleeve.position.set(-7.4, floorY + 2.6, -half + 0.1);
  group.add(sleeve);
  flange(-7.4, floorY + 2.6, -half + 0.7, 0.13, "z");
  // 三回路仪表（流量/温度）：指针几何由状态驱动
  const gaugeMat = track(new THREE.MeshStandardMaterial({ color: 0x11161c, emissive: 0x1b3a66, emissiveIntensity: 0.4, roughness: 0.3 }));
  function gauge(x, y, z) {
    const g = new THREE.Group();
    const face = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 18)), gaugeMat);
    face.rotation.x = Math.PI / 2;
    g.add(face);
    const needle = new THREE.Mesh(track(new THREE.BoxGeometry(0.015, 0.14, 0.012)), mat(0xff5533, { emissive: 0xff3311, emissiveIntensity: 0.9 }));
    needle.position.set(0, 0.06, 0.035);
    const pivot = new THREE.Group();
    pivot.add(needle);
    g.add(pivot);
    g.position.set(x, y, z);
    group.add(g);
    return pivot;
  }
  const tertFlowGauge = gauge(-7.0, floorY + 3.3, -8.2);
  const tertTempGauge = gauge(-6.6, floorY + 3.3, -8.2);

  // ——————————————————————————— UG-F01..F03/S01/S02 净化支路 ———————————————————————————
  const filterV = vessel(11.8, floorY + 0.35, 4.4, 0.4, 1.5, painted);
  const ixA = vessel(13.0, floorY + 0.35, 4.4, 0.45, 2.2);
  const ixB = vessel(13.0, floorY + 0.35, 6.0, 0.45, 2.2);
  // 支路从一回路取水（隔离阀下游）→ 过滤器 → 两根离子交换柱 → 回到回池管
  pipe([9.2, floorY + 1.5, -1.1], [11.8, floorY + 1.5, -1.1], 0.09, pipeCold);
  elbow([11.8, floorY + 1.5, -1.1], 0.09, pipeCold);
  pipe([11.8, floorY + 1.5, -1.1], [11.8, floorY + 1.5, 4.4], 0.09, pipeCold);
  hanger(11.8, floorY + 1.5, 1.6, 0.5);
  pipe([11.8, floorY + 1.9, 4.4], [13.0, floorY + 2.4, 4.4], 0.08, pipeCold);
  pipe([13.0, floorY + 2.4, 4.4], [13.0, floorY + 2.4, 6.0], 0.08, pipeCold);
  pipe([13.0, floorY + 0.5, 6.0], [8.6, floorY + 0.5, 6.0], 0.08, pipeCold);
  elbow([8.6, floorY + 0.5, 6.0], 0.08, pipeCold);
  pipe([8.6, floorY + 0.5, 6.0], [8.6, floorY + 1.05, 1.5], 0.08, pipeCold);
  // 取样管 + 取样柜（水质代理读数）
  pipe([13.45, floorY + 1.2, 6.0], [15.2, floorY + 1.2, 6.0], 0.045, boltMat, false);
  const sampleCab = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 1.6, 0.6)), mat(0x353d45, { metalness: 0.45, roughness: 0.55 }));
  sampleCab.position.set(15.6, floorY + 0.8, 6.0);
  group.add(sampleCab);
  const sampleScreenMat = track(new THREE.MeshStandardMaterial({ color: 0x0a1420, emissive: 0x1b3a66, emissiveIntensity: 0.5, roughness: 0.3 }));
  const sampleScreen = new THREE.Mesh(track(new THREE.BoxGeometry(0.55, 0.4, 0.05)), sampleScreenMat);
  sampleScreen.position.set(15.6, floorY + 1.2, 5.68);
  group.add(sampleScreen);
  // 取样支路上引：净化回水管 → 楼板套管 → 地面取样柜（labEnvironment 的 LAB-Q02）。
  // 地面那一侧从同一个 XZ (7.6, 3.0) 的套管接出来，两层的管子真的对得上。
  pipe([8.6, floorY + 0.87, 3.0], [7.6, floorY + 0.87, 3.0], 0.045, boltMat, false);
  pipe([7.6, floorY + 0.87, 3.0], [7.6, ceilingY - 0.05, 3.0], 0.045, boltMat, false);
  hanger(7.6, floorY + 3.2, 3.0, 0.4);
  const sampleRiserSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 12)), concrete);
  sampleRiserSleeve.position.set(7.6, ceilingY, 3.0);
  group.add(sampleRiserSleeve);

  const purifyBeads = flowBeads([
    [9.3, floorY + 1.5, -1.1], [11.8, floorY + 1.5, 0.4], [11.8, floorY + 1.9, 4.3],
    [13.0, floorY + 2.4, 5.9], [13.0, floorY + 0.5, 6.0], [8.7, floorY + 0.5, 5.4], [8.6, floorY + 1.05, 1.6]
  ], 10, 0x9fe8ff);

  // ——————————————————————————— UG-D01..D03 排水/集水 ———————————————————————————
  // 排水沟：地面上的凹槽（真实几何：两条边石 + 篦子）
  const trenchSide = track(new THREE.BoxGeometry(0.12, 0.22, 16));
  [-0.42, 0.42].forEach(dx => {
    const s = new THREE.Mesh(trenchSide, concrete);
    s.position.set(-6.2 + dx, floorY + 0.11, -1.0);
    group.add(s);
  });
  const grateGeo = track(new THREE.BoxGeometry(0.72, 0.04, 0.09));
  const grates = new THREE.InstancedMesh(grateGeo, steel, 60);
  for (let i = 0; i < 60; i++) {
    dummy.position.set(-6.2, floorY + 0.2, -9.0 + i * 0.27);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    grates.setMatrixAt(i, dummy.matrix);
  }
  grates.instanceMatrix.needsUpdate = true;
  group.add(grates);
  // 集水坑 + 泄漏收集斗 + 集水泵（运行状态由池水温度/净化流量代理驱动）
  const pit = new THREE.Mesh(track(new THREE.CylinderGeometry(0.95, 0.95, 1.1, 20, 1, true)), concrete);
  pit.position.set(-6.2, floorY - 0.35, -9.4);
  group.add(pit);
  const sumpWaterMat = track(new THREE.MeshStandardMaterial({
    color: 0x123044, metalness: 0.1, roughness: 0.15, transparent: true, opacity: 0.75,
    emissive: 0x06202e, emissiveIntensity: 0.4
  }));
  const sumpWater = new THREE.Mesh(track(new THREE.CircleGeometry(0.92, 24)), sumpWaterMat);
  sumpWater.rotation.x = -Math.PI / 2;
  sumpWater.position.set(-6.2, floorY - 0.6, -9.4);
  group.add(sumpWater);
  // 地面补给撬块的溢流/排空重力管（labEnvironment 的 LAB-D01）：同一个 XZ (-6.2, -7.6)
  // 的楼板套管落下来 → 沿地下顶板走到集水坑上方 → 下泄进坑（UG-D02）。
  const drainRiserSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12)), concrete);
  drainRiserSleeve.position.set(-6.2, ceilingY, -7.6);
  group.add(drainRiserSleeve);
  pipe([-6.2, ceilingY - 0.05, -7.6], [-6.2, floorY + 1.2, -7.6], 0.09, boltMat, false);
  hanger(-6.2, floorY + 3.0, -7.6, 0.4);
  elbow([-6.2, floorY + 1.2, -7.6], 0.09, boltMat);
  pipe([-6.2, floorY + 1.2, -7.6], [-6.2, floorY + 1.2, -9.4], 0.09, boltMat, false);
  elbow([-6.2, floorY + 1.2, -9.4], 0.09, boltMat);
  pipe([-6.2, floorY + 1.2, -9.4], [-6.2, floorY + 0.1, -9.4], 0.09, boltMat, false);

  const sumpPump = pump(-6.2, floorY + 0.35, -9.4, 0.65);
  pipe([-6.2, floorY + 0.7, -9.4], [-6.2, floorY + 2.4, -9.4], 0.07, boltMat, false);
  elbow([-6.2, floorY + 2.4, -9.4], 0.07, boltMat);
  pipe([-6.2, floorY + 2.4, -9.4], [-7.4, floorY + 2.4, -9.4], 0.07, boltMat, false);
  // 泄漏收集斗（挂在换热器鞍座下）
  [[8.6, -3.2], [-9.0, -3.0]].forEach(([x, z]) => {
    const funnel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.34, 0.1, 0.3, 14, 1, true)), steel);
    funnel.position.set(x, floorY + 0.42, z);
    group.add(funnel);
    pipe([x, floorY + 0.3, z], [-6.2, floorY + 0.16, z], 0.05, boltMat, false);
  });

  // ——————————————————————————— UG-A01..A03 TRANS 压缩空气 ———————————————————————————
  const airReceiver = new THREE.Mesh(track(new THREE.CylinderGeometry(0.55, 0.55, 2.6, 20)), airMat);
  airReceiver.rotation.z = Math.PI / 2;
  airReceiver.position.set(-6.2, floorY + 0.95, 6.6);
  group.add(airReceiver);
  [-1, 1].forEach(s => {
    const cap = new THREE.Mesh(track(new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)), airMat);
    cap.position.set(-6.2 + s * 1.3, floorY + 0.95, 6.6);
    cap.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(cap);
    const saddle = new THREE.Mesh(track(new THREE.BoxGeometry(0.3, 0.85, 1.2)), steel);
    saddle.position.set(-6.2 + s * 0.8, floorY + 0.42, 6.6);
    group.add(saddle);
  });
  const airGauge = gauge(-6.2, floorY + 1.75, 6.6);
  // 调压/阀组
  const manifold = new THREE.Mesh(track(new THREE.BoxGeometry(0.7, 0.5, 0.35)), boltMat);
  manifold.position.set(-4.6, floorY + 1.2, 6.6);
  group.add(manifold);
  const airValve = valve(-4.6, floorY + 1.55, 6.6, 0.11, 0xc8a12a);
  pipe([-5.5, floorY + 0.95, 6.6], [-4.6, floorY + 1.05, 6.6], 0.06, airMat, false);
  // 气路立管：穿过地下顶板 → 大厅 → 桥架（终点交给 reactorModel 的桥上气路）
  pipe([-4.6, floorY + 1.2, 6.6], [-4.6, ceilingY - 0.1, 6.6], 0.055, airMat, false);
  [floorY + 3.0, floorY + 5.0, floorY + 7.0].forEach(y => hanger(-4.6, y, 6.6, 0.35));
  const riserSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 14)), concrete);
  riserSleeve.position.set(-4.6, ceilingY, 6.6);
  group.add(riserSleeve);

  // ——————————————————————————— UG-E01/E02 电缆管廊 ———————————————————————————
  const trayMat = mat(0x4a5058, { metalness: 0.5, roughness: 0.5 });
  function gallery(z) {
    const g = new THREE.Group();
    const len = half * 2 - 2;
    [-0.28, 0.28].forEach(dz => {
      const side = new THREE.Mesh(track(new THREE.BoxGeometry(len, 0.14, 0.05)), trayMat);
      side.position.z = dz;
      g.add(side);
    });
    const rung = track(new THREE.BoxGeometry(0.05, 0.05, 0.6));
    const n = Math.floor(len / 0.6);
    const rungs = new THREE.InstancedMesh(rung, trayMat, n);
    for (let i = 0; i < n; i++) {
      dummy.position.set(-len / 2 + i * 0.6 + 0.3, -0.06, 0);
      dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1);
      dummy.updateMatrix();
      rungs.setMatrixAt(i, dummy.matrix);
    }
    rungs.instanceMatrix.needsUpdate = true;
    g.add(rungs);
    // 柔性电缆束（与刚性导管截面/材质不同）
    [-0.14, 0, 0.14].forEach((dz, i) => {
      const cable = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045 + i * 0.012, 0.045 + i * 0.012, len, 8)), cableMat);
      cable.rotation.z = Math.PI / 2;
      cable.position.set(0, 0.05, dz);
      g.add(cable);
    });
    g.position.set(0, ceilingY - 0.75, z);
    group.add(g);
    return g;
  }
  gallery(10.5);
  gallery(-11.5);
  // 刚性导管（与柔性电缆并行但截面/材质不同）
  const conduit = new THREE.Mesh(track(new THREE.CylinderGeometry(0.085, 0.085, half * 2 - 2, 12)), boltMat);
  conduit.rotation.z = Math.PI / 2;
  conduit.position.set(0, ceilingY - 1.15, 10.5);
  group.add(conduit);
  // 接地母排（铜）
  const groundBar = new THREE.Mesh(track(new THREE.BoxGeometry(half * 2 - 4, 0.06, 0.12)), copperMat);
  groundBar.position.set(0, floorY + 0.5, 12.4);
  group.add(groundBar);
  [-12, -6, 0, 6, 12].forEach(x => {
    const strap = new THREE.Mesh(track(new THREE.BoxGeometry(0.05, 0.5, 0.06)), copperMat);
    strap.position.set(x, floorY + 0.25, 12.4);
    group.add(strap);
  });

  // ——————————————————————————— UG-R01/R02 样品气动传输 ———————————————————————————
  // LENA 记录了连接放射化学实验室和热室的地下气动传输系统（SOURCE_VERIFIED）。
  // 管段从屏蔽体穿出后沿地下顶板走向场外，位置为 REALTIME_PROXY。
  const rabbitCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(3.9, -3.0, 3.2),
    new THREE.Vector3(5.6, -4.4, 4.6),
    new THREE.Vector3(6.4, ceilingY - 1.4, 8.4),
    new THREE.Vector3(6.4, ceilingY - 1.4, 14.0),
    new THREE.Vector3(6.4, ceilingY - 1.4, half - 0.5)
  ]);
  const rabbitTube = new THREE.Mesh(track(new THREE.TubeGeometry(rabbitCurve, 40, 0.075, 10, false)), boltMat);
  group.add(rabbitTube);
  [9.0, 12.0, 15.0].forEach(z => hanger(6.4, ceilingY - 1.25, z, 0.3));
  const hotCellFlange = flange(6.4, ceilingY - 1.4, half - 0.35, 0.075, "z");
  hotCellFlange.name = "UG-R02";

  // ——— 地下照明（少量点光 + 自发光灯具，保证设备可读）———
  const ugLampMat = track(new THREE.MeshStandardMaterial({
    color: 0xdfeaff, emissive: 0xbcd4f0, emissiveIntensity: 0.7, roughness: 0.45
  }));
  const ugLampGeo = track(new THREE.BoxGeometry(1.6, 0.1, 0.4));
  [[-9, 2], [9, 0], [0, -8], [10, 6], [-6, 10]].forEach(([x, z]) => {
    const l = new THREE.Mesh(ugLampGeo, ugLampMat);
    l.position.set(x, ceilingY - 0.35, z);
    group.add(l);
  });
  const ugLight1 = new THREE.PointLight(0xbcd4f0, 70, 26, 2);
  ugLight1.position.set(-8, ceilingY - 1.2, 2);
  group.add(ugLight1);
  const ugLight2 = new THREE.PointLight(0xbcd4f0, 70, 26, 2);
  ugLight2.position.set(9, ceilingY - 1.2, 0);
  group.add(ugLight2);

  // ——————————————————————————— 状态驱动 ———————————————————————————
  const hotColor = new THREE.Color(0x3a1004);
  let sumpLevel = 0;

  function update(state, dt = 0.016) {
    if (!state) return;
    const flow = clamp(state.coolantFlowProxy, 0, 1);
    const dT = clamp(state.poolTemperatureProxy - 0.12, 0, 1);
    const powered = !!state.unlocked;

    // 泵：轴/风扇转速 = 流量代理；流量 0 → 真的停住
    const spin = flow * 12 * dt * (reduceMotion ? 0.25 : 1);
    [pumpA, pumpB].forEach((p, i) => {
      const share = i === 0 ? flow : Math.max(0, flow - 0.35) / 0.65;
      const s = clamp(share, 0, 1);
      p.shaft.rotation.x += spin * (i === 0 ? 1 : 0.92);
      p.fan.rotation.x += spin * (i === 0 ? 1 : 0.92);
      p.lampMat.emissiveIntensity = s > 0.02 ? 0.4 + s * 1.4 : 0;
    });
    // 集水泵：泄漏收集是连续过程，池水温度越高蒸发/补水越多 → 液位上升；
    // 液位越过阈值时泵启动，把液位排回去。状态机可解释，不是无因动画。
    sumpLevel = clamp(sumpLevel + (0.006 + dT * 0.02) * dt, 0, 1);
    const sumpRun = sumpLevel > 0.55;
    if (sumpRun) sumpLevel = clamp(sumpLevel - 0.28 * dt, 0, 1);
    sumpPump.shaft.rotation.x += (sumpRun ? 9 : 0) * dt;
    sumpPump.fan.rotation.x += (sumpRun ? 9 : 0) * dt;
    sumpPump.lampMat.emissiveIntensity = sumpRun ? 1.6 : 0.05;
    sumpWater.position.y = floorY - 0.95 + sumpLevel * 0.75;
    sumpWaterMat.emissiveIntensity = 0.2 + sumpLevel * 0.5;

    // 阀杆位置：一回路隔离阀随流量开启，三回路阀随中间回路负荷开启
    primaryValve.stem.position.y = 0.18 * 3.2 + flow * 0.16;
    primaryValve.wheel.rotation.y += flow * 1.6 * dt;
    tertiaryValve.stem.position.y = 0.16 * 3.2 + clamp(dT * 2, 0, 1) * 0.14;
    tertiaryValve.wheel.rotation.y += clamp(dT * 2, 0, 1) * 1.2 * dt;

    // 换热器壳温：回路温差着色（冷 → 热）
    hx1.shellMat.emissive.copy(hotColor);
    hx1.shellMat.emissiveIntensity = dT * 1.5 * flow;
    hx2.shellMat.emissive.copy(hotColor);
    hx2.shellMat.emissiveIntensity = dT * 0.9 * flow;

    // 流向光珠
    updateBeads(primaryBeads, flow, dt);
    updateBeads(interBeads, flow * 0.9, dt);
    // 净化支路：常开小流量，随泵运行增强
    updateBeads(purifyBeads, 0.12 + flow * 0.35, dt);

    // 仪表指针：三回路流量与温度
    tertFlowGauge.rotation.z = -flow * 2.2 + 1.1;
    tertTempGauge.rotation.z = -dT * 2.2 + 1.1;
    // 储气罐压力：TRANS 在座 = 充满；弹出瞬间泄压；复位后重新充气
    const transPos = state.rod && state.rod.TRANS ? state.rod.TRANS.pos : 0;
    const airPressure = clamp(1 - transPos * 0.75, 0, 1);
    airGauge.rotation.z = -airPressure * 2.2 + 1.1;
    airValve.stem.position.y = 0.11 * 3.2 + (state.mode === "PULSE" ? 0.1 : 0);

    // 取样柜水质代理：净化支路运行时偏青，池水温度高时偏暖
    sampleScreenMat.emissiveIntensity = powered ? 0.4 + flow * 0.5 : 0.1;
    sampleScreenMat.emissive.setRGB(0.10 + dT * 0.5, 0.23 + flow * 0.2, 0.40);

    // 通风/辅助电源：地下照明只在会话时钟释放后达到工作亮度
    ugLight1.intensity = powered ? 70 : 26;
    ugLight2.intensity = powered ? 70 : 26;
    ugLampMat.emissiveIntensity = powered ? 0.7 : 0.25;
  }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  // 只读检查快照（供自动化验收确认“设备真的由状态驱动”，非文字）
  function snapshot() {
    return {
      components: PLANT_COMPONENTS.length,
      sumpLevel: +sumpLevel.toFixed(3),
      pumpASpin: +pumpA.shaft.rotation.x.toFixed(3),
      hx1Heat: +hx1.shellMat.emissiveIntensity.toFixed(3),
      primaryBeadPhase: +primaryBeads.phase.toFixed(3)
    };
  }

  void FLANGE_GEO;
  return { group, update, dispose, snapshot, bounds: UNDERGROUND_BOUNDS, components: PLANT_COMPONENTS };
}
