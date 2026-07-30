// SOURCE 逻辑测试（node，无需浏览器/WebGL）。
//
// 覆盖 PROJECT_SPEC.md 中可以在浏览器之外机械验证的验收条件：
//   - 会话联锁复位与首次交互门；
//   - 单一控制权：AUTO / MANUAL 分流、原位人工接管、安全返回；
//   - AUTO 连续运行程序的阶段顺序、脉冲联锁、脉冲后传热时间尺度、250 kW 平衡；
//   - 帧率无关性（点堆固定子步长 + 脉冲解析取峰）；
//   - 玻璃损伤能量代理与碎片几何；
//   - 反应堆池 / 轻水 / 厂房的结构与边界不变量。
//
// 三维外观、音频听感和交互手感由 Playwright MCP 在浏览器中验证，不在本文件范围内。
//
// 运行：npm test

import {
  createSessionController, MODES, CONTROL_OWNERS, AUTO_PHASES,
  FULL_POWER, PULSE_POWER_LIMIT
} from "../src/scenes/reactor/sessionController.js";
import {
  createDamageState, registerImpact, buildFragmentGeometries, impactEnergy
} from "../src/scenes/reactor/glassDamage.js";
import { createReactorModel } from "../src/scenes/reactor/reactorModel.js";
import { createWaterSystem, cherenkovIntensity } from "../src/scenes/reactor/waterSystem.js";
import {
  HALL_BOUNDS, HALL_COLLIDERS, LAB_COMPONENTS, createLabEnvironment
} from "../src/scenes/reactor/labEnvironment.js";
import {
  UNDERGROUND_BOUNDS, PLANT_COMPONENTS, HEAT_EXCHANGERS, COOLANT_LOOPS, createUndergroundPlant
} from "../src/scenes/reactor/undergroundPlant.js";
import { frameDelta, wrap01 } from "../src/scenes/reactor/timeStep.js";
import { GLASS_ARCH, floorBrickLayout } from "../src/scenes/reactor/glassArchitecture.js";
import { createFreeCamera, CAM_LIMITS, CAM_INPUT, homeFitDistance } from "../src/scenes/reactor/freeCamera.js";
import { createCherenkov, exposureGain } from "../src/scenes/reactor/cherenkov.js";
import { createAutoConsole, AUTO_PHASE_ORDER } from "../src/scenes/reactor/autoConsole.js";
import * as THREE from "three";

let failures = 0;
let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
function section(name) { console.log("\n== " + name + " =="); }

// 运行控制器：steps = [{ at: 秒, do: ctrl => ... }]，watch 每帧回调
function run(ctrl, seconds, dt, steps = [], watch = null) {
  const done = new Set();
  const t0 = run.clock.get(ctrl) || 0;
  let t = t0;
  const end = t0 + seconds;
  while (t < end) {
    for (let i = 0; i < steps.length; i++) {
      if (!done.has(i) && t >= t0 + steps[i].at) { steps[i].do(ctrl); done.add(i); }
    }
    const events = ctrl.update(dt);
    if (watch) watch(ctrl.state, t, events);
    t += dt;
  }
  run.clock.set(ctrl, t);
  return ctrl;
}
run.clock = new WeakMap();

// 一直推进到条件满足（或超时），返回实际用时
function runUntil(ctrl, cond, maxSeconds, dt = 1 / 60) {
  let t = 0;
  while (t < maxSeconds && !cond(ctrl.state)) { ctrl.update(dt); t += dt; }
  return t;
}

function freshUnlocked() {
  const c = createSessionController({ reduceMotion: false });
  c.unlock();
  return c;
}

// ————————————————— 1. 会话与联锁复位 —————————————————
section("session / interlocked reset");
{
  const c = createSessionController({ reduceMotion: false });
  assert(c.state.mode === "SHUTDOWN" && c.state.scrammed, "加载后处于停堆 + SCRAM 联锁状态");
  assert(c.state.controlOwner === "NONE", "加载后无控制权所有者: " + c.state.controlOwner);
  assert(c.state.autoPhase === "INTERLOCKED_RESET", "加载后 AUTO 阶段为 INTERLOCKED_RESET");
  assert(c.state.gratingLocked === true, "格栅放下并锁定 (S-003)");
  assert(c.state.rod.SHIM.pos === 0 && c.state.rod.REG.pos === 0 && c.state.rod.TRANS.pos === 0,
    "三根控制棒都在底部安全棒位");

  run(c, 5, 1 / 60);
  assert(c.state.powerProxy === 0 && c.state.mode === "SHUTDOWN",
    "首次交互前场景时钟不释放：功率与模式不变");
  assert(c.requestAuto() === false, "未解锁时 requestAuto 被拒绝");

  c.unlock();
  assert(c.state.unlocked && c.state.sceneClockRunning, "unlock() 同时解锁音频门与场景时钟");
  run(c, 2, 1 / 60);
  assert(c.state.powerProxy > 0 && c.state.powerProxy < 1e-5,
    "解锁后仍停堆，功率停在源倍增水平: " + c.state.powerProxy.toExponential(2));
  assert(c.state.reactivityProxy < -2.5,
    "停堆时深度次临界 ($): " + c.state.reactivityProxy.toFixed(2));
  assert(MODES.length === 3 && CONTROL_OWNERS.length === 3 && AUTO_PHASES.length === 8,
    "导出 3 种模式 / 3 种控制权 / 8 个 AUTO 阶段");
}

// ————————————————— 2. 控制权分流与接管 —————————————————
section("control ownership");
{
  // 控制台热点以外的首次交互 → AUTO
  const a = freshUnlocked();
  assert(a.isSafeShutdown(), "联锁复位状态满足安全停堆条件");
  assert(a.requestAuto() === true && a.state.controlOwner === "AUTO", "非控制台首次交互进入 AUTO");
  assert(a.requestAuto() === false, "已在 AUTO 时重复请求不重启程序");

  // 控制台热点的首次交互 → MANUAL，并执行该指令
  const m = freshUnlocked();
  m.startup();
  assert(m.state.controlOwner === "MANUAL", "控制台首次交互进入 MANUAL");
  assert(!m.state.scrammed && m.state.mode === "OPERATE", "该次真实控制指令被执行（不是先偷偷启动 AUTO）");
  assert(m.state.autoPhase === "INTERLOCKED_RESET", "MANUAL 分流时 AUTO 程序未运行过");

  // AUTO 运行中人工接管：原位继承，不复位
  const t = freshUnlocked();
  t.requestAuto();
  run(t, 25, 1 / 60);
  const before = {
    phase: t.state.autoPhase, power: t.state.powerProxy, shim: t.state.rod.SHIM.pos,
    reg: t.state.rod.REG.pos, fuel: t.state.fuelTemperatureProxy,
    pool: t.state.poolTemperatureProxy, flow: t.state.coolantFlowProxy, pump: t.state.pumpOn
  };
  assert(before.shim > 0.5 && before.power > 0, "接管前 AUTO 已把反应堆带到有棒位/有功率的状态");
  t.rodStop("SHIM");   // 人工指令
  assert(t.state.controlOwner === "MANUAL", "AUTO 期间的人工指令立即接管控制权");
  assert(t.state.autoPhase === "MANUAL_TAKEOVER", "接管后 AUTO 阶段标记为 MANUAL_TAKEOVER");
  assert(Math.abs(t.state.rod.SHIM.pos - before.shim) < 1e-9 &&
    Math.abs(t.state.powerProxy - before.power) < 1e-12 &&
    Math.abs(t.state.fuelTemperatureProxy - before.fuel) < 1e-12 &&
    Math.abs(t.state.poolTemperatureProxy - before.pool) < 1e-12 &&
    t.state.pumpOn === before.pump,
    "接管不复位棒位/功率/温度/流量/泵状态（原位继承）");

  // 接管后调度器彻底停止：棒不再自己动
  const shimAtTakeover = t.state.rod.SHIM.pos;
  const regAtTakeover = t.state.rod.REG.pos;
  run(t, 8, 1 / 60);
  assert(Math.abs(t.state.rod.SHIM.pos - shimAtTakeover) < 1e-9 &&
    Math.abs(t.state.rod.REG.pos - regAtTakeover) < 1e-9,
    "接管后 AUTO 调度器不再驱动任何棒（不存在两套控制器并行）");
  assert(t.state.autoPhase === "MANUAL_TAKEOVER", "接管后 AUTO 阶段不再推进");

  // MANUAL → 完整 AUTO 只能从安全停堆开始
  assert(t.state.autoAvailable === false, "有功率/棒已提出时不允许重新进入 AUTO");
  assert(t.requestAuto() === false, "非安全停堆状态下 requestAuto 被拒绝");
  t.scram();
  run(t, 12, 1 / 60);
  assert(t.isSafeShutdown(), "SCRAM 后进入安全停堆状态: power=" + t.state.powerProxy.toExponential(2));
  assert(t.state.autoAvailable === true, "安全停堆后控制台的 AUTO 控件变为可用");
  assert(t.requestAuto() === true && t.state.controlOwner === "AUTO", "安全停堆后可重新进入完整 AUTO");
  assert(t.state.autoPhase === "INTERLOCKED_RESET", "重新进入的 AUTO 从联锁复位开始，不在任意功率状态重放");
}

