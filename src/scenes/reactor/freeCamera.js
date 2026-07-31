// 统一自由观察相机（CAM-001 / CAM-002 / CAM-003，见 SOURCE_LAB_OPTICS.md §5）。
//
// 资料标签：`SOURCE_ART_DIRECTION` —— 可穿越水面、地板与设备的观察相机是所有者锁定
// 的 SOURCE 方向，不是运行人员在 Pavia 的真实视点。
//
// 只有一套状态（pivot + yaw + pitch + distance），三种输入方式都改写这同一套状态，
// 因此不存在"两个相机互相打架"：
//
//   camera.position = pivot - forward(yaw, pitch) * distance
//   forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))
//
//   - 右键按下 → beginOrbit() 从画面中心命中/回退焦点锁定本次 pivot；
//     右键拖动 → 改 yaw/pitch（绕锁定的 pivot 旋转，pivot 本身不跟随鼠标）；
//   - 中键拖动 → 沿相机右/上方向平移 pivot；
//   - 滚轮     → zoom() 只设定目标距离；tick() 每帧无过冲阻尼收敛，顶到最近距离后
//                继续推进时把剩余量转成 pivot 的连续前移（同样按帧率无关阻尼消耗）；
//   - 方向键   → panKeys() 按当前画面 up/right 对 pivot 做时间积分平移；
//   - goHome() → 回到 layout() 记录的规范初始取景（非文字的快速复位动作）。
//
// 相机不参与刚体求解（这里只写 camera.position/quaternion，从不建刚体），因此
// 不会推动玻璃、设备或水体（CAM-002）。W/S/A/D/Q/E 不再是相机的基础输入方案——
// 那六个键现在完全交给抓取中的玻璃（见 physicalScene.js 的 GLA-CTRL-003）。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

// 可达空间（CAM-002）：覆盖玻璃大厅（半宽 22）、天花之上一点点、以及地下设备层
// （UNDERGROUND_BOUNDS.floor = -9.2）之下的检修空间。不再有围绕池口的方位/仰角/
// 距离硬限位——这里只有一个"别飞到无穷远"的世界包围盒。
export const CAM_LIMITS = {
  worldHalf: 40,
  minY: -11.5,
  maxY: 15.6,
  // 近裁剪面要允许贴近小型部件（螺栓、仪表针）而不穿模；far/near = 8000 在 24 位
  // 深度缓冲下仍可用（three 默认对数深度关闭），实测大厅内无明显 z-fighting。
  near: 0.04,
  far: 320,
  minDistance: 0.08,
  maxDistance: 64,
  maxPitch: (88 * Math.PI) / 180
};

export const CAM_INPUT = {
  // 所有者锁定值（.agent/next-task.md）：300 CSS px 横向拖动 → 约 0.54 rad。
  orbitSpeed: 0.0018,      // 弧度/像素
  panSpeed: 1.0,           // 中键拖拽：与旧实现一致的屏幕空间平移系数
  // 滚轮：先在 physicalScene 里按 deltaMode 归一化到"像素等效"，这里再做单事件
  // 限幅 + 指数缩放系数，两道限幅共同保证一次普通滚轮 ≤ 8% 的目标距离变化。
  zoomSpeed: 0.00064,       // ln(factor) 每像素等效 delta
  wheelMaxDelta: 120,       // 单事件像素等效上限
  zoomDamping: 14,          // 1/s，指数收敛速率（帧率无关、无过冲）
  // 世界步长的参考尺度下限（米）。纯几何缩放的步长正比于当前距离，顶到
  // minDistance = 0.08 后每格滚轮只剩约 6 mm——浏览器实测从池面推到地下设备层
  // 需要上千格，等于"到不了"。步长改用 max(targetDistance, dollyFloor) 作尺度：
  // 远处仍是熟悉的按比例缩放（规范机位一格 6.2%，满足 ≤8%），贴近后步长落在
  // 约 0.37 m/格，推进与退出都保持可用且连续（CAM-001A / CAM-002）。
  dollyFloor: 6,
  // 方向键平移：世界速度随当前轨道距离缩放，使近距离/远距离下的屏幕观感一致。
  panKeySpeed: 5.5,
  panKeyRefDistance: 10,
  panKeySpeedMin: 0.15,
  panKeySpeedMax: 4
};

