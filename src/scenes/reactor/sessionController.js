// SOURCE 反应堆运行控制器 —— 由操作员手动驱动的实时反应堆模型。
//
// 本模块只负责“反应堆状态如何随操作员指令和物理反馈演化”，不接触 three.js /
// cannon-es 对象；reactorModel、waterSystem、controlConsole、physicalScene 读取
// 本模块产出的状态并各自渲染/求解。
//
// —— 物理层级（教育性视觉代理，不是核工程计算，但保持真实的因果结构）——
//
// 1. 反应性（美元 $ = ρ/β）：
//      ρ$ = 控制棒价值 - 停堆负偏置 - 燃料温度负反馈
//    控制棒用真实的 S 形积分价值曲线 sc(p)=p-sin(2πp)/2π（微分价值在行程中段最大）。
//    SHIM+REG 全提也低于瞬发临界（1$），即靠这两根棒无法把堆推到瞬发临界——真实
//    研究堆的安全特性；只有 TRANS 气动弹出才能越过瞬发临界产生脉冲。
//
// 2. 点堆动力学（单缓发组，按 $ 归一化，固定子步长积分，帧率无关）：
//      dn/dt = P*(ρ$-1)*n + λ*C + S
//      dC/dt = P*n - λ*C
//    ρ$<1（瞬发临界以下）时反应堆周期由缓发中子决定（数秒量级，稳定可控）；
//    ρ$≈0 时功率保持；ρ$>0 时按周期上升；SCRAM 使 ρ$ 深负、功率快速下降。
//    时间常数经 TUNED_PRESENTATION 压缩到网页可观察的秒级，因果顺序不变。
//
// 3. UZrH 瞬发负温度反馈：燃料温度升高→ρ$ 下降，功率自限——研究堆固有安全性，
//    也是脉冲能自终止的原因（SOURCE_VERIFIED 方向，REALTIME_PROXY 幅度）。
//
// 4. 脉冲：PULSE 模式下从低功率近临界点火，TRANS 气动弹出瞬间注入 >1$ 的正反应性，
//    用 Fuchs–Nordheim 绝热脉冲模型的解析形式给出功率尖峰（峰高、宽度、释放能量都
//    随越瞬发临界的反应性变化），沉积的燃料能量经负反馈在毫秒内终止脉冲。解析求值，
//    不做刚性 ODE 积分，帧率无关。
//
// 5. 热工：燃料→池水传热 + 自然对流/泵驱动的池水散热；池水温度代理驱动切伦科夫和
//    自然对流着色。

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

// 运行模式（供控制台/调试读取）
export const MODES = ["SHUTDOWN", "OPERATE", "PULSE"];

// —— 点堆动力学常量（$ 归一化，TUNED_PRESENTATION 时间尺度）——
const PROMPT_RATE = 8.0;   // β/Λ 的代理 (1/s)，决定瞬发响应速度
const LAMBDA = 0.8;        // 缓发前驱核衰变常数代理 (1/s)，压缩自 ~0.08 以加快可观察响应
const SOURCE = 1.2e-5;     // 中子源项：保证停堆时有可观测的源功率（启动源）
const KIN_SUBSTEP = 1 / 240; // 固定子步长，保证低帧率下积分稳定、结果帧率无关

// —— 控制棒（美元价值）——
const ROD_BIAS = 3.2;      // 全棒插入时的停堆负偏置（$）；SHIM+REG 全提=3.7>bias 可达临界
const ROD_WORTH = { SHIM: 2.5, REG: 1.2, TRANS: 3.0 }; // 各棒满行程积分价值（$）
// 手动驱动速率（行程分数/秒，TUNED_PRESENTATION，压缩自 ~0.5 cm/s 齿条）
const ROD_DRIVE_RATE = 0.14;
const SCRAM_RATE = 3.0;    // SCRAM/停堆插棒速率（远快于手动提棒）
// TRANS 气动脉冲时序（秒）
const TRANS_EJECT_TIME = 0.12;
const TRANS_DWELL = 0.15;
const TRANS_REINSERT_TIME = 1.1;

// —— 温度反馈与热工 ——
const ALPHA_FB = 0.70;     // UZrH 负温度反馈系数（$/单位燃料温度代理）
const K_HEAT = 0.30;       // 功率→燃料温升（较小→满功率燃料不过热，留出功率空间）
const K_FT = 0.60;         // 燃料→池水导热
const K_COOL = 0.42;       // 池水→冷源排热，随冷却流量增强（泵/自然对流驱动）
const PUMP_FLOW = 0.6;     // 一回路泵开时的强制流量代理
const NATCIRC = 0.28;      // 自然对流系数（随燃料-池水温差增强）
const POOL_AMBIENT = 0.12; // 池水环境基线温度代理