// ————————————————— 3. AUTO 连续运行程序 —————————————————
section("AUTO continuous operation");
const autoRun = (dt, seconds = 200) => {
  const c = freshUnlocked();
  c.requestAuto();
  const seen = [];
  let maxPulse = 0, maxPower = 0, pulseFirePower = null;
  let maxRodStep = 0;
  const prev = { SHIM: 0, REG: 0 };
  run(c, seconds, dt, [], (s, t, events) => {
    if (seen[seen.length - 1] !== s.autoPhase) seen.push(s.autoPhase);
    if (s.pulsePowerProxy > maxPulse) maxPulse = s.pulsePowerProxy;
    if (s.powerProxy > maxPower) maxPower = s.powerProxy;
    for (const e of events) if (e.type === "pulse_start") pulseFirePower = s.powerProxy;
    for (const k of ["SHIM", "REG"]) {
      const step = Math.abs(s.rod[k].pos - prev[k]) / dt;
      if (step > maxRodStep) maxRodStep = step;
      prev[k] = s.rod[k].pos;
    }
  });
  return { c, seen, maxPulse, maxPower, pulseFirePower, maxRodStep };
};
{
  const { c, seen, maxPulse, pulseFirePower, maxRodStep } = autoRun(1 / 60);
  const expected = AUTO_PHASES.filter(p => p !== "MANUAL_TAKEOVER");
  assert(seen.join(" → ") === expected.join(" → "),
    "AUTO 按锁定顺序经历全部 8 个阶段:\n     " + seen.join(" → "));
  assert(c.state.autoPhase === "FULL_POWER_EQUILIBRIUM", "AUTO 到达全功率平衡");
  assert(c.state.controlOwner === "AUTO", "全程控制权仍属 AUTO");

  assert(c.state.pulseId === 1, "整个程序恰好触发一次历史脉冲: " + c.state.pulseId);
  assert(pulseFirePower !== null && pulseFirePower < PULSE_POWER_LIMIT,
    `脉冲从 100 W 代理以下的低功率触发: ${pulseFirePower.toExponential(2)} < ${PULSE_POWER_LIMIT}`);
  assert(maxPulse > 0.9 && maxPulse <= 1.05,
    "脉冲峰值达到 250 MW 代理量级: " + maxPulse.toFixed(3));
  assert(c.state.pulse === null && c.state.pulsePowerProxy === 0, "脉冲自终止并归零");

  assert(Math.abs(c.state.powerProxy - FULL_POWER) < 0.05 * FULL_POWER,
    "最终稳定在 250 kW 代理: P=" + c.state.powerProxy.toFixed(4));
  assert(c.state.pumpOn && c.state.coolantFlowProxy > 0.5,
    "全功率平衡由真实冷却状态支撑: flow=" + c.state.coolantFlowProxy.toFixed(3));
  assert(Math.abs(c.state.reactivityProxy) < 0.05,
    "平衡点净反应性接近零（由棒位与温度反馈共同决定）: " + c.state.reactivityProxy.toFixed(4));
  assert(c.state.rod.SHIM.pos > 0.6 && c.state.rod.SHIM.pos < 1 &&
    c.state.rod.REG.pos > 0.3 && c.state.rod.REG.pos < 1,
    `平衡棒位落在两根棒都仍有双向调节权限的行程中段: SHIM=${c.state.rod.SHIM.pos.toFixed(3)} REG=${c.state.rod.REG.pos.toFixed(3)}`);
  assert(c.state.rod.TRANS.pos < 0.02, "TRANS 脉冲后回座并保持在座");

  // AUTO 只按住提/插棒开关：棒速永远不超过驱动机构速率，不会跳到某个棒位
  assert(maxRodStep < 0.145, "AUTO 不直接写棒位，棒速受驱动机构限制: " + maxRodStep.toFixed(4) + "/s");

  // 平衡是持续状态，不是一次性到达
  run(c, 60, 1 / 60);
  assert(Math.abs(c.state.powerProxy - FULL_POWER) < 0.05 * FULL_POWER,
    "继续运行 60 s 仍维持 250 kW 平衡: P=" + c.state.powerProxy.toFixed(4));
  assert(c.state.poolTemperatureProxy > 0.3 && c.state.poolTemperatureProxy < 0.6,
    "池水温度稳定在全功率平衡值: Tp=" + c.state.poolTemperatureProxy.toFixed(3));
}

// 帧率无关：粗步长下同样走完程序并停在同一平衡点
{
  const fine = autoRun(1 / 60, 200);
  const coarse = autoRun(1 / 12, 200);
  assert(coarse.c.state.autoPhase === "FULL_POWER_EQUILIBRIUM",
    "1/12 s 步长下 AUTO 同样到达全功率平衡");
  assert(Math.abs(coarse.c.state.powerProxy - fine.c.state.powerProxy) < 0.08,
    `平衡功率与帧率无关: fine=${fine.c.state.powerProxy.toFixed(3)} coarse=${coarse.c.state.powerProxy.toFixed(3)}`);
  assert(Math.abs(coarse.maxPulse - fine.maxPulse) < 0.05,
    `脉冲峰值与帧率无关（解析曲线按帧区间取极值）: fine=${fine.maxPulse.toFixed(3)} coarse=${coarse.maxPulse.toFixed(3)}`);
  assert(coarse.c.state.pulseId === 1, "粗步长下仍然恰好一次脉冲");
}

// 脉冲后传热的时间尺度：燃料快、池水慢
section("post-pulse heat transfer time scales");
{
  const c = freshUnlocked();
  c.requestAuto();
  let atPulseEnd = null, fuelPeak = 0, poolAtPeak = 0;
  const samples = [];
  run(c, 60, 1 / 60, [], (s) => {
    if (s.fuelTemperatureProxy > fuelPeak) { fuelPeak = s.fuelTemperatureProxy; poolAtPeak = s.poolTemperatureProxy; }
    if (atPulseEnd === null && s.pulseId === 1 && s.pulse === null && s.autoPhase === "POST_PULSE_HEAT_TRANSFER") {
      atPulseEnd = { fuel: s.fuelTemperatureProxy, pool: s.poolTemperatureProxy };
    }
    if (atPulseEnd) samples.push({ fuel: s.fuelTemperatureProxy, pool: s.poolTemperatureProxy });
  });
  assert(atPulseEnd !== null, "捕捉到脉冲结束时刻的热工状态");
  assert(fuelPeak > atPulseEnd.pool + 0.15,
    `脉冲把能量沉积在燃料里而不是直接加热池水: 燃料峰=${fuelPeak.toFixed(3)} 池水=${poolAtPeak.toFixed(3)}`);
  const poolJump = poolAtPeak - 0.12;
  assert(poolJump < 0.05, "脉冲瞬间池水没有爆炸式跃起: Δ池水=" + poolJump.toFixed(4));
  // 脉冲后 3 s 内燃料温度回落幅度远大于池水升幅（两个时间尺度）
  const s3 = samples[Math.min(samples.length - 1, 180)];
  const fuelDrop = atPulseEnd.fuel - s3.fuel;
  const poolRise = s3.pool - atPulseEnd.pool;
  assert(fuelDrop > 0 && poolRise > 0 && fuelDrop > poolRise * 3,
    `脉冲后 3 s：燃料降温 ${fuelDrop.toFixed(3)} 远快于池水升温 ${poolRise.toFixed(3)}`);
}

