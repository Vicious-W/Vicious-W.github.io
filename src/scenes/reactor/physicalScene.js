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
import { createGlassAudio } from "./glassAudio.js";
import { createReactorAudio } from "./reactorAudio.js";
import {
  createDamageState, registerImpact, buildCrackTexture, buildFragmentGeometries
} from "./glassDamage.js";

const CUBE = 1;
const FOV = 22;
const LIFT_Y = 2.0;
const MAX_DPR = 1.5;
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
  camera.up.set(0, 0, -1);

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

  // —— 反应堆池 + 轻水（轻水作为反应堆 group 的子级，随其整体缩放）——
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

  // 走道/屏蔽体上沿静态支承（池口外侧的真实工程结构，见 RP-001）。
  // 用瓦片拼出的复合刚体，故意跳过池口半径内的区域——那部分的支承完全交给下面
  // 弹簧悬挂的格栅刚体，避免一张无限平面在格栅下沉时"顶替"格栅成为实际支承面。
  const walkwaySupport = new CANNON.Body({ mass: 0, material: glassPhys });
  {
    const TILE = 1.5;
    const REACH = 16; // 覆盖已知最宽视口仍留余量
    const tileShape = new CANNON.Box(new CANNON.Vec3(TILE / 2, 0.05, TILE / 2));
    for (let tx = -REACH; tx <= REACH; tx += TILE) {
      for (let tz = -REACH; tz <= REACH; tz += TILE) {
        if (Math.hypot(tx, tz) < reactor.grating.radius + TILE * 0.75) continue; // 让给格栅
        walkwaySupport.addShape(tileShape, new CANNON.Vec3(tx, -0.03, tz));
      }
    }
  }
  world.addBody(walkwaySupport);

  // —— RP-003 安全格栅刚体：弹簧+阻尼挂在桥架锚点上，真正承托玻璃 ——
  const gratingBody = new CANNON.Body({
    mass: 55, material: glassPhys,
    shape: new CANNON.Cylinder(reactor.grating.radius, reactor.grating.radius, reactor.grating.thickness, 20),
    position: new CANNON.Vec3(0, reactor.grating.y, 0),
    linearDamping: 0.35, angularDamping: 0.55
  });
  world.addBody(gratingBody);
  const bridgeAnchor = new CANNON.Body({ mass: 0, position: new CANNON.Vec3(0, reactor.grating.y, 0) });
  world.addBody(bridgeAnchor);
  const MOUNT_R = reactor.grating.radius * 0.7;
  const springs = [0, 1, 2, 3].map(i => {
    const a = (i / 4) * Math.PI * 2;
    const offset = new CANNON.Vec3(Math.cos(a) * MOUNT_R, 0, Math.sin(a) * MOUNT_R);
    return new CANNON.Spring(bridgeAnchor, gratingBody, {
      restLength: 0, stiffness: 5200, damping: 90,
      localAnchorA: offset, localAnchorB: offset
    });
  });
  world.addEventListener("postStep", () => springs.forEach(s => s.applyForce()));

  // applyImpulse() 的第二参数是相对质心的偏移，不是世界坐标；格栅静止位形下质心
  // 在 (0, grating.y, 0)，所以 TRANS 位置相对质心的偏移就是其 (x, 0, z)。
  const transOffset = new CANNON.Vec3(reactor.controlRods.TRANS.x, 0, reactor.controlRods.TRANS.z);
  const GRATING_EJECT_IMPULSE = 3.4;
  const GRATING_RESEAT_IMPULSE = 1.1;

  // 让格栅的可见网格跟随其弹簧物理体：桥架/格栅的有限刚度振动因此真正可见，
  // 不只是"玻璃在一个看不见的物理面上弹跳"。gratingBody 在未缩放的原始世界坐标
  // 系工作，可见网格是 reactor.group（有整体缩放 s）的子级，需要除以 s 换算成局部坐标。
  const gratingVisual = reactor.grating.visual;
  function syncGratingVisual() {
    const s = reactor.group.scale.x || 1;
    gratingVisual.position.set(gratingBody.position.x / s, gratingBody.position.y / s, gratingBody.position.z / s);
    gratingVisual.quaternion.set(
      gratingBody.quaternion.x, gratingBody.quaternion.y, gratingBody.quaternion.z, gratingBody.quaternion.w
    );
  }

  // 四面看不见的边界墙：只防止玻璃被拖出可视区域，不承担支承解释（支承已由格栅/走道刚体完成）
  const walls = [];
  for (let i = 0; i < 4; i++) {
    const body = new CANNON.Body({ mass: 0, material: glassPhys });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 14, 0.5)));
    world.addBody(body);
    walls.push(body);
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
    if (mesh.material !== materials[entry.matIndex]) mesh.material.dispose();

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

    if (audio) audio.fracture(THREE.MathUtils.clamp(basePos.x / Math.max(extentX / 2, 0.001), -1, 1));
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
    body.userData = { lastSound: 0, baseAngularDamping: 0.35, isFragment: false, spawnedAt: performance.now() };
    body.addEventListener("collide", onCollide);
    world.addBody(body);
    const entry = { mesh, body, damage: createDamageState(), matIndex: matIndex % materials.length };
    cubes.push(entry);
    meshes.push(mesh);
    mesh.userData.body = body;
    mesh.userData.entry = entry;
  };

  // —— 碰撞：撞击声 + 损伤 ——
  const DAMAGE_MIN_SPEED = 2.4; // 低于此不计入损伤（过滤静止/轻微接触，见 SOURCE_SCENE.md §7.2）
  // 初始铺层从小高度自由落体的第一次触底速度可能超过损伤阈值，但那是场景初始化
  // 的复位落位，不是玩家造成的碰撞；用一次性“出生宽限期”豁免，声音仍然照常播放。
  const SETTLE_GRACE_MS = 1800;
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
        const halfX = Math.max(extentX / 2, 0.001);
        const pan = Math.max(-1, Math.min(1, wx / halfX));
        const entry = !isFragment ? cubes.find(c => c.body === body) : null;
        audio.impact({
          strength: THREE.MathUtils.clamp((vImpact - 0.7) / 6.5, 0, 1),
          velocity: THREE.MathUtils.clamp(vImpact / 8, 0, 1),
          pan, stage: entry ? entry.damage.stage : "INTACT", shard: isFragment
        });
      }
    }

    const withinSettleGrace = !isFragment && body.userData &&
      (performance.now() - body.userData.spawnedAt) < SETTLE_GRACE_MS;
    if (!isFragment && !withinSettleGrace && vImpact >= DAMAGE_MIN_SPEED) {
      const entry = cubes.find(c => c.body === body);
      if (entry) {
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
          const pan = Math.max(-1, Math.min(1, body.position.x / Math.max(extentX / 2, 0.001)));
          audio.crackTick(pan);
        }
        if (result.changed) {
          if (entry.damage.stage === "FRACTURED") spawnFragments(entry);
          else applyCrackVisual(entry);
        }
      }
    }
  }

  // —— 尺寸 / 布局 ——
  let extentX = 10;
  let extentZ = 6;

  const layout = () => {
    const cssW = canvas.clientWidth || section.clientWidth;
    const cssH = canvas.clientHeight || section.clientHeight;
    if (!cssW || !cssH) return false;

    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;

    const narrow = matchMedia("(max-width: 640px)").matches;
    const acrossShort = narrow ? 5.5 : 8.0;
    const shortExtent = acrossShort * CUBE;
    const camY = (shortExtent / 2) / Math.tan((FOV * Math.PI) / 360);
    camera.position.set(0, camY, 0);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    if (camera.aspect >= 1) {
      extentZ = shortExtent;
      extentX = shortExtent * camera.aspect;
    } else {
      extentX = shortExtent;
      extentZ = shortExtent / camera.aspect;
    }

    reactor.setScale(shortExtent);
    water.setCamera(camera.position);

    const hx = extentX / 2;
    const hz = extentZ / 2;
    const place = (body, px, pz, ex, ez) => {
      body.position.set(px, 10, pz);
      const s = body.shapes[0];
      s.halfExtents.set(ex, 14, ez);
      s.updateConvexPolyhedronRepresentation();
      s.updateBoundingSphereRadius();
      body.updateBoundingRadius();
      body.updateAABB();
    };
    place(walls[0], hx + 0.5, 0, 0.5, hz + 1);
    place(walls[1], -hx - 0.5, 0, 0.5, hz + 1);
    place(walls[2], 0, hz + 0.5, hx + 1, 0.5);
    place(walls[3], 0, -hz - 0.5, hx + 1, 0.5);

    return true;
  };

  const GAP = 1.02;
  const populate = () => {
    const nx = Math.max(2, Math.floor(extentX / (CUBE * GAP)));
    const nz = Math.max(2, Math.floor(extentZ / (CUBE * GAP)));
    const stepX = extentX / nx;
    const stepZ = extentZ / nz;
    let k = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = -extentX / 2 + stepX * (ix + 0.5);
        const z = -extentZ / 2 + stepZ * (iz + 0.5);
        const rest = CUBE / 2;
        const dist = Math.hypot(x, z) / Math.hypot(extentX / 2, extentZ / 2);
        const y = reduceMotion ? rest : rest + 1.2 + dist * 3.2;
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

  const onPointerDown = event => {
    unlockAll();
    if (pointerId !== null) return;
    setNdc(event);
    raycaster.setFromCamera(ndc, camera);
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
    if (pointerId === null) {
      setNdc(event);
      raycaster.setFromCamera(ndc, camera);
      canvas.style.cursor = raycaster.intersectObjects(meshes, false).length ? "grab" : "";
      return;
    }
    if (event.pointerId !== pointerId) return;
    setNdc(event);
    moveHand();
  };

  const endDrag = event => {
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

  const onKeyDown = () => unlockAll();

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
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
    const halfX = Math.max(extentX / 2, 0.001);
    audio.setSlide(level, Math.max(-1, Math.min(1, panX / halfX)));
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
          THREE.MathUtils.clamp(body.position.x / Math.max(extentX / 2, 0.001), -1, 1));
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

  // —— 主循环 ——
  let raf = 0;
  let running = false;
  let disposed = false;
  let last = 0;
  let time = 7.0;

  const frame = now => {
    if (!running || disposed) return;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!reduceMotion) time += dt;

    const events = session.update(dt);
    handleSessionEvents(events);
    reactor.update(dt, session.state);
    water.update(dt, session.state);
    if (reactorAudio) reactorAudio.update(dt, session.state);

    world.step(1 / 60, dt, 4);
    applyBuoyancy();
    computeSlide();
    syncGratingVisual();

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
  renderer.render(scene, camera);
  section.classList.add("physical-ready");
  start();

  // 供 Playwright/自动化测试读取的只读调试快照（非文字 UI，不影响页面外观）
  window.__SOURCE_STATE__ = session.state;

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
  canvas.addEventListener("webglcontextlost", onContextLost);

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
      canvas.removeEventListener("webglcontextlost", onContextLost);
      window.removeEventListener("keydown", onKeyDown);
      cubes.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      fragments.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      if (audio) audio.dispose();
      if (reactorAudio) reactorAudio.dispose();
      reactor.dispose();
      water.dispose();
      geo.dispose();
      materials.forEach(m => m.dispose());
      envRT.dispose();
      renderer.dispose();
      if (window.__SOURCE_STATE__ === session.state) delete window.__SOURCE_STATE__;
    }
  };
}
