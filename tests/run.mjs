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
  FULL_POWER, PULSE_POWER_LIMIT, POWER_TRIP
} from "../src/scenes/reactor/sessionController.js";
import {
  createDamageState, registerImpact, buildFragmentGeometries, impactEnergy
} from "../src/scenes/reactor/glassDamage.js";
import { createReactorModel } from "../src/scenes/reactor/reactorModel.js";
import { createWaterSystem, cherenkovIntensity } from "../src/scenes/reactor/waterSystem.js";
import { HALL_BOUNDS, HALL_COLLIDERS } from "../src/scenes/reactor/labEnvironment.js";

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
  // 相机不穿墙 / 玻璃不无限下坠所依赖的常量（改厂房尺寸时在这里失败）
  const CAM_MAX_DISTANCE = 19;                    // physicalScene layout() 缩放上限
  const CAM_MIN_ELEVATION = (22 * Math.PI) / 180; // physicalScene orbit.minElevation
  const FLOOR_RING_FACTOR = 1.5;                  // physicalScene hallFloor 外半径系数
  assert(HALL_BOUNDS.half > 0 && HALL_BOUNDS.ceiling > 0, "厂房净空为正");
  assert(CAM_MAX_DISTANCE * Math.cos(CAM_MIN_ELEVATION) < HALL_BOUNDS.half,
    `最远机位在最低仰角下仍在墙内: ${(CAM_MAX_DISTANCE * Math.cos(CAM_MIN_ELEVATION)).toFixed(2)} < ${HALL_BOUNDS.half}`);
  assert(HALL_BOUNDS.half < HALL_COLLIDERS.wallInner, "相机水平限位比墙碰撞面更靠内");
  assert(HALL_BOUNDS.ceiling > reactor.poolBounds.surfaceY, "相机天花限位高于水面");
  assert(FLOOR_RING_FACTOR >= Math.SQRT2, "楼板扇环覆盖方形大厅四角");
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
  // 保护回路：人工把三根棒全提出来不会停在“无限升功率”状态
  const c = freshUnlocked();
  c.startup();
  ["SHIM", "REG", "TRANS"].forEach(n => c.rodStart(n, +1));
  run(c, 60, 1 / 60);
  assert(c.state.protectionTrips >= 1, "越过高功率整定值触发保护回路自动 SCRAM");
  assert(c.state.scrammed && c.state.powerProxy < POWER_TRIP,
    "保护动作后已停堆且功率回落: " + c.state.powerProxy.toFixed(3));
  assert(c.state.powerProxy <= 2.6, "功率始终有界");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(failures === 0 ? "ALL LOGIC CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