// ————————————————— 4. MANUAL 操作链与联锁 —————————————————
section("MANUAL control chain / interlocks");
{
  // 启动 → 提棒 → 升功率 → 温度反馈自限
  const c = freshUnlocked();
  c.startup(); c.pumpToggle();
  c.rodStart("SHIM", +1); c.rodStart("REG", +1);
  run(c, 10, 1 / 60);
  c.rodStop("SHIM"); c.rodStop("REG");
  run(c, 60, 1 / 60);
  const steady = c.state.powerProxy;
  assert(steady > FULL_POWER, "全提 SHIM+REG 的稳态功率高于 250 kW（留有控制裕量）: " + steady.toFixed(3));
  assert(steady < 2.6, "功率被负温度反馈自限，不发散: " + steady.toFixed(3));
  assert(c.state.fuelTemperatureProxy > c.state.poolTemperatureProxy, "燃料温度高于池水温度（热从燃料流向池水）");

  // 脉冲联锁：满功率下拒绝点火
  assert(c.setMode("PULSE") === true, "运行中可以切到脉冲工况");
  assert(c.pulseFire() === false && c.state.pulseId === 0,
    "250 kW 稳态下拒绝点火（脉冲前功率联锁）");
  assert(c.state.pulseReady === false, "控制台脉冲联锁指示为不可用");

  // SCRAM → 功率快速下降、棒插入
  const before = c.state.powerProxy;
  c.scram();
  run(c, 4, 1 / 60);
  assert(c.state.powerProxy < before * 0.2, `SCRAM 使功率快速下降: ${before.toFixed(3)} → ${c.state.powerProxy.toFixed(4)}`);
  assert(c.state.rod.SHIM.pos < 0.02 && c.state.rod.REG.pos < 0.02, "SCRAM 把棒全部插入");
  assert(c.state.mode === "SHUTDOWN" && c.state.scrammed, "SCRAM 后处于停堆状态");
  assert(c.setMode("PULSE") === false && c.pulseFire() === false, "停堆状态拒绝模式切换与点火");
}
{
  // 人工独立完成完整脉冲程序：启动 → SHIM 粗调 → REG 整定到低功率临界 → 点火。
  // 这正是 AUTO 走的同一条路径，只是由用户按控制台完成。
  const c = freshUnlocked();
  c.startup(); c.pumpToggle();
  assert(c.pulseFire() === false, "OPERATE 模式下拒绝点火");

  c.rodStart("SHIM", +1);
  runUntil(c, s => s.rod.SHIM.pos >= 0.72, 20);
  c.rodStop("SHIM");
  c.rodStart("REG", +1);
  runUntil(c, s => s.reactivityProxy >= -0.012, 20);
  c.rodStop("REG");
  run(c, 2, 1 / 60);
  assert(Math.abs(c.state.reactivityProxy) < 0.1,
    "人工把反应堆带到近临界: ρ=" + c.state.reactivityProxy.toFixed(4) + "$");
  assert(c.state.powerProxy < PULSE_POWER_LIMIT,
    "低功率临界的功率仍在 100 W 代理联锁以下: " + c.state.powerProxy.toExponential(2));

  c.setMode("PULSE");
  run(c, 1 / 60, 1 / 60);
  assert(c.state.pulseReady === true, "低功率 + PULSE 模式 + TRANS 在座 → 联锁满足");
  assert(c.pulseFire() === true && c.state.pulseId === 1, "人工点火成功");
  let maxPulse = 0;
  run(c, 6, 1 / 60, [], s => { if (s.pulsePowerProxy > maxPulse) maxPulse = s.pulsePowerProxy; });
  assert(maxPulse > 0.9, "人工脉冲产生与 AUTO 相同量级的 250 MW 尖峰: " + maxPulse.toFixed(3));
  assert(c.state.pulse === null && c.state.rod.TRANS.pos < 0.05, "人工脉冲自终止且 TRANS 回座");
  assert(c.state.controlOwner === "MANUAL", "整条脉冲链都在 MANUAL 控制权下完成");
}
{
  // 从深度次临界弹 TRANS：机构照常动作，但不越瞬发临界 → 没有毫秒尖峰，
  // 反应性也不会被凭空吞掉（照常进入稳态通道）。
  const c = freshUnlocked();
  c.startup();
  c.setMode("PULSE");
  run(c, 1 / 60, 1 / 60);
  assert(c.pulseFire() === true, "棒全插时仍可发射 TRANS（机构动作真实存在）");
  let maxPulse = 0;
  const events = [];
  run(c, 3, 1 / 60, [], (s, t, evs) => {
    if (s.pulsePowerProxy > maxPulse) maxPulse = s.pulsePowerProxy;
    for (const e of evs) events.push(e.type);
  });
  assert(maxPulse < 0.01, "未越瞬发临界 → 没有毫秒功率尖峰: " + maxPulse.toFixed(4));
  assert(events.includes("trans_eject_impulse") && events.includes("trans_underwater_impulse"),
    "机械反力与水下冲量事件照常发出（结构/水体耦合与核功率无关）");
  assert(c.state.fuelTemperatureProxy < 0.2, "没有脉冲能量沉积到燃料");
}
{
  // 泵：开泵降低稳态池水温度（真实排热方向）
  const mk = (pump) => {
    const c = freshUnlocked();
    c.startup(); if (pump) c.pumpToggle();
    c.rodStart("SHIM", +1); c.rodStart("REG", +1);
    run(c, 8, 1 / 60);
    c.rodStop("SHIM"); c.rodStop("REG");
    run(c, 90, 1 / 60);
    return c.state;
  };
  const on = mk(true), off = mk(false);
  assert(on.poolTemperatureProxy < off.poolTemperatureProxy,
    `一回路泵降低稳态池水温度: on=${on.poolTemperatureProxy.toFixed(3)} < off=${off.poolTemperatureProxy.toFixed(3)}`);
  assert(on.coolantFlowProxy > off.coolantFlowProxy, "泵开时冷却流量更高");
}

// ————————————————— 5. 玻璃损伤 —————————————————
section("glass damage");
{
  const d1 = createDamageState();
  const lowHit = registerImpact(d1, { normalRelativeSpeed: 0.5, effectiveMass: 1.5, localPoint: { x: 0.1, y: 0.1, z: 0.1 } });
  assert(d1.stage === "INTACT" && !lowHit.changed, "极低能量接触不产生损伤");

  const d2 = createDamageState();
  const stages = [];
  for (let i = 0; i < 6; i++) {
    registerImpact(d2, { normalRelativeSpeed: 6, effectiveMass: 1.5, localPoint: { x: 0.3, y: -0.2, z: 0.1 } });
    stages.push(d2.stage);
  }
  assert(stages[0] === "INTACT", "单次中等冲击不会直接破碎");
  assert(stages.includes("MICRO_DAMAGED"), "重复中等冲击累积到 MICRO_DAMAGED: " + stages.join(","));
  assert(d2.durability < 1, "耐久随可复现的碰撞能量下降: " + d2.durability.toFixed(3));

  // 初始布局的复位落位（最大落差约 0.34，g=20）不得扣耐久
  const settleSpeed = Math.sqrt(2 * 20 * 0.34);
  const dS = createDamageState();
  const settleHit = registerImpact(dS, { normalRelativeSpeed: settleSpeed, effectiveMass: 1.5, localPoint: { x: 0, y: -0.5, z: 0 } });
  assert(dS.stage === "INTACT" && !settleHit.changed,
    `复位落位不损伤（v=${settleSpeed.toFixed(2)}）`);

  const d3 = createDamageState();
  const big = registerImpact(d3, { normalRelativeSpeed: 20, effectiveMass: 1.5, localPoint: { x: 0, y: 0, z: 0 } });
  assert(d3.stage === "FRACTURED" && big.changed, "单次超强冲击直接破碎");

  const shards = buildFragmentGeometries(1, 7);
  assert(shards.length === 8, "破碎生成 8 块独立碎片: " + shards.length);
  assert(shards.every(s => s.geometry.attributes.position.count >= 4), "每块碎片都有真实非退化三维几何");
  assert(shards.every(s => s.halfExtents.x > 0 && s.halfExtents.y > 0 && s.halfExtents.z > 0),
    "每块碎片都有正的碰撞体尺寸");
  assert(Math.abs(impactEnergy(1.5, 4) - 12) < 1e-9,
    "冲击能量代理 = 0.5·m·v²（SOURCE_SCENE.md §7.2）");
}

