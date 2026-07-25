// 操作员控制台：立在操作层地面上的三维操纵台，带可点击控件与指示器。
//
// 约束：整页无可见文字，因此所有控件只能靠**颜色 + 形状 + 图标几何**区分，不用文字标签：
//   - 绿色圆钮 = 启动/励磁；红色蘑菇钮 = SCRAM 急停；琥珀钮 = 脉冲点火；
//   - 青色拨钮 = 一回路泵开关；双位拨杆 = 运行/脉冲模式切换；
//   - **蓝色方钮 = AUTO 连续运行程序**（方形是全台唯一的方钮，与所有人工控件区分）；
//   - 三对上/下拨杆 = 三根控制棒（各棒有区别色，向上三角=提出，向下三角=插入）；
//   - 竖条表 = 功率（蓝→白，脉冲时强闪）、燃料温度（蓝→红）；
//   - 指示灯 = 模式（停堆灰/运行绿/脉冲琥珀）、SCRAM 红、泵青、AUTO 蓝、MANUAL 白；
//   - 八段进度条 = AUTO 程序阶段（联锁复位 → … → 全功率平衡），逐段点亮。
//
// 控制权的无文字反馈（PROJECT_SPEC「三维控制台提供无文字的 AUTO 启动/模式控件和
// AUTO/MANUAL 状态反馈」）：
//   - AUTO 蓝灯亮 = 自动程序拥有控制权；MANUAL 白灯亮 = 用户拥有控制权；
//   - AUTO 方钮全亮 = 现在可以启动完整 AUTO（安全停堆）；半亮 = AUTO 正在运行；
//     压暗 = 当前状态不允许重放自动程序（必须先 SCRAM 到安全停堆）；
//   - 脉冲钮同理：联锁全部满足才点亮，250 kW 稳态下自动压暗。
//
// 交互契约（physicalScene 负责射线拾取与按下/松开分发）：
//   hotspot = { mesh, kind: 'button'|'toggle'|'hold', name, press(), release() }
//   'button' 按下即触发；'toggle' 按下切换；'hold' 按下开始、松开停止（用于提/插棒）。
// 控件动作直接调用传入的 commands（= sessionController 的操作员方法）。
//
// update(state) 每帧刷新指示器与控件视觉（棒拨杆随棒位、灯随模式等）。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

// 颜色语言（与语义绑定，全站一致）
const COL = {
  start: 0x33dd66, scram: 0xff2a2a, pulse: 0xffa61f, pump: 0x27c6e0,
  auto: 0x4d8dff, manual: 0xe8eef5,
  panel: 0x2a3138, frame: 0x171c21, bezel: 0x0c0f12, idle: 0x40484f,
  SHIM: 0x6f9ad6, REG: 0x35c9a8, TRANS: 0xff8a3a,
  lampOff: 0x22282d, meterLow: 0x1f4fb0, meterHigh: 0xf4f9ff, tempHot: 0xff4020
};

// AUTO 程序阶段顺序（与 autoProgram.js 的 AUTO_PHASES 一致，用于八段进度条）
const PHASE_ORDER = [
  "INTERLOCKED_RESET", "AUXILIARIES_READY", "LOW_POWER_APPROACH", "PULSE_ARMED",
  "PULSE", "POST_PULSE_HEAT_TRANSFER", "STEADY_POWER_ASCENT", "FULL_POWER_EQUILIBRIUM"
];

