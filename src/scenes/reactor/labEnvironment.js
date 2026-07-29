// 反应堆实验大厅环境：把漆黑的背景换成真实的三维反应堆厂房。
//
// 全部为真实三维几何（无贴图背景、无平面兜底）：
//   - 房间外壳：混凝土操作层地面、四面墙、天花，工业照明灯具；
//   - 厂房设备：桥式起重机（轨道+小车+吊钩）、电缆桥架、墙面管路、监视屏、通风管；
//   - 人员安全设施：池边黄黑危险条带、状态危险信号灯（随反应堆状态变色/闪烁）、栏杆。
//
// 运动只由反应堆状态驱动（危险灯、监视屏），不做与状态无关的装饰性循环——
// 起重机等结构静止（除非将来接入吊装状态）。update(state) 每帧刷新状态驱动的部分。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

// 厂房尺度（世界单位，与反应堆共用坐标；屏蔽体外半径约 4.9）
const HALL = 44;          // 大厅平面边长：半宽 22 要大于相机最远机位（19），否则镜头会穿到墙外
const HALF = HALL / 2;
const FLOOR_Y = -0.06;    // 操作层地面（略低于走道 -0.02）
// 真实研究堆厂房是"高而空"的：吊装高度要够把堆芯部件从池里提出来，所以层高远大于
// 一般厂房。44×11 的比例接近实际，也避免大厅一放大就变成扁平的"盒子盖"。
const CEIL_Y = 12.0;      // 天花高度
const CRANE_Y = 9.0;      // 起重机轨道高度

// 相机是"厂房里的人"，不能穿墙穿顶。这里导出房间内净空，由 physicalScene 拿去夹取
// 轨道机位——单一事实来源，改厂房尺寸时相机限制自动跟着走。
export const HALL_BOUNDS = {
  half: HALF - 0.9,       // 留出墙厚与近裁剪面的余量
  ceiling: CEIL_Y - 1.1,  // 留出灯具/桥架的余量
  floor: FLOOR_Y
};

// 厂房的**可见**混凝土结构对应的碰撞面：操作层地面顶面与四面墙内表面。玻璃被拖过
// 栏杆掉出去时，落到的是这块真实存在的楼板，而不是无限下坠——碰撞体与看得见的
// 几何一一对应，不是凭空的隐形平面。
export const HALL_COLLIDERS = {
  floorTop: FLOOR_Y,
  wallInner: HALF - 0.15   // 墙厚 0.3，内表面在 HALF-0.15
};

// LAB-002 地面设备清单：id / 资料标签 / 上游 / 下游。
// 每一台都有上下游，测试据此确认"管线不在半空结束"，实现报告据此列证据。
// 注意：`REACTOR_POOL_SYSTEM.md` 锁定"三回路 + 两台换热器"，两台换热器都在地下
// （UG-H01/UG-H02），因此地面**不允许**再出现换热器——这里只有补给、取样、通风、
// 电气与气路设备。
export const LAB_COMPONENTS = [
  { id: "LAB-X01", tag: "REALTIME_PROXY", name: "siteWaterPenetration", up: "site", down: "LAB-M01" },
  { id: "LAB-M01", tag: "TRIGA_ANALOGUE", name: "makeupWaterTank", up: "LAB-X01", down: "LAB-K01" },
  { id: "LAB-K01", tag: "TRIGA_ANALOGUE", name: "makeupPumpA", up: "LAB-M01", down: "LAB-M02" },
  { id: "LAB-K02", tag: "TRIGA_ANALOGUE", name: "makeupPumpB", up: "LAB-M01", down: "LAB-M02" },
  { id: "LAB-M02", tag: "REALTIME_PROXY", name: "poolFillFlange", up: "LAB-K01", down: "pool" },
  { id: "LAB-D01", tag: "TRIGA_ANALOGUE", name: "overflowDrainRiser", up: "LAB-M01", down: "UG-D02" },
  { id: "LAB-Q01", tag: "REALTIME_PROXY", name: "poolInstrumentMast", up: "pool", down: "LAB-Q02" },
  { id: "LAB-Q02", tag: "TRIGA_ANALOGUE", name: "samplingCabinet", up: "LAB-Q01", down: "UG-F03" },
  { id: "LAB-C01", tag: "TRIGA_ANALOGUE", name: "rodDriveCabinetSHIM", up: "UG-E01", down: "rodSHIM" },
  { id: "LAB-C02", tag: "TRIGA_ANALOGUE", name: "rodDriveCabinetREG", up: "UG-E01", down: "rodREG" },
  { id: "LAB-C03", tag: "TRIGA_ANALOGUE", name: "rodDriveCabinetTRANS", up: "UG-E01", down: "rodTRANS" },
  { id: "LAB-C04", tag: "TRIGA_ANALOGUE", name: "safetyAnnunciator", up: "UG-E01", down: "hall" },
  { id: "LAB-V01", tag: "TRIGA_ANALOGUE", name: "supplyAirUnit", up: "site", down: "LAB-V03" },
  { id: "LAB-V02", tag: "TRIGA_ANALOGUE", name: "exhaustAirUnit", up: "LAB-V03", down: "stack" },
  { id: "LAB-V03", tag: "REALTIME_PROXY", name: "hallDuct", up: "LAB-V01", down: "LAB-V02" },
  { id: "LAB-A01", tag: "TRIGA_ANALOGUE", name: "transAirRegulatorPanel", up: "UG-A03", down: "bridge" },
  { id: "LAB-T01", tag: "REALTIME_PROXY", name: "poolToolRack", up: "hall", down: "pool" },
  { id: "LAB-P01", tag: "SOURCE_ART_DIRECTION", name: "maintenancePlatform", up: "hall", down: "LAB-M01" }
];