// ————————————————— 6. 反应堆池 / 轻水 / 厂房结构 —————————————————
section("reactor pool / water / hall invariants");
const reactor = createReactorModel({ reduceMotion: false });
{
  assert(reactor.grating.radius > 0 && reactor.grating.y >= reactor.poolBounds.surfaceY,
    "安全格栅位于水面之上（玻璃不漂在水上）");
  const rods = reactor.controlRods;
  assert(!!rods.SHIM && !!rods.REG && !!rods.TRANS, "Pavia 三棒构型：SHIM / REG / TRANS");
  // 玻璃可以被抓取伺服提过 0.58 高的栏杆丢到池外。掉落路径上的每一层**可见**结构
  // 都必须有对应的落脚点，否则玻璃会穿过看得见的混凝土永远下坠（浏览器实测过）。
  assert(reactor.shield.innerRadius === reactor.deck.outerRadius,
    "生物屏蔽上盖内边与走道外沿相接：落点之间没有缝");
  assert(reactor.shield.outerRadius > reactor.shield.innerRadius &&
    reactor.shield.topY > reactor.deck.y,
    `屏蔽上盖是高于走道的实体环: r ${reactor.shield.innerRadius}→${reactor.shield.outerRadius}, y=${reactor.shield.topY}`);
  assert(reactor.shield.outerRadius < GLASS_ARCH.supportInnerR,
    "屏蔽外皮到承托层内边之间是敞开采光井（可以看见地下设备）");
  assert(UNDERGROUND_BOUNDS.floorY < reactor.poolBounds.floorY &&
    UNDERGROUND_BOUNDS.half > GLASS_ARCH.supportInnerR,
    `采光井底部有地坑底板兜底: floorY=${UNDERGROUND_BOUNDS.floorY}, half=${UNDERGROUND_BOUNDS.half}`);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  assert(dist(rods.SHIM, rods.TRANS) > 0.1 && dist(rods.TRANS, rods.REG) > 0.1 && dist(rods.SHIM, rods.REG) > 0.1,
    "三根控制棒位于互不相同的格位");
  assert(reactor.poolBounds.surfaceY < 0 && reactor.poolBounds.floorY < reactor.poolBounds.surfaceY,
    "池体有明确的水面与池底");
  assert(reactor.deck.outerRadius > reactor.deck.innerRadius && reactor.deck.railHeight > 0,
    "池口走道与栏杆有真实尺寸");
  const c = freshUnlocked();
  c.requestAuto();
  run(c, 80, 1 / 60);
  reactor.update(0.016, c.state);
  console.log("   reactorModel.update 在全功率状态下正常执行");
}
{
  const water = createWaterSystem({
    poolRadius: reactor.poolBounds.radius, poolDepth: reactor.poolBounds.depth,
    surfaceY: reactor.poolBounds.surfaceY, corePosition: reactor.corePosition, reduceMotion: false
  });
  const rest = water.heightAt(0, 0);
  water.addImpulse(0, 0, 1, 0.4);
  for (let i = 0; i < 5; i++) water.update(1 / 30, null);
  assert(Math.abs(water.heightAt(0, 0) - rest) > 1e-4, "水下冲量真实扰动高度场");
  for (let i = 0; i < 600; i++) water.update(1 / 30, null);
  assert(Math.abs(water.heightAt(0, 0) - rest) < 1e-3,
    "能量输入停止后水面回到静水平衡（无残余水位偏移）: Δ=" +
    (water.heightAt(0, 0) - rest).toExponential(2));
  // 反复冲量不得累积出永久水位偏移
  for (let k = 0; k < 8; k++) {
    water.addImpulse(0, 0, 1, 0.4);
    for (let i = 0; i < 60; i++) water.update(1 / 30, null);
  }
  for (let i = 0; i < 900; i++) water.update(1 / 30, null);
  assert(Math.abs(water.heightAt(0, 0) - rest) < 1e-3,
    "8 次冲量后仍回到同一静水面（不累积残余）: Δ=" +
    (water.heightAt(0, 0) - rest).toExponential(2));
}
{
  // 厂房尺度仍是设备与碰撞体的单一事实来源（相机自 CAM-002 起不再受这些限位约束）
  assert(HALL_BOUNDS.half > 0 && HALL_BOUNDS.ceiling > 0, "厂房净空为正");
  assert(HALL_BOUNDS.half < HALL_COLLIDERS.wallInner, "厂房净空比墙碰撞面更靠内");
  assert(HALL_BOUNDS.ceiling > reactor.poolBounds.surfaceY, "厂房净空高于水面");
  assert(HALL_COLLIDERS.floorTop < reactor.deck.y, "厂房楼板低于池边走道");
}

// ————————————— 9. 审查 R-001…R-005 的回归断言 —————————————
section("review regressions: TRANS drive / control-owner source / cherenkov / trip");
{
  // R-001：OPERATE 工况下 TRANS 与另外两根棒一样可人工连续提插
  const c = freshUnlocked();
  c.startup();
  assert(c.state.mode === "OPERATE" && !c.state.scrammed, "MANUAL 启动后进入 OPERATE");
  assert(c.state.rodDriveEnabled.TRANS === true, "OPERATE 下 TRANS 驱动可用（控制台拨杆点亮）");
  assert(c.rodStart("TRANS", +1) === true, "OPERATE 下接受 TRANS 提出指令");
  let prev = c.state.rod.TRANS.pos;
  let monotonic = true, maxRate = 0;
  for (let i = 0; i < 180; i++) {
    c.update(1 / 60);
    const now = c.state.rod.TRANS.pos;
    if (now < prev - 1e-12) monotonic = false;
    maxRate = Math.max(maxRate, (now - prev) * 60);
    prev = now;
  }
  assert(monotonic && c.state.rod.TRANS.pos > 0.3,
    "按住 3 s 后 TRANS 棒位单调增长: " + c.state.rod.TRANS.pos.toFixed(3));
  assert(maxRate <= 0.145, "TRANS 提出速率不超过驱动机构速率: " + maxRate.toFixed(3));
  c.rodStop("TRANS");
  const held = c.state.rod.TRANS.pos;
  run(c, 2, 1 / 60);
  assert(Math.abs(c.state.rod.TRANS.pos - held) < 1e-9, "松开后 TRANS 停在原位（不自动回座）");
  // TRANS 提出后棒价值真的进入反应性（不是只动图形）
  assert(c.state.rodReactivity > 0.5, "TRANS 行程进入反应性: " + c.state.rodReactivity.toFixed(2));

  // PULSE 工况：TRANS 交给气动机构，人工驱动被联锁拒绝且棒回座
  c.setMode("PULSE");
  c.update(1 / 60);
  assert(c.state.rodDriveEnabled.TRANS === false, "PULSE 下 TRANS 驱动被联锁禁用（拨杆压暗）");
  assert(c.rodStart("TRANS", +1) === false, "PULSE 下 TRANS 人工驱动指令被拒绝");
  assert(c.state.rodDriveEnabled.SHIM === true, "PULSE 下 SHIM/REG 仍可人工驱动");
  run(c, 2, 1 / 60);
  assert(c.state.rod.TRANS.pos <= 0.02, "PULSE 工况下 TRANS 被气缸拉回座上待发");
}
{
  // R-002：MANUAL 安全停堆后，控制台以外的交互不得静默交回控制权
  const c = freshUnlocked();
  c.startup();
  c.rodStart("SHIM", +1);
  run(c, 6, 1 / 60);
  c.rodStop("SHIM");
  assert(c.state.controlOwner === "MANUAL", "人工指令进入 MANUAL");
  c.scram();
  run(c, 5, 1 / 60);
  assert(c.state.autoAvailable === true, "安全停堆后 AUTO 方钮变为可用");
  assert(c.sceneInteraction() === false, "MANUAL 下的控制台外交互不请求 AUTO");
  assert(c.state.controlOwner === "MANUAL", "转相机/滚轮/拖玻璃不夺走控制权");
  assert(c.state.autoPhase !== "INTERLOCKED_RESET" || c.state.controlOwner === "MANUAL",
    "自动程序未被静默重放");
  assert(c.requestAuto() === true && c.state.controlOwner === "AUTO",
    "控制台 AUTO 方钮仍可在安全停堆后重入完整 AUTO");
  assert(c.state.autoPhase === "INTERLOCKED_RESET", "重入的 AUTO 从联锁复位开始");

  // 首次分流本身不受影响：NONE 时控制台外交互仍然进入 AUTO
  const f = freshUnlocked();
  assert(f.state.controlOwner === "NONE", "新会话没有控制权所有者");
  assert(f.sceneInteraction() === true && f.state.controlOwner === "AUTO",
    "首次控制台外交互仍进入 AUTO");
  assert(f.sceneInteraction() === false && f.state.controlOwner === "AUTO",
    "AUTO 运行中的控制台外交互不重启程序");
}
{
  // R-003：切伦科夫稳态通道按资料阈值软起辉，无阶跃
  assert(cherenkovIntensity(0.001, 0) === 0, "250 W 代理下稳态辉光为 0");
  assert(cherenkovIntensity(0.29, 0) === 0, "powerProxy 0.29（< 100 kW 阈值区）仍为 0");
  const samples = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.8, 1.0].map(p => cherenkovIntensity(p, 0));
  let mono = true, maxJump = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < samples[i - 1]) mono = false;
    maxJump = Math.max(maxJump, samples[i] - samples[i - 1]);
  }
  assert(mono && samples[samples.length - 1] === 1, "0.3 → 1.0 区间单调升到满强度");
  assert(maxJump < 0.35, "相邻采样点之间没有阶跃: 最大跳变 " + maxJump.toFixed(3));
  assert(cherenkovIntensity(0.45, 0) > 0 && cherenkovIntensity(0.45, 0) < 1,
    "100 kW 附近处于连续过渡中段");
  assert(cherenkovIntensity(0, 1) > 0.7, "低功率下的历史脉冲仍然照亮池水（脉冲通道独立）");
}
{
  // R-001 的副作用边界：TRANS 可人工驱动之后，三根棒同时全提是可达状态。
  // 这里断言它仍然由瞬发负温度反馈自限（真实 TRIGA 的自限特性），不发散、
  // 不进入物理上荒谬的状态——不引入任何额外的保护装置。
  const c = freshUnlocked();
  c.startup(); c.pumpToggle();
  ["SHIM", "REG", "TRANS"].forEach(n => c.rodStart(n, +1));
  run(c, 10, 1 / 60);
  ["SHIM", "REG", "TRANS"].forEach(n => c.rodStop(n));
  let peak = 0;
  for (let i = 0; i < 60 * 120; i++) { c.update(1 / 60); peak = Math.max(peak, c.state.powerProxy); }
  assert(c.state.rod.TRANS.pos > 0.99, "三根棒确实全部提到顶");
  assert(Number.isFinite(peak) && peak < 6,
    "三棒全提时功率被负温度反馈自限、不发散: 峰值 " + peak.toFixed(3));
  assert(c.state.powerProxy > FULL_POWER,
    "三棒全提的稳态功率高于满功率（存在真实控制裕量）: " + c.state.powerProxy.toFixed(3));
  assert(c.state.fuelTemperatureProxy > c.state.poolTemperatureProxy,
    "自限状态下燃料温度仍高于池水（热流方向正确）");
  // 该状态下 SCRAM 仍然有效
  c.scram();
  run(c, 5, 1 / 60);
  assert(c.state.rod.TRANS.pos < 0.02 && c.state.powerProxy < peak * 0.2,
    "三棒全提状态下 SCRAM 仍把功率和棒位压下来");
}

