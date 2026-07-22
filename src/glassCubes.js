// 第一页表层：一个个**独立的**玻璃立方体。
//
// 为什么推翻了原来的做法：之前玻璃是在反应堆那张全屏 shader 里用屏幕空间分格
// "划分"出来的——在一整块画面上画格子，不管怎么调折射、倒角、压花，都得不到
// 一个个真正的物体，因为画面里根本不存在物体。现在每个立方体是：
//   · 一个真实的三维网格（BoxGeometry），有确切的体积和六个面；
//   · 一个真实的刚体（cannon-es Box），有质量、碰撞、重力、摩擦；
//   · 可以被鼠标抓起、拖到任意位置、松手后落下并压在别的立方体上。
// 折射由 MeshPhysicalMaterial 的 transmission 真实计算，不是贴图或屏幕空间近似。
//
// 池底那块平面用的是和 reactorScene.js 同一份 shader（reactorShader.js），
// 所以玻璃层接管画面时不会跳色。
//
// 已知限制：Three.js 的 transmission 只采样**不透明**物体的那一遍渲染，
// 因此玻璃透过玻璃看不到后面那块玻璃。单层平铺时几乎看不出来；叠高后
// 上面那块会直接看到池底而不是下面那块玻璃。要根治得自己写光线追踪，
// 那是另一个量级的工程，先按当前方案跑起来看观感。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import * as CANNON from "cannon-es";
import { REACTOR_GLSL } from "./reactorShader.js";

const CUBE = 1;                 // 立方体边长（世界单位），所有尺寸都以它为基准
// 长焦俯视。用 42° 这种"正常"视角时相机离得太近，画面边缘的方块几乎整个侧面
// 都露出来，读成一堆乱翻的盒子而不是"平铺的一层玻璃砖"。
// 压到 22° 相当于把相机架高、拉远：仍然能看出是正方体（棱边和侧面还在），
// 但整层重新读成俯视的一个平面。
const FOV = 22;
const LIFT_Y = 2.6;             // 拖动时立方体被提到的高度：高过任何堆叠，方便放置
const MAX_DPR = 1.5;

const POOL_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// 池面平面的片元着色器。注意最后要把颜色从"显示空间"转回线性空间：
// poolColor() 返回的是已经压过光、带过 gamma 的成品色（和原生 WebGL 那版一致），
// 而 Three.js 在输出时还会再做一次 linear→sRGB。不转回去就会被二次提亮，
// 玻璃层一接管画面就整体发灰变亮。
const POOL_FRAG = `
precision highp float;
uniform float uTime;
uniform vec2 uExtent;   // 这块平面自身在世界里的尺寸（比可见范围大一圈）
uniform vec2 uView;     // 相机实际看得见的范围，暗角按它算
uniform float uShort;   // 可见范围的短边，场景坐标以它为 1
varying vec2 vUv;

${REACTOR_GLSL}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

void main() {
  // 还原成 reactorScene 里那套"画面中心为原点、短边 = 1、y 向上"的场景坐标。
  // 平面绕 X 转了 -90°，它的局部 +y 对应世界 -Z，而相机 up 也是 -Z，
  // 所以局部 y 正好就是屏幕上的"上"，和原版的 sp.y 一致。
  vec2 p = (vUv - 0.5) * uExtent;
  vec2 sp = p / uShort;

  vec3 col = poolColor(sp, uTime);

  // 暗角：和原生 WebGL 版同一条曲线（那边 vc 是按整幅画面归一化的，范围 ±0.5）
  col *= 1.0 - smoothstep(0.35, 0.78, length(p / uView)) * 0.50;

  gl_FragColor = vec4(srgbToLinear(clamp(col, 0.0, 1.0)), 1.0);
}`;

// 环境贴图：本场景的光源在**下方**（发光的重水池），上方几乎全黑。
// 玻璃的立体感几乎全靠环境反射，给错方向就会看着像塑料——所以这张图
// 下半球是池子的蓝辉光，上半球接近全黑，只留两处很小的亮斑给棱边高光抓。
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