export function createControlConsole({ commands, position = [0, 0, 6.8], facing = 0, reduceMotion } = {}) {
  const group = new THREE.Group();
  group.position.set(position[0], position[1], position[2]);
  group.rotation.y = facing;

  const disposables = [];
  const track = obj => { disposables.push(obj); return obj; };
  const mat = (color, opts = {}) => track(new THREE.MeshStandardMaterial(Object.assign({
    color, metalness: 0.3, roughness: 0.55
  }, opts)));

  const hotspots = [];
  const dynamic = []; // { update(state) } 每帧刷新的视觉

  // —— 台体：底柜 + 斜面板 ——
  const DESK_W = 3.4, DESK_H = 1.15, DESK_D = 1.5;
  const cabinet = new THREE.Mesh(track(new THREE.BoxGeometry(DESK_W, DESK_H, DESK_D)), mat(COL.frame, { roughness: 0.7 }));
  cabinet.position.set(0, DESK_H / 2, 0);
  group.add(cabinet);
  // 斜操作面（朝操作员/相机一侧上翻）
  const PANEL_W = DESK_W, PANEL_H = 1.25, PANEL_TILT = -Math.PI * 0.32;
  const panelGroup = new THREE.Group();
  panelGroup.position.set(0, DESK_H, DESK_D * 0.1);
  panelGroup.rotation.x = PANEL_TILT;
  group.add(panelGroup);
  const panel = new THREE.Mesh(track(new THREE.BoxGeometry(PANEL_W, PANEL_H, 0.09)), mat(COL.panel, { roughness: 0.5 }));
  panel.position.set(0, PANEL_H / 2, 0);
  panelGroup.add(panel);
  // 控件挂在面板局部坐标（x 横向，y 沿面板向上，贴在 z=+0.05 面上）
  const SURF_Z = 0.055;
  const place = (obj, x, y) => { obj.position.set(x, y, SURF_Z); panelGroup.add(obj); };

  // —— 控件几何 helpers ——
  // sides = 4 时得到方形钮帽（AUTO 专用形状，无文字也能与所有圆钮区分）
  function buttonMesh(color, r = 0.14, h = 0.06, sides = 20) {
    const g = new THREE.Group();
    const bezel = new THREE.Mesh(track(new THREE.CylinderGeometry(r * 1.35, r * 1.35, 0.03, sides === 4 ? 4 : 20)), mat(COL.bezel, { roughness: 0.8 }));
    bezel.rotation.x = Math.PI / 2;
    if (sides === 4) bezel.rotation.y = Math.PI / 4;
    const cap = new THREE.Mesh(track(new THREE.CylinderGeometry(r, r, h, sides)),
      track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, metalness: 0.2, roughness: 0.4 })));
    cap.rotation.x = Math.PI / 2; cap.position.z = h / 2;
    if (sides === 4) cap.rotation.y = Math.PI / 4;
    g.add(bezel, cap);
    return { group: g, cap, mat: cap.material, baseColor: color };
  }
  // 拨杆：底座 + 可转杆，杆顶三角图标（up/down）
  function leverMesh(color, dir) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(track(new THREE.CylinderGeometry(0.06, 0.075, 0.04, 12)), mat(COL.bezel, { roughness: 0.8 }));
    base.rotation.x = Math.PI / 2;
    const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.022, 0.03, 0.2, 10)),
      track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.1, metalness: 0.4, roughness: 0.4 })));
    stem.position.set(0, 0.1, 0.02);
    // 顶端三角图标（up 朝面板上方，down 朝下）
    const tri = new THREE.Mesh(track(new THREE.ConeGeometry(0.05, 0.08, 3)),
      track(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.4 })));
    tri.position.set(0, dir > 0 ? 0.22 : -0.02, 0.03);
    tri.rotation.z = dir > 0 ? 0 : Math.PI;
    g.add(base, stem, tri);
    return { group: g, stem, tri };
  }
  function lampMesh(color, r = 0.055) {
    const m = track(new THREE.MeshStandardMaterial({ color: COL.lampOff, emissive: color, emissiveIntensity: 0, roughness: 0.4 }));
    const dome = new THREE.Mesh(track(new THREE.SphereGeometry(r, 12, 10)), m);
    dome.scale.z = 0.6;
    return { mesh: dome, mat: m, color };
  }
  // 竖条表：外框 + 可缩放填充条
  function barMeter(w, h, lowColor, highColor) {
    const g = new THREE.Group();
    const frame = new THREE.Mesh(track(new THREE.BoxGeometry(w + 0.03, h + 0.03, 0.02)), mat(COL.bezel, { roughness: 0.8 }));
    const fillMat = track(new THREE.MeshStandardMaterial({ color: lowColor, emissive: lowColor, emissiveIntensity: 0.5, roughness: 0.3 }));
    const fill = new THREE.Mesh(track(new THREE.BoxGeometry(w, h, 0.03)), fillMat);
    fill.position.z = 0.01;
    g.add(frame, fill);
    return { group: g, fill, fillMat, h, lowColor: new THREE.Color(lowColor), highColor: new THREE.Color(highColor) };
  }

  const addHotspot = (mesh, kind, name, press, release) => {
    mesh.userData.hotspot = true;
    hotspots.push({ mesh, kind, name, press, release: release || (() => {}) });
  };

  // —— 顶行：启动 / SCRAM / 泵 ——
  const rowTop = PANEL_H - 0.28;
  const startB = buttonMesh(COL.start, 0.15);
  place(startB.group, -1.25, rowTop);
  addHotspot(startB.cap, "button", "start", () => { commands.startup(); pulseCap(startB); });

  const scramB = buttonMesh(COL.scram, 0.21, 0.09); // 更大的红色蘑菇钮
  place(scramB.group, -0.6, rowTop);
  addHotspot(scramB.cap, "button", "scram", () => { commands.scram(); pulseCap(scramB); });

  const pumpB = buttonMesh(COL.pump, 0.14);
  place(pumpB.group, 0.02, rowTop);
  addHotspot(pumpB.cap, "toggle", "pump", () => { commands.pumpToggle(); });

  // 模式双位拨杆（OPERATE↔PULSE），用一个可倾杆表示；点击切换
  const modeLever = leverMesh(COL.pulse, +1);
  place(modeLever.group, 0.66, rowTop);
  addHotspot(modeLever.stem, "toggle", "mode", () => { setModeToggle(); });

  // 脉冲点火（琥珀钮）
  const pulseB = buttonMesh(COL.pulse, 0.15);
  place(pulseB.group, 1.28, rowTop);
  addHotspot(pulseB.cap, "button", "pulseFire", () => { commands.pulseFire(); pulseCap(pulseB); });

  // —— 中行：三根控制棒 提/插 ——
  const rodNames = ["SHIM", "REG", "TRANS"];
  const rodX = { SHIM: -1.0, REG: 0.0, TRANS: 1.0 };
  const rodLevers = {};
  const rowRodUp = PANEL_H - 0.7, rowRodDn = PANEL_H - 1.02;
  rodNames.forEach(name => {
    const up = leverMesh(COL[name], +1);
    place(up.group, rodX[name], rowRodUp);
    addHotspot(up.stem, "hold", name + "_up",
      () => commands.rodStart(name, +1), () => commands.rodStop(name));
    const dn = leverMesh(COL[name], -1);
    place(dn.group, rodX[name], rowRodDn);
    addHotspot(dn.stem, "hold", name + "_dn",
      () => commands.rodStart(name, -1), () => commands.rodStop(name));
    // 棒位小竖条（提示当前行程）
    const b = barMeter(0.05, 0.34, COL[name], COL[name]);
    b.group.position.set(rodX[name] + 0.26, (rowRodUp + rowRodDn) / 2, SURF_Z);
    panelGroup.add(b.group);
    rodLevers[name] = { up, dn, bar: b };
  });

  // —— 指示器：功率条、燃料温度条、模式灯、SCRAM 灯、泵灯 ——
  const powerBar = barMeter(0.13, 0.9, COL.meterLow, COL.meterHigh);
  powerBar.group.position.set(-1.55, PANEL_H - 0.62, SURF_Z);
  panelGroup.add(powerBar.group);

  const tempBar = barMeter(0.1, 0.9, COL.meterLow, COL.tempHot);
  tempBar.group.position.set(1.55, PANEL_H - 0.62, SURF_Z);
  panelGroup.add(tempBar.group);

  const lampShutdown = lampMesh(0x9099a0);
  const lampOperate = lampMesh(COL.start);
  const lampPulse = lampMesh(COL.pulse);
  const lampScram = lampMesh(COL.scram);
  const lampPump = lampMesh(COL.pump);
  const lampAuto = lampMesh(COL.auto);
  const lampManual = lampMesh(COL.manual);
  const lampRow = [lampShutdown, lampOperate, lampPulse, lampScram, lampPump, lampAuto, lampManual];
  lampRow.forEach((l, i) => { place(l.mesh, -0.55 + i * 0.26, 0.16); });

  // —— AUTO 连续运行程序：方形蓝钮（全台唯一的方钮）——
  const autoB = buttonMesh(COL.auto, 0.13, 0.06, 4);
  place(autoB.group, -1.55, 0.20);
  addHotspot(autoB.cap, "button", "auto", () => { commands.autoStart(); pulseCap(autoB); });

  // —— AUTO 阶段八段进度条（无文字：逐段点亮表示程序走到哪一步）——
  const phaseSegs = PHASE_ORDER.map((_, i) => {
    const m = track(new THREE.MeshStandardMaterial({
      color: 0x1a2029, emissive: COL.auto, emissiveIntensity: 0, roughness: 0.35
    }));
    const seg = new THREE.Mesh(track(new THREE.BoxGeometry(0.145, 0.05, 0.022)), m);
    place(seg, -1.05 + i * 0.18, 0.045);
    return m;
  });

  // —— 控件动作辅助 ——
  let modeLatched = "OPERATE";
  function setModeToggle() {
    modeLatched = modeLatched === "OPERATE" ? "PULSE" : "OPERATE";
    commands.setMode(modeLatched);
  }
  // 按下反馈：短暂提升发光
  const flashers = [];
  function pulseCap(btn) { flashers.push({ mat: btn.mat, t: 0, base: 0.15 }); }

  // —— 每帧刷新 ——
  function update(state, dt = 0.016) {
    // 功率条（含脉冲强闪，reduceMotion 下压制）
    const pShow = clamp(state.powerProxy + state.pulsePowerProxy * (reduceMotion ? 0.2 : 1.0), 0, 1);
    powerBar.fill.scale.y = clamp(pShow, 0.001, 1);
    powerBar.fill.position.y = -powerBar.h / 2 + (powerBar.h * powerBar.fill.scale.y) / 2;
    powerBar.fillMat.color.copy(powerBar.lowColor).lerp(powerBar.highColor, pShow);
    powerBar.fillMat.emissive.copy(powerBar.fillMat.color);
    powerBar.fillMat.emissiveIntensity = 0.4 + pShow * (reduceMotion ? 0.4 : 1.4);

    // 燃料温度条
    const tShow = clamp(state.fuelTemperatureProxy, 0, 1);
    tempBar.fill.scale.y = clamp(tShow, 0.001, 1);
    tempBar.fill.position.y = -tempBar.h / 2 + (tempBar.h * tempBar.fill.scale.y) / 2;
    tempBar.fillMat.color.copy(tempBar.lowColor).lerp(tempBar.highColor, tShow);
    tempBar.fillMat.emissive.copy(tempBar.fillMat.color);
    tempBar.fillMat.emissiveIntensity = 0.35 + tShow * 0.8;

    // 棒拨杆随棒位倾转 + 棒位小条
    rodNames.forEach(name => {
      const pos = state.rod[name].pos;
      const rl = rodLevers[name];
      rl.up.stem.rotation.x = -pos * 0.5;
      rl.up.tri.rotation.x = -pos * 0.5;
      rl.bar.fill.scale.y = clamp(pos, 0.001, 1);
      rl.bar.fill.position.y = -rl.bar.h / 2 + (rl.bar.h * rl.bar.fill.scale.y) / 2;
      rl.bar.fillMat.emissiveIntensity = 0.3 + pos * 0.6;
      // 无文字的“这根棒现在能不能动”反馈：驱动被联锁禁止（停堆，或 PULSE 工况下
      // TRANS 交给气动机构）时把该棒的提/插拨杆压暗，与脉冲钮同一套语言。
      const live = state.rodDriveEnabled ? state.rodDriveEnabled[name] : !state.scrammed;
      [rl.up, rl.dn].forEach(lv => {
        lv.stem.material.emissiveIntensity = live ? 0.45 : 0.02;
        lv.tri.material.emissiveIntensity = live ? 0.9 : 0.04;
      });
    });

    // 模式拨杆倾角
    modeLever.stem.rotation.z = state.mode === "PULSE" ? 0.5 : -0.5;
    modeLatched = state.mode === "PULSE" ? "PULSE" : "OPERATE";

    // 指示灯
    const setLamp = (l, on, intensity = 1.4) => { l.mat.emissiveIntensity = on ? intensity : 0; };
    setLamp(lampShutdown, state.mode === "SHUTDOWN");
    setLamp(lampOperate, state.mode === "OPERATE" && !state.scrammed);
    setLamp(lampPulse, state.mode === "PULSE");
    // SCRAM 灯在停堆时慢闪
    const blink = reduceMotion ? 1 : (0.5 + 0.5 * Math.sin(performance.now() * 0.006));
    setLamp(lampScram, state.scrammed, 0.4 + blink * 1.4);
    setLamp(lampPump, state.pumpOn);
    // 泵钮发光反映开关
    pumpB.mat.emissiveIntensity = state.pumpOn ? 0.9 : 0.12;

    // —— 控制权反馈：AUTO 蓝灯 / MANUAL 白灯 ——
    setLamp(lampAuto, state.controlOwner === "AUTO", 1.6);
    setLamp(lampManual, state.controlOwner === "MANUAL", 1.2);
    // AUTO 方钮：可启动=全亮；正在运行=呼吸；不允许重放=压暗（必须先 SCRAM 到安全停堆）
    if (state.controlOwner === "AUTO") {
      autoB.mat.emissiveIntensity = reduceMotion ? 0.9 : 0.55 + blink * 0.5;
    } else {
      autoB.mat.emissiveIntensity = state.autoAvailable ? 1.1 : 0.06;
    }
    // 脉冲钮：只有全部脉冲联锁满足才点亮（无文字地表达“现在能不能点火”）
    pulseB.mat.emissiveIntensity = state.pulseReady ? 1.0 : 0.08;

    // —— AUTO 阶段进度条：逐段点亮，当前段最亮 ——
    const phaseIdx = PHASE_ORDER.indexOf(state.autoPhase);
    phaseSegs.forEach((m, i) => {
      if (state.controlOwner === "AUTO" && phaseIdx >= 0) {
        m.emissive.setHex(COL.auto);
        m.emissiveIntensity = i < phaseIdx ? 0.45 : (i === phaseIdx ? 1.5 : 0.0);
      } else if (state.controlOwner === "MANUAL") {
        // 人工接管：进度条整体转为白色低亮，表示自动程序已交还给用户
        m.emissive.setHex(COL.manual);
        m.emissiveIntensity = 0.12;
      } else {
        m.emissiveIntensity = 0.0;
      }
    });

    // 按下闪光衰减
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