export function createLabEnvironment({ reduceMotion } = {}) {
  const group = new THREE.Group();
  // LAB-004 连续状态（不是动画计时器）：补给贮罐液位与通风转速
  let makeupLevel = 0.86;
  let makeupRunning = false;
  let ventSpeed = 0;
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const mat = (color, opts = {}) => track(new THREE.MeshStandardMaterial(Object.assign({
    color, metalness: 0.1, roughness: 0.85
  }, opts)));
  // 法兰/螺栓一类的亮金属只需要一份材质，重复 new 出来的只是垃圾
  let _bolt = null;
  const boltLikeMat = () => (_bolt ||= mat(0x8f979e, { metalness: 0.85, roughness: 0.3 }));

  // 两点之间的一段直管：管线必须首尾都落在实体上，不能停在半空（LAB-002/LAB-003）。
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Vector3();
  function pipeRun(parent, keep, material, from, to, r = 0.12) {
    _a.fromArray(from); _b.fromArray(to);
    const len = _a.distanceTo(_b);
    if (len < 1e-4) return null;
    const seg = new THREE.Mesh(keep(new THREE.CylinderGeometry(r, r, len, 12)), material);
    seg.position.copy(_m.addVectors(_a, _b).multiplyScalar(0.5));
    seg.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), _b.clone().sub(_a).normalize()
    );
    parent.add(seg);
    return seg;
  }

  // —— 环境补光：让厂房不至于纯黑（半球光廉价，不做逐灯阴影）——
  const hemi = new THREE.HemisphereLight(0x3a4a5e, 0x0a0f14, 0.55);
  group.add(hemi);

  // —— 房间外壳 ——
  const concrete = mat(0x2c333b, { roughness: 0.95, metalness: 0.05 });
  const concreteWall = mat(0x333b44, { roughness: 0.92, metalness: 0.05 });
  // 地板、四面墙和天花板不再是混凝土盒子：它们由 glassArchitecture.js 的独立玻璃砖
  // 单元构成（GLA-001/GLA-002）。这里只保留混凝土材质，供设备基础、穿墙套管和
  // 楼板套管复用。
  void concreteWall;

  // —— 天花工业灯具（自发光板 + 少量真实点光提供厂房照明）——
  const fixtureMat = track(new THREE.MeshStandardMaterial({
    color: 0xdfeaff, emissive: 0xcfe0ff, emissiveIntensity: 0.9, roughness: 0.4
  }));
  // 灯具按 8 米栅格铺满大厅（自发光板本身不发光照，只是"看得见的灯"）
  const fixtureGeo = track(new THREE.BoxGeometry(2.4, 0.12, 0.7));
  const lampStep = 8;
  const lampN = Math.floor(HALF / lampStep);
  for (let i = -lampN; i <= lampN; i++) {
    for (let j = -lampN; j <= lampN; j++) {
      const fx = new THREE.Mesh(fixtureGeo, fixtureMat);
      fx.position.set(i * lampStep, CEIL_Y - 0.18, j * lampStep);
      group.add(fx);
    }
  }
  // 三盏柔和点光（成本可控）提供真实照明与方向感；距离覆盖到大厅对角
  [[-8, -8], [8, 8], [0, 2]].forEach(([x, z], i) => {
    const lamp = new THREE.PointLight(0xbfd4f0, i === 2 ? 130 : 110, 60, 2);
    lamp.position.set(x, CEIL_Y - 0.6, z);
    group.add(lamp);
  });

  // —— 桥式起重机：两条轨道 + 横梁 + 小车 + 吊钩（静止结构）——
  const steel = mat(0x565f68, { metalness: 0.6, roughness: 0.45 });
  const craneYellow = mat(0xc8a12a, { metalness: 0.5, roughness: 0.5 });
  const railGeo = track(new THREE.BoxGeometry(HALL - 1, 0.25, 0.35));
  [-7, 7].forEach(z => {
    const rail = new THREE.Mesh(railGeo, steel);
    rail.position.set(0, CRANE_Y, z);
    group.add(rail);
  });
  const girder = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.5, 14.4)), craneYellow);
  girder.position.set(-3.5, CRANE_Y + 0.2, 0);
  group.add(girder);
  const trolley = new THREE.Mesh(track(new THREE.BoxGeometry(0.9, 0.6, 1.2)), craneYellow);
  trolley.position.set(-3.5, CRANE_Y - 0.1, 2.2);
  group.add(trolley);
  const cable1 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.03, 2.6, 6)), steel);
  cable1.position.set(-3.5, CRANE_Y - 1.5, 2.2);
  group.add(cable1);
  const hook = new THREE.Mesh(track(new THREE.TorusGeometry(0.14, 0.05, 8, 12, Math.PI * 1.4)), steel);
  hook.position.set(-3.5, CRANE_Y - 2.9, 2.2);
  hook.rotation.x = Math.PI / 2;
  group.add(hook);

  // —— 电缆桥架（沿墙上沿的梯式结构，用实例化横档）——
  const trayMat = mat(0x4a5058, { metalness: 0.5, roughness: 0.5 });
  function cableTray(x, z, len, axis) {
    const g = new THREE.Group();
    const side1 = new THREE.Mesh(track(new THREE.BoxGeometry(len, 0.12, 0.05)), trayMat);
    const side2 = side1.clone();
    side1.position.z = -0.2; side2.position.z = 0.2;
    g.add(side1, side2);
    const rungGeo = track(new THREE.BoxGeometry(0.05, 0.08, 0.45));
    const n = Math.floor(len / 0.5);
    const rungs = new THREE.InstancedMesh(rungGeo, trayMat, n);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      dummy.position.set(-len / 2 + i * 0.5 + 0.25, 0, 0);
      dummy.updateMatrix(); rungs.setMatrixAt(i, dummy.matrix);
    }
    rungs.instanceMatrix.needsUpdate = true;
    g.add(rungs);
    g.position.set(x, CEIL_Y - 1.1, z);
    if (axis === 'z') g.rotation.y = Math.PI / 2;
    return g;
  }
  group.add(cableTray(0, -HALF + 0.5, HALL - 2, 'x'));
  group.add(cableTray(HALF - 0.5, 0, HALL - 2, 'z'));

  // —— 墙面管路（几根沿墙竖/横向大管）——
  const pipeMat = mat(0x60686f, { metalness: 0.6, roughness: 0.4 });
  const pipeH = new THREE.Mesh(track(new THREE.CylinderGeometry(0.18, 0.18, HALL - 3, 16)), pipeMat);
  pipeH.rotation.z = Math.PI / 2;
  pipeH.position.set(0, 1.4, -HALF + 0.45);
  group.add(pipeH);
  const pipeV = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, 5.5, 16)), pipeMat);
  pipeV.position.set(-HALF + 0.5, 2.6, -4);
  group.add(pipeV);

  // —— 通风管（天花下的大方管 + 弯头）——
  const ductMat = mat(0x707880, { metalness: 0.4, roughness: 0.6 });
  const duct = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.8, HALL - 4)), ductMat);
  duct.position.set(HALF - 1.6, CEIL_Y - 1.0, 0);
  group.add(duct);
  const ductElbow = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.8, 3)), ductMat);
  ductElbow.rotation.y = Math.PI / 2;
  ductElbow.position.set(HALF - 3, CEIL_Y - 1.0, -HALF + 3);
  group.add(ductElbow);

  // —— 仪表柜列（池后方的落地机柜，柜面自发光屏随反应堆状态变色；无文字）——
  // 放在中景（z≈-9.5）而不是 22 米外的墙上：真实厂房里核测量与工艺仪表机柜就是
  // 沿池边成排落地布置的，同时也把放大后的大厅中景填起来，避免"空盒子"观感。
  const monitors = [];
  const cabMat = mat(0x353d45, { metalness: 0.45, roughness: 0.55 });
  const rackZ = -9.5;
  for (let i = 0; i < 5; i++) {
    const x = -6.4 + i * 3.2;
    const cab = new THREE.Mesh(track(new THREE.BoxGeometry(2.6, 2.2, 0.9)), cabMat);
    cab.position.set(x, FLOOR_Y + 1.1, rackZ);
    group.add(cab);
    // 柜顶通风罩
    const cap = new THREE.Mesh(track(new THREE.BoxGeometry(2.7, 0.12, 1.0)), mat(0x1c2126));
    cap.position.set(x, FLOOR_Y + 2.26, rackZ);
    group.add(cap);
    const m = track(new THREE.MeshStandardMaterial({
      color: 0x0a1420, emissive: 0x1b3a66, emissiveIntensity: 0.7, roughness: 0.3
    }));
    const screen = new THREE.Mesh(track(new THREE.BoxGeometry(1.9, 1.15, 0.06)), m);
    screen.position.set(x, FLOOR_Y + 1.45, rackZ + 0.48);
    group.add(screen);
    monitors.push(m);
  }

  // —— LAB-002 池水补给（去离子水）撬块：贮罐 + 两台补给泵 ——
  //
  // 这里**原本**放着一台卧式换热器。`REACTOR_POOL_SYSTEM.md` 锁定的拓扑是"三回路、
  // 两台换热器"，而两台换热器（UG-H01/UG-H02）都在地下设备层里；地面再摆一台就变成
  // 第三台，属于凭空增加设备。因此本轮把这套撬块改成池水蒸发补给用的去离子水贮罐 +
  // 两台补给泵：上游是场区去矿物质水的穿墙接口（LAB-X01，`REALTIME_PROXY`，与地下
  // UG-X01 的处理方式一致），下游是屏蔽体上的池内补水法兰，溢流/排空经楼板套管落到
  // 地下集水坑（UG-D02）。没有任何一段管子停在半空。
  const tankMat = mat(0x8a9199, { metalness: 0.55, roughness: 0.4 });
  const loopPipe = mat(0x5a6570, { metalness: 0.6, roughness: 0.4 });
  const makeupTank = new THREE.Mesh(track(new THREE.CylinderGeometry(0.85, 0.85, 4.4, 20)), tankMat);
  makeupTank.rotation.z = Math.PI / 2;
  makeupTank.position.set(-9.4, FLOOR_Y + 1.5, -1.5);
  group.add(makeupTank);
  [-1, 1].forEach(s => {
    const saddle = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 1.5, 1.7)), steel);
    saddle.position.set(-9.4 + s * 1.6, FLOOR_Y + 0.75, -1.5);
    group.add(saddle);
    // 罐两端封头（把圆柱端面盖住，避免看起来像被切开的管）
    const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.85, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2)), tankMat);
    head.position.set(-9.4 + s * 2.2, FLOOR_Y + 1.5, -1.5);
    head.rotation.z = s > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(head);
  });
  // 人孔 + 玻璃液位计（液位随补给动作变化，见 update）
  const manway = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 14)), boltLikeMat());
  manway.position.set(-9.4, FLOOR_Y + 2.38, -1.5);
  group.add(manway);
  const gaugeGlassMat = track(new THREE.MeshStandardMaterial({
    color: 0x1a3f52, emissive: 0x2ea8d8, emissiveIntensity: 0.5, roughness: 0.25,
    transparent: true, opacity: 0.85
  }));
  const tankGauge = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 1.2, 0.07)), gaugeGlassMat);
  tankGauge.position.set(-9.4, FLOOR_Y + 1.5, -0.6);
  group.add(tankGauge);

  // 两台立式补给泵（电机 + 蜗壳 + 联轴节护罩），出口汇入补水总管
  const pumpMotorMat = mat(0x2f6f5a, { metalness: 0.5, roughness: 0.5 });
  const makeupPumps = [];
  [0, 1].forEach(k => {
    const z = 1.6 + k * 2.0;
    const skid = new THREE.Mesh(track(new THREE.BoxGeometry(1.6, 0.25, 1.4)), steel);
    skid.position.set(-9.4, FLOOR_Y + 0.13, z);
    group.add(skid);
    const volute = new THREE.Mesh(track(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16)), tankMat);
    volute.position.set(-9.4, FLOOR_Y + 0.5, z);
    group.add(volute);
    const motor = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.3, 1.1, 14)), pumpMotorMat);
    motor.position.set(-9.4, FLOOR_Y + 1.3, z);
    group.add(motor);
    // 联轴节风扇：只有这台泵真的在补给时才转（LAB-004）
    const fan = new THREE.Mesh(track(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 8)), steel);
    fan.position.set(-9.4, FLOOR_Y + 0.86, z);
    group.add(fan);
    const lampMat = track(new THREE.MeshStandardMaterial({
      color: 0x101418, emissive: 0x33ff88, emissiveIntensity: 0, roughness: 0.3
    }));
    const lamp = new THREE.Mesh(track(new THREE.SphereGeometry(0.07, 10, 8)), lampMat);
    lamp.position.set(-8.95, FLOOR_Y + 1.3, z);
    group.add(lamp);
    makeupPumps.push({ fan, lampMat });
  });
  // 场区去矿物质水穿墙接口（LAB-X01）→ 贮罐
  const wallPen = new THREE.Mesh(track(new THREE.CylinderGeometry(0.22, 0.22, 0.5, 14)), concrete);
  wallPen.rotation.z = Math.PI / 2;
  wallPen.position.set(-HALF + 0.3, FLOOR_Y + 2.4, -1.5);
  group.add(wallPen);
  pipeRun(group, track, loopPipe, [-HALF + 0.5, FLOOR_Y + 2.4, -1.5], [-11.6, FLOOR_Y + 2.4, -1.5], 0.12);
  pipeRun(group, track, loopPipe, [-11.6, FLOOR_Y + 2.4, -1.5], [-11.6, FLOOR_Y + 1.5, -1.5], 0.12);
  pipeRun(group, track, loopPipe, [-11.6, FLOOR_Y + 1.5, -1.5], [-10.25, FLOOR_Y + 1.5, -1.5], 0.12);
  // 贮罐 → 两台泵吸入
  pipeRun(group, track, loopPipe, [-9.4, FLOOR_Y + 0.66, 0.65], [-9.4, FLOOR_Y + 0.66, 3.6], 0.12);
  pipeRun(group, track, loopPipe, [-9.4, FLOOR_Y + 0.9, 0.0], [-9.4, FLOOR_Y + 0.66, 0.65], 0.12);
  pipeRun(group, track, loopPipe, [-9.4, FLOOR_Y + 1.5, -0.15], [-9.4, FLOOR_Y + 0.9, 0.0], 0.12);
  // 泵出口 → 补水总管 → 屏蔽体上的池内补水法兰（LAB-M02，终点是实体，不是半空）
  pipeRun(group, track, loopPipe, [-9.4, FLOOR_Y + 0.5, 4.7], [-9.4, FLOOR_Y + 1.9, 4.7], 0.14);
  pipeRun(group, track, loopPipe, [-9.4, FLOOR_Y + 1.9, 4.7], [-4.0, FLOOR_Y + 1.9, 4.7], 0.14);
  pipeRun(group, track, loopPipe, [-4.0, FLOOR_Y + 1.9, 4.7], [-3.4, FLOOR_Y + 1.3, 4.1], 0.14);
  const fillFlange = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 16)), boltLikeMat());
  fillFlange.position.set(-3.35, FLOOR_Y + 1.25, 4.05);
  fillFlange.lookAt(0, FLOOR_Y + 1.25, 0);
  fillFlange.rotateX(Math.PI / 2);
  group.add(fillFlange);
  // 溢流/排空 → 楼板套管 → 地下集水坑（LAB-D01 → UG-D02）
  pipeRun(group, track, loopPipe, [-10.25, FLOOR_Y + 0.55, -1.5], [-11.4, FLOOR_Y + 0.55, -1.5], 0.09);
  pipeRun(group, track, loopPipe, [-11.4, FLOOR_Y + 0.55, -1.5], [-11.4, FLOOR_Y + 0.55, -7.6], 0.09);
  pipeRun(group, track, loopPipe, [-11.4, FLOOR_Y + 0.55, -7.6], [-6.2, FLOOR_Y + 0.55, -7.6], 0.09);
  pipeRun(group, track, loopPipe, [-6.2, FLOOR_Y + 0.55, -7.6], [-6.2, FLOOR_Y - 0.55, -7.6], 0.09);
  const drainSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 14)), concrete);
  drainSleeve.position.set(-6.2, FLOOR_Y - 0.28, -7.6);
  group.add(drainSleeve);

  // —— 乏燃料 / 源转运容器（屏蔽罐）与一排储料桶：池的 +X 侧中景 ——
  const caskMat = mat(0x4d545b, { metalness: 0.5, roughness: 0.55 });
  const cask = new THREE.Mesh(track(new THREE.CylinderGeometry(0.75, 0.75, 2.6, 18)), caskMat);
  cask.position.set(9.2, FLOOR_Y + 1.3, -2.4);
  group.add(cask);
  const caskLid = new THREE.Mesh(track(new THREE.CylinderGeometry(0.85, 0.85, 0.22, 18)), craneYellow);
  caskLid.position.set(9.2, FLOOR_Y + 2.72, -2.4);
  group.add(caskLid);
  const drumGeo = track(new THREE.CylinderGeometry(0.32, 0.32, 0.9, 14));
  const drums = new THREE.InstancedMesh(drumGeo, craneYellow, 6);
  const drumDummy = new THREE.Object3D();
  for (let i = 0; i < 6; i++) {
    drumDummy.position.set(8.6 + (i % 2) * 0.75, FLOOR_Y + 0.45, 1.4 + Math.floor(i / 2) * 0.8);
    drumDummy.updateMatrix();
    drums.setMatrixAt(i, drumDummy.matrix);
  }
  drums.instanceMatrix.needsUpdate = true;
  group.add(drums);

  // ————————————————— LAB-002 棒驱动供电与信号柜（控制区，+Z）—————————————————
  //
  // 三套棒驱动各有一台落地柜，电源与信号从地下电缆管廊（UG-E01）经楼板套管上来，
  // 下游是 reactorModel 的三根控制棒驱动。柜面只有一盏"驱动可用"灯和一条行程指示
  // 条，两者都直接读 sessionController 的 `rodDriveEnabled` 与 `rod[name].pos`——
  // 没有第二套反应堆状态，也没有无因闪烁（LAB-004 / CTL-003）。
  const cabDark = mat(0x2b323a, { metalness: 0.5, roughness: 0.5 });
  const rodCabs = [];
  const ROD_CAB_Z = 10.6;
  ["SHIM", "REG", "TRANS"].forEach((name, i) => {
    const x = -2.4 + i * 2.4;
    const body = new THREE.Mesh(track(new THREE.BoxGeometry(1.7, 2.4, 0.85)), cabDark);
    body.position.set(x, FLOOR_Y + 1.2, ROD_CAB_Z);
    group.add(body);
    // 基础（穿过玻璃地板砖落到透明承托层上：设备是固定结构，地板砖是可搬开的盖板）
    const plinth = new THREE.Mesh(track(new THREE.BoxGeometry(1.8, 0.3, 0.95)), concrete);
    plinth.position.set(x, FLOOR_Y - 0.14, ROD_CAB_Z);
    group.add(plinth);
    // 柜门缝 + 通风百叶
    const louver = new THREE.Mesh(track(new THREE.BoxGeometry(1.1, 0.5, 0.04)), steel);
    louver.position.set(x, FLOOR_Y + 0.55, ROD_CAB_Z - 0.44);
    group.add(louver);
    const lampMat = track(new THREE.MeshStandardMaterial({
      color: 0x101418, emissive: 0x2fd07a, emissiveIntensity: 0, roughness: 0.3
    }));
    const lamp = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12)), lampMat);
    lamp.rotation.x = Math.PI / 2;
    lamp.position.set(x - 0.5, FLOOR_Y + 2.0, ROD_CAB_Z - 0.44);
    group.add(lamp);
    // 行程指示条：几何高度 = 棒位（缩放，不是贴图）
    const barMat = track(new THREE.MeshStandardMaterial({
      color: 0x0d2036, emissive: 0x4ad0ff, emissiveIntensity: 0.6, roughness: 0.3
    }));
    const bar = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, 1.0, 0.04)), barMat);
    bar.position.set(x + 0.45, FLOOR_Y + 1.55, ROD_CAB_Z - 0.44);
    group.add(bar);
    const barTrack = new THREE.Mesh(track(new THREE.BoxGeometry(0.2, 1.06, 0.03)), mat(0x14181d));
    barTrack.position.set(x + 0.45, FLOOR_Y + 1.55, ROD_CAB_Z - 0.46);
    group.add(barTrack);
    rodCabs.push({ name, lampMat, bar, barMat, baseY: FLOOR_Y + 1.05 });
  });
  // 电缆立管：地下管廊（UG-E01，(0, ceilingY-1.15, 10.5)）→ 楼板套管 → 柜底汇线槽
  const cableRiserMat = mat(0x343a41, { metalness: 0.4, roughness: 0.6 });
  const riserSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.26, 0.26, 0.5, 14)), concrete);
  riserSleeve.position.set(0, FLOOR_Y - 0.25, 10.5);
  group.add(riserSleeve);
  pipeRun(group, track, cableRiserMat, [0, FLOOR_Y - 0.5, 10.5], [0, FLOOR_Y + 0.35, 10.5], 0.2);
  const cabTrunk = new THREE.Mesh(track(new THREE.BoxGeometry(6.6, 0.24, 0.34)), cableRiserMat);
  cabTrunk.position.set(0, FLOOR_Y + 0.32, ROD_CAB_Z - 0.62);
  group.add(cabTrunk);
  pipeRun(group, track, cableRiserMat, [0, FLOOR_Y + 0.35, 10.5], [0, FLOOR_Y + 0.32, ROD_CAB_Z - 0.62], 0.18);

  // ————————————————— LAB-002 独立安全/停堆指示柱 —————————————————
  //
  // 与两台控制台物理分离（大厅另一侧的立柱），只做四路状态显示：停堆、时钟/供电、
  // 联锁允许、控制权归属。它不接受点击，也不是第三套控制装置。
  const annunPost = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.07, 2.8, 10)), steel);
  annunPost.position.set(-7.8, FLOOR_Y + 1.4, 8.2);
  group.add(annunPost);
  const annunBox = new THREE.Mesh(track(new THREE.BoxGeometry(0.9, 0.62, 0.22)), cabDark);
  annunBox.position.set(-7.8, FLOOR_Y + 2.6, 8.2);
  annunBox.rotation.y = -0.5;
  group.add(annunBox);
  const annunLamps = [0xff2020, 0xdfeaff, 0xffb020, 0x3aa0ff].map((c, i) => {
    const m = track(new THREE.MeshStandardMaterial({
      color: 0x0c1014, emissive: c, emissiveIntensity: 0.05, roughness: 0.3
    }));
    const l = new THREE.Mesh(track(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 12)), m);
    l.position.set(-7.8, FLOOR_Y + 2.6, 8.2);
    l.translateOnAxis(new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), -0.5), -0.3 + (i % 2) * 0.6);
    l.position.y += i < 2 ? 0.14 : -0.14;
    l.rotation.set(Math.PI / 2, 0, 0);
    l.rotateY(-0.5);
    group.add(l);
    return m;
  });
  const annunLight = new THREE.PointLight(0xff2020, 0, 9, 2);
  annunLight.position.set(-7.8, FLOOR_Y + 2.8, 8.2);
  group.add(annunLight);

  // ————————————————— LAB-002 池边取样与水质/辐射监测 —————————————————
  //
  // 传感器桅杆立在屏蔽体外沿（液位、池水温度、电导率探头下水，辐射监测仪朝池口），
  // 信号沿一条线槽走到取样柜；取样柜下面是穿楼板的取样管，接地下净化支路
  // （UG-F03 → UG-S01）。柜面屏幕的颜色/亮度由池水温度与净化流量代理驱动。
  const mastX = 4.2, mastZ = 3.4;                    // r ≈ 5.4，正好在屏蔽体外皮外侧
  const mast = new THREE.Mesh(track(new THREE.CylinderGeometry(0.055, 0.055, 2.2, 10)), steel);
  mast.position.set(mastX, FLOOR_Y + 1.1, mastZ);
  group.add(mast);
  const sensorMats = [];
  [[0x4ad0ff, 0.55], [0xff8a3a, 0.95], [0x9fe8ff, 1.35], [0xc8ff5a, 1.75]].forEach(([c, y]) => {
    const m = track(new THREE.MeshStandardMaterial({
      color: 0x11161b, emissive: c, emissiveIntensity: 0.15, roughness: 0.35
    }));
    const box = new THREE.Mesh(track(new THREE.BoxGeometry(0.22, 0.2, 0.16)), m);
    box.position.set(mastX + 0.16, FLOOR_Y + y, mastZ);
    group.add(box);
    sensorMats.push(m);
  });
  // 液位/温度/电导率探头缆下到池水里（终点在水面以下，不停在半空）
  pipeRun(group, track, cableRiserMat, [mastX + 0.16, FLOOR_Y + 0.55, mastZ], [3.05, FLOOR_Y - 0.9, 2.5], 0.025);
  // 桅杆 → 取样柜的信号线槽
  const sampX = 7.6, sampZ = 3.0;
  pipeRun(group, track, cableRiserMat, [mastX, FLOOR_Y + 1.95, mastZ], [sampX, FLOOR_Y + 1.95, sampZ], 0.05);
  const sampCab = new THREE.Mesh(track(new THREE.BoxGeometry(0.95, 2.0, 0.7)), cabDark);
  sampCab.position.set(sampX, FLOOR_Y + 1.0, sampZ);
  group.add(sampCab);
  const sampScreenMat = track(new THREE.MeshStandardMaterial({
    color: 0x0a1420, emissive: 0x1b3a66, emissiveIntensity: 0.6, roughness: 0.3
  }));
  const sampScreen = new THREE.Mesh(track(new THREE.BoxGeometry(0.62, 0.42, 0.05)), sampScreenMat);
  sampScreen.position.set(sampX, FLOOR_Y + 1.5, sampZ - 0.37);
  group.add(sampScreen);
  // 取样管：柜底 → 楼板套管 → 地下净化支路
  pipeRun(group, track, loopPipe, [sampX, FLOOR_Y + 0.2, sampZ], [sampX, FLOOR_Y - 0.55, sampZ], 0.045);
  const sampSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 12)), concrete);
  sampSleeve.position.set(sampX, FLOOR_Y - 0.28, sampZ);
  group.add(sampSleeve);

  // ————————————————— LAB-002 送风/排风机组与竖风管 —————————————————
  //
  // 大厅通风：送风机组把外部空气送进大厅，排风机组从大厅抽风经天花大方管排到烟囱。
  // 两台风机轮只在会话时钟释放（供电）后转，转速随池水温度上升——不是常开动画。
  const ahuMat = mat(0x596670, { metalness: 0.45, roughness: 0.55 });
  const ahus = [];
  [[17.6, 6.0, 1], [17.6, -6.0, -1]].forEach(([x, z, dir]) => {
    const box = new THREE.Mesh(track(new THREE.BoxGeometry(2.6, 2.4, 2.0)), ahuMat);
    box.position.set(x, FLOOR_Y + 1.2, z);
    group.add(box);
    const base = new THREE.Mesh(track(new THREE.BoxGeometry(2.8, 0.25, 2.2)), concrete);
    base.position.set(x, FLOOR_Y + 0.12, z);
    group.add(base);
    // 风机轮（护网后可见）
    const guard = new THREE.Mesh(track(new THREE.TorusGeometry(0.62, 0.05, 6, 18)), steel);
    guard.position.set(x - 1.32, FLOOR_Y + 1.4, z);
    guard.rotation.y = Math.PI / 2;
    group.add(guard);
    const wheel = new THREE.Group();
    for (let b = 0; b < 6; b++) {
      const blade = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 1.05, 0.2)), steel);
      blade.rotation.x = (b / 6) * Math.PI * 2;
      blade.rotation.z = 0.35;
      wheel.add(blade);
    }
    // 叶片已经绕 X 轴排布（风机朝 -X 面向大厅），所以直接增量 rotation.x 就是转子自转
    wheel.position.set(x - 1.26, FLOOR_Y + 1.4, z);
    group.add(wheel);
    // 竖风管 → 天花大方管（x = HALF-1.6 = 20.4，y = CEIL_Y-1.0）
    const riser = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, CEIL_Y - 1.0 - (FLOOR_Y + 2.4), 0.8)), ductMat);
    riser.position.set(x + 1.0, (CEIL_Y - 1.0 + FLOOR_Y + 2.4) / 2, z);
    group.add(riser);
    const tie = new THREE.Mesh(track(new THREE.BoxGeometry(2.0, 0.8, 0.8)), ductMat);
    tie.position.set(HALF - 2.6, CEIL_Y - 1.0, z);
    group.add(tie);
    const tieZ = new THREE.Mesh(track(new THREE.BoxGeometry(0.8, 0.8, Math.abs(z) + 0.4)), ductMat);
    tieZ.position.set(HALF - 1.6, CEIL_Y - 1.0, z / 2);
    group.add(tieZ);
    ahus.push({ wheel, dir });
  });

  // ————————————————— LAB-002 池边长柄工具支架 —————————————————
  const rackFrame = new THREE.Mesh(track(new THREE.BoxGeometry(0.12, 2.2, 1.8)), steel);
  rackFrame.position.set(-6.6, FLOOR_Y + 1.1, -3.2);
  group.add(rackFrame);
  const toolGeo = track(new THREE.CylinderGeometry(0.035, 0.035, 3.6, 8));
  const tools = new THREE.InstancedMesh(toolGeo, boltLikeMat(), 5);
  const toolDummy = new THREE.Object3D();
  for (let i = 0; i < 5; i++) {
    toolDummy.position.set(-6.45 + (i % 2) * 0.12, FLOOR_Y + 1.72, -3.9 + i * 0.36);
    toolDummy.rotation.set(0, 0, 0.16);
    toolDummy.updateMatrix();
    tools.setMatrixAt(i, toolDummy.matrix);
  }
  tools.instanceMatrix.needsUpdate = true;
  group.add(tools);

  // ————————————————— LAB-001 维护平台、楼梯与栏杆 —————————————————
  //
  // 补给撬块上方的检修平台：楼梯从操作层上去，平台边缘有栏杆，形成"地面 → 平台 →
  // 罐顶人孔/阀门"这条可解释的通行关系，而不是一堆互不相干的箱子。
  const PLAT_Y = FLOOR_Y + 2.9;
  const grateMat = mat(0x4e5760, { metalness: 0.55, roughness: 0.55 });
  const deck = new THREE.Mesh(track(new THREE.BoxGeometry(3.2, 0.12, 7.4)), grateMat);
  deck.position.set(-12.0, PLAT_Y, 0.4);
  group.add(deck);
  [[-13.4, -3.1], [-13.4, 3.9], [-10.6, -3.1], [-10.6, 3.9]].forEach(([x, z]) => {
    const col = new THREE.Mesh(track(new THREE.BoxGeometry(0.16, PLAT_Y - FLOOR_Y, 0.16)), steel);
    col.position.set(x, (PLAT_Y + FLOOR_Y) / 2, z);
    group.add(col);
  });
  // 直跑楼梯（踏步实例化）
  const stepGeo = track(new THREE.BoxGeometry(1.0, 0.06, 0.28));
  const stepN = 12;
  const steps = new THREE.InstancedMesh(stepGeo, grateMat, stepN);
  const stepDummy = new THREE.Object3D();
  for (let i = 0; i < stepN; i++) {
    stepDummy.position.set(-12.0, FLOOR_Y + 0.24 * (i + 1), 4.3 + i * 0.3);
    stepDummy.updateMatrix();
    steps.setMatrixAt(i, stepDummy.matrix);
  }
  steps.instanceMatrix.needsUpdate = true;
  group.add(steps);
  const stringer = new THREE.Mesh(track(new THREE.BoxGeometry(0.08, 0.3, 4.8)), steel);
  stringer.position.set(-12.0, FLOOR_Y + 1.4, 5.9);
  stringer.rotation.x = -Math.atan2(2.88, 3.6);
  group.add(stringer);
  // 栏杆：平台四周 + 楼梯侧；立柱实例化，扶手/中间横杆用细长盒
  const railMat = craneYellow;
  const postGeo = track(new THREE.BoxGeometry(0.06, 1.05, 0.06));
  const railPosts = [];
  for (let i = 0; i <= 7; i++) railPosts.push([-13.5, -3.2 + i * 1.06]);
  for (let i = 0; i <= 7; i++) railPosts.push([-10.5, -3.2 + i * 1.06]);
  const posts = new THREE.InstancedMesh(postGeo, railMat, railPosts.length);
  const postDummy = new THREE.Object3D();
  railPosts.forEach(([x, z], i) => {
    postDummy.position.set(x, PLAT_Y + 0.58, z);
    postDummy.updateMatrix();
    posts.setMatrixAt(i, postDummy.matrix);
  });
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);
  [[-13.5, 1.1], [-13.5, 0.55], [-10.5, 1.1], [-10.5, 0.55]].forEach(([x, dy]) => {
    const r = new THREE.Mesh(track(new THREE.BoxGeometry(0.05, 0.05, 7.5)), railMat);
    r.position.set(x, PLAT_Y + dy, 0.4);
    group.add(r);
  });

  // ————————————————— LAB-002 TRANS 气路立管与调压盘 —————————————————
  //
  // 接地下 UG-A03 气路立管（(-4.6, ceilingY, 6.6) 的套管），上到操作层的调压盘，
  // 再沿一段气路走向池上桥架（终点由 reactorModel 的桥上气路承接）。
  const airMat2 = mat(0x4a4038, { metalness: 0.6, roughness: 0.5 });
  pipeRun(group, track, airMat2, [-4.6, FLOOR_Y - 0.5, 6.6], [-4.6, FLOOR_Y + 1.35, 6.6], 0.055);
  const airSleeve = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 12)), concrete);
  airSleeve.position.set(-4.6, FLOOR_Y - 0.25, 6.6);
  group.add(airSleeve);
  const regPanel = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 0.62, 0.2)), cabDark);
  regPanel.position.set(-4.6, FLOOR_Y + 1.66, 6.6);
  group.add(regPanel);
  const airGaugeMat = track(new THREE.MeshStandardMaterial({
    color: 0x0d1218, emissive: 0x9fe8ff, emissiveIntensity: 0.2, roughness: 0.3
  }));
  const airGauge = new THREE.Mesh(track(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 14)), airGaugeMat);
  airGauge.rotation.x = Math.PI / 2;
  airGauge.position.set(-4.6, FLOOR_Y + 1.66, 6.49);
  group.add(airGauge);
  pipeRun(group, track, airMat2, [-4.6, FLOOR_Y + 1.97, 6.6], [-4.6, FLOOR_Y + 2.6, 6.6], 0.045);
  pipeRun(group, track, airMat2, [-4.6, FLOOR_Y + 2.6, 6.6], [-4.6, FLOOR_Y + 2.6, 2.9], 0.045);
  pipeRun(group, track, airMat2, [-4.6, FLOOR_Y + 2.6, 2.9], [-2.6, FLOOR_Y + 2.6, 2.9], 0.045);
  const airFlange = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12)), boltLikeMat());
  airFlange.rotation.z = Math.PI / 2;
  airFlange.position.set(-2.55, FLOOR_Y + 2.6, 2.9);
  group.add(airFlange);

  // —— 池边黄黑危险条带（实例化扇段，环绕屏蔽体外沿）——
  const stripeR = 5.25;
  const stripeN = 40;
  const stripeYellow = track(new THREE.MeshStandardMaterial({ color: 0xd8b12a, emissive: 0x2a2205, emissiveIntensity: 0.3, roughness: 0.7 }));
  const stripeDark = track(new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.8 }));
  const stripeGeo = track(new THREE.BoxGeometry(0.55, 0.03, 0.42));
  const stripesY = new THREE.InstancedMesh(stripeGeo, stripeYellow, Math.ceil(stripeN / 2));
  const stripesD = new THREE.InstancedMesh(stripeGeo, stripeDark, Math.floor(stripeN / 2));
  const dummy = new THREE.Object3D();
  let iy = 0, idk = 0;
  for (let i = 0; i < stripeN; i++) {
    const a = (i / stripeN) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * stripeR, FLOOR_Y + 0.01, Math.sin(a) * stripeR);
    dummy.rotation.set(0, -a, 0);
    dummy.updateMatrix();
    if (i % 2 === 0) stripesY.setMatrixAt(iy++, dummy.matrix);
    else stripesD.setMatrixAt(idk++, dummy.matrix);
  }
  stripesY.instanceMatrix.needsUpdate = true;
  stripesD.instanceMatrix.needsUpdate = true;
  group.add(stripesY, stripesD);

  // —— 危险信号灯（立柱 + 灯罩），随反应堆状态变色/闪烁 + 一盏状态点光 ——
  const beaconPost = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 10)), steel);
  beaconPost.position.set(-5.2, FLOOR_Y + 1.2, 4.6);
  group.add(beaconPost);
  const beaconMat = track(new THREE.MeshStandardMaterial({ color: 0x201510, emissive: 0xff7000, emissiveIntensity: 0.2, roughness: 0.3 }));
  const beacon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.2, 0.34, 14)), beaconMat);
  beacon.position.set(-5.2, FLOOR_Y + 2.5, 4.6);
  group.add(beacon);
  const beaconLight = new THREE.PointLight(0xff7000, 0, 14, 2);
  beaconLight.position.set(-5.2, FLOOR_Y + 2.5, 4.6);
  group.add(beaconLight);

  const cOff = new THREE.Color(0x201510);
  const cAmber = new THREE.Color(0xff7a10);
  const cRed = new THREE.Color(0xff1a1a);
  const cGreen = new THREE.Color(0x2fd07a);
  const cBlue = new THREE.Color(0x3aa0ff);
  const cWhite = new THREE.Color(0xdfeaff);
  const cMonIdle = new THREE.Color(0x1b3a66);
  const cMonHot = new THREE.Color(0xff5a2a);
  const cMonPow = new THREE.Color(0x4ad0ff);
  const tmp = new THREE.Color();

  function update(state, dt = 0.016) {
    const t = performance.now();
    const power = clamp(state.powerProxy, 0, 1);
    const pulse = clamp(state.pulsePowerProxy, 0, 1);
    const blink = reduceMotion ? 1 : (0.5 + 0.5 * Math.sin(t * 0.008));
    const fastBlink = reduceMotion ? 1 : (0.5 + 0.5 * Math.sin(t * 0.02));

    // 危险信号灯：脉冲→强白闪；停堆→红慢闪；运行→琥珀，亮度随功率；脉冲模式→琥珀快闪
    let col = cOff, inten = 0.2, lightI = 0;
    if (pulse > 0.05) {
      col = cWhite; inten = 0.6 + pulse * 2.5; lightI = 6 + pulse * 40;
    } else if (state.scrammed) {
      col = cRed; inten = 0.3 + blink * 1.6; lightI = 2 + blink * 10;
    } else if (state.mode === "PULSE") {
      col = cAmber; inten = 0.4 + fastBlink * 1.4; lightI = 3 + fastBlink * 8;
    } else if (state.mode === "OPERATE") {
      col = cAmber; inten = 0.4 + power * 1.8; lightI = 2 + power * 14;
    }
    beaconMat.emissive.copy(col);
    beaconMat.emissiveIntensity = inten;
    beaconLight.color.copy(col);
    beaconLight.intensity = reduceMotion ? Math.min(lightI, 6) : lightI;

    // 监视屏：随功率蓝→亮，脉冲/停堆偏红
    monitors.forEach((m, i) => {
      let target = tmp.copy(cMonIdle).lerp(cMonPow, power);
      if (state.scrammed) target = tmp.copy(cMonIdle).lerp(cRed, 0.4 + blink * 0.3);
      if (pulse > 0.05) target = tmp.copy(cMonPow).lerp(cMonHot, pulse);
      m.emissive.lerp(target, 0.15);
      m.emissiveIntensity = 0.55 + power * 0.6 + pulse * 0.8 + (i === 3 && state.pumpOn ? 0.2 : 0);
    });

    // ——— LAB-004 地面设备的状态驱动（没有一处是无因循环）———
    const powered = !!state.unlocked;
    const poolT = clamp(state.poolTemperatureProxy, 0, 1);
    const flow = clamp(state.coolantFlowProxy, 0, 1);

    // 棒驱动柜：灯 = 该套驱动当前是否接受指令；指示条几何高度 = 棒位行程分数
    rodCabs.forEach(c => {
      const enabled = !!(state.rodDriveEnabled && state.rodDriveEnabled[c.name]);
      const pos = clamp(state.rod && state.rod[c.name] ? state.rod[c.name].pos : 0, 0, 1);
      c.lampMat.emissiveIntensity = enabled ? 1.3 : 0.04;
      c.lampMat.emissive.copy(enabled ? cGreen : cRed);
      const h = Math.max(pos, 0.001);
      c.bar.scale.y = h;
      c.bar.position.y = c.baseY + h * 0.5;
      c.barMat.emissiveIntensity = 0.25 + pos * 1.1;
    });

    // 独立安全指示柱：停堆（红，慢闪）/ 供电（白）/ 联锁允许（琥珀）/ 控制权（蓝=AUTO）
    const owner = state.controlOwner;
    annunLamps[0].emissiveIntensity = state.scrammed ? 0.5 + blink * 1.5 : 0.03;
    annunLamps[1].emissiveIntensity = powered ? 1.1 : 0.05;
    annunLamps[2].emissiveIntensity = state.pulseReady ? 0.4 + fastBlink * 1.2
      : (state.autoAvailable ? 0.7 : 0.04);
    annunLamps[3].emissiveIntensity = owner === "AUTO" ? 1.3 : (owner === "MANUAL" ? 0.45 : 0.04);
    annunLight.color.copy(state.scrammed ? cRed : (owner === "AUTO" ? cBlue : cAmber));
    annunLight.intensity = state.scrammed ? 1.2 + blink * 3.5 : (powered ? 1.6 : 0);

    // 池边传感器：液位（常亮，供电后）/ 池水温度 / 电导率（净化流量）/ 辐射（功率+脉冲）
    sensorMats[0].emissiveIntensity = powered ? 0.9 : 0.1;
    sensorMats[1].emissiveIntensity = 0.15 + poolT * 1.6;
    sensorMats[2].emissiveIntensity = 0.12 + flow * 1.3;
    sensorMats[3].emissiveIntensity = 0.1 + power * 1.4 + pulse * 2.2;
    // 取样柜屏幕：水质代理 = 净化流量与池水温度的合成，脉冲时偏红
    let sTarget = tmp.copy(cMonIdle).lerp(cMonPow, flow);
    if (pulse > 0.05) sTarget = tmp.copy(cMonPow).lerp(cMonHot, pulse);
    sampScreenMat.emissive.lerp(sTarget, 0.15);
    sampScreenMat.emissiveIntensity = 0.4 + flow * 0.7 + poolT * 0.5;

    // 通风机组：供电后才转，转速随池水温度（排热需求）上升；reduceMotion 下减速
    const vent = powered ? 0.35 + poolT * 0.9 : 0;
    ventSpeed += (vent - ventSpeed) * clamp(1.5 * dt, 0, 1);
    ahus.forEach(a => { a.wheel.rotation.x += a.dir * ventSpeed * (reduceMotion ? 1.2 : 6.0) * dt; });

    // 补给撬块：池水温度越高蒸发越多 → 贮罐液位下降；低于阈值时补给泵启动补水。
    // 这是一个可解释的状态机，泵不转时几何真的停住（LAB-004）。
    makeupLevel = clamp(makeupLevel - (powered ? 0.004 + poolT * 0.03 : 0) * dt, 0, 1);
    if (makeupLevel < 0.35) makeupRunning = true;
    if (makeupLevel > 0.92) makeupRunning = false;
    if (makeupRunning && powered) makeupLevel = clamp(makeupLevel + 0.16 * dt, 0, 1);
    makeupPumps.forEach((p, i) => {
      const run = makeupRunning && powered && (i === 0 || poolT > 0.45);
      p.fan.rotation.y += (run ? 11 : 0) * dt * (reduceMotion ? 0.25 : 1);
      p.lampMat.emissiveIntensity = run ? 1.5 : 0.05;
    });
    tankGauge.scale.y = Math.max(makeupLevel, 0.02);
    tankGauge.position.y = FLOOR_Y + 0.9 + Math.max(makeupLevel, 0.02) * 0.6;
    gaugeGlassMat.emissiveIntensity = 0.25 + makeupLevel * 0.7;
    // 气路调压盘：TRANS 气动传输的供气压力代理（会话供电 + TRANS 棒可用时充压）
    const airOk = powered && !!(state.rodDriveEnabled && state.rodDriveEnabled.TRANS);
    airGaugeMat.emissiveIntensity = airOk ? 1.0 : 0.15;
  }

  // 只读检查快照（供自动化验收确认地面设备真的由状态驱动，非文字）
  function snapshot() {
    return {
      components: LAB_COMPONENTS.length,
      makeupLevel: +makeupLevel.toFixed(3),
      makeupRunning,
      ventSpeed: +ventSpeed.toFixed(3),
      ahuSpin: +ahus[0].wheel.rotation.x.toFixed(3),
      rodBars: rodCabs.map(c => +c.bar.scale.y.toFixed(3)),
      annunciator: annunLamps.map(m => +m.emissiveIntensity.toFixed(2))
    };
  }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  return { group, update, dispose, snapshot, components: LAB_COMPONENTS };
}
