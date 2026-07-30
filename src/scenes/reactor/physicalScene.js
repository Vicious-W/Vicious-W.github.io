// 唯一页面场景：完整 Pavia TRIGA 反应堆池系统 + 独立轻水 + 放下并锁定的实体安全
// 格栅 + 格栅上的玻璃立方体。场景拓扑、会话重置和跨系统耦合见
// docs/engineering/SOURCE_SCENE.md；连续运行程序见
// docs/engineering/REACTOR_POOL_SYSTEM.md；反应堆内部结构见
// docs/engineering/REACTOR_MODEL.md。
//
// 玻璃使用 Three.js 网格与 cannon-es 刚体；格栅本身也是刚体（弹簧+阻尼挂在桥架
// 锚点上），真正承托玻璃——不再用隐形地平面解释玻璃悬在池口上方。
//
// 会话与重置：每次加载/刷新都创建一次新的 physicalScene() 调用，所有状态只存在
// 于本次调用闭包中；resize/可见性切换只触发 layout()/start()/stop()，不重建场景，
// 因此天然满足“resize 和标签页切换不得触发新会话”的要求。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import * as CANNON from "cannon-es";
import { createReactorModel } from "./reactorModel.js";
import { createWaterSystem, cherenkovIntensity, UNDERWATER_FOG_COLOR } from "./waterSystem.js";
import { createSessionController } from "./sessionController.js";
import { createControlConsole } from "./controlConsole.js";
import { createAutoConsole } from "./autoConsole.js";
import { createFreeCamera, CAM_LIMITS, homeFitDistance } from "./freeCamera.js";
import { createCherenkov } from "./cherenkov.js";
import { createLabEnvironment } from "./labEnvironment.js";
import { createGlassArchitecture, GLASS_ARCH } from "./glassArchitecture.js";
import { createUndergroundPlant, UNDERGROUND_BOUNDS } from "./undergroundPlant.js";
import { frameDelta } from "./timeStep.js";
import { createGlassAudio } from "./glassAudio.js";
import { createReactorAudio } from "./reactorAudio.js";
import {
  createDamageState, registerImpact, buildCrackTexture, buildFragmentGeometries
} from "./glassDamage.js";

const clamp = THREE.MathUtils.clamp;

const CUBE = 1;
const FOV = 50;   // 较宽视场：相机离被摄体更近，留在厂房内
// 相机相对水平面的仰角：90° 是严格正俯视，读起来像一张二维平面图；65°（相对正
// 俯视下压 25°）能同时看到池深、水面、格栅厚度、桥架与棒驱动的高度关系，
// 验收要求的"确认反应堆池是完整三维系统"才可能成立。
const CAM_ELEVATION_DEG = 40;   // 操作员 3/4 视角：前景控制台 + 池口都可见
const CAM_TARGET_Y = 0.3;
// 取景半径：竖直方向到屏蔽体上沿，水平/纵深方向要同时容纳前景控制台（z≈6.9）。
const FIT_RADIUS_V = 7.0;
const FIT_RADIUS_H = 6.2;
// 初始机位的净空上限（见 freeCamera.homeFitDistance）。留出的余量刻意取得比
// 1440×900 的几何 fit 距离宽：桌面取景保持不变，只有会把相机顶出玻璃建筑的竖直
// 窄视口才被封顶。
const HOME_CEILING_LIMIT_Y = GLASS_ARCH.ceilingY - 0.8;   // 11.2
const HOME_WALL_LIMIT = GLASS_ARCH.hallHalf - 1.5;        // 20.5
const LIFT_Y = 1.0;  // 抓取平面高度：松手落差约 0.3，正常拖放不掉耐久（见 glassDamage 标定）
const MAX_DPR = 1.5;
const PAN_REF = 4.0; // 声像参考半宽（走道外沿量级），与视口无关
const REDUCE_SCALE = 0.3; // reduceMotion 下削弱脉冲冲量/闪光幅度，仍保留结构可检查性

