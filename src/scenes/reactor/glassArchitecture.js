// 玻璃砖建筑（GLA-001 / GLA-002 / GLA-003，见 SOURCE_LAB_OPTICS.md §4）。
//
// 资料标签：`SOURCE_ART_DIRECTION` —— 玻璃砖大厅和透明地板承托层是所有者锁定的
// SOURCE 艺术方向，不是 Pavia 的建筑事实（LAB-G02）。
//
//   墙 / 天花：独立玻璃砖单元，有厚度、砖缝、内外表面、折射（transmission）和静态
//              碰撞。实例化 + 合并静态碰撞，不可抓取、不进入自由刚体求解。
//   地板：    独立动态玻璃砖刚体，铺在一层连续、透明、无装饰纹理的结构承托层上；
//             承托层只服务地板砖，不冒充池口安全格栅。
//
// 本模块只产出几何、材质和布局；地板砖的刚体、抓取、耐久和破碎仍由 physicalScene
// 与 glassDamage 统一处理，因此地板砖与格栅玻璃共用同一套系统。

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export const GLASS_ARCH = {
  hallHalf: 22,
  floorTop: -0.06,        // 地板砖顶面（= 操作层地面标高）
  ceilingY: 12.0,
  wallCell: [2.75, 1.5],  // 墙砖单元 [宽, 高]
  wallThickness: 0.32,
  ceilCell: 2.75,
  ceilThickness: 0.30,
  floorCell: 2.4,         // 地板砖格距
  floorBrick: [2.26, 0.26, 2.26],
  joint: 0.05,            // 砖缝
  poolClearR: 6.2,        // 池口/屏蔽体让位半径（地板砖中心不进入）
  supportInnerR: 5.6,     // 透明承托层内边
  supportOuterR: 31.5,    // 覆盖方形大厅四角
  supportThickness: 0.07
};

// 地板砖顶面 = floorTop，砖高 = floorBrick[1]，承托层顶面在其下
GLASS_ARCH.supportTop = GLASS_ARCH.floorTop - GLASS_ARCH.floorBrick[1];

// 规范初始布局：刷新后地板砖必须回到这里（GLA-002）。
// dynamicRadius 之外的格位改用固定实例化玻璃地板（GLA-003 性能档），
// 不把整块地板退化成一个不可移动平面。
export function floorBrickLayout(dynamicRadius = Infinity) {
  const { hallHalf, floorCell, floorTop, floorBrick, poolClearR } = GLASS_ARCH;
  const n = Math.floor((hallHalf * 2) / floorCell);
  const origin = -((n - 1) * floorCell) / 2;
  const dynamic = [];
  const fixed = [];
  const restY = floorTop - floorBrick[1] / 2;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = origin + i * floorCell;
      const z = origin + j * floorCell;
      const r = Math.hypot(x, z);
      if (r < poolClearR) continue;
      (r <= dynamicRadius ? dynamic : fixed).push({ x, y: restY, z });
    }
  }
  return { dynamic, fixed, restY };
}