// ————————— 10. SOURCE 第二阶段：自由相机 / 玻璃砖地板 / 切伦科夫 —————————
{
  // —— CAM-001 / CAM-002 自由观察相机 ——
  const camera = new THREE.PerspectiveCamera(50, 1.6, CAM_LIMITS.near, CAM_LIMITS.far);
  const cam = createFreeCamera({ camera });
  cam.setHome({ pivot: new THREE.Vector3(0, 0.3, 0), yaw: 0, pitch: -0.6981, distance: 14 });
  cam.goHome();
  assert(camera.position.z > 0 && camera.position.y > 0.3,
    `初始机位在 +Z 上方（与旧固定机位一致）: ${camera.position.toArray().map(n => n.toFixed(2))}`);
  assert(cam.isHome(), "goHome() 后处于规范初始取景");

  // 解除方位/距离/高度限制：能转到池下方、能一路推进到堆芯附近
  // orbit() 用 pitch -= dy*speed：dy>0（向下拖）→ pitch 变负 = 俯视
  cam.orbit(0, 900);                         // 大幅下拖 → 俯仰到下限（接近正俯视）
  assert(cam.rig.pitch <= -CAM_LIMITS.maxPitch + 1e-6,
    `俯仰可到接近正俯视: ${cam.rig.pitch.toFixed(3)}`);
  cam.goHome();
  cam.orbit(0, -600);                        // 反向 → 机位降到 pivot 之下仰视，旧 rig 在 22° 仰角就被挡住
  assert(cam.rig.pitch >= CAM_LIMITS.maxPitch - 1e-6,
    `不再有 22° 最低仰角限位: ${cam.rig.pitch.toFixed(3)}`);

  cam.goHome();
  for (let i = 0; i < 40; i++) cam.zoom(-400);
  assert(cam.rig.distance <= CAM_LIMITS.minDistance + 1e-9,
    "连续缩放可以顶到最近距离（不再有 fit*0.32 的下限）");
  assert(Math.hypot(camera.position.x, camera.position.z) < 6.5,
    `顶到最近后机位已进到池口以内: r=${Math.hypot(camera.position.x, camera.position.z).toFixed(2)}`);

  // 进入水下与地下：飞行必须能穿过名义水面和地板标高
  cam.goHome();
  cam.rig.pitch = -Math.PI / 2 + 0.02; cam.apply();   // 朝下
  cam.fly(1, new Set(["w"]), true);
  cam.fly(1, new Set(["w"]), true);
  assert(camera.position.y < reactor.poolBounds.surfaceY,
    `自由飞行可以下到名义水面之下: y=${camera.position.y.toFixed(2)} < ${reactor.poolBounds.surfaceY}`);
  for (let i = 0; i < 6; i++) cam.fly(1, new Set(["w"]), true);
  assert(camera.position.y < UNDERGROUND_BOUNDS.ceilingY,
    `自由飞行可以下到地下设备层: y=${camera.position.y.toFixed(2)} < ${UNDERGROUND_BOUNDS.ceilingY}`);
  assert(camera.position.y >= CAM_LIMITS.minY - 1e-6, "但仍被世界包围盒兜住，不会飞到无穷远");

  // 平移（中键）与飞行都改 pivot，不改 distance
  cam.goHome();
  const d0 = cam.rig.distance;
  cam.pan(120, 60, 900);
  assert(Math.abs(cam.rig.distance - d0) < 1e-9 && cam.pivot.lengthSq() > 0,
    "中键平移只移动 pivot，不改变轨道距离");
  cam.goHome();
  assert(cam.isHome(), "任意漫游后都能回到规范初始取景");

  // Shift 只是速度倍率
  cam.goHome();
  const p1 = cam.pivot.clone();
  cam.fly(1, new Set(["w"]), false);
  const slow = cam.pivot.distanceTo(p1);
  cam.goHome();
  cam.fly(1, new Set(["w"]), true);
  const fast = cam.pivot.distanceTo(p1);
  assert(Math.abs(fast / slow - CAM_INPUT.flyBoost) < 1e-6,
    `Shift 是纯速度倍率: ${(fast / slow).toFixed(3)} == ${CAM_INPUT.flyBoost}`);
}

{
  // —— GLA-001 / GLA-002 / GLA-003 玻璃砖建筑与动态地板 ——
  // R-002：地板上**没有**"固定装饰砖"这一档。性能不靠取消功能来买（那会让远处
  // 地板不可抓、不可损伤、不可破碎），而是靠休眠 + 只同步醒着的实例。因此布局与
  // 视口/性能档无关：任何调用都返回同一批独立动态砖。
  const full = floorBrickLayout();
  const tiered = floorBrickLayout(15);
  const mobile = floorBrickLayout(10.5);
  assert(full.fixed === undefined && full.dynamic.length > 200,
    `地板上不存在固定砖档，全部格位都是动态砖: ${full.dynamic.length}`);
  assert(tiered.dynamic.length === full.dynamic.length &&
    mobile.dynamic.length === full.dynamic.length,
    `动态砖数量不随视口/性能档减少: ${mobile.dynamic.length} / ${tiered.dynamic.length} / ${full.dynamic.length}`);
  assert(full.dynamic.every((p, i) =>
    p.x === mobile.dynamic[i].x && p.z === mobile.dynamic[i].z),
    "移动端与桌面端拿到逐块一致的规范布局，没有整片被降级成不可移动地面");
  assert(full.dynamic.every(p => Math.hypot(p.x, p.z) >= GLASS_ARCH.poolClearR),
    "地板砖不侵入池口/屏蔽体让位半径");
  assert(Math.abs(full.restY - (GLASS_ARCH.floorTop - GLASS_ARCH.floorBrick[1] / 2)) < 1e-9,
    "规范初始布局的静止高度 = 地板顶面减半个砖厚（刷新即复位）");
  assert(GLASS_ARCH.supportTop <= full.restY - GLASS_ARCH.floorBrick[1] / 2 + 1e-9,
    `透明承托层顶面不高于砖底: ${GLASS_ARCH.supportTop} <= ${full.restY - GLASS_ARCH.floorBrick[1] / 2}`);
  assert(GLASS_ARCH.supportInnerR < GLASS_ARCH.poolClearR,
    "承托层内边在池口让位半径以内，不会在砖下留空");
  assert(GLASS_ARCH.supportOuterR >= GLASS_ARCH.hallHalf * Math.SQRT2,
    "承托层覆盖方形大厅四角");
  // 承托层只服务地板砖，不冒充池口安全格栅：两者高度与半径都不重叠
  assert(GLASS_ARCH.supportInnerR > reactor.grating.radius,
    `承托层不覆盖池口格栅: ${GLASS_ARCH.supportInnerR} > ${reactor.grating.radius}`);
}