export function createGlassCubes({ section, canvas, reduceMotion }) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (err) {
    console.error("glassCubes: renderer unavailable", err);
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
  renderer.setClearColor(0x02070f, 1);
  renderer.toneMapping = THREE.NoToneMapping; // 池面色已经压过光，不能再压一次
  if ("transmissionResolutionScale" in renderer) {
    renderer.transmissionResolutionScale = 0.5; // 折射用的那张离屏图可以低一半分辨率
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 200);
  // 正上方俯视：屏幕的"上"对应世界的 -Z
  camera.up.set(0, 0, -1);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envSrc = buildEnvTexture();
  const envRT = pmrem.fromEquirectangular(envSrc);
  scene.environment = envRT.texture;
  envSrc.dispose();
  pmrem.dispose();

  // 一盏定向光，给玻璃棱边一道明确的锐利高光（纯环境反射会偏柔）
  const key = new THREE.DirectionalLight(0xdceeff, 1.5);
  key.position.set(-4, 7, -3);
  scene.add(key);

  // —— 池底平面 ——
  const poolMat = new THREE.ShaderMaterial({
    vertexShader: POOL_VERT,
    fragmentShader: POOL_FRAG,
    uniforms: {
      uTime: { value: 7.0 },
      uExtent: { value: new THREE.Vector2(1, 1) },
      uView: { value: new THREE.Vector2(1, 1) },
      uShort: { value: 1 }
    }
  });
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), poolMat);
  pool.rotation.x = -Math.PI / 2; // 平放在 XZ 平面
  scene.add(pool);

  // —— 物理世界 ——
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -14, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  const glassPhys = new CANNON.Material("glass");
  world.addContactMaterial(new CANNON.ContactMaterial(glassPhys, glassPhys, {
    friction: 0.32,     // 玻璃之间很滑，但要能堆得住
    restitution: 0.06   // 几乎不弹：厚玻璃砸在玻璃上是"闷"的
  }));
  world.defaultContactMaterial.friction = 0.32;
  world.defaultContactMaterial.restitution = 0.06;

  const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane(), material: glassPhys });
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(ground);

  // 四面看不见的墙，把立方体关在画面里。要够高：入场时它们是从画面上方落下来的，
  // 墙比落点矮的话，砖会从墙头飞出画面。
  const walls = [];
  for (let i = 0; i < 4; i++) {
    const body = new CANNON.Body({ mass: 0, material: glassPhys });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.5, 14, 0.5)));
    world.addBody(body);
    walls.push(body);
  }

  // 拖动用的"手"：一个不参与碰撞的静态点，通过点对点约束把立方体吊起来。
  // 用约束而不是直接设坐标，立方体才会在手上摆动、并能推开挡路的邻居——
  // 这就是"物理特性"该有的手感。
  const hand = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Sphere(0.05),
    collisionFilterGroup: 0,
    collisionFilterMask: 0
  });
  world.addBody(hand);

  // —— 立方体 ——
  // 棱边要略微倒圆：现实里没有数学意义上的尖棱，而玻璃的棱边正是高光最集中的地方。
  // 纯 BoxGeometry 的绝对尖棱在渲染里一眼就假。
  const geo = new RoundedBoxGeometry(CUBE, CUBE, CUBE, 4, 0.05);

  // 几种材质变体：真实的玻璃砖是分批浇铸的，块与块之间的清澈度和料色略有差别
  const materials = [0, 1, 2, 3].map(i => new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.015 + i * 0.012,
    transmission: 1,
    thickness: CUBE * (0.85 + i * 0.08),
    ior: 1.52,
    // 厚玻璃的体吸收：光在玻璃里走得越长颜色越浓，这是"有体积"最好认的证据。
    // 但衰减距离给太短会把方块染成实心蓝，反而像有色塑料——玻璃首先得是**清**的。
    attenuationColor: new THREE.Color(0.62, 0.86, 1.0),
    attenuationDistance: 7.0 + i * 1.5,
    // 不加 clearcoat：清漆层是塑料/车漆的特征，玻璃表面就是玻璃本身，
    // 多一层清漆只会糊上一层塑料味的柔光。
    specularIntensity: 1,
    envMapIntensity: 1.25
  }));

  const cubes = [];   // { mesh, body }
  const meshes = [];

  const addCube = (x, y, z, matIndex) => {
    const mesh = new THREE.Mesh(geo, materials[matIndex % materials.length]);
    scene.add(mesh);
    const body = new CANNON.Body({
      mass: 1.1,
      material: glassPhys,
      shape: new CANNON.Box(new CANNON.Vec3(CUBE / 2, CUBE / 2, CUBE / 2)),
      position: new CANNON.Vec3(x, y, z),
      linearDamping: 0.10,
      angularDamping: 0.22,
      sleepSpeedLimit: 0.12,
      sleepTimeLimit: 0.6
    });
    world.addBody(body);
    cubes.push({ mesh, body });
    meshes.push(mesh);
    mesh.userData.body = body;
  };

  // —— 尺寸 / 布局 ——
  let extentX = 10;
  let extentZ = 6;

  const layout = () => {
    const cssW = canvas.clientWidth || section.clientWidth;
    const cssH = canvas.clientHeight || section.clientHeight;
    if (!cssW || !cssH) return false;

    renderer.setSize(cssW, cssH, false);
    camera.aspect = cssW / cssH;

    // 短边上要排几块砖 —— 决定了立方体在画面里的大小
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

    const planeW = extentX * 1.6;
    const planeH = extentZ * 1.6;
    pool.scale.set(planeW, planeH, 1); // 比可见范围大一圈，避免边缘露空
    poolMat.uniforms.uExtent.value.set(planeW, planeH);
    poolMat.uniforms.uView.value.set(extentX, extentZ);
    poolMat.uniforms.uShort.value = shortExtent;

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

  // 初始铺一层。每块砖**正对着自己那格的正上方**落下，落差很小、按离画面中心的
  // 距离错开时间——这样它们会各就各位地铺成一层。
  // （第一版让它们从很高的随机位置乱落，而可见范围又恰好只装得下这么多块，
  //   结果互相砸中、彼此卡住，堆成一团乱翻的盒子，完全不是"一层"。）
  const GAP = 1.02; // 每格比砖略宽一点，落定后不会互相挤着抖；再宽砖缝就明显了
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

  // 把屏幕位置投到 y = LIFT_Y 的水平面上：拖动时立方体悬在所有堆叠之上
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LIFT_Y);
  const hit = new THREE.Vector3();

  const moveHand = () => {
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(dragPlane, hit)) {
      hand.position.set(hit.x, hit.y, hit.z);
    }
  };

  const onPointerDown = event => {
    if (pointerId !== null) return;
    setNdc(event);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return;

    const body = hits[0].object.userData.body;
    pointerId = event.pointerId;
    // 指针捕获失败不该让整个拖拽功能挂掉（合成事件、指针中途被系统收走都会抛）
    try { canvas.setPointerCapture(pointerId); } catch (e) { /* 没捕获也能拖，只是移出画布会断 */ }
    dragging = body;
    body.wakeUp();

    // 抓在实际点击到的那个点上，而不是几何中心——这样立方体会自然地歪着被提起来
    const p = hits[0].point;
    const local = new CANNON.Vec3(p.x, p.y, p.z);
    body.pointToLocalFrame(local, local);

    hand.position.set(p.x, p.y, p.z);
    joint = new CANNON.PointToPointConstraint(body, local, hand, new CANNON.Vec3(0, 0, 0), 60);
    world.addConstraint(joint);
    canvas.style.cursor = "grabbing";
    moveHand();
  };

  const onPointerMove = event => {
    if (pointerId === null) {
      // 悬停在立方体上时给个"可抓"的指针
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
    if (dragging) dragging.wakeUp();  // 松手 → 恢复受重力，落下并压在别的立方体上
    dragging = null;
    try { canvas.releasePointerCapture(pointerId); } catch (e) { /* 指针已经没了 */ }
    pointerId = null;
    canvas.style.cursor = "";
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

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
    if (!reduceMotion) {
      time += dt;
      poolMat.uniforms.uTime.value = time;
    }
    world.step(1 / 60, dt, 3);
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
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  if (!layout()) return null;
  populate();
  renderer.render(scene, camera);
  section.classList.add("glass-ready");
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
    section.classList.remove("glass-ready");
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
      geo.dispose();
      materials.forEach(m => m.dispose());
      poolMat.dispose();
      pool.geometry.dispose();
      envRT.dispose();
      renderer.dispose();
    }
  };
}