// S 形积分棒价值：p=0→0，p=1→1，微分价值在中段最大
function rodShape(p) {
  return clamp(p - Math.sin(2 * Math.PI * p) / (2 * Math.PI), 0, 1);
}

export function createSessionController({ reduceMotion } = {}) {
  const state = {
    // 会话
    unlocked: false,
    sceneClockRunning: false,
    gratingLocked: true,       // S-003：格栅始终放下并锁定

    // 运行
    mode: "SHUTDOWN",
    scrammed: true,            // 加载即停堆（联锁），首次交互只解锁时钟/音频，不启堆
    pumpOn: false,

    // 控制棒：pos 行程分数 0..1，vel 手动驱动速度
    rod: {
      SHIM: { pos: 0, target: 0, vel: 0 },
      TRANS: { pos: 0, target: 0, vel: 0 },
      REG: { pos: 0, target: 0, vel: 0 }
    },

    // 反应堆物理
    reactivityProxy: -ROD_BIAS, // 净反应性（$），供控制台仪表
    rodReactivity: 0,           // 仅控制棒贡献（$）
    powerProxy: 0,              // 稳态功率通道 0..~1.1，代表 0..250 kW
    pulsePowerProxy: 0,         // 脉冲功率通道 0..1，代表 0..250 MW（独立标度）
    period: Infinity,           // 反应堆周期代理（s），供仪表（正=上升，负=下降）
    fuelTemperatureProxy: 0,
    poolTemperatureProxy: POOL_AMBIENT,
    coolantFlowProxy: 0.0,

    // 脉冲
    pulseId: 0,
    pulseArmed: false,
    pulse: null                // { clock, peak, sigma, t0, deposited }
  };

  // 点堆内部量（n 与 powerProxy 同步，C 为缓发前驱代理）
  let nPop = 0;
  let cPrec = 0;
  let kinAccum = 0;

  let pendingEvents = [];
  const emit = (type, payload) => pendingEvents.push({ type, ...payload });
  const drain = () => { const out = pendingEvents; pendingEvents = []; return out; };

  // —— 首次交互门：解锁音频/时钟，但不启堆（仍停堆等待操作员）——
  const unlock = () => {
    if (state.unlocked) return;
    state.unlocked = true;
    state.sceneClockRunning = true;
    emit("unlocked", {});
  };

  // —— 操作员指令 ——
  const startup = () => {
    // 复位联锁并进入运行准备：清除 SCRAM，转入 OPERATE。棒仍在，由操作员提出。
    if (!state.unlocked) return;
    state.scrammed = false;
    if (state.mode === "SHUTDOWN") state.mode = "OPERATE";
    emit("startup", {});
  };

  const scram = () => {
    state.scrammed = true;
    state.mode = "SHUTDOWN";
    state.pulseArmed = false;
    for (const k in state.rod) { state.rod[k].vel = 0; state.rod[k].target = 0; }
    emit("scram", {});
  };

  const setMode = (mode) => {
    if (state.scrammed || !state.unlocked) return;
    if (mode !== "OPERATE" && mode !== "PULSE") return;
    // 进入脉冲模式前不改变棒位；只有点火时才弹 TRANS。
    state.mode = mode;
    state.pulseArmed = mode === "PULSE";
    emit("mode", { mode });
  };

  const pumpToggle = () => {
    state.pumpOn = !state.pumpOn;
    emit("pump", { on: state.pumpOn });
  };

  // 手动棒驱动：dir=+1 提出，-1 插入；松开调用 rodStop
  const rodStart = (name, dir) => {
    if (state.scrammed || !state.rod[name]) return;
    if (name === "TRANS" && state.mode === "PULSE") return; // 脉冲模式 TRANS 由气动机构控制
    state.rod[name].vel = dir * ROD_DRIVE_RATE;
  };
  const rodStop = (name) => { if (state.rod[name]) state.rod[name].vel = 0; };

  // 脉冲点火：仅 PULSE 模式、未停堆、低功率、TRANS 在座时允许
  const pulseFire = () => {
    if (state.mode !== "PULSE" || state.scrammed) return;
    if (state.pulse) return;                       // 已有脉冲进行中
    if (state.powerProxy > 0.06) return;           // 必须从低功率触发（资料约束）
    if (state.rod.TRANS.pos > 0.02) return;        // TRANS 必须在座
    // 弹出瞬间的越瞬发临界反应性（$）：当前棒反应性 + TRANS 满价值 - 1（瞬发临界）
    const rodNow = rodReactivityOf(state.rod);
    const rhoInsert = rodNow + ROD_WORTH.TRANS - ROD_BIAS
      - ALPHA_FB * state.fuelTemperatureProxy;      // 净 ρ$（含反馈）
    const excess = Math.max(0.05, rhoInsert - 1);   // 越瞬发临界的 $ 数
    // Fuchs–Nordheim 定性关系：峰高随 excess² 增长、脉宽随 excess 收窄、
    // 释放能量随 excess 增长（都归一化到可观察范围）。
    state.pulse = {
      clock: 0,
      t0: TRANS_EJECT_TIME + TRANS_DWELL * 0.35,
      peak: clamp(0.25 + 0.32 * excess * excess, 0, 1),
      sigma: clamp(0.075 / (0.6 + excess), 0.02, 0.09),
      fuelBump: clamp(0.28 + 0.16 * excess, 0, 0.9),
      deposited: false
    };
    state.pulseId += 1;
    emit("pulse_start", { pulseId: state.pulseId, excess });
  };

  function rodReactivityOf(rod) {
    return ROD_WORTH.SHIM * rodShape(rod.SHIM.pos)
      + ROD_WORTH.REG * rodShape(rod.REG.pos)
      + ROD_WORTH.TRANS * rodShape(rod.TRANS.pos);
  }

  // —— 每帧：棒运动 ——
  function stepRods(dt) {
    const r = state.rod;
    if (state.scrammed) {
      for (const k in r) r[k].pos = Math.max(0, r[k].pos - SCRAM_RATE * dt);
      return;
    }
    // 手动驱动（TRANS 在脉冲模式由气动时序接管）
    for (const k in r) {
      if (k === "TRANS" && state.pulse) continue;
      if (r[k].vel !== 0) r[k].pos = clamp(r[k].pos + r[k].vel * dt, 0, 1);
    }
    // TRANS 气动时序（脉冲进行中）
    if (state.pulse) {
      const t = state.pulse.clock;
      if (t < TRANS_EJECT_TIME) {
        r.TRANS.pos = clamp(t / TRANS_EJECT_TIME, 0, 1);
      } else if (t < TRANS_EJECT_TIME + TRANS_DWELL) {
        r.TRANS.pos = 1;
      } else {
        const rt = (t - TRANS_EJECT_TIME - TRANS_DWELL) / TRANS_REINSERT_TIME;
        r.TRANS.pos = clamp(1 - rt, 0, 1);
      }
    } else if (state.mode !== "PULSE") {
      // OPERATE 下 TRANS 保持在座
      r.TRANS.pos = Math.max(0, r.TRANS.pos - SCRAM_RATE * dt);
    }
  }

  // —— 点堆动力学（固定子步长）——
  function stepKinetics() {
    const rodR = rodReactivityOf(state.rod);
    state.rodReactivity = rodR;
    // 脉冲进行中，稳态通道的反应性不含 TRANS 的爆发贡献（脉冲走独立解析通道），
    // 用在座 SHIM/REG + 反馈评估稳态背景。
    const rodSteady = state.pulse
      ? ROD_WORTH.SHIM * rodShape(state.rod.SHIM.pos) + ROD_WORTH.REG * rodShape(state.rod.REG.pos)
      : rodR;
    const rho = rodSteady - ROD_BIAS - ALPHA_FB * state.fuelTemperatureProxy; // $
    state.reactivityProxy = rho;

    // 单缓发组点堆，$ 归一化，显式欧拉 @ 固定子步长
    const dn = (PROMPT_RATE * (rho - 1) * nPop + LAMBDA * cPrec + SOURCE) * KIN_SUBSTEP;
    const dc = (PROMPT_RATE * nPop - LAMBDA * cPrec) * KIN_SUBSTEP;
    nPop = Math.max(0, nPop + dn);
    cPrec = Math.max(0, cPrec + dc);
    // 稳态功率通道上限，避免 OPERATE 下数值意外发散
    nPop = Math.min(nPop, 1.4);
  }

  // —— 脉冲解析通道 ——
  function stepPulse(dt) {
    if (!state.pulse) {
      // 脉冲通道自然衰减到 0
      state.pulsePowerProxy += (0 - state.pulsePowerProxy) * clamp(6 * dt, 0, 1);
      return;
    }
    const p = state.pulse;
    p.clock += dt;
    const d = (p.clock - p.t0) / p.sigma;
    state.pulsePowerProxy = p.peak * Math.exp(-0.5 * d * d);
    // 峰后一次性沉积燃料能量→负反馈（脉冲自终止的物理来源）
    if (!p.deposited && p.clock >= p.t0) {
      state.fuelTemperatureProxy += p.fuelBump;
      p.deposited = true;
      emit("pulse_energy_deposited", { amount: p.fuelBump });
    }
    // 机械/水体耦合事件（经桥架/格栅传给玻璃，见 physicalScene）
    if (!p._eject && p.clock >= TRANS_EJECT_TIME) {
      p._eject = true;
      emit("trans_eject_impulse", { magnitude: 1 });
      emit("trans_underwater_impulse", { magnitude: 1 });
    }
    const seatT = TRANS_EJECT_TIME + TRANS_DWELL + TRANS_REINSERT_TIME;
    if (!p._reseat && p.clock >= seatT) {
      p._reseat = true;
      emit("trans_reseat_impulse", { magnitude: 0.35 });
    }
    if (p.clock >= seatT + 0.4) {
      state.pulse = null;
      state.pulsePowerProxy = 0;
      emit("pulse_end", { pulseId: state.pulseId });
    }
  }

  // —— 热工 ——
  function stepThermal(dt) {
    state.powerProxy = nPop;

    const flow = (state.pumpOn ? PUMP_FLOW : 0)
      + NATCIRC * clamp(state.fuelTemperatureProxy - state.poolTemperatureProxy, 0, 1);
    state.coolantFlowProxy += (clamp(flow, 0, 1) - state.coolantFlowProxy) * clamp(2.5 * dt, 0, 1);

    // 燃料温度：功率加热 - 向池水导热（脉冲的一次性沉积在 stepPulse 里已加）
    const qFuelToPool = K_FT * (state.fuelTemperatureProxy - state.poolTemperatureProxy);
    const dTfuel = (K_HEAT * state.powerProxy - qFuelToPool) * dt;
    state.fuelTemperatureProxy = Math.max(0, state.fuelTemperatureProxy + dTfuel);

    // 池水温度：从燃料导入的热 - 经冷却回路排到冷源（排热速率随冷却流量增强，
    // 这才是泵/自然对流的真实作用：把池水的热带走。开泵→排热增强→池水更凉→燃料更凉
    // →功率略升，是正确的因果链）。
    const qPoolToSink = K_COOL * (0.2 + state.coolantFlowProxy) * (state.poolTemperatureProxy - POOL_AMBIENT);
    const dTpool = (qFuelToPool - qPoolToSink) * dt;
    state.poolTemperatureProxy = clamp(state.poolTemperatureProxy + dTpool, POOL_AMBIENT * 0.5, 1.2);
  }

  // 反应堆周期代理（供仪表）：由稳态功率的对数变化率估计
  let lastPower = 0;
  function updatePeriod(dt) {
    const p = state.powerProxy;
    if (p > 1e-4 && lastPower > 1e-4 && dt > 0) {
      const rate = (Math.log(p) - Math.log(lastPower)) / dt;
      state.period = Math.abs(rate) < 1e-3 ? Infinity : 1 / rate;
    } else {
      state.period = Infinity;
    }
    lastPower = p;
  }

  const update = (dt) => {
    if (!state.unlocked) return drain();

    stepRods(dt);

    // 点堆用固定子步长积分（稳定、帧率无关）
    kinAccum = Math.min(kinAccum + dt, KIN_SUBSTEP * 40);
    while (kinAccum >= KIN_SUBSTEP) {
      stepKinetics();
      kinAccum -= KIN_SUBSTEP;
    }

    stepPulse(dt);
    stepThermal(dt);
    updatePeriod(dt);

    return drain();
  };

  return {
    state,
    unlock,
    update,
    // 操作员指令 API（由控制台点击调用）
    startup,
    scram,
    setMode,
    pumpToggle,
    rodStart,
    rodStop,
    pulseFire,
    isReduceMotion: () => !!reduceMotion
  };
}
