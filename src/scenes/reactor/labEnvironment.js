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

export function createLabEnvironment({ reduceMotion } = {}) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const mat = (color, opts = {}) => track(new THREE.MeshStandardMaterial(Object.assign({
    color, metalness: 0.1, roughness: 0.85
  }, opts)));

  // —— 环境补光：让厂房不至于纯黑（半球光廉价，不做逐灯阴影）——
  const hemi = new THREE.HemisphereLight(0x3a4a5e, 0x0a0f14, 0.55);
  group.add(hemi);

  // —— 房间外壳 ——
  const concrete = mat(0x2c333b, { roughness: 0.95, metalness: 0.05 });
  const concreteWall = mat(0x333b44, { roughness: 0.92, metalness: 0.05 });
  // 地板、四面墙和天花板不再是混凝土盒子：它们由 glassArchitecture.js 的独立玻璃砖
  // 单元构成（GLA-001/GLA-002）。这里只保留混凝土材质，供设备基础和地下结构复用。
  void concrete; void concreteWall;

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

  // —— 一次冷却回路设备（热交换器 + 泵撬块）：池水靠这套回路把堆芯热量排到二次侧，
  //    也就是 sessionController 里 K_COOL 那一项对应的实物。放在池的 -X 侧中景。 ——
  const tankMat = mat(0x8a9199, { metalness: 0.55, roughness: 0.4 });
  const hx = new THREE.Mesh(track(new THREE.CylinderGeometry(0.85, 0.85, 4.4, 20)), tankMat);
  hx.rotation.z = Math.PI / 2;
  hx.position.set(-9.4, FLOOR_Y + 1.5, -1.5);
  group.add(hx);
  [-1, 1].forEach(s => {
    const saddle = new THREE.Mesh(track(new THREE.BoxGeometry(0.5, 1.5, 1.7)), steel);
    saddle.position.set(-9.4 + s * 1.6, FLOOR_Y + 0.75, -1.5);
    group.add(saddle);
  });
  // 两台立式泵（电机 + 蜗壳），出口接一段回池的管
  [0, 1].forEach(k => {
    const z = 1.6 + k * 2.0;
    const skid = new THREE.Mesh(track(new THREE.BoxGeometry(1.6, 0.25, 1.4)), steel);
    skid.position.set(-9.4, FLOOR_Y + 0.13, z);
    group.add(skid);
    const volute = new THREE.Mesh(track(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 16)), tankMat);
    volute.position.set(-9.4, FLOOR_Y + 0.5, z);
    group.add(volute);
    const motor = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.3, 1.1, 14)), mat(0x2f6f5a, { metalness: 0.5, roughness: 0.5 }));
    motor.position.set(-9.4, FLOOR_Y + 1.3, z);
    group.add(motor);
  });
  // 回路管线：泵出口 → 热交换器 → 折向池方向
  const loopPipe = mat(0x5a6570, { metalness: 0.6, roughness: 0.4 });
  const runZ = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 6.4, 14)), loopPipe);
  runZ.rotation.x = Math.PI / 2;
  runZ.position.set(-9.4, FLOOR_Y + 0.5, 0.6);
  group.add(runZ);
  const runX = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 3.6, 14)), loopPipe);
  runX.rotation.z = Math.PI / 2;
  runX.position.set(-7.4, FLOOR_Y + 0.5, 3.6);
  group.add(runX);

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
  }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  return { group, update, dispose };
}