// 规范初始取景的距离（CAM-002）。
//
// 纯几何 fit 距离在竖直窄视口上会失控：halfH 随宽高比一起变小，`radiusH / sin(halfH)`
// 因此暴涨——1440×900 是 16.56，768×1024 已是 18.78，390×844 到 29.44。按 40° 仰角
// 换算，后两者的初始机位分别落在 y=12.37 和 y=19.2（钳到 15.6，z=22.55）：一个在
// 12.0 的玻璃天花板之上，一个直接在 22 的玻璃墙之外。初始画面于是只剩两块贴脸折射
// 的玻璃砖，看不到反应堆池。
//
// 初始机位必须留在玻璃建筑内部，所以在纯几何 fit 之外再按大厅净空反解两个上限。
// 窄视口宁可裁掉两侧，也不出屋——用户随时可以滚轮拉远。
export function homeFitDistance({
  aspect, fovDeg, radiusV, radiusH, elevationDeg, targetY, ceilingLimitY, wallLimit
}) {
  const halfV = (fovDeg * Math.PI) / 360;
  const halfH = Math.atan(Math.tan(halfV) * aspect);
  const fit = Math.max(radiusV / Math.sin(halfV), radiusH / Math.sin(halfH));
  const elev = (elevationDeg * Math.PI) / 180;
  return Math.min(
    fit,
    (ceilingLimitY - targetY) / Math.sin(elev),  // 机位高度不得顶到天花板玻璃
    wallLimit / Math.cos(elev)                   // 机位纵深不得穿出墙玻璃
  );
}

// 世界包围盒钳制：pivot 与相机位置都必须留在可达空间内。
function clampToWorld(v) {
  const h = CAM_LIMITS.worldHalf;
  v.x = clamp(v.x, -h, h);
  v.z = clamp(v.z, -h, h);
  v.y = clamp(v.y, CAM_LIMITS.minY, CAM_LIMITS.maxY);
  return v;
}