{
  // —— CHR-001 / CHR-003 功率因果与有界曝光 ——
  assert(cherenkovIntensity(0.2, 0) === 0, "低功率（<100 kW 档）不常亮");
  assert(cherenkovIntensity(1.0, 0) > 0.99, "250 kW 稳态时稳态通道满亮");
  assert(cherenkovIntensity(0.1, 0.8) > cherenkovIntensity(0.1, 0),
    "低功率下的历史脉冲仍然照亮池水（独立毫秒功率通道）");
  assert(exposureGain(0.5) === 1, "膝点以下不压缩曝光");
  const g = exposureGain(3.0);
  assert(g < 1 && 3.0 * g < 1.6,
    `强脉冲经软压缩后峰值有界: 3.0 → ${(3.0 * g).toFixed(3)}`);
  assert(exposureGain(6.0) * 6.0 > exposureGain(3.0) * 3.0,
    "压缩是单调的：更强的输入仍然更亮，只是增益递减");

  const chr = createCherenkov({
    coreBounds: reactor.coreBounds, surfaceY: reactor.poolBounds.surfaceY,
    particleBudget: 200, intensityOf: s => cherenkovIntensity(s.powerProxy, s.pulsePowerProxy)
  });
  // physicalScene 每帧在 applyCamera 里调用这些方法。工厂少导出一个，整个场景就在
  // 首帧抛异常、页面空白——纯逻辑断言看不出来，所以在这里锁住 API 表面。
  ["update", "setViewer", "snapshot", "dispose"].forEach(fn =>
    assert(typeof chr[fn] === "function", `切伦科夫工厂导出 ${fn}()（physicalScene 每帧调用）`));
  assert(chr.group && chr.group.isObject3D, "切伦科夫工厂导出可挂载的 group");

  // 统一水体光程（CHR-002 / WTR-002）：同一个入口同时喂相机位置与连续浸没权重，
  // 离堆芯越远、穿过的水层越厚，透射率必须单调下降
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  chr.setViewer(V(0, -2.8, 4), 1);
  const near = chr.snapshot();
  chr.setViewer(V(0, 8, 20), 0);
  const far = chr.snapshot();
  assert(far.corePathLength > near.corePathLength && far.coreTransmittance < near.coreTransmittance,
    `水体光程随距离增长、透射率随之衰减: 近 ${near.corePathLength}/${near.coreTransmittance} → 远 ${far.corePathLength}/${far.coreTransmittance}`);
  assert(near.submersion === 1 && far.submersion === 0,
    `浸没权重与水面跨越读同一个连续量: ${near.submersion} / ${far.submersion}`);

  const shut = { powerProxy: 0, pulsePowerProxy: 0 };
  for (let i = 0; i < 120; i++) chr.update(1 / 60, shut);
  assert(chr.snapshot().particles === 0, "停堆时不发射粒子（池水里没有蓝点）");
  const full = { powerProxy: 1, pulsePowerProxy: 0 };
  for (let i = 0; i < 180; i++) chr.update(1 / 60, full);
  const snap = chr.snapshot();
  assert(snap.particles > 20, `250 kW 时粒子系统在工作: ${snap.particles}`);
  assert(snap.shown > 0.5, `250 kW 时辉光明显: ${snap.shown}`);
  const coreCenter = reactor.coreBounds.topY - reactor.coreBounds.height / 2;
  assert(Math.abs(snap.coreCenterY - coreCenter) < 1e-3,
    "辉光体积附着活性燃料段中心，不附着水面或相机");
  assert(coreCenter + reactor.coreBounds.height / 2 < reactor.poolBounds.surfaceY,
    "活性段整体浸没在水面之下");
  chr.dispose();
}

{
  // —— CTL-002 / CTL-003 双控制台共享同一个 session controller ——
  const c = createSessionController({});
  const calls = [];
  const auto = createAutoConsole({
    commands: { autoStart: () => { calls.push("auto"); return c.requestAuto(); },
      scram: () => { calls.push("scram"); return c.scram(); } }
  });
  const names = auto.hotspots.map(h => h.name);
  assert(names.includes("auto"), "AUTO 台有完整自动程序的入口控件");
  assert(names.includes("autoScram"), "AUTO 台有安全返回控件");
  assert(auto.hotspots.length === 2,
    `AUTO 台只有 AUTO 与安全返回两个控件，不建立第二套人工指令: ${names.join(",")}`);
  assert(AUTO_PHASE_ORDER.length === AUTO_PHASES.length &&
    AUTO_PHASE_ORDER.every((p, i) => p === AUTO_PHASES[i]),
    "AUTO 台的阶段塔与 autoProgram 的阶段序列一致");

  // 控制权互斥仍由 sessionController 唯一裁决
  c.unlock();
  auto.hotspots.find(h => h.name === "auto").press();
  assert(c.state.controlOwner === "AUTO", "AUTO 台的方钮把控制权交给自动程序");
  auto.hotspots.find(h => h.name === "autoScram").press();
  assert(c.state.controlOwner === "MANUAL" && c.state.scrammed,
    "AUTO 台的安全返回走同一个 scram()，因此原位接管为 MANUAL");
  auto.update(c.state, 1 / 60);   // 不抛异常即可（几何更新只读状态）
  auto.dispose();
}

