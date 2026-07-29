// AUTO 连续运行控制台（CTL-002 / CTL-003，见 SOURCE_LAB_OPTICS.md §9）。
//
// 资料标签：General Atomics「Complete Control Systems」支持研究堆同时具有人工与
// 自动控制以及独立的仪控子系统；本台的**无文字双实体布局**是项目决定
// （`SOURCE_ART_DIRECTION`），不宣称复制 Pavia 当前控制室。
//
// 与 MANUAL 台的关系：
//   - 物理上是独立的立式仪控柜（不是同一张斜面操作台），几何、控件和指示都不同；
//   - 只调用**同一个** sessionController 的共享命令，不建立第二套反应堆状态；
//   - 控制权互斥由 sessionController 唯一裁决：本台的 AUTO 方钮请求把控制权交给
//     自动程序，任何人工控件（含本台的安全返回红钮）都会原位接管为 MANUAL；
//   - 完整 AUTO 程序的重入只能从本台的 AUTO 方钮发起（SOURCE_LAB_OPTICS §9 CTL-002），
//     因此该控件从 MANUAL 台迁到这里；MANUAL 台的全部**人工指令**一个都没减少。
//
// 无文字表达：立柱形阶段塔（八段，自下而上点亮）、棒位三条竖表、功率横表、
// 冷却流量转盘、联锁灯组、控制权双灯。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

const COL = {
  auto: 0x4d8dff, manual: 0xe8eef5, scram: 0xff2a2a, ready: 0x33dd66,
  pump: 0x27c6e0, pulse: 0xffa61f, bay: 0x232a31, frame: 0x141a1f, bezel: 0x0b0e11,
  SHIM: 0x6f9ad6, REG: 0x35c9a8, TRANS: 0xff8a3a, lampOff: 0x1d2328
};

export const AUTO_PHASE_ORDER = [
  "INTERLOCKED_RESET", "AUXILIARIES_READY", "LOW_POWER_APPROACH", "PULSE_ARMED",
  "PULSE", "POST_PULSE_HEAT_TRANSFER", "STEADY_POWER_ASCENT", "FULL_POWER_EQUILIBRIUM"
];

