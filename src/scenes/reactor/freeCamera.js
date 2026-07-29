// 统一自由观察相机（CAM-001 / CAM-002 / CAM-003，见 SOURCE_LAB_OPTICS.md §5）。
//
// 资料标签：`SOURCE_ART_DIRECTION` —— 可穿越水面、地板与设备的观察相机是所有者锁定
// 的 SOURCE 方向，不是运行人员在 Pavia 的真实视点。
//
// 只有一套状态（pivot + yaw + pitch + distance），轨道观察与自由飞行是同一套状态的
// 两种输入方式，因此可以在任何时刻连续切换，不存在"两个相机互相打架"：
//
//   camera.position = pivot - forward(yaw, pitch) * distance
//   forward = (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))
//
//   - 右键拖动 → 改 yaw/pitch（绕 pivot 旋转）；
//   - 中键拖动 → 沿相机右/上方向平移 pivot；
//   - 滚轮     → 连续改 distance；顶到最近距离后继续推进 pivot（可飞进堆芯附近）；
//   - W/S/A/D/Q/E → 沿相机基与世界竖直轴推进 pivot（自由飞行），Shift 只是速度倍率；
//   - goHome() → 回到 layout() 记录的规范初始取景（非文字的快速复位动作）。
//
// 相机不参与刚体求解（这里只写 camera.position/quaternion，从不建刚体），因此
// 不会推动玻璃、设备或水体（CAM-002）。

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
  orbitSpeed: 0.006,   // 弧度/像素
  zoomSpeed: 0.0012,   // 每单位 wheel delta 的对数缩放系数
  flySpeed: 6.5,       // 世界单位/秒
  flyBoost: 3.4,       // Shift 倍率（只改速度，不改物理时间）
  panSpeed: 1.0
};

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
    distance: 14
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

    // 连续缩放：顶到最近距离后把剩余的推进量转成 pivot 前移，因此可以一路推到
    // 堆芯附近或穿过水面，而不是卡在一个最小轨道半径上（CAM-002）。
    zoom(deltaY) {
      const factor = Math.exp(deltaY * CAM_INPUT.zoomSpeed);
      const wanted = rig.distance * factor;
      if (wanted < CAM_LIMITS.minDistance) {
        basis();
        pivot.addScaledVector(forward, (CAM_LIMITS.minDistance - wanted) * 4);
        rig.distance = CAM_LIMITS.minDistance;
      } else {
        rig.distance = Math.min(wanted, CAM_LIMITS.maxDistance);
      }
      apply();
    },

    // 自由飞行：keys 是当前按下的键集合（小写）。返回是否真的移动了。
    fly(dt, keys, boost) {
      if (!keys || keys.size === 0) return false;
      const f = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
      const r = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
      const u = (keys.has("e") ? 1 : 0) - (keys.has("q") ? 1 : 0);
      if (!f && !r && !u) return false;
      basis();
      const speed = CAM_INPUT.flySpeed * (boost ? CAM_INPUT.flyBoost : 1) * dt;
      tmp.set(0, 0, 0)
        .addScaledVector(forward, f)
        .addScaledVector(right, r)
        .addScaledVector(WORLD_UP, u);
      if (tmp.lengthSq() > 1e-9) pivot.addScaledVector(tmp.normalize(), speed);
      apply();
      return true;
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
        pivot: [+pivot.x.toFixed(2), +pivot.y.toFixed(2), +pivot.z.toFixed(2)],
        pos: [+camera.position.x.toFixed(2), +camera.position.y.toFixed(2), +camera.position.z.toFixed(2)]
      };
    }
  };
}
