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
import { createWaterSystem } from "./waterSystem.js";
import { createSessionController } from "./sessionController.js";
import { createControlConsole } from "./controlConsole.js";
import { createLabEnvironment, HALL_BOUNDS, HALL_COLLIDERS } from "./labEnvironment.js";
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
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200);

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
  const hotspotMeshes = console3d.hotspots.map(h => h.mesh);

  // —— 实验大厅环境（房间外壳、厂房设备、人员安全设施）——
  const lab = createLabEnvironment({ reduceMotion });
  scene.add(lab.group);

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
  const hallFloor = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const SEG = 32;
    const rIn = deck.outerRadius;
    const rOut = HALL_COLLIDERS.wallInner * 1.5;   // 乘 1.5 覆盖到方形大厅的四个角
    const rMid = (rIn + rOut) / 2;
    const halfRadial = (rOut - rIn) / 2;
    const halfTangent = rMid * Math.tan(Math.PI / SEG) * 1.05;
    const segShape = new CANNON.Box(new CANNON.Vec3(halfRadial, 0.06, halfTangent));
    const q = new CANNON.Quaternion();
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      q.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), -a);
      hallFloor.addShape(
        segShape,
        new CANNON.Vec3(Math.cos(a) * rMid, HALL_COLLIDERS.floorTop - 0.06, Math.sin(a) * rMid),
        q.clone()
      );
    }
  }
  world.addBody(hallFloor);

  const hallWalls = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const w = HALL_COLLIDERS.wallInner;
    const h = 6;
    const slab = new CANNON.Box(new CANNON.Vec3(0.25, h / 2, w));
    const q = new CANNON.Quaternion();
    const qz = new CANNON.Quaternion();
    qz.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2);
    const yMid = HALL_COLLIDERS.floorTop + h / 2;
    hallWalls.addShape(slab, new CANNON.Vec3(-w - 0.25, yMid, 0), q.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(w + 0.25, yMid, 0), q.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(0, yMid, -w - 0.25), qz.clone());
    hallWalls.addShape(slab, new CANNON.Vec3(0, yMid, w + 0.25), qz.clone());
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

  const hand = new CANNON.Body({
    mass: 0, shape: new CANNON.Sphere(0.05), collisionFilterGroup: 0, collisionFilterMask: 0
  });
  world.addBody(hand);

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

  function applyCrackVisual(entry) {
    const { mesh, damage } = entry;
    if (damage.stage === "INTACT") return;
    if (mesh.material === materials[entry.matIndex]) {
      mesh.material = materials[entry.matIndex].clone();
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
    scene.remove(mesh);
    world.removeBody(body);
    body.removeEventListener("collide", onCollide);
    const idx2 = cubes.indexOf(entry);
    if (idx2 >= 0) cubes.splice(idx2, 1);
    const midx = meshes.indexOf(mesh);
    if (midx >= 0) meshes.splice(midx, 1);
    if (mesh.material !== materials[entry.matIndex]) {
      // 裂纹贴图是 applyCrackVisual 生成的 canvas 纹理，破碎时一并释放
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.dispose();
    }

    const shards = buildFragmentGeometries(CUBE, cubes.length + fragments.length + 1);
    const basePos = body.position;
    const baseQuat = body.quaternion;
    const worldCenter = new CANNON.Vec3();
    shards.forEach(shard => {
      const mat = materials[entry.matIndex].clone();
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
        mass: 1.5 / 8, material: glassPhys,
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
    const entry = { mesh, body, damage: createDamageState(), matIndex: matIndex % materials.length };
    cubes.push(entry);
    meshes.push(mesh);
    mesh.userData.body = body;
    mesh.userData.entry = entry;
  };

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
        const entry = !isFragment ? cubes.find(c => c.body === body) : null;
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
      const entry = cubes.find(c => c.body === body);
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
  const orbit = {
    azimuth: 0,                                 // 0 = 从 +Z 正面看，与旧固定机位一致
    elevation: (CAM_ELEVATION_DEG * Math.PI) / 180,
    distance: 14,
    targetY: CAM_TARGET_Y,
    minDistance: 4,
    maxDistance: 40,
    minElevation: (22 * Math.PI) / 180,         // 不低于池沿视角；再低会把镜头压进走道结构里
    maxElevation: (88 * Math.PI) / 180,         // 不完全正俯视，保留立体感
    initialized: false
  };
  const applyCamera = () => {
    // 机位受厂房净空约束：抬头角越大、机位越远，相机就越高，不能穿过天花板；同理
    // 水平半径不能超出墙内侧。这里在算位置前把两者夹回来——所以"越拉远越只能俯视
    // 得越浅"，和真实房间里退到墙角看池子的感受一致。
    const headroom = HALL_BOUNDS.ceiling - orbit.targetY;
    const elCeil = Math.asin(clamp(headroom / Math.max(orbit.distance, 1e-3), -1, 1));
    orbit.elevation = clamp(orbit.elevation, orbit.minElevation,
      Math.max(orbit.minElevation, Math.min(orbit.maxElevation, elCeil)));
    const ce0 = Math.cos(orbit.elevation);
    if (orbit.distance * ce0 > HALL_BOUNDS.half) orbit.distance = HALL_BOUNDS.half / Math.max(ce0, 1e-3);

    const ce = Math.cos(orbit.elevation);
    camera.position.set(
      orbit.distance * ce * Math.sin(orbit.azimuth),
      orbit.targetY + orbit.distance * Math.sin(orbit.elevation),
      orbit.distance * ce * Math.cos(orbit.azimuth)
    );
    camera.lookAt(0, orbit.targetY, 0);
    water.setCamera(camera.position);
  };

  const layout = () => {
    const cssW = canvas.clientWidth || section.clientWidth;
    const cssH = canvas.clientHeight || section.clientHeight;
    if (!cssW || !cssH) return false;

    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;
    camera.updateProjectionMatrix();

    const halfV = (FOV * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const fit = Math.max(FIT_RADIUS_V / Math.sin(halfV), FIT_RADIUS_H / Math.sin(halfH));
    if (!orbit.initialized) { orbit.distance = fit; orbit.initialized = true; }
    orbit.minDistance = fit * 0.32;
    // 缩放上限同时受两件事约束：别退得太远失去主体，以及别退出厂房外墙（HALL/2 = 22）。
    orbit.maxDistance = Math.min(fit * 2.2, 19);
    orbit.distance = clamp(orbit.distance, orbit.minDistance, orbit.maxDistance);
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
  let joint = null;
  let dragging = null;
  let pointerId = null;

  const setNdc = event => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  };

  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LIFT_Y);
  const hit = new THREE.Vector3();

  const moveHand = () => {
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(dragPlane, hit)) hand.position.set(hit.x, hit.y, hit.z);
  };

  // —— 右键轨道拖拽状态 ——
  const ORBIT_SPEED = 0.006;   // 弧度/像素
  const ZOOM_SPEED = 0.0012;   // 每单位 wheel delta 的对数缩放系数
  let orbitPointerId = null;
  let orbitLast = { x: 0, y: 0 };
  let activeHotspot = null;       // 当前按住的控制台控件（用于 hold 类松开）
  let activeHotspotPointer = null;

  const onPointerDown = event => {
    // 右键（或中键）→ 轨道相机
    if (event.button === 2 || event.button === 1) {
      interactOutsideConsole();
      if (orbitPointerId !== null) return;
      orbitPointerId = event.pointerId;
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
      const spot = console3d.hotspots.find(h => h.mesh === hs[0].object);
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
    // 否则 → 抓取玻璃
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const body = hits[0].object.userData.body;
    pointerId = event.pointerId;
    try { canvas.setPointerCapture(pointerId); } catch (e) { /* 合成事件可能抛，无碍 */ }
    dragging = body;
    body.wakeUp();
    body.angularDamping = 0.8;

    const p = hits[0].point;
    const local = new CANNON.Vec3(p.x, p.y, p.z);
    body.pointToLocalFrame(local, local);

    hand.position.set(p.x, p.y, p.z);
    joint = new CANNON.PointToPointConstraint(body, local, hand, new CANNON.Vec3(0, 0, 0), 55);
    world.addConstraint(joint);
    canvas.style.cursor = "grabbing";
    moveHand();
  };

  const onPointerMove = event => {
    if (orbitPointerId !== null && event.pointerId === orbitPointerId) {
      const dx = event.clientX - orbitLast.x;
      const dy = event.clientY - orbitLast.y;
      orbitLast.x = event.clientX; orbitLast.y = event.clientY;
      orbit.azimuth -= dx * ORBIT_SPEED;
      orbit.elevation = clamp(orbit.elevation + dy * ORBIT_SPEED, orbit.minElevation, orbit.maxElevation);
      applyCamera();
      return;
    }
    if (pointerId === null) {
      setNdc(event);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObjects(hotspotMeshes, false).length) canvas.style.cursor = "pointer";
      else canvas.style.cursor = raycaster.intersectObjects(meshes, false).length ? "grab" : "";
      return;
    }
    if (event.pointerId !== pointerId) return;
    setNdc(event);
    moveHand();
  };

  const endDrag = event => {
    if (activeHotspot && (!event || event.pointerId === activeHotspotPointer)) {
      activeHotspot.release();
      try { canvas.releasePointerCapture(activeHotspotPointer); } catch (e) { /* 指针已没了 */ }
      activeHotspot = null; activeHotspotPointer = null;
      canvas.style.cursor = "";
      return;
    }
    if (orbitPointerId !== null && (!event || event.pointerId === orbitPointerId)) {
      try { canvas.releasePointerCapture(orbitPointerId); } catch (e) { /* 指针已没了 */ }
      orbitPointerId = null;
      canvas.style.cursor = "";
      return;
    }
    if (pointerId === null || (event && event.pointerId !== pointerId)) return;
    if (joint) { world.removeConstraint(joint); joint = null; }
    if (dragging) {
      dragging.angularDamping = dragging.userData.baseAngularDamping;
      dragging.wakeUp();
    }
    dragging = null;
    try { canvas.releasePointerCapture(pointerId); } catch (e) { /* 指针已没了 */ }
    pointerId = null;
    canvas.style.cursor = "";
  };

  const onWheel = event => {
    interactOutsideConsole();
    event.preventDefault();
    orbit.distance = clamp(orbit.distance * Math.exp(event.deltaY * ZOOM_SPEED),
      orbit.minDistance, orbit.maxDistance);
    applyCamera();
  };

  const onContextMenu = event => event.preventDefault();
  const onKeyDown = () => interactOutsideConsole();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown);

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
    lab.update(session.state, dt);
    if (reactorAudio) reactorAudio.update(dt, session.state);

    world.step(1 / 60, dt, 4);
    applyBuoyancy();
    computeSlide();
    syncGratingVisual();
    trackPeaks();
  };

  const frame = now => {
    if (!running || disposed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

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

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
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
  // 控制台控件的屏幕坐标（供自动化验收模拟点击；非文字）
  window.__SOURCE_HOTSPOTS__ = () => {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3();
    return console3d.hotspots.map(h => {
      h.mesh.getWorldPosition(v);
      v.project(camera);
      return {
        name: h.name, kind: h.kind,
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
  window.__SOURCE_CAM__ = () => ({
    az: +orbit.azimuth.toFixed(4), el: +orbit.elevation.toFixed(4), dist: +orbit.distance.toFixed(3),
    pos: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)]
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

  let observer = null;
  if ("IntersectionObserver" in window) {
    observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !document.hidden) start();
      else stop();
    }, { threshold: 0 });
    observer.observe(section);
  }

  const onVisibility = () => {
    if (document.hidden) stop();
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
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      window.removeEventListener("keydown", onKeyDown);
      cubes.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      fragments.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      if (audio) audio.dispose();
      if (reactorAudio) reactorAudio.dispose();
      reactor.dispose();
      water.dispose();
      console3d.dispose();
      lab.dispose();
      geo.dispose();
      materials.forEach(m => m.dispose());
      envRT.dispose();
      renderer.dispose();
      if (window.__SOURCE_STATE__ === session.state) delete window.__SOURCE_STATE__;
      delete window.__SOURCE_GLASS__;
      delete window.__SOURCE_CAM__;
      delete window.__SOURCE_CMD__;
      delete window.__SOURCE_HOTSPOTS__;
      delete window.__SOURCE_ADVANCE__;
      delete window.__SOURCE_WATER__;
    }
  };
}
