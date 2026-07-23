// 唯一页面场景：独立玻璃立方体覆盖真三维研究堆模型。
//
// 玻璃使用 Three.js 网格与 cannon-es 刚体；反应堆由 reactorModel.js 中的独立
// 三维部件构成。场景不使用平面图片或整面 shader 代替主要物体。
//
// 玻璃物理声音由 glassAudio.js 合成，触发量（冲击速度、切向滑动速度、接触点位置）
// 全部来自 cannon-es 的真实碰撞/接触数据——见下方 collide 监听与 slide 计算。
//
// 已知限制：Three.js 的 transmission 只采样**不透明**物体那一遍渲染，所以玻璃透过
// 玻璃看不到后面那块玻璃，加性辉光盘也不进折射（燃料棒自发光会进）。单层平铺几乎
// 看不出来；叠高后上面那块会直接看到反应堆而不是下面那块玻璃。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import * as CANNON from "cannon-es";
import { createReactorModel } from "./reactorModel.js";
import { createGlassAudio } from "./glassAudio.js";

const CUBE = 1;                 // 立方体边长（世界单位），所有尺寸都以它为基准
const FOV = 22;                 // 长焦俯视：仍看得出是正方体，整层又读成俯视的一个平面
const LIFT_Y = 2.0;             // 拖动时立方体被提到的高度：高过任何堆叠，又不撞到驱动桥
const MAX_DPR = 1.5;

