// SOURCE 会话与连续运行控制器。
//
// 定义 REACTOR_POOL_SYSTEM.md §4 的八个可测试阶段：
//   INTERLOCKED_RESET → AUXILIARIES_READY → LOW_POWER_APPROACH → PULSE_ARMED
//   → PULSE → POST_PULSE_HEAT_TRANSFER → STEADY_POWER_ASCENT → FULL_POWER_EQUILIBRIUM
//
// 本模块只负责“状态如何演化”，不接触 three.js / cannon-es 对象；reactorModel、
// waterSystem、physicalScene 读取本模块产出的状态并各自渲染/求解。
//
// 求解层级标签（REACTOR_POOL_SYSTEM.md §8）：
//   - 棒位是明确的目标追踪运动（TUNED_PRESENTATION：把资料给出的真实速度/时长压缩到
//     网页可观察的秒级，但顺序、方向和相对快慢关系不变）；
//   - reactivityProxy/powerProxy/temperatureProxy/coolantFlowProxy 是一阶弛豫代理
//     （REALTIME_PROXY，不是点堆动力学或热工水力求解）；
//   - PULSE 的功率峰值使用解析闭式高斯函数，在阶段内的任意采样时刻都能算出正确值，
//     不依赖逐帧积分，因此不会因帧率变化丢失峰值或改变脉冲能量（毫秒脉冲层）；
//   - 脉冲注入燃料的总能量在阶段切换时一次性以闭式常数加入，同样不随帧率变化。
//
// 所有数值都是教育性视觉代理，不是核工程计算结果。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

export const PHASES = [
  "INTERLOCKED_RESET",
  "AUXILIARIES_READY",
  "LOW_POWER_APPROACH",
  "PULSE_ARMED",
  "PULSE",
  "POST_PULSE_HEAT_TRANSFER",
  "STEADY_POWER_ASCENT",
  "FULL_POWER_EQUILIBRIUM"
];

// 阶段时长（秒）。INTERLOCKED_RESET 和 FULL_POWER_EQUILIBRIUM 为 Infinity（等待
// 外部事件/无限期保持）。数值是 TUNED_PRESENTATION：把资料记录的真实时间尺度
// （棒以 0.5 cm/s 抽出需要数分钟、池水升温需要数小时）压缩到可观察的秒级，但保持
// 「棒位变化快于功率响应，功率响应快于池水整体升温」的相对时间尺度顺序。
const DURATIONS = {
  INTERLOCKED_RESET: Infinity,
  AUXILIARIES_READY: 2.2,
  LOW_POWER_APPROACH: 5.5,
  PULSE_ARMED: 1.4,
  PULSE: 1.0,
  POST_PULSE_HEAT_TRANSFER: 4.5,
  STEADY_POWER_ASCENT: 6.0,
  FULL_POWER_EQUILIBRIUM: Infinity
};

// —— 棒物理常量（REALTIME_PROXY，压缩自 §3.2 的 0.5 cm/s 齿条速度与 TRANS 气动行程）——
const SHIM_SPEED = 1 / 5.0;      // 全行程秒数（LOW_POWER_APPROACH 内完成粗抽）
const REG_SPEED = 1 / 5.5;
const SHIM_ASCENT_SPEED = 1 / 7.0;
const REG_ASCENT_SPEED = 1 / 2.2;
const TRANS_EJECT_TIME = 0.12;   // TRANS 气动瞬发抽出耗时（秒），刻意远快于其余棒
const TRANS_DWELL = 0.15;        // 抽出到底后的短暂停留
const TRANS_REINSERT_TIME = 1.1; // 安全逻辑控制下的插入回位

// —— 反应性/功率模型常量（REALTIME_PROXY）——
const R_SHIM = 0.7;
const R_REG = 0.3;
const CRIT_THRESHOLD = 0.40;      // 低于此反应性代理不产生可观察稳态功率
const REF_REACTIVITY = 0.795;     // 250 kW 运行棒位对应的参考反应性代理
const FEEDBACK_GAIN = 0.35;       // UZrH 负温度反馈（方向为 SOURCE_VERIFIED，幅度为 REALTIME_PROXY）
const POWER_LAG = 0.9;            // powerProxy 追踪 target 的弛豫速率 (1/s)
const LOW_POWER_TARGET = 0.00035; // 脉冲前功率上限代理，< 100 W / 250 kW 的资料约束

const FUEL_RATE = 0.6;
const POOL_RATE = 0.05;
const FLOW_RATE = 0.4;
const PULSE_FUEL_BUMP = 0.62;     // 闭式脉冲能量注入燃料代理的固定增量

// PULSE 阶段内解析高斯（对相位内实时秒 t 求值，不做逐帧积分）
const PULSE_T0 = TRANS_EJECT_TIME + TRANS_DWELL * 0.3;
const PULSE_SIGMA = 0.045;

function gaussian(t, t0, sigma) {
  const d = (t - t0) / sigma;
  return Math.exp(-0.5 * d * d);
}