{
  // —— LAB-001 / LAB-002 / LAB-004 地面设备：拓扑闭合与状态驱动 ——
  const ids = new Set(LAB_COMPONENTS.map(c => c.id));
  const ugIds = new Set(PLANT_COMPONENTS.map(c => c.id));
  const EXTERNAL = new Set(["site", "pool", "hall", "stack", "bridge", "earth",
    "rodSHIM", "rodREG", "rodTRANS"]);
  const dangling = LAB_COMPONENTS.filter(c =>
    !(ids.has(c.up) || ugIds.has(c.up) || EXTERNAL.has(c.up)) ||
    !(ids.has(c.down) || ugIds.has(c.down) || EXTERNAL.has(c.down)));
  assert(dangling.length === 0,
    `地面设备的上下游都落在实体上（同层、地下层或场外接口），没有停在半空: ${
      dangling.map(c => c.id).join(",") || "none"}`);
  assert(LAB_COMPONENTS.every(c => ["SOURCE_VERIFIED", "TRIGA_ANALOGUE", "REALTIME_PROXY",
    "SOURCE_ART_DIRECTION"].includes(c.tag)), "每台地面设备都带资料标签");

  // 锁定拓扑：三回路两台换热器，两台都在地下；地面不得再出现第三台
  const hx = PLANT_COMPONENTS.filter(c => /heatExchanger/i.test(c.name));
  assert(hx.length === 2, `两台换热器全部在地下设备层: ${hx.map(c => c.id).join(",")}`);
  assert(!LAB_COMPONENTS.some(c => /heatExchanger|换热/i.test(c.name)),
    "地面设备清单里没有第四回路/第三台换热器一类无来源设备");

  // —— R-001：三条回路各自闭合，且**遍历真实场景对象**而不是只统计注册表名单 ——
  const plantR1 = createUndergroundPlant({});
  const reactorR1 = createReactorModel({ reduceMotion: false });
  const byId = new Map(PLANT_COMPONENTS.map(c => [c.id, c]));

  // 1) 全场只有两台换热器实体：地下两台命名对象，池体一侧一台都没有
  const hxNodes = [];
  plantR1.group.traverse(o => { if (/^UG-H\d+$/.test(o.name)) hxNodes.push(o.name); });
  assert(hxNodes.length === 2 && hxNodes.includes("UG-H01") && hxNodes.includes("UG-H02"),
    `地下层的换热器实体正好两台: ${hxNodes.join(",") || "none"}`);
  let poolSideHx = 0;
  reactorR1.group.traverse(o => { if (/hx|heatExchanger|换热/i.test(o.name || "")) poolSideHx++; });
  assert(poolSideHx === 0,
    `reactorModel 只保留池内取/回水接管，不再重复建模换热器: ${poolSideHx} 个残留`);

  // 2) 每台换热器都有可检查的双侧四端口，且两侧不共用任何端口
  assert(HEAT_EXCHANGERS.length === 2, `换热器端口表覆盖且仅覆盖两台: ${HEAT_EXCHANGERS.length}`);
  for (const h of HEAT_EXCHANGERS) {
    const sides = Object.keys(h.sides);
    assert(sides.length === 2, `${h.id} 是双侧设备: ${sides.join("/")}`);
    const ports = sides.flatMap(s => [h.sides[s].in, h.sides[s].out]);
    assert(new Set(ports).size === 4, `${h.id} 四个端口互不相同（两侧不串流）: ${ports.join(",")}`);
    assert(plantR1.group.getObjectByName(h.id),
      `${h.id} 在场景里有同名实体对象`);
  }

  // 3) 三条流路逐段闭合：每一步的下游必须真的是下一段的上游，最后回到起点
  const EXT = new Set(["pool", "site"]);
  for (const [loop, chain] of Object.entries(COOLANT_LOOPS)) {
    assert(chain[0] === chain[chain.length - 1], `${loop} 回路首尾同一节点（闭合）: ${chain[0]}`);
    for (let i = 0; i < chain.length - 1; i++) {
      const from = chain[i], to = chain[i + 1];
      if (EXT.has(from) || EXT.has(to)) continue;
      const hxHere = HEAT_EXCHANGERS.find(h => h.id === from);
      // 换热器按“本回路那一侧”的出口续接，而不是按扁平 down 字段
      const nextOf = hxHere ? hxHere.sides[loop].out : (byId.get(from) || {}).down;
      assert(nextOf === to, `${loop}: ${from} 的下游是 ${to}（实际 ${nextOf}）`);
      assert(plantR1.group.getObjectByName(to) || EXT.has(to),
        `${loop}: 节点 ${to} 在场景里有同名实体对象`);
    }
  }

  // 4) 中间回路是**隔离**回路：它不接场外，三回路也不接池水
  assert(!COOLANT_LOOPS.INTERMEDIATE.includes("site") && !COOLANT_LOOPS.INTERMEDIATE.includes("pool"),
    `中间回路既不进池也不出场，只在两台换热器之间闭合: ${COOLANT_LOOPS.INTERMEDIATE.join("→")}`);
  assert(!COOLANT_LOOPS.TERTIARY.includes("pool") && COOLANT_LOOPS.PRIMARY.includes("pool"),
    "三回路只接场外冷源，一回路只接池水");
  const shared = COOLANT_LOOPS.INTERMEDIATE.filter(n => COOLANT_LOOPS.TERTIARY.includes(n));
  assert(shared.length === 1 && shared[0] === "UG-H02",
    `中间回路与三回路唯一的共同节点是换热器 UG-H02: ${shared.join(",")}`);
  const shared2 = COOLANT_LOOPS.PRIMARY.filter(n => COOLANT_LOOPS.INTERMEDIATE.includes(n));
  assert(shared2.length === 1 && shared2[0] === "UG-H01",
    `一回路与中间回路唯一的共同节点是换热器 UG-H01: ${shared2.join(",")}`);

  // —— R-005：首次有效交互前，地下设备层不推进任何状态 ——
  const idleCtl = createSessionController({});
  const ugBefore = plantR1.snapshot();
  for (let i = 0; i < 120 * 60; i++) plantR1.update(idleCtl.state, 1 / 60);   // 未解锁 120 s
  const ugAfter = plantR1.snapshot();
  const drifted = Object.keys(ugBefore).filter(k => ugBefore[k] !== ugAfter[k]);
  assert(!idleCtl.state.unlocked, "该断言的前提：会话时钟仍未释放");
  assert(drifted.length === 0,
    `未解锁 120 秒后地下设备的动态状态全部保持初值: 漂移=${drifted.join(",") || "none"}`);
  assert(ugAfter.sumpLevel === 0 && ugAfter.sumpPumpSpin === 0,
    `集水液位与集水泵在联锁复位期间真的不动: level=${ugAfter.sumpLevel} spin=${ugAfter.sumpPumpSpin}`);
  assert(ugAfter.purifyBeadPhase === 0,
    `净化支路没有无来源的常开定值流量: phase=${ugAfter.purifyBeadPhase}`);

  // 解锁并带流量运行后，同一批设备才按上游状态推进
  idleCtl.unlock();
  idleCtl.startup();
  idleCtl.pumpToggle();         // 一回路泵起来才有冷却剂流量（流向光珠读同一个代理）
  for (let i = 0; i < 600; i++) {
    idleCtl.update(1 / 60);
    plantR1.update(idleCtl.state, 1 / 60);
  }
  const running = plantR1.snapshot();
  assert(running.sumpLevel > 0 && running.primaryBeadPhase !== ugAfter.primaryBeadPhase,
    `解锁并有流量后集水与流向光珠才推进: level=${running.sumpLevel} bead=${running.primaryBeadPhase}`);
  assert(running.interReturnBeadPhase !== 0,
    `中间回路回程总管有独立的流向表现: ${running.interReturnBeadPhase}`);
  plantR1.dispose?.();
  reactorR1.dispose?.();

  // 跨层对接：地面的排水立管与取样管必须真的接到地下的部件上
  const drain = LAB_COMPONENTS.find(c => c.id === "LAB-D01");
  const samp = LAB_COMPONENTS.find(c => c.id === "LAB-Q02");
  assert(drain && ugIds.has(drain.down), `溢流排空接地下集水坑: ${drain.down}`);
  assert(samp && ugIds.has(samp.down), `取样管接地下净化支路: ${samp.down}`);

  // 状态驱动（LAB-004）：未解锁时通风不转、补给不动作
  const lab = createLabEnvironment({});
  const c = createSessionController({});
  for (let i = 0; i < 60; i++) lab.update(c.state, 1 / 60);
  const idle = lab.snapshot();
  assert(idle.ventSpeed === 0 && idle.ahuSpin === 0,
    `会话时钟未释放时通风机组真的停住: vent=${idle.ventSpeed}`);
  assert(idle.rodBars.every(v => v <= 0.002),
    `停堆时棒行程指示条在底部: ${idle.rodBars.join(",")}`);
  assert(idle.annunciator[0] > 0.4 && idle.annunciator[1] <= 0.1,
    `独立安全柱：停堆灯亮、供电灯灭: ${idle.annunciator.slice(0, 2).join(",")}`);

  // 解锁并提棒运行：通风转起来、棒指示条跟随真实棒位、控制权灯点亮
  c.unlock();
  c.startup();
  c.rodStart("SHIM", 1);
  for (let i = 0; i < 600; i++) { c.update(1 / 60); lab.update(c.state, 1 / 60); }
  const run = lab.snapshot();
  assert(run.ventSpeed > 0.3 && run.ahuSpin !== 0,
    `供电后通风机组按池水温度转起来: vent=${run.ventSpeed}`);
  assert(Math.abs(run.rodBars[0] - c.state.rod.SHIM.pos) < 0.01,
    `棒驱动柜指示条高度 = 真实棒位（不是独立动画）: ${run.rodBars[0]} vs ${c.state.rod.SHIM.pos.toFixed(3)}`);
  assert(run.annunciator[1] > 0.5 && run.annunciator[0] <= 0.1,
    `独立安全柱：运行时供电灯亮、停堆灯灭: ${run.annunciator.slice(0, 2).join(",")}`);
  assert(run.annunciator[3] > 0.2, "独立安全柱显示当前控制权归属（MANUAL 已接管）");
  assert(run.makeupLevel < 0.86 || run.makeupRunning,
    `补给贮罐液位随蒸发下降 / 或补给泵已启动: ${run.makeupLevel}`);

  // SCRAM 后停堆灯回来，控制权仍是 MANUAL
  c.scram();
  for (let i = 0; i < 30; i++) { c.update(1 / 60); lab.update(c.state, 1 / 60); }
  const after = lab.snapshot();
  assert(after.annunciator[0] > 0.4, "SCRAM 后独立安全柱的停堆灯立即恢复");
  assert(after.rodBars.every(v => v <= 0.05), "SCRAM 后三条棒行程指示条都落回底部");
  lab.dispose();
}