export function createGlassArchitecture({ reduceMotion, dynamicFloorRadius = Infinity } = {}) {
  const group = new THREE.Group();
  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const {
    hallHalf, floorTop, ceilingY, wallCell, wallThickness, ceilCell, ceilThickness,
    floorBrick, joint, supportInnerR, supportOuterR, supportThickness, supportTop
  } = GLASS_ARCH;

  // ——— 材质 ———
  // 建筑玻璃：真实厚度 + 折射。粗糙度略高于手持玻璃，避免前后层全部糊在一起
  // （SOURCE_LAB_OPTICS §3 LAB-001「必须保持层次」）。
  const archGlass = track(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.085, transmission: 1,
    thickness: wallThickness, ior: 1.52,
    attenuationColor: new THREE.Color(0.62, 0.84, 1.0), attenuationDistance: 3.2,
    specularIntensity: 1, envMapIntensity: 1.15, side: THREE.FrontSide
  }));
  // 地板砖：数量大（数百块独立刚体），改用不走 transmission pass 的透明玻璃，
  // 保留厚度、折射率高光和环境反射（GLA-003 性能边界）。
  const floorGlass = track(new THREE.MeshPhysicalMaterial({
    color: 0xdff0ff, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.42,
    ior: 1.5, specularIntensity: 1, envMapIntensity: 1.6, depthWrite: true,
    clearcoat: 0.6, clearcoatRoughness: 0.08
  }));
  const jointMat = track(new THREE.MeshStandardMaterial({
    color: 0x1b232b, metalness: 0.55, roughness: 0.6
  }));

  const dummy = new THREE.Object3D();
  // name 只用于自动化验收识别射线打到了哪一类建筑玻璃（GLA-001 "墙/天花不可抓取"
  // 必须能证明射线**确实**打在墙砖上而不是打空）；不影响渲染。
  const instanced = (geo, mat, list, rotY = 0, name = "") => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.name = name;
    list.forEach(([x, y, z], i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, rotY, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
    });
    im.instanceMatrix.needsUpdate = true;
    group.add(im);
    return im;
  };

  // ——————————— GLA-001 固定墙玻璃砖 ———————————
  const wallBrickGeo = track(new RoundedBoxGeometry(
    wallCell[0] - joint, wallCell[1] - joint, wallThickness, 2, 0.035));
  const cols = Math.round((hallHalf * 2) / wallCell[0]);
  const rows = Math.ceil((ceilingY - floorTop) / wallCell[1]);
  const wallCounts = [];
  for (let side = 0; side < 4; side++) {
    const list = [];
    for (let r = 0; r < rows; r++) {
      const y = floorTop + (r + 0.5) * wallCell[1];
      if (y > ceilingY - 0.1) continue;
      for (let c = 0; c < cols; c++) {
        const u = -hallHalf + (c + 0.5) * wallCell[0];
        const off = hallHalf - wallThickness / 2;
        if (side === 0) list.push([u, y, -off]);
        else if (side === 1) list.push([u, y, off]);
        else if (side === 2) list.push([-off, y, u]);
        else list.push([off, y, u]);
      }
    }
    instanced(wallBrickGeo, archGlass, list, side >= 2 ? Math.PI / 2 : 0, `GLA-WALL-${side}`);
    wallCounts.push(list.length);
  }
  // 砖缝框架：每面墙的横/竖缝各一根实例化细梁（不是贴图）
  const jointH = track(new THREE.BoxGeometry(hallHalf * 2, joint * 0.9, wallThickness * 0.55));
  const jointV = track(new THREE.BoxGeometry(joint * 0.9, ceilingY - floorTop, wallThickness * 0.55));
  for (let side = 0; side < 4; side++) {
    const hs = [], vs = [];
    for (let r = 0; r <= rows; r++) {
      const y = floorTop + r * wallCell[1];
      if (y > ceilingY) continue;
      hs.push(y);
    }
    const off = hallHalf - wallThickness / 2;
    const axis = side >= 2;
    hs.forEach(y => {
      const m = new THREE.Mesh(jointH, jointMat);
      if (!axis) m.position.set(0, y, side === 0 ? -off : off);
      else { m.position.set(side === 2 ? -off : off, y, 0); m.rotation.y = Math.PI / 2; }
      group.add(m);
    });
    for (let c = 0; c <= cols; c++) {
      const u = -hallHalf + c * wallCell[0];
      vs.push(u);
      const m = new THREE.Mesh(jointV, jointMat);
      m.position.y = floorTop + (ceilingY - floorTop) / 2;
      if (!axis) m.position.set(u, m.position.y, side === 0 ? -off : off);
      else { m.position.set(side === 2 ? -off : off, m.position.y, u); m.rotation.y = Math.PI / 2; }
      group.add(m);
    }
  }

  // ——————————— GLA-001 固定天花玻璃砖 ———————————
  const ceilBrickGeo = track(new RoundedBoxGeometry(
    ceilCell - joint, ceilThickness, ceilCell - joint, 2, 0.035));
  const cn = Math.round((hallHalf * 2) / ceilCell);
  const ceilList = [];
  for (let j = 0; j < cn; j++) {
    for (let i = 0; i < cn; i++) {
      ceilList.push([
        -hallHalf + (i + 0.5) * ceilCell,
        ceilingY - ceilThickness / 2,
        -hallHalf + (j + 0.5) * ceilCell
      ]);
    }
  }
  instanced(ceilBrickGeo, archGlass, ceilList, 0, "GLA-CEILING");
  // 天花砖缝网格
  const ceilJointX = track(new THREE.BoxGeometry(hallHalf * 2, ceilThickness * 0.5, joint * 0.9));
  for (let i = 0; i <= cn; i++) {
    const u = -hallHalf + i * ceilCell;
    const a = new THREE.Mesh(ceilJointX, jointMat);
    a.position.set(0, ceilingY - ceilThickness / 2, u);
    group.add(a);
    const b = new THREE.Mesh(ceilJointX, jointMat);
    b.position.set(u, ceilingY - ceilThickness / 2, 0);
    b.rotation.y = Math.PI / 2;
    group.add(b);
  }

  // ——————————— GLA-002 透明结构承托层 ———————————
  // 连续、无装饰纹理、只承托地板砖。相机不受它阻挡（观察相机不参与碰撞）。
  const supportMat = track(new THREE.MeshPhysicalMaterial({
    color: 0xbfe4ff, metalness: 0, roughness: 0.12, transparent: true, opacity: 0.16,
    ior: 1.48, side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 0.9
  }));
  const supportGeo = track(new THREE.RingGeometry(supportInnerR, supportOuterR, 96, 1));
  [supportTop, supportTop - supportThickness].forEach(y => {
    const plate = new THREE.Mesh(supportGeo, supportMat);
    plate.name = "GLA-FLOOR-SUPPORT";
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = y;
    group.add(plate);
  });
  const supportRim = new THREE.Mesh(
    track(new THREE.CylinderGeometry(supportInnerR, supportInnerR, supportThickness, 96, 1, true)), supportMat);
  supportRim.position.y = supportTop - supportThickness / 2;
  group.add(supportRim);

  // ——————————— GLA-002/GLA-003 地板砖 ———————————
  const layout = floorBrickLayout(dynamicFloorRadius);
  const floorBrickGeo = track(new RoundedBoxGeometry(
    floorBrick[0], floorBrick[1], floorBrick[2], 2, 0.03));
  // 性能档之外的固定地板砖（同一几何/材质，静态实例化，不可抓取）
  if (layout.fixed.length) {
    instanced(floorBrickGeo, floorGlass, layout.fixed.map(p => [p.x, p.y, p.z]), 0, "GLA-FLOOR-FIXED");
  }

  function update() { /* 建筑玻璃是固定结构：没有状态驱动的运动 */ }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  return {
    group, update, dispose,
    floorBrickGeometry: floorBrickGeo,
    floorGlassMaterial: floorGlass,
    layout,
    counts: {
      wall: wallCounts.reduce((a, b) => a + b, 0),
      ceiling: ceilList.length,
      floorDynamic: layout.dynamic.length,
      floorFixed: layout.fixed.length
    },
    reduceMotion: !!reduceMotion
  };
}