function buildEnvTexture() {
  const W = 96;
  const H = 48;
  const data = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const theta = ((j + 0.5) / H) * Math.PI;
    const y = Math.cos(theta);
    const down = Math.max(-y, 0);
    const up = Math.max(y, 0);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W) * Math.PI * 2;
      const spot = Math.pow(Math.max(0, Math.cos(phi - 2.1)), 40) * Math.pow(up, 3)
                 + Math.pow(Math.max(0, Math.cos(phi + 1.2)), 60) * Math.pow(up, 2);
      const o = (j * W + i) * 4;
      data[o]     = 0.020 + 0.30 * Math.pow(down, 1.6) + up * 0.010 + spot * 1.6;
      data[o + 1] = 0.055 + 0.78 * Math.pow(down, 1.4) + up * 0.016 + spot * 1.7;
      data[o + 2] = 0.125 + 1.40 * Math.pow(down, 1.2) + up * 0.030 + spot * 1.8;
      data[o + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

function effectiveMass(mA, mB) {
  if (mA === 0) return mB;
  if (mB === 0) return mA;
  return (mA * mB) / (mA + mB);
}

export function createPhysicalScene({ section, canvas, reduceMotion }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (err) {
    console.error("physicalScene: renderer unavailable", err);
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(0x02070f, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  if ("transmissionResolutionScale" in renderer) renderer.transmissionResolutionScale = 0.5;

  const scene = new THREE.Scene();
  // 近裁剪面来自 CAM-002：自由相机要能贴近仪表针和螺栓，又要覆盖到地下设备层
  const camera = new THREE.PerspectiveCamera(FOV, 1, CAM_LIMITS.near, CAM_LIMITS.far);
  // 水下体积雾（CAM-003 / WTR-002）：相机在水面之下时启用，跨越水面只切换光学分支
  const underwaterFog = new THREE.FogExp2(UNDERWATER_FOG_COLOR.getHex(), 0.14);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = buildEnvTexture();
  const envRT = pmrem.fromEquirectangular(envSrc);
  scene.environment = envRT.texture;
  envSrc.dispose();
  pmrem.dispose();

  const key = new THREE.DirectionalLight(0xdceeff, 1.4);
  key.position.set(-4, 7, -3);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x14202e, 0.6));

  // —— 会话/连续运行控制器 ——
  const session = createSessionController({ reduceMotion });

  // —— 反应堆池 + 轻水（轻水是反应堆 group 的子级，与其共用同一套世界坐标）——
  const reactor = createReactorModel({ reduceMotion });
  scene.add(reactor.group);
  const water = createWaterSystem({
    poolRadius: reactor.poolBounds.radius,
    poolDepth: reactor.poolBounds.depth,
    surfaceY: reactor.poolBounds.surfaceY,
    corePosition: reactor.corePosition,
    reduceMotion
  });
  reactor.group.add(water.group);

  // —— 操作员控制台（立在操作层地面上，可点击操控反应堆）——
  const console3d = createControlConsole({
    commands: {
      // AUTO 控件是控制台上唯一不夺取人工控制权的控件：它请求把控制权交给自动程序。
      // 其余控件都是真实的人工指令，一按就原位接管（见 sessionController 的 manual 包装）。
      autoStart: () => session.requestAuto(),
      startup: () => session.startup(),
      scram: () => session.scram(),
      setMode: (m) => session.setMode(m),
      pumpToggle: () => session.pumpToggle(),
      rodStart: (n, d) => session.rodStart(n, d),
      rodStop: (n) => session.rodStop(n),
      pulseFire: () => session.pulseFire()
    },
    position: [0, 0, 6.9],
    facing: 0,
    reduceMotion
  });
  scene.add(console3d.group);

  // —— CTL-002 AUTO 控制台（物理独立的立式仪控柜，共享同一个 session controller）——
  const autoConsole3d = createAutoConsole({
    commands: {
      autoStart: () => session.requestAuto(),
      scram: () => session.scram()
    },
    position: [4.9, 0, 6.2],
    facing: -0.34,
    reduceMotion
  });
  scene.add(autoConsole3d.group);

  // 两台控制台的控件进同一个拾取表：控制权互斥由 sessionController 唯一裁决，
  // 不存在第二套反应堆状态（CTL-003）。
  const allHotspots = console3d.hotspots.concat(autoConsole3d.hotspots);
  const hotspotMeshes = allHotspots.map(h => h.mesh);

  // —— 实验大厅环境（房间外壳、厂房设备、人员安全设施）——
  const lab = createLabEnvironment({ reduceMotion });
  scene.add(lab.group);

  // —— 玻璃砖建筑（GLA-001/GLA-002）与地下设备层（LAB-003/LAB-004）——
  // 全部 300 个地板格位在所有视口都是**独立动态玻璃砖**：各自有刚体、耐久、裂纹和
  // 破碎状态，任意一块都能抓走。性能靠休眠 + 只同步醒着的实例来买（见下面的
  // floorMesh 同步与 syncedThisFrame），不靠把远处砖降级成不可移动地面。
  const smallViewport = Math.min(window.innerWidth || 1440, window.innerHeight || 900) < 820;
  const arch = createGlassArchitecture({ reduceMotion });
  scene.add(arch.group);
  const underground = createUndergroundPlant({ reduceMotion });
  scene.add(underground.group);

  // —— CHR-001…CHR-003 切伦科夫：附着堆芯活性段，由同一条功率因果驱动 ——
  // 粒子质量档（§11 性能与降级）：先减粒子密度，体积辉光与功率因果不被降级掉。
  const cherenkov = createCherenkov({
    coreBounds: reactor.coreBounds,
    surfaceY: reactor.poolBounds.surfaceY,
    reduceMotion,
    particleBudget: smallViewport ? 360 : 900,
    intensityOf: s => cherenkovIntensity(s.powerProxy, s.pulsePowerProxy, reduceMotion)
  });
  reactor.group.add(cherenkov.group);

  // —— 物理世界 ——
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.solver.iterations = 14;
  world.solver.tolerance = 0.001;
  const glassPhys = new CANNON.Material("glass");
  const glassContact = new CANNON.ContactMaterial(glassPhys, glassPhys, {
    friction: 0.45, restitution: 0.03,
    contactEquationStiffness: 1e7, contactEquationRelaxation: 3
  });
  world.addContactMaterial(glassContact);
  world.defaultContactMaterial.friction = 0.45;
  world.defaultContactMaterial.restitution = 0.03;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 3;

  // RP-001 上部作业面：池口与栏杆之间那圈**可见**环形走道的碰撞体。用一圈梯形
  // 近似的扇段盒子拼出，内边紧贴池口、外边止于走道外沿——不再向外延伸成一张
  // 覆盖整个视口的隐形平面（PROJECT_SPEC 明令禁止用隐形碰撞面解释玻璃的支承）。
  const deck = reactor.deck;
  const deckSupport = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const SEG = 24;
    const rMid = (deck.innerRadius + deck.outerRadius) / 2;
    const halfRadial = (deck.outerRadius - deck.innerRadius) / 2;
    const halfTangent = rMid * Math.tan(Math.PI / SEG) * 1.05; // 略微交叠，接缝处不漏
    const segShape = new CANNON.Box(new CANNON.Vec3(halfRadial, 0.06, halfTangent));
    const q = new CANNON.Quaternion();
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a);
      deckSupport.addShape(
        segShape,
        new CANNON.Vec3(Math.cos(a) * rMid, deck.y - 0.06, Math.sin(a) * rMid),
        q.clone()
      );
    }
  }
  world.addBody(deckSupport);

  // 栏杆（RP-001）：玻璃向外的真实边界。可见的立柱+扶手在 railRadius 处围了一圈，
  // 这里用同半径的一圈盒子作为连续近似，玻璃因此不会被拖进屏蔽体外的空白。
  const railBarrier = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const SEG = 24;
    const halfTangent = deck.railRadius * Math.tan(Math.PI / SEG) * 1.05;
    const segShape = new CANNON.Box(new CANNON.Vec3(0.06, deck.railHeight / 2, halfTangent));
    const q = new CANNON.Quaternion();
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a);
      railBarrier.addShape(
        segShape,
        new CANNON.Vec3(Math.cos(a) * deck.railRadius, deck.y + deck.railHeight / 2, Math.sin(a) * deck.railRadius),
        q.clone()
      );
    }
  }
  world.addBody(railBarrier);

  // 厂房楼板与四面墙：栏杆只有 0.58 高，而抓取平面在 LIFT_Y=1.0，所以玩家**可以**
  // 把玻璃提过栏杆扔到走道外——那时它必须落在看得见的混凝土操作层上并停住，而不是
  // 永远下坠（实测：无楼板时松手后速度 1.5→4.0→6.0 持续增长，永不休眠）。
  // 用一圈扇段盒子拼出楼板，内边止于走道外沿——不用无限平面：无限平面会一路伸进
  // 池子里，把落进池中的玻璃架在 -0.06 上，而且正是规范禁止的"隐形碰撞面"。
  // GLA-002 透明结构承托层的碰撞体：地板玻璃砖就落在这上面，移开砖之后留下的洞
  // 直接通到地下设备层。它对应 glassArchitecture 里那层**看得见的**连续透明板
  // （supportInnerR → supportOuterR，顶面 supportTop），不是凭空的隐形平面；
  // 观察相机不参与碰撞，因此不会被它挡住（CAM-002）。
  const hallFloor = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const SEG = 32;
    const rIn = GLASS_ARCH.supportInnerR;
    const rOut = GLASS_ARCH.supportOuterR;
    const rMid = (rIn + rOut) / 2;
    const halfRadial = (rOut - rIn) / 2;
    const halfTangent = rMid * Math.tan(Math.PI / SEG) * 1.05;
    const halfT = GLASS_ARCH.supportThickness / 2;
    const segShape = new CANNON.Box(new CANNON.Vec3(halfRadial, halfT, halfTangent));
    const q = new CANNON.Quaternion();
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a);
      hallFloor.addShape(
        segShape,
        new CANNON.Vec3(Math.cos(a) * rMid, GLASS_ARCH.supportTop - halfT, Math.sin(a) * rMid),
        q.clone()
      );
    }
  }
  world.addBody(hallFloor);

  // RP-001 生物屏蔽上盖的碰撞体（可见的 shieldTopCap 环：deck.outerRadius →
  // shield.outerRadius，顶面 shield.topY）。栏杆只有 0.58 高，抓取伺服可以把玻璃提到
  // y=11，所以玻璃**可以**被丢到池外——实测它会穿过这圈看得见的混凝土继续下坠。
  // 这不是新增隐形平面：它逐段对齐已经画出来的八角上盖。
  const shieldCap = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const SEG = 16;
    const rIn = reactor.deck.outerRadius;
    const rOut = reactor.shield.outerRadius;
    const rMid = (rIn + rOut) / 2;
    const halfRadial = (rOut - rIn) / 2;
    const halfTangent = rMid * Math.tan(Math.PI / SEG) * 1.05;
    const segShape = new CANNON.Box(new CANNON.Vec3(halfRadial, 0.12, halfTangent));
    const q = new CANNON.Quaternion();
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a);
      shieldCap.addShape(
        segShape,
        new CANNON.Vec3(Math.cos(a) * rMid, reactor.shield.topY - 0.12, Math.sin(a) * rMid),
        q.clone()
      );
    }
  }
  world.addBody(shieldCap);

  // LAB-003 地坑底板的碰撞体（可见的混凝土底板，UNDERGROUND_BOUNDS.floorY）。
  // 屏蔽体外皮（4.9）与透明承托层内边（5.6）之间是敞开的采光井——那是有意的，
  // 从操作层就能看见地下设备。但掉进去的玻璃必须停在地下设备层的地面上，
  // 而不是永远下坠：没有这块底板时实测玻璃穿过 y=-1 后速度持续增长、永不休眠。
  const pitFloor = new CANNON.Body({
    mass: 0, material: glassPhys,
    shape: new CANNON.Box(new CANNON.Vec3(UNDERGROUND_BOUNDS.half, 0.2, UNDERGROUND_BOUNDS.half)),
    position: new CANNON.Vec3(0, UNDERGROUND_BOUNDS.floorY - 0.2, 0)
  });
  world.addBody(pitFloor);

  // GLA-001 玻璃墙与玻璃天花的静态碰撞：边界直接由 GLASS_ARCH 的砖层常量生成，
  // 因此**碰撞面与看得见的砖面重合**（墙砖中心在 hallHalf - wallThickness/2，
  // 内表面在 hallHalf - wallThickness；天花砖中心在 ceilingY - ceilThickness/2）。
  // 早先只有一圈高 6 的墙碰撞、天花完全没有碰撞，被提到 y≈11 的玻璃会直接穿过
  // 可见砖面飞出去；现在墙从地板顶面一直封到天花，天花本身也是一块合并静态盒。
  const HALL_WALL = {
    inner: GLASS_ARCH.hallHalf - GLASS_ARCH.wallThickness,
    top: GLASS_ARCH.ceilingY - GLASS_ARCH.ceilThickness,
    bottom: GLASS_ARCH.floorTop
  };
  const hallWalls = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const half = GLASS_ARCH.wallThickness / 2;
    const center = GLASS_ARCH.hallHalf - half;       // = 可见墙砖的中心面
    const h = GLASS_ARCH.ceilingY - GLASS_ARCH.floorTop;
    const yMid = GLASS_ARCH.floorTop + h / 2;
    // 沿墙长度取 hallHalf（而不是内表面半宽），四角因此被两侧墙板互相盖住，不漏缝
    const slab = new CANNON.Box(new CANNON.Vec3(half, h / 2, GLASS_ARCH.hallHalf));
    const q = new CANNON.Quaternion();
    const qz = new CANNON.Quaternion();
    qz.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    hallWalls.addShape(slab, new CANNON.Vec3(-center, yMid, 0), q.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(center, yMid, 0), q.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(0, yMid, -center), qz.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(0, yMid, center), qz.clone());
    // 玻璃天花：与 GLA-CEILING 实例砖同厚同高的一块合并静态盒
    hallWalls.addShape(
      new CANNON.Box(new CANNON.Vec3(
        GLASS_ARCH.hallHalf, GLASS_ARCH.ceilThickness / 2, GLASS_ARCH.hallHalf)),
      new CANNON.Vec3(0, GLASS_ARCH.ceilingY - GLASS_ARCH.ceilThickness / 2, 0),
      q.clone()
    );
  }
  world.addBody(hallWalls);

  // —— RP-003 安全格栅刚体：弹簧+阻尼挂在桥架锚点上，真正承托玻璃 ——
  const gratingBody = new CANNON.Body({
    mass: 55, material: glassPhys,
    shape: new CANNON.Cylinder(reactor.grating.radius, reactor.grating.radius, reactor.grating.thickness, 20),
    position: new CANNON.Vec3(0, reactor.grating.y, 0),
    linearDamping: 0.2, angularDamping: 0.4
  });
  world.addBody(gratingBody);
  const bridgeAnchor = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(0, reactor.grating.y, 0) });
  world.addBody(bridgeAnchor);
  const MOUNT_R = reactor.grating.radius * 0.7;
  const springs = [0, 1, 2, 3].map(i => {
    const a = (i / 4) * Math.PI * 2;
    const offset = new CANNON.Vec3(Math.cos(a) * MOUNT_R, 0, Math.sin(a) * MOUNT_R);
    // 刚度/阻尼（RP-G04，REALTIME_PROXY——Pavia 桥架真实振动谱未知）：
    // 总刚度 4×24000 让满载（格栅 55 + 约 20 块玻璃）静沉降只有约 0.02，
    // 玻璃不会随格栅一起持续起伏；阻尼取临界的约 0.35 倍，脉冲后几个周期收敛，
    // 既能看见有限振动，又不会把玻璃反复抛起来砸出损伤。
    return new CANNON.Spring(bridgeAnchor, gratingBody, {
      restLength: 0, stiffness: 24000, damping: 505,
      localAnchorA: offset, localAnchorB: offset
    });
  });
  world.addEventListener("postStep", () => springs.forEach(s => s.applyForce()));

  // applyImpulse() 的第二参数是相对质心的偏移，不是世界坐标；格栅静止位形下质心
  // 在 (0, grating.y, 0)，所以 TRANS 位置相对质心的偏移就是其 (x, 0, z)。
  const transOffset = new CANNON.Vec3(reactor.controlRods.TRANS.x, 0, reactor.controlRods.TRANS.z);
  // 冲量经格栅质量与其上玻璃的附加质量分摊后给出 Δv ≈ I/(55+载荷)；配合 ω≈33 rad/s，
  // 115 N·s 实测峰值位移约 0.03（约玻璃棱长的 3%），是看得见的有限振动，而玻璃与
  // 格栅的相对法向速度只有零点几 m/s（能量代理远低于 12 的损伤阈值），
  // 因此规范布局不会被脉冲直接击碎（PROJECT_SPEC「不得在 PULSE 时直接改速度或扣耐久」）。
  const GRATING_EJECT_IMPULSE = 115;
  const GRATING_RESEAT_IMPULSE = 38;

  // 让格栅的可见网格跟随其弹簧物理体：桥架/格栅的有限刚度振动因此真正可见，
  // 不只是"玻璃在一个看不见的物理面上弹跳"。反应堆 group 不再缩放，物理体与
  // 可见网格共用同一套世界坐标，直接赋值即可。
  const gratingVisual = reactor.grating.visual;
  function syncGratingVisual() {
    gratingVisual.position.set(gratingBody.position.x, gratingBody.position.y, gratingBody.position.z);
    gratingVisual.quaternion.set(
      gratingBody.quaternion.x, gratingBody.quaternion.y, gratingBody.quaternion.z, gratingBody.quaternion.w
    );
  }

  // —— 声音 ——
  const audio = createGlassAudio();
  const reactorAudio = createReactorAudio();
  let audioUnlocked = false;

  const unlockAll = () => {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (audio) audio.unlock();
    if (reactorAudio) reactorAudio.unlock();
    session.unlock();
    resetPeaks(); // 峰值统计从连续运行开始算起，不混入加载时的落位
  };

  // 控制权分流（PROJECT_SPEC / SOURCE_SCENE.md §5）：
  //   控制台热点以外的任何有效交互（点击空处、拖玻璃、右键转相机、滚轮、键盘）
  //   → 解锁并进入 AUTO；控制台热点上的交互 → 由该控件自己的指令进入 MANUAL。
  // 分流只发生在**第一次**（controlOwner === "NONE"）：之后转相机/缩放/拖玻璃
  // 都不改变控制权，从 MANUAL 重入完整 AUTO 只能按控制台的 AUTO 方钮。该判断
  // 放在 sessionController.sceneInteraction() 里，与命令、联锁同处一个模块。
  const interactOutsideConsole = () => {
    unlockAll();
    session.sceneInteraction();
  };

  // —— 立方体 ——
  const geo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 4, 0.06);
  const materials = [0, 1, 2, 3].map(i => new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.02 + i * 0.014, transmission: 1,
    thickness: CUBE * (0.95 + i * 0.1), ior: 1.5,
    attenuationColor: new THREE.Color(0.74, 0.89, 1.0), attenuationDistance: 9.0 + i * 2.0,
    specularIntensity: 1, envMapIntensity: 1.4
  }));

  const cubes = [];    // { mesh, body, damage } 可拖拽的完整/受损玻璃
  const fragments = []; // { mesh, body } 破碎后的碎片
  const meshes = [];    // 仅完整玻璃参与拾取

  const baseMaterialOf = entry =>
    entry.kind === "floor" ? arch.floorGlassMaterial : materials[entry.matIndex];

  function applyCrackVisual(entry) {
    const { damage } = entry;
    if (damage.stage === "INTACT") return;
    if (entry.kind === "floor") promoteFloorBrick(entry);
    const mesh = entry.mesh;
    if (mesh.material === baseMaterialOf(entry)) {
      mesh.material = baseMaterialOf(entry).clone();
    }
    if (mesh.material.map) mesh.material.map.dispose();
    const tex = buildCrackTexture(damage.cracks, damage.stage);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    mesh.material.map = tex;
    mesh.material.roughness = Math.min(0.5, mesh.material.roughness + (damage.stage === "CRACKED" ? 0.12 : 0.05));
    mesh.material.needsUpdate = true;
  }

  function spawnFragments(entry) {
    const { mesh, body } = entry;
    if (grab.entry === entry) releaseGrab();   // 对象破碎时必须安全释放约束（GLA-CTRL-003）
    if (mesh) scene.remove(mesh);
    world.removeBody(body);
    body.removeEventListener("collide", onCollide);
    const idx2 = cubes.indexOf(entry);
    if (idx2 >= 0) cubes.splice(idx2, 1);
    const fidx = floorBricks.indexOf(entry);
    if (fidx >= 0) {
      floorMesh.setMatrixAt(entry.instanceId, ZERO_MATRIX);
      floorMesh.instanceMatrix.needsUpdate = true;
      floorBricks.splice(fidx, 1);
    }
    if (mesh) {
      const midx = meshes.indexOf(mesh);
      if (midx >= 0) meshes.splice(midx, 1);
      if (mesh.material !== baseMaterialOf(entry)) {
        // 裂纹贴图是 applyCrackVisual 生成的 canvas 纹理，破碎时一并释放
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      }
    }

    const shards = buildFragmentGeometries(entry.size, cubes.length + fragments.length + 1);
    // 地板砖不是立方体：把碎片沿厚度方向等比压扁，碎片仍来自同一套破碎系统
    const ky = entry.kind === "floor" ? FLOOR_BRICK[1] / FLOOR_BRICK[0] : 1;
    if (ky !== 1) shards.forEach(s => {
      s.geometry.scale(1, ky, 1);
      s.halfExtents.y *= ky;
      s.localCenter.y *= ky;
    });
    const basePos = body.position;
    const baseQuat = body.quaternion;
    const worldCenter = new CANNON.Vec3();
    shards.forEach(shard => {
      const mat = baseMaterialOf(entry).clone();
      const fMesh = new THREE.Mesh(shard.geometry, mat);
      const localVec = new CANNON.Vec3(shard.localCenter.x, shard.localCenter.y, shard.localCenter.z);
      body.pointToWorldFrame(localVec, worldCenter);
      fMesh.position.set(worldCenter.x, worldCenter.y, worldCenter.z);
      fMesh.quaternion.set(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
      scene.add(fMesh);

      const kick = 1.1 + Math.random() * 0.6;
      const dir = new CANNON.Vec3(shard.localCenter.x, shard.localCenter.y, shard.localCenter.z);
      body.vectorToWorldFrame(dir, dir);
      dir.normalize();
      const fBody = new CANNON.Body({
        mass: Math.max(0.05, body.mass / 8), material: glassPhys,
        shape: new CANNON.Box(new CANNON.Vec3(shard.halfExtents.x, shard.halfExtents.y, shard.halfExtents.z)),
        position: new CANNON.Vec3(worldCenter.x, worldCenter.y, worldCenter.z),
        linearDamping: 0.15, angularDamping: 0.4, sleepSpeedLimit: 0.14, sleepTimeLimit: 0.6
      });
      fBody.quaternion.set(baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w);
      fBody.velocity.set(
        body.velocity.x + dir.x * kick,
        body.velocity.y + dir.y * kick + 0.6,
        body.velocity.z + dir.z * kick
      );
      fBody.angularVelocity.copy(body.angularVelocity);
      fBody.userData = { lastSound: 0, baseAngularDamping: 0.4, isFragment: true };
      fBody.addEventListener("collide", onCollide);
      world.addBody(fBody);
      fragments.push({ mesh: fMesh, body: fBody });
    });

    if (audio) audio.fracture(THREE.MathUtils.clamp(basePos.x / PAN_REF, -1, 1));
  }

  const addCube = (x, y, z, matIndex) => {
    const mesh = new THREE.Mesh(geo, materials[matIndex % materials.length]);
    scene.add(mesh);
    const body = new CANNON.Body({
      mass: 1.5, material: glassPhys,
      shape: new CANNON.Box(new CANNON.Vec3(CUBE / 2, CUBE / 2, CUBE / 2)),
      position: new CANNON.Vec3(x, y, z),
      linearDamping: 0.12, angularDamping: 0.35, sleepSpeedLimit: 0.14, sleepTimeLimit: 0.5
    });
    body.userData = {
      lastSound: 0, lastDamage: -Infinity, baseAngularDamping: 0.35,
      isFragment: false, spawnedAt: performance.now()
    };
    body.addEventListener("collide", onCollide);
    world.addBody(body);
    const entry = {
      kind: "cube", mesh, body, damage: createDamageState(),
      matIndex: matIndex % materials.length, size: CUBE
    };
    cubes.push(entry);
    meshes.push(mesh);
    mesh.userData.body = body;
    mesh.userData.entry = entry;
    body.userData.entry = entry;
  };

  // —————————— GLA-002 动态地板玻璃砖 ——————————
  // 与格栅玻璃共用同一套质量/摩擦/耐久/裂纹/破碎/音频/会话复位系统（下面的
  // onCollide、registerImpact、spawnFragments、抓取伺服全部复用），差别只有两点，
  // 都是 GLA-003 明确的性能边界：
  //   1) 完好的地板砖用一个 InstancedMesh 渲染（数百块 → 1 次绘制调用），逐帧从刚体
  //      写回矩阵；抓取射线打到 InstancedMesh 时用 instanceId 还原到具体砖块；
  //   2) 一旦某块砖开始受损（需要独立裂纹贴图），就把它"升格"成独立网格，
  //      并把它在实例里的矩阵缩到 0 —— 因此裂纹系统一点没被降级掉。
  const floorBricks = [];
  let floorSynced = 0;   // 上一帧实际写回矩阵的地板砖数（性能证据：休眠 → 接近 0）
  const FLOOR_BRICK = GLASS_ARCH.floorBrick;
  const floorHalf = new CANNON.Vec3(FLOOR_BRICK[0] / 2, FLOOR_BRICK[1] / 2, FLOOR_BRICK[2] / 2);
  // 质量按玻璃立方体的密度等比放大（1.5 kg / 1 m³ 的同一比例尺）
  const FLOOR_MASS = 1.5 * FLOOR_BRICK[0] * FLOOR_BRICK[1] * FLOOR_BRICK[2];
  const floorMesh = new THREE.InstancedMesh(
    arch.floorBrickGeometry, arch.floorGlassMaterial, Math.max(1, arch.layout.dynamic.length));
  floorMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  floorMesh.count = arch.layout.dynamic.length;
  floorMesh.frustumCulled = false;
  scene.add(floorMesh);
  const brickDummy = new THREE.Object3D();
  const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

  arch.layout.dynamic.forEach((p, i) => {
    const body = new CANNON.Body({
      mass: FLOOR_MASS, material: glassPhys,
      shape: new CANNON.Box(floorHalf),
      position: new CANNON.Vec3(p.x, p.y, p.z),
      linearDamping: 0.14, angularDamping: 0.45,
      sleepSpeedLimit: 0.12, sleepTimeLimit: 0.4
    });
    body.userData = {
      lastSound: 0, lastDamage: -Infinity, baseAngularDamping: 0.45,
      isFragment: false, spawnedAt: performance.now()
    };
    body.addEventListener("collide", onCollide);
    world.addBody(body);
    body.sleep(); // 初始布局是静止的：不因场景启动自行运动（GLA-002 刷新即复位）
    const entry = {
      kind: "floor", mesh: null, body, damage: createDamageState(),
      matIndex: 0, size: FLOOR_BRICK[0], instanceId: i, home: { x: p.x, y: p.y, z: p.z },
      synced: false   // 睡着且已写过最后一帧矩阵 → 后续帧跳过同步（GLA-003）
    };
    body.userData.entry = entry;
    floorBricks.push(entry);
    brickDummy.position.set(p.x, p.y, p.z);
    brickDummy.rotation.set(0, 0, 0);
    brickDummy.scale.setScalar(1);
    brickDummy.updateMatrix();
    floorMesh.setMatrixAt(i, brickDummy.matrix);
  });
  floorMesh.instanceMatrix.needsUpdate = true;

  // 受损地板砖升格为独立网格（保留完整裂纹贴图系统）
  function promoteFloorBrick(entry) {
    if (entry.mesh) return;
    const mesh = new THREE.Mesh(arch.floorBrickGeometry, arch.floorGlassMaterial.clone());
    mesh.userData.body = entry.body;
    mesh.userData.entry = entry;
    scene.add(mesh);
    entry.mesh = mesh;
    meshes.push(mesh);
    floorMesh.setMatrixAt(entry.instanceId, ZERO_MATRIX);
    floorMesh.instanceMatrix.needsUpdate = true;
  }

  // —— 碰撞：撞击声 + 损伤 ——
  const DAMAGE_MIN_SPEED = 3.0; // 低于此不计入损伤（过滤静止/轻微接触，见 SOURCE_SCENE.md §7.2）
  // 初始铺层从小高度自由落体的第一次触底速度可能超过损伤阈值，但那是场景初始化
  // 的复位落位，不是玩家造成的碰撞；用一次性“出生宽限期”豁免，声音仍然照常播放。
  const SETTLE_GRACE_MS = 1800;
  // 一次平放落地会在同一物理步内产生四个角的接触事件，每个都带着完整的法向相对
  // 速度。若逐个累加，同一次撞击会被记四遍损伤。这里按物体做去抖：一次撞击只结算
  // 一次，取窗口内的第一（也是最强的）个接触。
  const DAMAGE_DEBOUNCE_MS = 90;
  function onCollide(event) {
    const contact = event.contact;
    let vImpact = Math.abs(contact.getImpactVelocityAlongNormal());
    const body = event.target;
    const other = event.body;
    const isFragment = !!(body.userData && body.userData.isFragment);

    if (audioUnlocked && audio && vImpact >= 0.7) {
      const now = performance.now();
      if (now - body.userData.lastSound >= 45) {
        body.userData.lastSound = now;
        const wx = body.position.x + contact.ri.x;
        const pan = Math.max(-1, Math.min(1, wx / PAN_REF));
        const entry = !isFragment ? body.userData.entry : null;
        audio.impact({
          strength: THREE.MathUtils.clamp((vImpact - 0.7) / 6.5, 0, 1),
          velocity: THREE.MathUtils.clamp(vImpact / 8, 0, 1),
          pan, stage: entry ? entry.damage.stage : "INTACT", shard: isFragment
        });
      }
    }

    const nowMs = performance.now();
    const withinSettleGrace = !isFragment && body.userData &&
      (nowMs - body.userData.spawnedAt) < SETTLE_GRACE_MS;
    const debounced = !isFragment && body.userData &&
      (nowMs - body.userData.lastDamage) < DAMAGE_DEBOUNCE_MS;
    if (!isFragment && !withinSettleGrace && !debounced && vImpact >= DAMAGE_MIN_SPEED) {
      const entry = body.userData.entry;
      if (entry) {
        body.userData.lastDamage = nowMs;
        const em = effectiveMass(body.mass, other.mass);
        const local = new CANNON.Vec3();
        body.pointToLocalFrame(new CANNON.Vec3(
          body.position.x + contact.ri.x, body.position.y + contact.ri.y, body.position.z + contact.ri.z
        ), local);
        const result = registerImpact(entry.damage, {
          normalRelativeSpeed: vImpact, effectiveMass: em,
          localPoint: { x: local.x, y: local.y, z: local.z }
        });
        if (result.cracked && audioUnlocked && audio) {
          const pan = Math.max(-1, Math.min(1, body.position.x / PAN_REF));
          audio.crackTick(pan);
        }
        if (result.changed) {
          if (entry.damage.stage === "FRACTURED") spawnFragments(entry);
          else applyCrackVisual(entry);
        }
      }
    }
  }

  // —— 取景 / 轨道相机 ——
  // 反应堆按固定世界尺度建模，相机是一个绕池心的轨道机位：方位角/仰角由右键拖拽
  // 控制，距离由滚轮缩放。首帧用一个能同时装下屏蔽体上沿与池口的 fit 距离作为初始
  // 值，并据此设定缩放上下限；之后 resize 只更新宽高比，不覆盖用户的机位。
  const cam = createFreeCamera({ camera });
  let camInitialized = false;

  // 水面跨越是**连续**的（CAM-003 / WTR-002）：相机穿过水面时没有任何一帧发生整体
  // 跳色。雾对象常驻场景（密度从 0 连续升到水下值），因此跨越时也不会触发材质
  // 重编译；clear color 与雾色按同一个 submersion 权重插值。
  scene.fog = underwaterFog;
  underwaterFog.density = 0;
  const ABOVE_CLEAR = new THREE.Color(0x02070f);
  const UNDER_CLEAR = new THREE.Color(0x061c28);
  const ABOVE_FOG = new THREE.Color(0x02070f);
  const clearMix = new THREE.Color();
  const UNDERWATER_FOG_DENSITY = 0.14;
  let submersion = 0;

  const applyCamera = () => {
    cam.apply();
    // 水上/水下光学的唯一判据是相机相对名义水面的位置（CAM-003）。跨越水面只改变
    // 光学权重：不新建水体/反应堆/玻璃会话，不改控制权，不触发音频。
    water.setCamera(camera.position);
    submersion = water.submersion;
    underwaterFog.density = UNDERWATER_FOG_DENSITY * submersion;
    underwaterFog.color.copy(ABOVE_FOG).lerp(UNDERWATER_FOG_COLOR, submersion);
    clearMix.copy(ABOVE_CLEAR).lerp(UNDER_CLEAR, submersion);
    renderer.setClearColor(clearMix, 1);
    // 切伦科夫四层与 bloom 读同一个相机位置/水面/浸没权重：水体光程是唯一来源
    cherenkov.setViewer(camera.position, submersion);
  };

  const layout = () => {
    const cssW = canvas.clientWidth || section.clientWidth;
    const cssH = canvas.clientHeight || section.clientHeight;
    if (!cssW || !cssH) return false;

    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();

    const fit = homeFitDistance({
      aspect: camera.aspect, fovDeg: FOV,
      radiusV: FIT_RADIUS_V, radiusH: FIT_RADIUS_H,
      elevationDeg: CAM_ELEVATION_DEG, targetY: CAM_TARGET_Y,
      ceilingLimitY: HOME_CEILING_LIMIT_Y, wallLimit: HOME_WALL_LIMIT
    });
    // 规范初始取景（CAM-002 的"可回到初始取景"就是回到这里）。resize 只更新宽高比
    // 与 home 距离，不再覆盖用户当前机位。
    cam.setHome({
      pivot: new THREE.Vector3(0, CAM_TARGET_Y, 0),
      yaw: 0, pitch: -(CAM_ELEVATION_DEG * Math.PI) / 180, distance: fit
    });
    if (!camInitialized) { cam.goHome(); camInitialized = true; }
    applyCamera();
    return true;
  };

  // —— 初始玻璃布局：只在安全格栅盘面上 ——
  // 每块玻璃的整个底面都必须落在格栅刚体（半径 reactor.grating.radius）之内，
  // 所以格心半径上限要扣掉立方体的半对角线。池口以外是走道与屏蔽体，属于反应堆
  // 结构本身，初始不摆玻璃——玻璃可以被拖过去，但那是用户造成的。
  const GAP = 1.06;
  const populate = () => {
    const gratingTop = reactor.grating.y + reactor.grating.thickness / 2;
    const rest = gratingTop + CUBE / 2;
    const maxR = reactor.grating.radius - Math.SQRT1_2 * CUBE - 0.05;
    const step = CUBE * GAP;
    // +1 让最外一圈也参与，落在圆外的格位由下面的半径判据剔除，铺出圆盘而不是方块
    const n = Math.floor((maxR * 2) / step) + 1;
    const origin = -((n - 1) * step) / 2;
    let k = 0;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = origin + ix * step;
        const z = origin + iz * step;
        if (Math.hypot(x, z) > maxR) continue;
        // 落差保持很小：即使没有出生宽限期，触底速度的能量代理也在损伤阈值以下，
        // 加载时的复位落位不会扣耐久。reduceMotion 下直接摆在静止高度。
        const dist = maxR > 0 ? Math.hypot(x, z) / maxR : 0;
        const y = reduceMotion ? rest : rest + 0.12 + dist * 0.22;
        addCube(x, y, z, k++);
      }
    }
  };

  // —— 拖拽 ——
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pointerId = null;

  const setNdc = event => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LIFT_Y);
  const hit = new THREE.Vector3();

  // ———————— GLA-CTRL 抓取伺服 ————————
  // 鼠标只改世界水平面上的目标位置（GLA-CTRL-001），W/S 改目标高度，A/D 只绕世界
  // 竖直轴偏航（GLA-CTRL-002）。跟随用**有界伺服冲量**，不是每帧传送：玻璃在抓取
  // 期间仍参与碰撞，冲量、速度都有上限。
  const GRAB = {
    gain: 9, maxSpeed: 7, maxImpulse: 26,
    liftRate: 2.4, yawRate: 2.0, minY: -10.6, maxY: 11.0, releaseSpeed: 3.0
  };
  // baseQuat = 抓取瞬间的**完整**朝向（含碰撞留下的俯仰/翻滚）；yaw0 = 那一刻的偏航。
  // 约束姿态 = 绕世界 Y 转 (yaw - yaw0) 再乘 baseQuat：世界 Y 旋转不改变本地 +Y 与
  // 世界 +Y 的夹角，因此俯仰/翻滚在整个抓取过程中逐位保持不变（GLA-CTRL-002）。
  const grab = {
    entry: null, y: LIFT_Y, yaw: 0, yaw0: 0, tx: 0, tz: 0,
    baseQuat: new CANNON.Quaternion()
  };
  const keys = new Set();
  let shiftDown = false;

  const yawOf = q => Math.atan2(2 * (q.w * q.y + q.z * q.x), 1 - 2 * (q.y * q.y + q.x * q.x));

  function beginGrab(entry) {
    grab.entry = entry;
    const b = entry.body;
    b.wakeUp();
    b.allowSleep = false;
    b.angularDamping = 0.9;
    b.angularVelocity.set(0, 0, 0);   // 抓取成功时清除已有随机角速度
    grab.y = clamp(b.position.y, GRAB.minY, GRAB.maxY);
    grab.baseQuat.copy(b.quaternion);
    grab.yaw0 = yawOf(b.quaternion);
    grab.yaw = grab.yaw0;
    grab.tx = b.position.x; grab.tz = b.position.z;
    dragPlane.constant = -grab.y;
    canvas.style.cursor = "grabbing";
  }

  function releaseGrab() {
    const entry = grab.entry;
    grab.entry = null;
    if (!entry) return;
    const b = entry.body;
    b.angularDamping = b.userData.baseAngularDamping;
    b.allowSleep = true;
    // 松开不注入随机角速度；线速度也钳到一个不会甩飞的上限，之后完全交回刚体系统
    b.angularVelocity.set(0, 0, 0);
    const sp = b.velocity.length();
    if (sp > GRAB.releaseSpeed) b.velocity.scale(GRAB.releaseSpeed / sp, b.velocity);
    b.wakeUp();
    canvas.style.cursor = "";
  }

  const grabImpulse = new CANNON.Vec3();
  const grabYawQ = new CANNON.Quaternion();
  const GRAB_WORLD_Y = new CANNON.Vec3(0, 1, 0);
  function grabServo() {
    if (!grab.entry) return;
    const b = grab.entry.body;
    // 位置伺服（有界）
    const dx = grab.tx - b.position.x, dy = grab.y - b.position.y, dz = grab.tz - b.position.z;
    let vx = dx * GRAB.gain, vy = dy * GRAB.gain, vz = dz * GRAB.gain;
    const vlen = Math.hypot(vx, vy, vz);
    if (vlen > GRAB.maxSpeed) { const s = GRAB.maxSpeed / vlen; vx *= s; vy *= s; vz *= s; }
    grabImpulse.set((vx - b.velocity.x) * b.mass, (vy - b.velocity.y) * b.mass, (vz - b.velocity.z) * b.mass);
    const il = grabImpulse.length();
    if (il > GRAB.maxImpulse) grabImpulse.scale(GRAB.maxImpulse / il, grabImpulse);
    b.applyImpulse(grabImpulse);                       // 作用于质心 → 不产生随机力矩
    // 朝向：锁定抓取瞬间的俯仰/翻滚，只把 A/D 的世界竖直轴偏航增量叠上去。
    // 不再用纯 Y 轴四元数重建姿态——那会在第一物理步把侧躺的玻璃"扶正"。
    grabYawQ.setFromAxisAngle(GRAB_WORLD_Y, grab.yaw - grab.yaw0);
    grabYawQ.mult(grab.baseQuat, b.quaternion);
    b.angularVelocity.set(0, 0, 0);
  }
  world.addEventListener("preStep", grabServo);

  // 抓取拾取表：格栅玻璃（独立网格）+ 动态地板砖（实例化）。
  // 墙/天花玻璃属于固定建筑结构，从不进入这张表，因此不可抓取（GLA-001）。
  const pickTargets = () => meshes.concat(floorMesh.count > 0 ? [floorMesh] : []);
  const resolveEntry = h => {
    if (h.object === floorMesh) return floorBricks.find(e => e.instanceId === h.instanceId) || null;
    return h.object.userData.entry || null;
  };

  const moveHand = () => {
    raycaster.setFromCamera(ndc, camera);
    dragPlane.constant = -grab.y;
    if (raycaster.ray.intersectPlane(dragPlane, hit)) { grab.tx = hit.x; grab.tz = hit.z; }
  };

  // —— 右键轨道 / 中键平移拖拽状态 ——
  let orbitPointerId = null;
  let orbitMode = "orbit";
  let orbitLast = { x: 0, y: 0 };
  let activeHotspot = null;       // 当前按住的控制台控件（用于 hold 类松开）
  let activeHotspotPointer = null;

  const onPointerDown = event => {
    // 右键 → 轨道旋转；中键 → 平移（CAM-001）
    if (event.button === 2 || event.button === 1) {
      interactOutsideConsole();
      if (orbitPointerId !== null) return;
      orbitPointerId = event.pointerId;
      orbitMode = event.button === 1 ? "pan" : "orbit";
      orbitLast.x = event.clientX; orbitLast.y = event.clientY;
      try { canvas.setPointerCapture(orbitPointerId); } catch (e) { /* 合成事件可能抛 */ }
      canvas.style.cursor = "move";
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    // 左键：先判定控制台控件（操控反应堆），命中则不进入玻璃拖拽
    if (pointerId !== null || activeHotspot) return;
    setNdc(event);
    raycaster.setFromCamera(ndc, camera);
    const hs = raycaster.intersectObjects(hotspotMeshes, false);
    if (hs.length) {
      const spot = allHotspots.find(h => h.mesh === hs[0].object);
      if (spot) {
        // 控制台热点：只解锁音频/时钟，控制权由该控件的指令自己决定
        // （AUTO 方钮 → AUTO；其余人工控件 → MANUAL 原位接管）。
        unlockAll();
        activeHotspot = spot;
        activeHotspotPointer = event.pointerId;
        try { canvas.setPointerCapture(event.pointerId); } catch (e) { /* 合成事件可能抛 */ }
        spot.press();
        canvas.style.cursor = "pointer";
        return;
      }
    }
    // 控制台以外的左键（拖玻璃或点空处）→ 进入 AUTO
    interactOutsideConsole();
    // 否则 → 抓取玻璃（只有格栅玻璃和动态地板玻璃在拾取表里）
    const hits = raycaster.intersectObjects(pickTargets(), false);
    if (!hits.length) return;
    const entry = resolveEntry(hits[0]);
    if (!entry) return;

    pointerId = event.pointerId;
    try { canvas.setPointerCapture(pointerId); } catch (e) { /* 合成事件可能抛，无碍 */ }
    beginGrab(entry);
    // 抓取起点就用命中点所在的水平面，避免玻璃在按下瞬间跳到别处
    grab.tx = hits[0].point.x;
    grab.tz = hits[0].point.z;
    moveHand();
  };

  const onPointerMove = event => {
    if (orbitPointerId !== null && event.pointerId === orbitPointerId) {
      const dx = event.clientX - orbitLast.x;
      const dy = event.clientY - orbitLast.y;
      orbitLast.x = event.clientX; orbitLast.y = event.clientY;
      if (orbitMode === "pan") cam.pan(dx, dy, canvas.clientHeight || 900);
      else cam.orbit(dx, dy);
      applyCamera();
      return;
    }
    if (pointerId === null) {
      setNdc(event);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObjects(hotspotMeshes, false).length) canvas.style.cursor = "pointer";
      else canvas.style.cursor = raycaster.intersectObjects(pickTargets(), false).length ? "grab" : "";
      return;
    }
    if (event.pointerId !== pointerId) return;
    setNdc(event);
    moveHand();
  };

  // 控制台 hold 控件的释放（提/插棒是持续指令：不释放就会留下幽灵输入）。
  // 单独抽出来，好让失焦/隐藏/指针捕获丢失都能走同一条释放路径。
  const releaseHotspot = () => {
    if (!activeHotspot) return;
    activeHotspot.release();
    try { canvas.releasePointerCapture(activeHotspotPointer); } catch (e) { /* 指针已没了 */ }
    activeHotspot = null; activeHotspotPointer = null;
    canvas.style.cursor = "";
  };

  const endDrag = event => {
    if (activeHotspot && (!event || event.pointerId === activeHotspotPointer)) {
      releaseHotspot();
      return;
    }
    if (orbitPointerId !== null && (!event || event.pointerId === orbitPointerId)) {
      try { canvas.releasePointerCapture(orbitPointerId); } catch (e) { /* 指针已没了 */ }
      orbitPointerId = null;
      canvas.style.cursor = "";
      return;
    }
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    releaseGrab();
    try { canvas.releasePointerCapture(pointerId); } catch (e) { /* 指针已没了 */ }
    pointerId = null;
    canvas.style.cursor = "";
  };

  const onWheel = event => {
    interactOutsideConsole();
    event.preventDefault();
    cam.zoom(event.deltaY);
    applyCamera();
  };

  const onContextMenu = event => event.preventDefault();

  // —— 键盘：自由飞行 / 抓取输入所有权（GLA-CTRL-003）——
  // 抓取期间 W/S/A/D 专用于玻璃；松开后立即恢复自由飞行。Q/E 始终属于相机，
  // Shift 只是速度倍率（不改物理时间）。Home/F = 非文字的"回到规范初始取景"。
  const CAM_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
  const onKeyDown = event => {
    interactOutsideConsole();
    const k = (event.key || "").toLowerCase();
    if (k === "shift") { shiftDown = true; return; }
    if (k === "home" || k === "f") { cam.goHome(); applyCamera(); return; }
    if (CAM_KEYS.has(k)) { keys.add(k); event.preventDefault(); }
  };
  const onKeyUp = event => {
    const k = (event.key || "").toLowerCase();
    if (k === "shift") { shiftDown = false; return; }
    keys.delete(k);
  };
  // 键盘丢焦 / 窗口失焦 / 标签页隐藏：把**所有**持续输入都安全归零，避免"键卡住"、
  // 玻璃被无人拖着，或者提棒指令在后台继续驱动控制棒（棒速必须立即归零）。
  const onBlur = () => {
    keys.clear();
    shiftDown = false;
    releaseHotspot();
    if (orbitPointerId !== null) {
      try { canvas.releasePointerCapture(orbitPointerId); } catch (e) { /* 指针已没了 */ }
      orbitPointerId = null;
    }
    releaseGrab();
    pointerId = null;
    canvas.style.cursor = "";
  };
  // 指针捕获被浏览器收回（触屏手势竞争、元素移出文档等）也必须走同一条释放路径
  const onLostCapture = event => endDrag(event);

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", onLostCapture);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  // —— 滑动声：扫描当前接触，取最大切向相对速度 ——
  const relVel = new CANNON.Vec3();
  const tmpA = new CANNON.Vec3();
  const tmpB = new CANNON.Vec3();
  const computeSlide = () => {
    if (!audioUnlocked || !audio) return;
    let maxTan = 0;
    let panX = 0;
    const contacts = world.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const bi = c.bi, bj = c.bj;
      if (bi.sleepState === CANNON.Body.SLEEPING && bj.sleepState === CANNON.Body.SLEEPING) continue;
      bi.angularVelocity.cross(c.ri, tmpA);
      tmpA.vadd(bi.velocity, tmpA);
      bj.angularVelocity.cross(c.rj, tmpB);
      tmpB.vadd(bj.velocity, tmpB);
      tmpA.vsub(tmpB, relVel);
      const vn = relVel.dot(c.ni);
      relVel.x -= vn * c.ni.x; relVel.y -= vn * c.ni.y; relVel.z -= vn * c.ni.z;
      const tan = relVel.length();
      if (tan > maxTan) { maxTan = tan; panX = bi.position.x + c.ri.x; }
    }
    const level = THREE.MathUtils.clamp((maxTan - 0.35) / 3.5, 0, 1);
    audio.setSlide(level, Math.max(-1, Math.min(1, panX / PAN_REF)));
  };

  // —— 轻水浮力/阻力耦合：仅对进入池体半径且低于水面的刚体生效（碎片安全网） ——
  const BUOY_RHO = 26;
  function applyBuoyancy() {
    const all = fragments;
    for (let i = 0; i < all.length; i++) {
      const body = all[i].body;
      const r = Math.hypot(body.position.x, body.position.z);
      if (r > water.poolRadius) continue;
      const surface = water.heightAt(body.position.x, body.position.z);
      const half = body.shapes[0].halfExtents ? body.shapes[0].halfExtents.y : 0.1;
      const submerged = surface - (body.position.y - half);
      if (submerged <= 0) continue;
      const depthRatio = THREE.MathUtils.clamp(submerged / (half * 2), 0, 1);
      const volume = (half * 2) * (body.shapes[0].halfExtents.x * 2) * (body.shapes[0].halfExtents.z * 2);
      const buoy = BUOY_RHO * volume * depthRatio * 20;
      body.applyForce(new CANNON.Vec3(0, buoy, 0)); // 力作用于质心，偏移量默认为零
      body.velocity.scale(0.965, body.velocity);
      body.angularVelocity.scale(0.9, body.angularVelocity);
      if (!body.userData.wetted) {
        body.userData.wetted = true;
        water.addImpulse(body.position.x, body.position.z, Math.min(1, Math.abs(body.velocity.y) / 6));
        if (reactorAudio) reactorAudio.waterImpulse(Math.min(1, Math.abs(body.velocity.y) / 6),
          THREE.MathUtils.clamp(body.position.x / PAN_REF, -1, 1));
      }
    }
  }

  // —— 会话事件 → 格栅冲量 / 轻水冲量 / 机械声音 ——
  function handleSessionEvents(events) {
    const scale = reduceMotion ? REDUCE_SCALE : 1;
    for (const ev of events) {
      if (ev.type === "trans_eject_impulse") {
        gratingBody.wakeUp();
        gratingBody.applyImpulse(new CANNON.Vec3(0, -GRATING_EJECT_IMPULSE * scale, 0), transOffset);
        if (reactorAudio) reactorAudio.transEject();
      } else if (ev.type === "trans_reseat_impulse") {
        gratingBody.wakeUp();
        gratingBody.applyImpulse(new CANNON.Vec3(0, GRATING_RESEAT_IMPULSE * scale, 0), transOffset);
        if (reactorAudio) reactorAudio.transReseat();
      } else if (ev.type === "trans_underwater_impulse") {
        water.addImpulse(reactor.corePosition.x, reactor.corePosition.z, 0.8 * scale, 0.6);
      }
    }
  }

  // 逐帧峰值记录：脉冲的机械响应只持续零点几秒，外部按固定间隔轮询会漏掉峰值，
  // 因此在循环内就地记录极值，供自动化验收判断"振动有限、玻璃不被脉冲击碎"。
  const peaks = { gratingDeviation: 0, gratingSpeed: 0, cubeSpeed: 0, pulsePower: 0 };
  function resetPeaks() {
    peaks.gratingDeviation = 0; peaks.gratingSpeed = 0; peaks.cubeSpeed = 0; peaks.pulsePower = 0;
  }
  function trackPeaks() {
    const dev = Math.abs(gratingBody.position.y - reactor.grating.restY);
    if (dev > peaks.gratingDeviation) peaks.gratingDeviation = dev;
    const gv = gratingBody.velocity.length();
    if (gv > peaks.gratingSpeed) peaks.gratingSpeed = gv;
    if (session.state.pulsePowerProxy > peaks.pulsePower) peaks.pulsePower = session.state.pulsePowerProxy;
    for (let i = 0; i < cubes.length; i++) {
      const v = cubes[i].body.velocity.length();
      if (v > peaks.cubeSpeed) peaks.cubeSpeed = v;
    }
  }

  // —— 主循环 ——
  let raf = 0;
  let running = false;
  let disposed = false;
  let last = 0;

  // 一步完整仿真（反应堆状态 → 结构/水体耦合 → 刚体求解）。渲染帧和自动化验收用的
  // __SOURCE_ADVANCE__ 走的是同一段代码，因此“快进”得到的是真实积分结果，不是另一
  // 套简化模型。
  const simulate = dt => {
    const events = session.update(dt);
    handleSessionEvents(events);
    reactor.update(dt, session.state);
    water.update(dt, session.state);
    console3d.update(session.state, dt);
    autoConsole3d.update(session.state, dt);
    lab.update(session.state, dt);
    underground.update(session.state, dt);
    arch.update(session.state, dt);
    cherenkov.update(dt, session.state);
    if (reactorAudio) reactorAudio.update(dt, session.state);

    world.step(1 / 60, dt, 4);
    applyBuoyancy();
    computeSlide();
    syncGratingVisual();
    trackPeaks();
  };

  const frame = now => {
    if (!running || disposed) return;
    // 先续订下一帧：任何一次瞬时异常都不应该让整个场景永久停住（异常本身仍会照常
    // 冒泡到 console，不被吞掉）。
    raf = requestAnimationFrame(frame);
    // rAF 时间戳可能早于 start() 里记录的 performance.now()，负步长必须夹掉，
    // 否则会倒着积分动力学并让曲线参数越界（见 timeStep.js）。
    const dt = frameDelta(now, last);
    last = now;

    // —— 输入所有权（GLA-CTRL-003）：抓着玻璃时 W/S/A/D 属于玻璃，否则属于相机 ——
    if (grab.entry) {
      const lift = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
      const yaw = (keys.has("a") ? 1 : 0) - (keys.has("d") ? 1 : 0);
      if (lift) grab.y = clamp(grab.y + lift * GRAB.liftRate * dt, GRAB.minY, GRAB.maxY);
      if (yaw) grab.yaw += yaw * GRAB.yawRate * dt;
      // Q/E 仍归相机：抓取只独占 W/S/A/D
      const camOnly = new Set();
      if (keys.has("q")) camOnly.add("q");
      if (keys.has("e")) camOnly.add("e");
      if (camOnly.size) cam.fly(dt, camOnly, shiftDown);
    } else {
      cam.fly(dt, keys, shiftDown);
    }
    // 每帧重算机位与水上/水下分支：水面本身在动，光学分支不能只在鼠标事件里更新
    applyCamera();

    simulate(dt);

    for (let i = 0; i < cubes.length; i++) {
      const { mesh, body } = cubes[i];
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }
    for (let i = 0; i < fragments.length; i++) {
      const { mesh, body } = fragments[i];
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
    }

    // 完好的动态地板砖：一次绘制调用写回实例矩阵（受损的已升格为独立网格）。
    // GLA-003 性能边界：**睡着的砖不写矩阵**——它的位姿按定义没有变化，重写只是
    // 白白刷 GPU 缓冲。全部 300 块砖始终保有独立刚体、耐久和抓取能力，代价靠休眠
    // 省掉，而不是靠把远处砖降级成不可移动地面。
    floorSynced = 0;
    if (floorMesh.count > 0) {
      for (let i = 0; i < floorBricks.length; i++) {
        const e = floorBricks[i];
        const asleep = e.body.sleepState === CANNON.Body.SLEEPING;
        if (asleep && e.synced) continue;
        e.synced = asleep;               // 入睡当帧再写最后一次，之后跳过
        floorSynced++;
        if (e.mesh) {
          e.mesh.position.set(e.body.position.x, e.body.position.y, e.body.position.z);
          e.mesh.quaternion.set(
            e.body.quaternion.x, e.body.quaternion.y, e.body.quaternion.z, e.body.quaternion.w);
          continue;
        }
        brickDummy.position.set(e.body.position.x, e.body.position.y, e.body.position.z);
        brickDummy.quaternion.set(
          e.body.quaternion.x, e.body.quaternion.y, e.body.quaternion.z, e.body.quaternion.w);
        brickDummy.scale.setScalar(1);
        brickDummy.updateMatrix();
        floorMesh.setMatrixAt(e.instanceId, brickDummy.matrix);
      }
      if (floorSynced > 0) floorMesh.instanceMatrix.needsUpdate = true;
    }

    renderer.render(scene, camera);
  };

  const start = () => {
    if (running || disposed) return;
    running = true;
    last = performance.now();
    if (audio && audioUnlocked) audio.unlock();
    if (reactorAudio && audioUnlocked) reactorAudio.unlock();
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
    if (audio) audio.suspend();
    if (reactorAudio) reactorAudio.suspend();
  };

  if (!layout()) return null;
  populate();
  reactor.update(0, session.state);
  water.update(0, session.state);
  console3d.update(session.state, 0);
  lab.update(session.state, 0);
  renderer.render(scene, camera);
  section.classList.add("physical-ready");
  start();

  // 供 Playwright/自动化测试读取的只读调试快照（非文字 UI，不影响页面外观）
  window.__SOURCE_STATE__ = session.state;
  // 玻璃/格栅的只读统计，供自动化验收检查"静止不抖、不漂浮、不自行破碎"
  // （REACTOR_POOL_SYSTEM.md §9.4）。只读取物理状态，不参与任何模拟。
  // 操作员指令调试钩子（非文字，供自动化验收在控制台几何就绪前直接驱动反应堆；
  // 控制台点击最终调用同一组 session 方法）。dispose 时删除。
  window.__SOURCE_CMD__ = {
    autoStart: () => session.requestAuto(),
    startup: () => session.startup(),
    scram: () => session.scram(),
    setMode: (m) => session.setMode(m),
    pumpToggle: () => session.pumpToggle(),
    rodStart: (n, d) => session.rodStart(n, d),
    rodStop: (n) => session.rodStop(n),
    pulseFire: () => session.pulseFire()
  };
  // 控制台控件的屏幕坐标（供自动化验收模拟点击；非文字）。
  // 必须覆盖 allHotspots（MANUAL 台 + 独立 AUTO 台）：射线拾取用的就是 allHotspots，
  // 只报 console3d 会让 AUTO 控制台在自动化验收里不可见、无法点击。
  window.__SOURCE_HOTSPOTS__ = () => {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    return allHotspots.map(h => {
      h.mesh.getWorldPosition(v);
      v.project(camera);
      return {
        name: h.name, kind: h.kind, console: h.console || (console3d.hotspots.includes(h) ? "MANUAL" : "AUTO"),
        x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-v.y * 0.5 + 0.5) * rect.height,
        onScreen: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
      };
    });
  };
  // 自动化验收用的快进钩子：以固定 1/60 s 步长推进**同一个** simulate()，不渲染。
  // AUTO 连续运行程序到达 250 kW 平衡需要约 70 s 仿真时间，而无 GPU 的验收环境只有
  // 一两帧每秒，实时等待不可行。快进不改变任何模型、常量或积分方式，只是把帧循环
  // 的节流去掉；dispose() 时删除。
  window.__SOURCE_ADVANCE__ = (seconds = 1) => {
    const step = 1 / 60;
    const n = Math.min(Math.round(seconds / step), 60 * 600);
    for (let i = 0; i < n; i++) simulate(step);
    return { seconds: n * step, phase: session.state.autoPhase, owner: session.state.controlOwner };
  };
  // 轻水的只读采样：沿池径取一圈样点，给出相对静水面的最大偏移，用于验收
  // “波动由物理事件触发并正确衰减”（SOURCE_SCENE.md §10.3）。
  window.__SOURCE_WATER__ = () => {
    let maxDev = 0;
    const samples = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = water.poolRadius * 0.55;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const dev = water.heightAt(x, z) - water.surfaceY;
      samples.push(+dev.toFixed(5));
      if (Math.abs(dev) > maxDev) maxDev = Math.abs(dev);
    }
    return {
      surfaceY: water.surfaceY,
      centerDeviation: +(water.heightAt(0, 0) - water.surfaceY).toFixed(5),
      maxDeviation: +maxDev.toFixed(5),
      samples
    };
  };
  window.__SOURCE_CAM__ = () => Object.assign(cam.snapshot(), {
    underwater: water.underwater,
    // 连续跨越水面的证据（CAM-003）：submersion / 雾密度 / clear color 都是连续量，
    // 相邻小步之间不会出现二选一的整体跳色。
    submersion: +submersion.toFixed(4),
    fogDensity: +underwaterFog.density.toFixed(5),
    clearColor: `#${clearMix.getHexString()}`,
    home: cam.isHome(),
    near: camera.near, far: camera.far
  });
  // 自由相机的自动化驱动钩子（非文字，供验收模拟右键/中键/滚轮/飞行；
  // 走的是与鼠标键盘完全相同的 cam.* 入口，不是另一套简化运动）。
  window.__SOURCE_NAV__ = {
    orbit: (dx, dy) => { cam.orbit(dx, dy); applyCamera(); return cam.snapshot(); },
    pan: (dx, dy) => { cam.pan(dx, dy, canvas.clientHeight || 900); applyCamera(); return cam.snapshot(); },
    zoom: (d) => { cam.zoom(d); applyCamera(); return cam.snapshot(); },
    fly: (dirs, seconds = 1, boost = false) => {
      const set = new Set(String(dirs).toLowerCase().split(""));
      const step = 1 / 60;
      for (let i = 0; i < Math.round(seconds / step); i++) cam.fly(step, set, boost);
      applyCamera();
      return cam.snapshot();
    },
    home: () => { cam.goHome(); applyCamera(); return cam.snapshot(); }
  };
  // 切伦科夫的只读快照（功率因果、有界曝光、活粒子数）
  window.__SOURCE_CHR__ = () => cherenkov.snapshot();
  // 声音激活的只读快照。听感无法在无声卡的验收环境里检查，但"首次手势之前根本没有
  // AudioContext / 手势之后 running / 发声计数只随真实物理事件增长"这三件事可以，
  // 所以把它们暴露出来，而不是把整条音频路径记成不可验证。
  window.__SOURCE_AUDIO__ = () => ({
    unlockedAll: audioUnlocked,
    glass: audio ? audio.status() : "NO_WEB_AUDIO",
    reactor: reactorAudio ? reactorAudio.status() : "NO_WEB_AUDIO"
  });
  // 渲染代价快照（绘制调用/三角形/活动刚体/粒子），供三视口性能记录
  window.__SOURCE_PERF__ = () => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    programs: renderer.info.programs ? renderer.info.programs.length : -1,
    bodies: world.bodies.length,
    awake: world.bodies.filter(b => b.mass > 0 && b.sleepState !== CANNON.Body.SLEEPING).length,
    // 醒着的刚体按类别拆开：格栅是弹簧悬挂的承托件，必须常醒（Spring.applyForce 不会
    // 唤醒睡着的刚体，睡着的格栅会退化成静态件、不再响应落上来的玻璃），所以
    // "grating: 1" 是设计结果而不是泄漏；其余类别不为 0 才需要追查。
    awakeKinds: world.bodies
      .filter(b => b.mass > 0 && b.sleepState !== CANNON.Body.SLEEPING)
      .reduce((acc, b) => {
        const k = b === gratingBody ? "grating"
          : b.userData && b.userData.isFragment ? "fragment"
            : b.userData && b.userData.entry ? b.userData.entry.kind : "other";
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
    particles: cherenkov.snapshot().particles,
    floorDynamic: floorBricks.length,
    floorFixed: arch.counts.floorFixed,          // GLA-002：恒为 0，地板上没有固定砖
    floorAsleep: floorBricks.filter(e => e.body.sleepState === CANNON.Body.SLEEPING).length,
    floorSynced,                                  // 上一帧真正写回的实例矩阵数
    wallBricks: arch.counts.wall,
    ceilingBricks: arch.counts.ceiling,
    dpr: renderer.getPixelRatio()
  });
  // 动态地板玻璃的只读统计（GLA-002 / GLA-CTRL：复位、休眠、抓取约束验收）
  window.__SOURCE_FLOOR__ = () => ({
    bricks: floorBricks.length,
    fixed: arch.counts.floorFixed,
    restY: +arch.layout.restY.toFixed(3),
    atHome: floorBricks.filter(e =>
      Math.hypot(e.body.position.x - e.home.x, e.body.position.y - e.home.y,
        e.body.position.z - e.home.z) < 0.02).length,
    asleep: floorBricks.filter(e => e.body.sleepState === CANNON.Body.SLEEPING).length,
    damaged: floorBricks.filter(e => e.damage.stage !== "INTACT").length,
    maxTilt: floorBricks.reduce((m, e) => {
      const q = e.body.quaternion;
      return Math.max(m, Math.abs(2 * (q.w * q.x + q.y * q.z)) + Math.abs(2 * (q.w * q.z - q.x * q.y)));
    }, 0),
    grabbed: grab.entry ? grab.entry.kind : null,
    grabTarget: grab.entry ? [+grab.tx.toFixed(3), +grab.y.toFixed(3), +grab.tz.toFixed(3)] : null,
    grabYaw: grab.entry ? +grab.yaw.toFixed(4) : null
  });
  window.__SOURCE_GLASS__ = () => ({
    cubes: cubes.length,
    fragments: fragments.length,
    stages: cubes.reduce((acc, c) => { acc[c.damage.stage] = (acc[c.damage.stage] || 0) + 1; return acc; }, {}),
    minDurability: cubes.reduce((m, c) => Math.min(m, c.damage.durability), 1),
    asleep: cubes.filter(c => c.body.sleepState === CANNON.Body.SLEEPING).length,
    maxSpeed: cubes.reduce((m, c) => Math.max(m, c.body.velocity.length()), 0),
    offDeck: cubes.filter(c => Math.hypot(c.body.position.x, c.body.position.z) > deck.outerRadius).length,
    below: cubes.filter(c => c.body.position.y < -1).length,
    restY: cubes.map(c => +c.body.position.y.toFixed(3)),
    grating: {
      y: +gratingBody.position.y.toFixed(4),
      speed: +gratingBody.velocity.length().toFixed(4)
    },
    peaks: {
      gratingDeviation: +peaks.gratingDeviation.toFixed(4),
      gratingSpeed: +peaks.gratingSpeed.toFixed(4),
      cubeSpeed: +peaks.cubeSpeed.toFixed(4),
      pulsePower: +peaks.pulsePower.toFixed(4)
    }
  });

  // 抓取验收钩子（非文字、只读）：给自动化一个"这块玻璃在屏幕的哪里"和"这个屏幕点
  // 打到了什么"的回答。GLA-CTRL 要求真实指针拖拽格栅玻璃与地板玻璃，GLA-001 要求
  // 证明墙/天花玻璃不可抓取——后者只有先证明射线**确实**命中墙砖才算数，否则"没抓到"
  // 和"点空了"分不开。probe 用的是 onPointerDown 里同一条射线与同一张拾取表。
  window.__SOURCE_PICK__ = () => {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    const project = (p) => {
      v.set(p.x, p.y, p.z).project(camera);
      return {
        x: +(rect.left + (v.x * 0.5 + 0.5) * rect.width).toFixed(1),
        y: +(rect.top + (-v.y * 0.5 + 0.5) * rect.height).toFixed(1),
        onScreen: v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
      };
    };
    const pickable = pickTargets();
    // 抓取约束的可测量量：tilt 是刚体本地 +Y 与世界 +Y 的夹角——GLA-CTRL-002 的
    // "俯仰/翻滚锁定"等价于 tilt 恒为 0；yaw 是唯一允许变化的角；spin 是角速度模长，
    // 用来证明抓取时不随机自转、释放时不注入角速度。
    const up = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const bodyReport = (b, kind, i) => {
      q.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      up.set(0, 1, 0).applyQuaternion(q);
      return {
        i, kind, ...project(b.position),
        pos: [+b.position.x.toFixed(4), +b.position.y.toFixed(4), +b.position.z.toFixed(4)],
        tilt: +Math.acos(clamp(up.y, -1, 1)).toFixed(6),
        yaw: +yawOf(b.quaternion).toFixed(5),
        spin: +b.angularVelocity.length().toFixed(6),
        speed: +b.velocity.length().toFixed(5),
        asleep: b.sleepState === CANNON.Body.SLEEPING
      };
    };
    return {
      cube: (i = 0) => (cubes[i] ? bodyReport(cubes[i].body, "cube", i) : null),
      brick: (i = 0) => (floorBricks[i] ? bodyReport(floorBricks[i].body, "floor", i) : null),
      // 地板砖按到某个世界坐标的距离排序，便于挑一块"洞在相机看得见的地方"的砖
      nearestBrick: (x, z) => {
        let best = -1, bd = Infinity;
        floorBricks.forEach((e, k) => {
          const d = Math.hypot(e.body.position.x - x, e.body.position.z - z);
          if (d < bd) { bd = d; best = k; }
        });
        return best < 0 ? null : bodyReport(floorBricks[best].body, "floor", best);
      },
      // 屏幕点 → 场景第一命中 + 是否落在可抓取表里
      at: (clientX, clientY) => {
        ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const all = raycaster.intersectObjects(scene.children, true)
          .filter(h => h.object.visible && h.object.type !== "Points");
        const grabHits = raycaster.intersectObjects(pickable, false);
        const first = all[0];
        return {
          sceneHit: first ? (first.object.name || first.object.type) : null,
          sceneHitDistance: first ? +first.distance.toFixed(3) : null,
          grabbable: grabHits.length > 0,
          grabKind: grabHits.length ? (resolveEntry(grabHits[0]) || {}).kind || null : null,
          // 前四个命中体（带命中距离），便于判断墙砖前面挡了什么，以及移开地板砖后
          // 这条射线到底穿过了多深、落在哪个地下设备上
          stack: all.slice(0, 4).map(h =>
            `${h.object.name || h.object.type}@${h.distance.toFixed(2)}`)
        };
      }
    };
  };

  let observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !document.hidden) start();
      else stop();
    }, { threshold: 0 });
    observer.observe(section);
  }

  const onVisibility = () => {
    if (document.hidden) { onBlur(); stop(); }
    else if (section.getBoundingClientRect().bottom > 0) start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  let resizeObserver = null;
  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => layout());
    resizeObserver.observe(section);
  }

  const onContextLost = event => {
    event.preventDefault();
    stop();
    section.classList.remove("physical-ready");
  };
  // 上下文恢复：在**同一会话**内继续。场景图、刚体、反应堆状态和玻璃耐久都活在
  // 本闭包里，从未被销毁；three.js 在下一次 render 时重新上传 GPU 资源，所以这里
  // 只需要重新布局并恢复帧循环——不重建场景，因此不产生新会话
  // （PROJECT_SPEC：WebGL 恢复不得错误触发新会话）。
  const onContextRestored = () => {
    if (disposed) return;
    if (!layout()) return;
    section.classList.add("physical-ready");
    start();
  };
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  return {
    dispose() {
      disposed = true;
      stop();
      observer && observer.disconnect();
      resizeObserver && resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
      canvas.removeEventListener("lostpointercapture", onLostCapture);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      world.removeEventListener("preStep", grabServo);
      cubes.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      floorBricks.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      fragments.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      if (audio) audio.dispose();
      if (reactorAudio) reactorAudio.dispose();
      reactor.dispose();
      water.dispose();
      console3d.dispose();
      autoConsole3d.dispose();
      lab.dispose();
      arch.dispose();
      underground.dispose();
      cherenkov.dispose();
      geo.dispose();
      materials.forEach(m => m.dispose());
      envRT.dispose();
      renderer.dispose();
      if (window.__SOURCE_STATE__ === session.state) delete window.__SOURCE_STATE__;
      delete window.__SOURCE_GLASS__;
      delete window.__SOURCE_FLOOR__;
      delete window.__SOURCE_PICK__;
      delete window.__SOURCE_CAM__;
      delete window.__SOURCE_NAV__;
      delete window.__SOURCE_CHR__;
      delete window.__SOURCE_AUDIO__;
      delete window.__SOURCE_PERF__;
      delete window.__SOURCE_CMD__;
      delete window.__SOURCE_HOTSPOTS__;
      delete window.__SOURCE_ADVANCE__;
      delete window.__SOURCE_WATER__;
    }
  };
}