// ——————————————————————————— 帧步长与流向光珠相位（回归） ———————————————————————————
// 浏览器实测缺陷：rAF 回调的时间戳是本帧开始时刻，可能早于 start() 里刚记下的
// performance.now()，于是首帧 dt 为负；负相位让 CatmullRomCurve3.getPointAt 索引到
// points[-1] 并抛出 TypeError，异常逃出 rAF 回调后整个渲染循环永久停住。
{
  assert(frameDelta(1000, 1016) === 0, "rAF 时间戳早于 last 时步长夹为 0，不倒着积分");
  assert(frameDelta(1016, 1000) > 0.0159 && frameDelta(1016, 1000) < 0.0161,
    `正常帧步长按秒换算: ${frameDelta(1016, 1000)}`);
  assert(frameDelta(9000, 1000) === 0.05, "长时间挂起后步长夹到上限 0.05");
  assert(frameDelta(undefined, 1000) === 0 && frameDelta(NaN, 0) === 0,
    "非有限时间戳退化为 0 步长，不把 NaN 传进积分器");

  assert(wrap01(-0.0001) > 0.999 && wrap01(-0.0001) < 1, `负相位折回 [0,1): ${wrap01(-0.0001)}`);
  assert(wrap01(-2.25) === 0.75, `多圈负相位折回 [0,1): ${wrap01(-2.25)}`);
  assert(wrap01(1) === 0 && wrap01(3.5) === 0.5, "正相位仍按周期折回");
  assert(wrap01(NaN) === 0 && wrap01(Infinity) === 0, "非有限相位退化为 0");
  for (let i = -50; i <= 50; i++) {
    const v = wrap01(i * 0.137);
    if (!(v >= 0 && v < 1)) { assert(false, `wrap01 越界: ${i * 0.137} -> ${v}`); break; }
  }
  assert(true, "wrap01 在正负扫描下始终落在 [0,1)，曲线参数不会越界");

  // 端到端：负步长 + 满流量喂给地下厂房，不得抛异常（等价于首帧的真实时序）
  const plant = createUndergroundPlant({ reduceMotion: false });
  const negState = { coolantFlowProxy: 1, poolTemperatureProxy: 0.5, unlocked: true, powerProxy: 1 };
  let threw = null;
  try {
    plant.update(negState, frameDelta(1000, 1016));
    for (let i = 0; i < 5; i++) plant.update(negState, 1 / 60);
  } catch (e) { threw = e; }
  assert(threw === null, `首帧负步长不再让地下厂房抛异常: ${threw && threw.message}`);
  plant.dispose?.();
}

// —— CAM-002：任何宽高比下的初始机位都必须留在玻璃建筑内部 ——
// 纯几何 fit 距离在竖直窄视口上会把相机顶到天花板之上/墙外，初始画面只剩贴脸的
// 玻璃砖（768×1024 与 390×844 实测如此）。homeFitDistance 按大厅净空封顶。
{
  const A = { fovDeg: 50, radiusV: 7.0, radiusH: 6.2, elevationDeg: 40, targetY: 0.3,
    ceilingLimitY: 12.0 - 0.8, wallLimit: 22 - 1.5 };
  const elev = (A.elevationDeg * Math.PI) / 180;
  const desktop = homeFitDistance({ ...A, aspect: 1440 / 900 });
  assert(Math.abs(desktop - 16.563) < 0.01,
    `桌面 1440×900 初始取景距离不变: ${desktop.toFixed(3)}`);
  for (const [w, h] of [[768, 1024], [390, 844], [360, 900], [1440, 900], [1920, 1080]]) {
    const d = homeFitDistance({ ...A, aspect: w / h });
    const camY = A.targetY + d * Math.sin(elev);
    const camZ = d * Math.cos(elev);
    assert(camY <= A.ceilingLimitY + 1e-6,
      `${w}×${h} 初始机位在天花板玻璃之下: y=${camY.toFixed(2)}`);
    assert(camZ <= A.wallLimit + 1e-6,
      `${w}×${h} 初始机位在墙玻璃之内: z=${camZ.toFixed(2)}`);
    assert(d > 0 && d <= CAM_LIMITS.maxDistance,
      `${w}×${h} 初始取景距离有界: ${d.toFixed(2)}`);
  }
}

// —— 声音的手势门控与事件驱动（SOURCE_SCENE.md §7.5）——
// 听感需要声卡，无法在这里验证；但"首次手势之前不建 AudioContext"、"解锁后才发声"、
// "发声次数只随真实物理事件增长"和"节流/voice 上限"是纯逻辑，可以机械检查。
// 用一个最小 AudioContext 桩：只记录被创建的节点数与 resume 次数。
{
  let nodes = 0, resumes = 0, clock = 0;
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; }
  });
  const node = (extra = {}) => { nodes++; return { connect() {}, disconnect() {}, ...extra }; };
  class StubAudioContext {
    constructor() { this.state = "suspended"; this.sampleRate = 48000; this.destination = node(); }
    get currentTime() { return clock; }   // 测试可推进的桩时钟
    resume() { resumes++; this.state = "running"; }
    suspend() { this.state = "suspended"; }
    close() { this.state = "closed"; }
    createGain() { return node({ gain: param() }); }
    createDynamicsCompressor() {
      return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() });
    }
    createBiquadFilter() { return node({ type: "", frequency: param(), Q: param() }); }
    createStereoPanner() { return node({ pan: param() }); }
    createOscillator() { return node({ type: "", frequency: param(), start() {}, stop() {} }); }
    createBufferSource() {
      return node({ buffer: null, loop: false, playbackRate: param(), start() {}, stop() {} });
    }
    createBuffer(_ch, len) { return { getChannelData: () => new Float32Array(len) }; }
  }
  const prevWindow = globalThis.window;
  globalThis.window = { AudioContext: StubAudioContext };
  const { createGlassAudio } = await import("../src/scenes/reactor/glassAudio.js");
  const { createReactorAudio } = await import("../src/scenes/reactor/reactorAudio.js");

  const ga = createGlassAudio();
  const ra = createReactorAudio();
  assert(ga && ra, "有 AudioContext 时两条音频链路都被创建");

  // 首次手势之前：没有 AudioContext，因此不可能被浏览器判为自动播放
  assert(ga.status().state === "NONE" && ga.status().unlocked === false,
    `解锁前玻璃音频无 AudioContext: ${ga.status().state}`);
  assert(ra.status().state === "NONE" && ra.status().unlocked === false,
    `解锁前反应堆音频无 AudioContext: ${ra.status().state}`);
  assert(nodes === 0, `解锁前不创建任何音频节点: ${nodes}`);

  // 解锁前的物理事件不发声（onPointerDown 之前的加载落位不能出声）
  ga.impact({ strength: 1, velocity: 1, pan: 0 });
  ga.crackTick(0);
  ga.fracture(0);
  const before = ga.status().fired;
  assert(before.impact === 0 && before.crack === 0 && before.fracture === 0,
    `解锁前物理事件不发声: ${JSON.stringify(before)}`);

  // 首次手势 → 建链路并 resume
  ga.unlock(); ra.unlock();
  assert(ga.status().unlocked && ga.status().state === "running",
    `手势后玻璃音频 running: ${ga.status().state}`);
  assert(ra.status().unlocked && ra.status().state === "running",
    `手势后反应堆音频 running: ${ra.status().state}`);
  assert(resumes === 2, `两条链路各 resume 一次: ${resumes}`);
  assert(nodes > 0, `手势后才创建音频节点: ${nodes}`);

  // 解锁后：撞击发声，且弱撞击被阈值滤掉。
  // 先把桩时钟推过一个最小间隔——lastImpact 初值为 0，真实 AudioContext 的
  // currentTime 也从 0 起，所以"页面刚解锁那一瞬间的撞击"本来就会被节流吃掉。
  clock += 0.05;
  ga.impact({ strength: 1, velocity: 1, pan: 0 });
  assert(ga.status().fired.impact === 1, `解锁后撞击发声: ${ga.status().fired.impact}`);
  ga.impact({ strength: 0.01, velocity: 1, pan: 0 });
  assert(ga.status().fired.impact === 1,
    `低于阈值的撞击不发声: ${ga.status().fired.impact}`);

  // 全局节流：currentTime 不前进时后续撞击被压掉
  for (let i = 0; i < 20; i++) ga.impact({ strength: 1, velocity: 1, pan: 0 });
  assert(ga.status().fired.impact === 1,
    `同一时刻的密集撞击被节流: ${ga.status().fired.impact}`);

  // voice 上限：桩时钟每次都跨过最小间隔，节流不再拦截，此时只剩 voice 上限起作用。
  // 桩不会真的触发 onended，所以 activeVoices 永不回落——正好是最坏情况。
  const maxV = ga.status().maxVoices;
  const minGap = ga.status().minInterval;
  for (let i = 0; i < maxV + 6; i++) {
    clock += minGap * 2;
    ga.impact({ strength: 1, velocity: 1, pan: 0 });
  }
  assert(ga.status().voices === maxV, `活动 voice 顶到上限即停: ${ga.status().voices}/${maxV}`);
  assert(ga.status().fired.impact === maxV,
    `超出上限的撞击不再发声: ${ga.status().fired.impact}/${maxV}`);

  // 破碎是独立事件，与撞击分开计数
  ga.fracture(0); ga.crackTick(0);
  assert(ga.status().fired.fracture === 1 && ga.status().fired.crack === 1,
    `破碎/裂纹独立计数: ${JSON.stringify(ga.status().fired)}`);

  ga.dispose(); ra.dispose();
  if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? "ALL LOGIC CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