export function createFreeCamera({ camera }) {
  const pivot = new THREE.Vector3(0, 0.3, 0);
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Vector3();

  const rig = {
    yaw: 0,
    pitch: -(40 * Math.PI) / 180,   // 负 = 俯视（与旧轨道机位的 40° 仰角一致）
    distance: 14,
    targetDistance: 14,   // 滚轮设定的目标，tick() 阻尼收敛到这里（无过冲）
    pushBudget: 0          // 顶到 minDistance 后仍要推进的余量，tick() 逐帧消耗
  };
  const home = { pivot: pivot.clone(), yaw: rig.yaw, pitch: rig.pitch, distance: rig.distance };

  function basis() {
    const cp = Math.cos(rig.pitch);
    forward.set(-Math.sin(rig.yaw) * cp, Math.sin(rig.pitch), -Math.cos(rig.yaw) * cp).normalize();
    right.crossVectors(forward, WORLD_UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0); // 正俯视时右向量退化，取世界 X
    right.normalize();
    up.crossVectors(right, forward).normalize();
  }

  function apply() {
    rig.pitch = clamp(rig.pitch, -CAM_LIMITS.maxPitch, CAM_LIMITS.maxPitch);
    rig.distance = clamp(rig.distance, CAM_LIMITS.minDistance, CAM_LIMITS.maxDistance);
    basis();
    camera.position.copy(pivot).addScaledVector(forward, -rig.distance);
    // 世界包围盒钳制作用在**相机**上（不是 pivot）：否则一个 14 米的轨道半径会让
    // 相机永远停在盒底以上 14 米，进不了水下和地下（CAM-002）。钳完再把 pivot 拉回
    // 到相机前方 distance 处，rig 三个量与实际机位始终自洽。
    clampToWorld(camera.position);
    pivot.copy(camera.position).addScaledVector(forward, rig.distance);
    camera.up.copy(WORLD_UP);
    camera.lookAt(pivot);
  }

  return {
    rig,
    pivot,
    apply,
    forward,

    // 右键按下时调用一次：命中点（画面中心射线的第一有效命中）成为本次拖动的固定
    // 焦点；没有命中时保留当前 pivot/distance——这本身就是"沿视线、按既有焦距"的
    // 稳定虚拟焦点（CAM-001），不需要另外构造。
    //
    // 焦点沿**当前视线**重建（而不是直接 copy(hitPoint)）：命中距离超过
    // maxDistance 时 rig.distance 会被钳住，若 pivot 仍留在原命中点，apply() 里
    // `pivot - forward*distance` 就会把相机往前搬——右键一按下画面就跳。沿视线
    // 重建后，距离在量程内时结果与命中点完全相同，超量程时也只是焦点更近，
    // 机位纹丝不动（CAM-001「不得漂移、跳换」）。
    beginOrbit(hitPoint) {
      if (hitPoint) {
        const dist = camera.position.distanceTo(hitPoint);
        if (dist > 1e-4) {
          rig.distance = clamp(dist, CAM_LIMITS.minDistance, CAM_LIMITS.maxDistance);
          rig.targetDistance = rig.distance;
          rig.pushBudget = 0;
          basis();
          pivot.copy(camera.position).addScaledVector(forward, rig.distance);
        }
      }
      apply();
    },

    // 右键拖动：绕当前锁定的 pivot 转动 yaw/pitch，pivot 本身不重新拾取、不漂移。
    orbit(dx, dy) {
      rig.yaw -= dx * CAM_INPUT.orbitSpeed;
      rig.pitch -= dy * CAM_INPUT.orbitSpeed;
      apply();
    },

    // 中键平移：位移量与距离成比例，屏幕上的拖动感与缩放无关
    pan(dx, dy, viewportHeight) {
      basis();
      const k = (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(rig.distance, 0.5))
        / Math.max(viewportHeight, 1) * CAM_INPUT.panSpeed;
      pivot.addScaledVector(right, -dx * k);
      pivot.addScaledVector(up, dy * k);
      apply();
    },

    // 方向键平移：沿**当前画面**的 up/right（不是固定世界 X/Z），按 dt 积分，斜向
    // 组合归一化。dirs = { up, down, left, right }（布尔）。返回是否真的移动了。
    panKeys(dt, dirs) {
      if (!dirs) return false;
      const x = (dirs.right ? 1 : 0) - (dirs.left ? 1 : 0);
      const y = (dirs.up ? 1 : 0) - (dirs.down ? 1 : 0);
      if (!x && !y) return false;
      basis();
      const scale = clamp(
        rig.distance / CAM_INPUT.panKeyRefDistance,
        CAM_INPUT.panKeySpeedMin, CAM_INPUT.panKeySpeedMax);
      const speed = CAM_INPUT.panKeySpeed * scale * dt;
      tmp.set(0, 0, 0).addScaledVector(right, x).addScaledVector(up, y);
      if (tmp.lengthSq() > 1e-9) pivot.addScaledVector(tmp.normalize(), speed);
      apply();
      return true;
    },

    // 滚轮：只设定目标距离（单事件限幅，≤ 8% 的目标变化），不直接搬动相机——
    // 实际机位由 tick() 每帧阻尼收敛，因此天然无过冲、连续单调。
    zoom(deltaPxEquivalent) {
      const d = clamp(deltaPxEquivalent, -CAM_INPUT.wheelMaxDelta, CAM_INPUT.wheelMaxDelta);
      const factor = Math.exp(d * CAM_INPUT.zoomSpeed);
      // 步长 = (factor - 1) × 尺度。尺度取 max(当前目标距离, dollyFloor)：距离大时
      // 等价于旧的 `target *= factor`（同样的 6.2%/格），距离趋近 0 时不再退化成
      // 毫米级步长，因此贴近堆芯后仍能连续推进和退出。
      const scale = Math.max(rig.targetDistance, CAM_INPUT.dollyFloor);
      let target = rig.targetDistance + (factor - 1) * scale;
      if (target < CAM_LIMITS.minDistance) {
        // 顶到最近距离后继续推进：差额记入 pushBudget，tick() 里逐帧把它转成
        // pivot 的连续前移，而不是这里就地跳变 pivot（CAM-001A）。
        rig.pushBudget += (CAM_LIMITS.minDistance - target);
        target = CAM_LIMITS.minDistance;
      }
      rig.targetDistance = clamp(target, CAM_LIMITS.minDistance, CAM_LIMITS.maxDistance);
    },

    // 每帧调用一次：把 rig.distance 阻尼收敛到 rig.targetDistance，并消耗
    // pushBudget（推进 pivot）。frame-rate 无关（用 1 - e^-k·dt），无过冲。
    tick(dt) {
      const t = 1 - Math.exp(-CAM_INPUT.zoomDamping * Math.max(dt, 0));
      const diff = rig.targetDistance - rig.distance;
      if (Math.abs(diff) > 1e-6) {
        rig.distance = clamp(rig.distance + diff * t, CAM_LIMITS.minDistance, CAM_LIMITS.maxDistance);
      } else {
        rig.distance = rig.targetDistance;
      }
      if (rig.pushBudget > 1e-6) {
        const move = rig.pushBudget * t;
        basis();
        // camera.position = pivot - forward*distance；distance 顶在 minDistance 不变，
        // 所以要让相机沿视线继续前移，必须把 pivot 也沿 +forward 推进同样的量。
        pivot.addScaledVector(forward, move);
        rig.pushBudget -= move;
        if (rig.pushBudget < 1e-5) rig.pushBudget = 0;
      }
      apply();
    },

    // 规范初始取景：layout() 首帧算出 fit 距离后调用一次
    setHome(next) {
      if (next.pivot) home.pivot.copy(next.pivot);
      if (typeof next.yaw === "number") home.yaw = next.yaw;
      if (typeof next.pitch === "number") home.pitch = next.pitch;
      if (typeof next.distance === "number") home.distance = next.distance;
    },
    goHome() {
      pivot.copy(home.pivot);
      rig.yaw = home.yaw;
      rig.pitch = home.pitch;
      rig.distance = home.distance;
      rig.targetDistance = home.distance;
      rig.pushBudget = 0;
      apply();
    },
    isHome() {
      return Math.abs(rig.distance - home.distance) < 1e-3
        && Math.abs(rig.yaw - home.yaw) < 1e-3
        && Math.abs(rig.pitch - home.pitch) < 1e-3
        && pivot.distanceTo(home.pivot) < 1e-3;
    },

    snapshot() {
      return {
        yaw: +rig.yaw.toFixed(4),
        pitch: +rig.pitch.toFixed(4),
        dist: +rig.distance.toFixed(3),
        distTarget: +rig.targetDistance.toFixed(3),
        pivot: [+pivot.x.toFixed(2), +pivot.y.toFixed(2), +pivot.z.toFixed(2)],
        pos: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)]
      };
    }
  };
}