function moveToward(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

export function createSessionController({ reduceMotion } = {}) {
  const state = {
    phase: "INTERLOCKED_RESET",
    phaseElapsed: 0,
    unlocked: false,
    sceneClockRunning: false,
    gratingLocked: true, // S-003：格栅始终放下并锁定，本轮运行程序不解锁它
    rod: {
      SHIM: { pos: 0, target: 0 },
      TRANS: { pos: 0, target: 0 },
      REG: { pos: 0, target: 0 }
    },
    reactivityProxy: 0,
    powerProxy: 0,          // 0..1 归一化，代表 0..250 kW 稳态标度
    pulsePowerProxy: 0,      // 0..1 归一化，代表 0..250 MW 脉冲标度（独立通道，见模块顶部注释）
    fuelTemperatureProxy: 0,
    poolTemperatureProxy: 0.15,
    coolantFlowProxy: 0.1,
    pulseId: 0,
    pulseArmed: false,
    scramState: "none",
    transPulseClock: null // PULSE 进入后开始计时，跨越 PULSE→POST_PULSE 边界
  };

  // 事件队列：unlock() 和 update() 都可能 emit；update() 在末尾“取走并清空”，
  // 这样 unlock() 内产生的首个 phase_enter 事件不会在下一次 update() 开头被提前清掉。
  let pendingEvents = [];
  const emit = (type, payload) => pendingEvents.push({ type, ...payload });

  const enterPhase = (name) => {
    state.phase = name;
    state.phaseElapsed = 0;
    emit("phase_enter", { phase: name });
    if (name === "PULSE") {
      state.pulseId += 1;
      state.transPulseClock = 0;
      emit("pulse_start", { pulseId: state.pulseId });
    }
    if (name === "PULSE_ARMED") state.pulseArmed = true;
    if (name === "POST_PULSE_HEAT_TRANSFER") state.pulseArmed = false;
  };

  const unlock = () => {
    if (state.unlocked) return;
    state.unlocked = true;
    state.sceneClockRunning = true;
    enterPhase("AUXILIARIES_READY");
  };

  function stepRods(dt) {
    const r = state.rod;
    switch (state.phase) {
      case "AUXILIARIES_READY": {
        // 机构确认动作：小幅摆动确认后回零，不构成真正棒位变化。
        const p = clamp(state.phaseElapsed / DURATIONS.AUXILIARIES_READY, 0, 1);
        const twitch = Math.sin(p * Math.PI) * 0.03;
        r.SHIM.pos = twitch; r.REG.pos = twitch * 0.6; r.TRANS.pos = 0;
        break;
      }
      case "LOW_POWER_APPROACH": {
        r.SHIM.target = 0.5;
        r.REG.target = 0.35;
        r.SHIM.pos = moveToward(r.SHIM.pos, r.SHIM.target, SHIM_SPEED * dt);
        r.REG.pos = moveToward(r.REG.pos, r.REG.target, REG_SPEED * dt);
        r.TRANS.pos = 0;
        break;
      }
      case "PULSE_ARMED": {
        // 其余棒保持不动；TRANS 只做压力就绪的视觉确认（不改变棒位）。
        r.TRANS.pos = 0;
        break;
      }
      case "PULSE": {
        const t = state.transPulseClock;
        if (t < TRANS_EJECT_TIME) {
          r.TRANS.pos = clamp(t / TRANS_EJECT_TIME, 0, 1);
        } else if (t < TRANS_EJECT_TIME + TRANS_DWELL) {
          r.TRANS.pos = 1;
        } else {
          const rt = (t - TRANS_EJECT_TIME - TRANS_DWELL) / TRANS_REINSERT_TIME;
          r.TRANS.pos = clamp(1 - rt, 0, 1);
        }
        break;
      }
      case "POST_PULSE_HEAT_TRANSFER": {
        if (state.transPulseClock !== null) {
          const t = state.transPulseClock;
          const rt = (t - TRANS_EJECT_TIME - TRANS_DWELL) / TRANS_REINSERT_TIME;
          r.TRANS.pos = clamp(1 - rt, 0, 1);
          if (rt >= 1) state.transPulseClock = null;
        }
        break;
      }
      case "STEADY_POWER_ASCENT": {
        r.SHIM.target = 0.9;
        const fine = 0.55 + Math.sin(state.phaseElapsed * 1.6) * 0.08;
        r.REG.target = fine;
        r.SHIM.pos = moveToward(r.SHIM.pos, r.SHIM.target, SHIM_ASCENT_SPEED * dt);
        r.REG.pos = moveToward(r.REG.pos, r.REG.target, REG_ASCENT_SPEED * dt);
        r.TRANS.pos = 0;
        break;
      }
      case "FULL_POWER_EQUILIBRIUM": {
        r.SHIM.target = 0.9 + Math.sin(state.phaseElapsed * 0.05) * 0.01;
        const fine = 0.55 + Math.sin(state.phaseElapsed * 0.9) * 0.05;
        r.REG.target = fine;
        r.SHIM.pos = moveToward(r.SHIM.pos, r.SHIM.target, SHIM_ASCENT_SPEED * dt * 0.4);
        r.REG.pos = moveToward(r.REG.pos, r.REG.target, REG_ASCENT_SPEED * dt);
        r.TRANS.pos = 0;
        break;
      }
      default:
        break;
    }
  }

  function stepThermalAndPower(dt) {
    const r = state.rod;
    state.reactivityProxy = R_SHIM * r.SHIM.pos + R_REG * r.REG.pos - FEEDBACK_GAIN * state.fuelTemperatureProxy;

    let powerTarget;
    if (state.phase === "LOW_POWER_APPROACH" || state.phase === "PULSE_ARMED") {
      const p = clamp(state.phaseElapsed / DURATIONS[state.phase], 0, 1);
      powerTarget = LOW_POWER_TARGET * (state.phase === "LOW_POWER_APPROACH" ? p : 1);
    } else if (state.phase === "PULSE" || state.phase === "AUXILIARIES_READY" || state.phase === "INTERLOCKED_RESET") {
      powerTarget = 0;
    } else {
      const raw = (state.reactivityProxy - CRIT_THRESHOLD) / (REF_REACTIVITY - CRIT_THRESHOLD);
      powerTarget = Math.pow(clamp(raw, 0, 1.05), 1.4);
    }
    state.powerProxy += (powerTarget - state.powerProxy) * clamp(POWER_LAG * dt, 0, 1);

    // 脉冲功率通道：只在 PULSE 阶段由解析高斯驱动，闭式求值不依赖帧率。
    if (state.phase === "PULSE" && state.transPulseClock !== null) {
      state.pulsePowerProxy = gaussian(state.transPulseClock, PULSE_T0, PULSE_SIGMA);
    } else {
      state.pulsePowerProxy += (0 - state.pulsePowerProxy) * clamp(4 * dt, 0, 1);
    }

    const fuelTarget = state.powerProxy * 0.5;
    state.fuelTemperatureProxy += (fuelTarget - state.fuelTemperatureProxy) * clamp(FUEL_RATE * dt, 0, 1);

    const poolTarget = clamp(0.15 + state.powerProxy * 0.6 - state.coolantFlowProxy * 0.15, 0.1, 0.85);
    state.poolTemperatureProxy += (poolTarget - state.poolTemperatureProxy) * clamp(POOL_RATE * dt, 0, 1);

    const ascentActive = state.phase === "STEADY_POWER_ASCENT" || state.phase === "FULL_POWER_EQUILIBRIUM";
    const flowTarget = 0.12 + clamp(state.fuelTemperatureProxy - state.poolTemperatureProxy, 0, 1) * 0.5
      + (ascentActive ? 0.35 : 0);
    state.coolantFlowProxy += (flowTarget - state.coolantFlowProxy) * clamp(FLOW_RATE * dt, 0, 1);
  }

  function checkTransition() {
    const dur = DURATIONS[state.phase];
    if (dur === Infinity) return;
    if (state.phaseElapsed < dur) return;
    const idx = PHASES.indexOf(state.phase);
    if (idx < 0 || idx >= PHASES.length - 1) return;
    enterPhase(PHASES[idx + 1]);
  }

  const drain = () => { const out = pendingEvents; pendingEvents = []; return out; };

  const update = (dt) => {
    if (!state.unlocked) return drain();
    state.phaseElapsed += dt;
    if (state.transPulseClock !== null) state.transPulseClock += dt;

    // 脉冲事件：机构反力经桥架/格栅传给玻璃，只在 TRANS 抽出瞬间触发一次固定冲量，
    // 不给玻璃随机速度。回位到座时再触发一次较小的止挡冲量。
    if (state.phase === "PULSE" && state.transPulseClock !== null) {
      if (!state._ejectFired && state.transPulseClock >= TRANS_EJECT_TIME) {
        state._ejectFired = true;
        emit("trans_eject_impulse", { magnitude: 1 });
        emit("trans_underwater_impulse", { magnitude: 1 });
      }
    } else {
      state._ejectFired = false;
    }
    if (state.transPulseClock !== null) {
      const seatT = TRANS_EJECT_TIME + TRANS_DWELL + TRANS_REINSERT_TIME;
      if (!state._reseatFired && state.transPulseClock >= seatT) {
        state._reseatFired = true;
        emit("trans_reseat_impulse", { magnitude: 0.35 });
      }
    } else {
      state._reseatFired = false;
    }

    stepRods(dt);
    stepThermalAndPower(dt);

    if (state.phase === "PULSE" && state.transPulseClock !== null &&
        !state._energyDeposited && state.transPulseClock >= DURATIONS.PULSE * 0.6) {
      // 闭式脉冲能量：一次性加入，不随积分步长变化（毫秒脉冲层，独立于渲染帧率）。
      state.fuelTemperatureProxy += PULSE_FUEL_BUMP;
      state._energyDeposited = true;
      emit("pulse_energy_deposited", { amount: PULSE_FUEL_BUMP });
    }
    if (state.phase !== "PULSE") state._energyDeposited = false;

    checkTransition();
    return drain();
  };

  return {
    state,
    unlock,
    update,
    isReduceMotion: () => !!reduceMotion
  };
}