// 环境贴图：本场景光源在**下方**（发光的轻水反应堆水池），上方几乎全黑。玻璃的立体感几乎
// 全靠环境反射，给错方向就像塑料——下半球是池子蓝辉光，上半球接近全黑，留两处小
// 亮斑给棱边高光抓。
function buildEnvTexture() {
  const W = 96;
  const H = 48;
  const data = new Float32Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    const theta = ((j + 0.5) / H) * Math.PI;   // 0 = 正上方
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
  if ("transmissionResolutionScale" in renderer) {
    renderer.transmissionResolutionScale = 0.5; // 折射用的离屏图可低一半分辨率
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200);
  camera.up.set(0, 0, -1); // 正上方俯视：屏幕的"上"对应世界 -Z

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = buildEnvTexture();
  const envRT = pmrem.fromEquirectangular(envSrc);
  scene.environment = envRT.texture;
  envSrc.dispose();
  pmrem.dispose();

  // 定向光给玻璃棱边一道锐利高光（纯环境反射偏柔）
  const key = new THREE.DirectionalLight(0xdceeff, 1.4);
  key.position.set(-4, 7, -3);
  scene.add(key);
  // 一点冷色环境光，避免池壁背光面死黑
  scene.add(new THREE.AmbientLight(0x14202e, 0.6));

  // —— 底层：真三维反应堆 ——
  const reactor = createReactorModel({ reduceMotion });
  scene.add(reactor.group);

  // —— 物理世界 ——
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.solver.iterations = 14;   // 更多迭代 → 稳定堆叠、少穿透
  world.solver.tolerance = 0.001;
  const glassPhys = new CANNON.Material("glass");
  const glassContact = new CANNON.ContactMaterial(glassPhys, glassPhys, {
    friction: 0.45,     // 够摩擦才堆得稳，但玻璃仍偏滑
    restitution: 0.03,  // 厚玻璃砸在玻璃上几乎不弹，是"闷"的
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3
  });
  world.addContactMaterial(glassContact);
  world.defaultContactMaterial.friction = 0.45;
  world.defaultContactMaterial.restitution = 0.03;
  world.defaultContactMaterial.contactEquationStiffness = 1e7;
  world.defaultContactMaterial.contactEquationRelaxation = 3;

  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: glassPhys });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);

  // 四面看不见的墙，把立方体关在画面里。要够高：入场时它们从画面上方落下。
  const walls = [];
  for (let i = 0; i < 4; i++) {
    const body = new CANNON.Body({ mass: 0, material: glassPhys });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 14, 0.5)));
    world.addBody(body);
    walls.push(body);
  }

  // 拖动用的"手"：不参与碰撞的静态点，用点对点约束把立方体吊起来。用约束而非直接
  // 设坐标，立方体才会在手上摆动、推开挡路的邻居——这才有物理手感。
  const hand = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Sphere(0.05),
    collisionFilterGroup: 0,
    collisionFilterMask: 0
  });
  world.addBody(hand);

  // —— 声音 ——
  const audio = createGlassAudio();
  let audioUnlocked = false;

  // —— 立方体 ——
  // 棱边略倒圆：现实里没有数学尖棱，而玻璃棱边正是高光最集中处，纯尖棱一眼就假。
  const geo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 4, 0.06);

  // 几种材质变体：真实玻璃砖分批浇铸，清澈度和料色略有差别。
  // 不加 clearcoat（清漆是塑料/车漆特征）；衰减距离放长，避免染成实心蓝像有色塑料——
  // 玻璃首先得是**清**的，体积感靠折射真实几何和棱边高光来体现。
  const materials = [0, 1, 2, 3].map(i => new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.02 + i * 0.014,
    transmission: 1,
    thickness: CUBE * (0.95 + i * 0.1),
    ior: 1.5,
    attenuationColor: new THREE.Color(0.74, 0.89, 1.0),
    attenuationDistance: 9.0 + i * 2.0,
    specularIntensity: 1,
    envMapIntensity: 1.4
  }));

  const cubes = [];   // { mesh, body }
  const meshes = [];

  const addCube = (x, y, z, matIndex) => {
    const mesh = new THREE.Mesh(geo, materials[matIndex % materials.length]);
    scene.add(mesh);
    const body = new CANNON.Body({
      mass: 1.5,
      material: glassPhys,
      shape: new CANNON.Box(new CANNON.Vec3(CUBE / 2, CUBE / 2, CUBE / 2)),
      position: new CANNON.Vec3(x, y, z),
      linearDamping: 0.12,
      angularDamping: 0.35,
      sleepSpeedLimit: 0.14,
      sleepTimeLimit: 0.5
    });
    body.userData = { lastSound: 0, baseAngularDamping: 0.35 };
    // 碰撞 → 撞击声：强度/亮度来自法向冲击速度，声像来自接触点世界 x 坐标。
    body.addEventListener("collide", onCollide);
    world.addBody(body);
    cubes.push({ mesh, body });
    meshes.push(mesh);
    mesh.userData.body = body;
  };

  // —— 碰撞声 ——
  function onCollide(event) {
    if (!audioUnlocked || !audio) return;
    const contact = event.contact;
    // 法向冲击速度：静止接触≈0，真正撞上才大。这是撞击强度的物理来源。
    let vImpact = Math.abs(contact.getImpactVelocityAlongNormal());
    if (vImpact < 0.7) return;                 // 过滤静止接触的微冲击
    const body = event.target;
    const now = performance.now();
    if (now - body.userData.lastSound < 45) return; // 单体节流
    body.userData.lastSound = now;
    // 接触点世界 x → 声像
    const b = contact.bi;
    const wx = b.position.x + contact.ri.x;
    const halfX = Math.max(extentX / 2, 0.001);
    const pan = Math.max(-1, Math.min(1, wx / halfX));
    audio.impact({
      strength: THREE.MathUtils.clamp((vImpact - 0.7) / 6.5, 0, 1),
      velocity: THREE.MathUtils.clamp(vImpact / 8, 0, 1),
      pan
    });
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

  // 初始铺一层：每块砖**正对自己那格上方**落下，落差小、按离中心距离错开时间，
  // 于是各就各位铺成一层，而不是从高处乱落砸成一团。
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
    if (raycaster.ray.intersectPlane(dragPlane, hit)) {
      hand.position.set(hit.x, hit.y, hit.z);
    }
  };

  const onPointerDown = event => {
    // 首次手势解锁音频（浏览器 autoplay 策略要求）
    if (audio && !audioUnlocked) { audio.unlock(); audioUnlocked = true; }
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
    body.angularDamping = 0.8; // 拖动时更稳，不乱转

    const p = hits[0].point;
    const local = new CANNON.Vec3(p.x, p.y, p.z);
    body.pointToLocalFrame(local, local);

    hand.position.set(p.x, p.y, p.z);
    // maxForce 有限：质量 1.5 + 重力 20（重量 30）时，55 抬得起但有明显滞后 = 重量感
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
    if (joint) {
      world.removeConstraint(joint);
      joint = null;
    }
    if (dragging) {
      dragging.angularDamping = dragging.userData.baseAngularDamping;
      dragging.wakeUp(); // 松手 → 恢复受重力，落下压在别的立方体上
    }
    dragging = null;
    try { canvas.releasePointerCapture(pointerId); } catch (e) { /* 指针已没了 */ }
    pointerId = null;
    canvas.style.cursor = "";
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // —— 滑动声：扫描当前接触，取最大切向相对速度作为滑动强度 ——
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
      // 接触点相对速度：v = vel + angVel × r
      bi.angularVelocity.cross(c.ri, tmpA);
      tmpA.vadd(bi.velocity, tmpA);
      bj.angularVelocity.cross(c.rj, tmpB);
      tmpB.vadd(bj.velocity, tmpB);
      tmpA.vsub(tmpB, relVel);
      // 去掉法向分量，留切向
      const vn = relVel.dot(c.ni);
      relVel.x -= vn * c.ni.x;
      relVel.y -= vn * c.ni.y;
      relVel.z -= vn * c.ni.z;
      const tan = relVel.length();
      if (tan > maxTan) {
        maxTan = tan;
        panX = bi.position.x + c.ri.x;
      }
    }
    const level = THREE.MathUtils.clamp((maxTan - 0.35) / 3.5, 0, 1);
    const halfX = Math.max(extentX / 2, 0.001);
    audio.setSlide(level, Math.max(-1, Math.min(1, panX / halfX)));
  };

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
    world.step(1 / 60, dt, 4);
    reactor.update(dt, time);
    computeSlide();
    for (let i = 0; i < cubes.length; i++) {
      const { mesh, body } = cubes[i];
      mesh.position.set(body.position.x, body.position.y, body.position.z);
      mesh.quaternion.set(body.quaternion.x, body.quaternion.y,
                          body.quaternion.z, body.quaternion.w);
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running || disposed) return;
    running = true;
    last = performance.now();
    if (audio && audioUnlocked) audio.unlock(); // 回到画面时恢复音频
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
    if (audio) audio.suspend();
  };

  if (!layout()) return null;
  populate();
  renderer.render(scene, camera);
  section.classList.add("physical-ready");
  start();

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
      cubes.forEach(({ body }) => body.removeEventListener("collide", onCollide));
      if (audio) audio.dispose();
      reactor.dispose();
      geo.dispose();
      materials.forEach(m => m.dispose());
      envRT.dispose();
      renderer.dispose();
    }
  };
}