export function createAutoConsole({ commands, position = [4.6, 0, 6.4], facing = -0.32, reduceMotion } = {}) {
  const group = new THREE.Group();
  group.position.set(position[0], position[1], position[2]);
  group.rotation.y = facing;

  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const mat = (color, opts = {}) => track(new THREE.MeshStandardMaterial(Object.assign({
    color, metalness: 0.35, roughness: 0.5
  }, opts)));
  const emissiveMat = (color, intensity = 0) => track(new THREE.MeshStandardMaterial({
    color: COL.lampOff, emissive: color, emissiveIntensity: intensity, roughness: 0.35, metalness: 0.2
  }));

  const hotspots = [];
  const addHotspot = (mesh, kind, name, press, release) => {
    mesh.userData.hotspot = true;
    hotspots.push({ mesh, kind, name, press, release: release || (() => {}) });
  };

  // —— 柜体：立式仪控柜（与 MANUAL 的斜面操作台在形体上就能分辨）——
  const BAY_W = 1.75, BAY_H = 2.15, BAY_D = 0.78;
  const bay = new THREE.Mesh(track(new THREE.BoxGeometry(BAY_W, BAY_H, BAY_D)), mat(COL.frame, { roughness: 0.7 }));
  bay.position.set(0, BAY_H / 2, 0);
  group.add(bay);
  // 前面板略微内凹，四周有柜框（真实机柜的门框关系，不是一块贴图）
  const face = new THREE.Mesh(track(new THREE.BoxGeometry(BAY_W - 0.16, BAY_H - 0.22, 0.05)), mat(COL.bay, { roughness: 0.45 }));
  face.position.set(0, BAY_H / 2 + 0.02, BAY_D / 2 - 0.015);
  group.add(face);
  // 柜顶通风罩 + 底座
  const cap = new THREE.Mesh(track(new THREE.BoxGeometry(BAY_W + 0.08, 0.1, BAY_D + 0.08)), mat(0x1a2026));
  cap.position.set(0, BAY_H + 0.05, 0);
  group.add(cap);
  const plinth = new THREE.Mesh(track(new THREE.BoxGeometry(BAY_W + 0.1, 0.12, BAY_D + 0.1)), mat(0x101418, { roughness: 0.8 }));
  plinth.position.set(0, 0.06, 0);
  group.add(plinth);

  const SURF_Z = BAY_D / 2 + 0.035;
  const place = (obj, x, y) => { obj.position.set(x, y, SURF_Z); group.add(obj); return obj; };

  // —— AUTO 方钮（全场唯一的方形蓝钮：完整自动程序的唯一入口）——
  const autoBezel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 4)), mat(COL.bezel, { roughness: 0.8 }));
  autoBezel.rotation.x = Math.PI / 2; autoBezel.rotation.y = Math.PI / 4;
  place(autoBezel, -0.45, 0.55);
  const autoMat = track(new THREE.MeshStandardMaterial({
    color: COL.auto, emissive: COL.auto, emissiveIntensity: 0.15, metalness: 0.2, roughness: 0.38
  }));
  const autoCap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.15, 0.15, 0.07, 4)), autoMat);
  autoCap.rotation.x = Math.PI / 2; autoCap.rotation.y = Math.PI / 4;
  place(autoCap, -0.45, 0.55);
  autoCap.position.z = SURF_Z + 0.035;
  const flashers = [];
  addHotspot(autoCap, "button", "auto", () => {
    commands.autoStart();
    flashers.push({ mat: autoMat, t: 0, base: 0.15 });
  });

  // —— 安全返回：带护圈的红蘑菇钮（调用同一个 session.scram()，因此原位接管为 MANUAL）——
  const guard = new THREE.Mesh(track(new THREE.TorusGeometry(0.21, 0.028, 8, 20)), mat(0xb8b12a, { metalness: 0.6 }));
  place(guard, 0.45, 0.55);
  guard.rotation.x = Math.PI / 2;
  const scramMat = track(new THREE.MeshStandardMaterial({
    color: COL.scram, emissive: COL.scram, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.4
  }));
  const scramCap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 20)), scramMat);
  scramCap.rotation.x = Math.PI / 2;
  place(scramCap, 0.45, 0.55);
  scramCap.position.z = SURF_Z + 0.05;
  addHotspot(scramCap, "button", "autoScram", () => {
    commands.scram();
    flashers.push({ mat: scramMat, t: 0, base: 0.35 });
  });

  // —— 阶段塔：八段自下而上（无文字的"程序走到哪一步"）——
  const phaseMats = AUTO_PHASE_ORDER.map((_, i) => {
    const m = emissiveMat(COL.auto, 0);
    const seg = new THREE.Mesh(track(new THREE.BoxGeometry(0.2, 0.085, 0.035)), m);
    place(seg, -0.62, 0.95 + i * 0.115);
    return m;
  });
  // 塔身背板，让八段读起来是一列刻度而不是八个孤立灯
  const tower = new THREE.Mesh(track(new THREE.BoxGeometry(0.26, 8 * 0.115 + 0.06, 0.02)), mat(COL.bezel, { roughness: 0.85 }));
  place(tower, -0.62, 0.95 + 3.5 * 0.115);

  // —— 三根棒的棒位竖表（颜色与 MANUAL 台一致，同一套语言）——
  const rodNames = ["SHIM", "REG", "TRANS"];
  const rodBars = {};
  rodNames.forEach((name, i) => {
    const frame = new THREE.Mesh(track(new THREE.BoxGeometry(0.075, 0.72, 0.02)), mat(COL.bezel, { roughness: 0.85 }));
    place(frame, -0.2 + i * 0.19, 1.32);
    const fm = track(new THREE.MeshStandardMaterial({
      color: COL[name], emissive: COL[name], emissiveIntensity: 0.35, roughness: 0.3
    }));
    const fill = new THREE.Mesh(track(new THREE.BoxGeometry(0.055, 0.7, 0.03)), fm);
    place(fill, -0.2 + i * 0.19, 1.32);
    fill.position.z = SURF_Z + 0.008;
    rodBars[name] = { fill, fm, h: 0.7, baseY: 1.32 };
  });

  // —— 功率横表（左低右高）——
  const powFrame = new THREE.Mesh(track(new THREE.BoxGeometry(0.92, 0.115, 0.02)), mat(COL.bezel, { roughness: 0.85 }));
  place(powFrame, 0.12, 0.86);
  const powMat = track(new THREE.MeshStandardMaterial({
    color: 0x1f4fb0, emissive: 0x1f4fb0, emissiveIntensity: 0.5, roughness: 0.3
  }));
  const powFill = new THREE.Mesh(track(new THREE.BoxGeometry(0.88, 0.085, 0.03)), powMat);
  place(powFill, 0.12, 0.86);
  powFill.position.z = SURF_Z + 0.008;
  const POW_W = 0.88, POW_X = 0.12;
  const powLow = new THREE.Color(0x1f4fb0), powHigh = new THREE.Color(0xf4f9ff);

  // —— 冷却流量转盘：真实转动的指针（LAB-004：只由 coolantFlowProxy 驱动）——
  const dialBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.14, 0.14, 0.03, 20)), mat(0x1b2128, { roughness: 0.6 }));
  dialBody.rotation.x = Math.PI / 2;
  place(dialBody, 0.5, 1.32);
  const needleMat = track(new THREE.MeshStandardMaterial({
    color: COL.pump, emissive: COL.pump, emissiveIntensity: 0.6, roughness: 0.3
  }));
  const needle = new THREE.Mesh(track(new THREE.BoxGeometry(0.015, 0.12, 0.012)), needleMat);
  needle.position.set(0, 0.045, 0);
  const needlePivot = new THREE.Group();
  needlePivot.add(needle);
  place(needlePivot, 0.5, 1.32);
  needlePivot.position.z = SURF_Z + 0.02;

  // —— 联锁与控制权灯组 ——
  const lamp = (color) => {
    const m = emissiveMat(color, 0);
    const dome = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 12, 10)), m);
    dome.scale.z = 0.55;
    return { mesh: dome, m };
  };
  const lampAuto = lamp(COL.auto);
  const lampManual = lamp(COL.manual);
  const lampReady = lamp(COL.ready);
  const lampPump = lamp(COL.pump);
  const lampPulse = lamp(COL.pulse);
  const lampScram = lamp(COL.scram);
  [lampAuto, lampManual, lampReady, lampPump, lampPulse, lampScram]
    .forEach((l, i) => place(l.mesh, -0.5 + i * 0.2, 0.24));

  function update(state, dt = 0.016) {
    const blink = reduceMotion ? 1 : (0.5 + 0.5 * Math.sin(performance.now() * 0.006));

    // 阶段塔：已完成段低亮、当前段最亮；非 AUTO 所有权时转白色低亮（程序已交还）
    const idx = AUTO_PHASE_ORDER.indexOf(state.autoPhase);
    phaseMats.forEach((m, i) => {
      if (state.controlOwner === "AUTO" && idx >= 0) {
        m.emissive.setHex(COL.auto);
        m.emissiveIntensity = i < idx ? 0.4 : (i === idx ? 1.6 : 0);
      } else if (state.controlOwner === "MANUAL") {
        m.emissive.setHex(COL.manual);
        m.emissiveIntensity = 0.1;
      } else {
        m.emissiveIntensity = 0;
      }
    });

    // 棒位竖表：底部对齐向上生长
    rodNames.forEach(name => {
      const pos = clamp(state.rod[name].pos, 0.001, 1);
      const b = rodBars[name];
      b.fill.scale.y = pos;
      b.fill.position.y = b.baseY - b.h / 2 + (b.h * pos) / 2;
      b.fm.emissiveIntensity = 0.3 + pos * 0.7;
    });

    // 功率横表（含脉冲，reduceMotion 下压制）
    const pShow = clamp(state.powerProxy + state.pulsePowerProxy * (reduceMotion ? 0.2 : 1.0), 0.001, 1);
    powFill.scale.x = pShow;
    powFill.position.x = POW_X - POW_W / 2 + (POW_W * pShow) / 2;
    powMat.color.copy(powLow).lerp(powHigh, pShow);
    powMat.emissive.copy(powMat.color);
    powMat.emissiveIntensity = 0.4 + pShow * (reduceMotion ? 0.4 : 1.3);

    // 冷却流量指针：0 → -2.2 rad，满流 → +2.2 rad
    const flow = clamp(state.coolantFlowProxy, 0, 1);
    needlePivot.rotation.z = -2.2 + flow * 4.4;
    needleMat.emissiveIntensity = 0.3 + flow * 0.9;

    const set = (l, on, i = 1.4) => { l.m.emissiveIntensity = on ? i : 0; };
    set(lampAuto, state.controlOwner === "AUTO", 1.7);
    set(lampManual, state.controlOwner === "MANUAL", 1.2);
    set(lampReady, state.autoAvailable, 1.3);
    set(lampPump, state.pumpOn, 1.2);
    set(lampPulse, state.pulseReady, 1.2);
    set(lampScram, state.scrammed, 0.4 + blink * 1.4);

    // AUTO 方钮：可启动=全亮；正在运行=呼吸；不允许重放=压暗（必须先安全停堆）
    if (state.controlOwner === "AUTO") {
      autoMat.emissiveIntensity = reduceMotion ? 0.9 : 0.55 + blink * 0.5;
    } else {
      autoMat.emissiveIntensity = state.autoAvailable ? 1.2 : 0.06;
    }

    for (let i = flashers.length - 1; i >= 0; i--) {
      const f = flashers[i]; f.t += dt;
      f.mat.emissiveIntensity = f.base + Math.max(0, 1.2 - f.t * 4);
      if (f.t > 0.35) { f.mat.emissiveIntensity = f.base; flashers.splice(i, 1); }
    }
  }

  function dispose() {
    disposables.forEach(d => { if (d && d.dispose) d.dispose(); });
    group.clear();
  }

  return { group, hotspots, update, dispose };
}
