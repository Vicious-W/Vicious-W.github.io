// SOURCE 反应堆运行控制器 —— AUTO 调度器与人工操作员共用的同一个实时反应堆模型。
//
// 本模块只负责“反应堆状态如何随指令和物理反馈演化”，不接触 three.js / cannon-es
// 对象；reactorModel、waterSystem、controlConsole、physicalScene 读取本模块产出的
// 状态并各自渲染/求解。
//
// —— 控制权（PROJECT_SPEC「任意时刻只有一个控制权所有者」）——
//
//   state.controlOwner : "NONE" | "AUTO" | "MANUAL"
//
//   NONE    页面加载后的联锁复位状态，等待第一次有效交互；
//   AUTO    控制台热点以外的首次交互进入；由 autoProgram.js 调度，走的是与人工
//           完全相同的指令、联锁和积分器（不是第二套动画，也不写入终值）；
//   MANUAL  控制台热点上的首次交互进入；AUTO 运行期间的任一人工指令会**原位**
//           接管——停止调度器和它发出的棒驱动，但不复位任何物理状态。
//
//   从 MANUAL 回到完整 AUTO 只能在 SCRAM/安全停堆状态开始（isSafeShutdown）。
//
// —— 物理层级（教育性视觉代理，不是核工程计算，但保持真实的因果结构）——
//
// 1. 反应性（美元 $ = ρ/β）：
//      ρ$ = 控制棒价值 - 停堆负偏置 - 燃料温度负反馈
//    控制棒用真实的 S 形积分价值曲线 sc(p)=p-sin(2πp)/2π（微分价值在行程中段最大）。
//    SHIM+REG 全提 = 3.7$ 对停堆偏置 3.0$ 只余 0.7$，低于瞬发临界（1$）——靠这两根
//    棒无法把堆推到瞬发临界，是真实研究堆的安全特性；只有 TRANS 气动弹出才能越过
//    瞬发临界产生脉冲。
//
// 2. 点堆动力学（单缓发组，按 $ 归一化，固定子步长积分，帧率无关）：
//      dn/dt = P*(ρ$-1)*n + λ*C + S
//      dC/dt = P*n - λ*C
//    ρ$<1（瞬发临界以下）时反应堆周期由缓发中子决定；ρ$≈0 时功率保持；ρ$>0 时按
//    周期上升；SCRAM 使 ρ$ 深负、功率快速下降。停堆时源项 S 给出真实的源倍增功率
//    水平（启动量程可检测），不是恰好为零。
//    时间常数经 TUNED_PRESENTATION 压缩到网页可观察的秒级，因果顺序不变。
//
// 3. UZrH 瞬发负温度反馈：燃料温度升高→ρ$ 下降，功率自限——研究堆固有安全性，
//    也是脉冲能自终止的原因（SOURCE_VERIFIED 方向，REALTIME_PROXY 幅度）。
//
// 4. 脉冲：PULSE 模式下从低功率近临界点火（联锁要求 < 100 W 代理），TRANS 气动
//    弹出瞬间注入 >1$ 的正反应性，用 Fuchs–Nordheim 绝热脉冲模型的解析形式给出
//    功率尖峰（峰高随越瞬发临界反应性的平方增长、脉宽随之收窄），沉积的燃料能量
//    经负反馈在毫秒内终止脉冲。解析求值且按帧区间取极值，帧率再低也不会漏掉峰值。
//
// 5. 热工：两节点（燃料 / 池水）能量平衡，燃料热容远小于池水热容，因此脉冲后燃料
//    温度快速回落而池水只缓慢升温——不会出现“整个池水瞬间跃起”。池水热量经自然
//    对流 + 一回路泵驱动的换热排到冷源。
//
// —— 归一化标度 ——
//   powerProxy      1.0 = 250 kW（Pavia 当前许可稳态功率）
//   pulsePowerProxy 1.0 = 250 MW（Pavia 历史脉冲峰值）——独立通道，不是稳态热输入
//   fuel/poolTemperatureProxy、coolantFlowProxy 为定性代理，不标称工程单位

import * as THREE from "three";
import { createAutoProgram, AUTO_PHASES } from "./autoProgram.js";

const clamp = THREE.MathUtils.clamp;

// 运行模式（供控制台/调试读取）
export const MODES = ["SHUTDOWN", "OPERATE", "PULSE"];
export const CONTROL_OWNERS = ["NONE", "AUTO", "MANUAL"];
export { AUTO_PHASES };

// —— 点堆动力学常量（$ 归一化，TUNED_PRESENTATION 时间尺度）——
const PROMPT_RATE = 8.0;   // β/Λ 的代理 (1/s)，决定瞬发响应速度
const LAMBDA = 0.8;        // 缓发前驱核衰变常数代理 (1/s)，压缩自 ~0.08 以加快可观察响应
const SOURCE_N = 1.2e-5;   // 中子源项：Ra–Be 启动源，保证停堆时有可检测的源倍增功率
const KIN_SUBSTEP = 1 / 240; // 固定子步长，保证低帧率下积分稳定、结果帧率无关
const N_MAX = 2.6;         // 数值发散保护（全提棒稳态约 2.0，留出裕量）

// —— 控制棒（美元价值）——
const ROD_BIAS = 3.0;      // 全棒插入时的停堆负偏置（$）
const ROD_WORTH = { SHIM: 2.5, REG: 1.2, TRANS: 3.0 }; // 各棒满行程积分价值（$）
// 手动/自动共用的齿条驱动速率（行程分数/秒，TUNED_PRESENTATION，压缩自 ~0.5 cm/s）
const ROD_DRIVE_RATE = 0.14;
const SCRAM_RATE = 3.0;    // SCRAM/停堆插棒速率（远快于提棒）
// TRANS 气动脉冲时序（秒）
const TRANS_EJECT_TIME = 0.12;
const TRANS_DWELL = 0.15;
const TRANS_REINSERT_TIME = 1.1;

// —— 温度反馈与热工 ——
// 常量按“250 kW 平衡点”反解：P=1 时 ρ=0 要求棒价值 3.399$，SHIM 0.80 + REG 0.72
// 正好落在两根棒都还有双向调节权限的行程中段（见 autoProgram.js 的整定点）。
const ALPHA_FB = 0.70;     // UZrH 负温度反馈系数（$/单位燃料温度代理）
const K_HEAT = 0.12;       // 功率→燃料发热
const K_FT = 0.60;         // 燃料→池水导热
const K_COOL = 0.56;       // 池水→冷源排热基准，随冷却流量增强
const C_FUEL = 1.0;        // 燃料节点热容代理
const C_POOL = 12.0;       // 池水热容代理：远大于燃料，脉冲后池水只缓慢升温
const PUMP_FLOW = 0.6;     // 一回路泵开时的强制流量代理
const NATCIRC = 0.28;      // 自然对流系数（随燃料-池水温差增强）
const POOL_AMBIENT = 0.12; // 池水环境基线温度代理

// —— 运行边界（AUTO 与 MANUAL 共用的联锁数值）——
export const FULL_POWER = 1.0;         // 250 kW 稳态功率代理
// 脉冲前功率联锁：REACTOR_POOL_SYSTEM.md §4.3「脉冲前功率必须低于 100 W」，
// 按 powerProxy 1.0 = 250 kW 换算得 4e-4。250 kW 稳态下无法点火。
export const PULSE_POWER_LIMIT = 4e-4;
const SAFE_SHUTDOWN_POWER = 0.02;      // 允许重新进入完整 AUTO 的停堆功率上限
const SAFE_SHUTDOWN_ROD = 0.02;        // 允许重新进入完整 AUTO 的棒位上限
// 保护回路（RP-009）高功率整定值：125% 满功率自动 SCRAM。人工可以把三根棒都提
// 出来（真实 TRIGA 的稳态工况同样允许定位瞬发棒），但保护系统会在功率越过整定值
// 时插棒，所以控制台无法把反应堆停在"无限升功率"这种物理上荒谬的状态。脉冲通道
// 是独立标度，不参与该整定值。
export const POWER_TRIP = 1.25;

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

    // 控制权
    controlOwner: "NONE",
    autoPhase: "INTERLOCKED_RESET", // AUTO 程序阶段（加载即联锁复位）
    autoAvailable: false,           // 当前是否允许启动完整 AUTO（控制台无文字反馈）
    // 三套棒驱动当前是否接受指令（控制台无文字反馈：被联锁禁止的拨杆压暗）
    rodDriveEnabled: { SHIM: false, REG: false, TRANS: false },
    protectionTrips: 0,             // 保护回路自动 SCRAM 次数

    // 运行
    mode: "SHUTDOWN",
    scrammed: true,            // 加载即停堆（联锁），首次交互只解锁时钟/音频
    pumpOn: false,

    // 控制棒：pos 行程分数 0..1，vel 驱动速度
    rod: {
      SHIM: { pos: 0, target: 0, vel: 0 },
      TRANS: { pos: 0, target: 0, vel: 0 },
      REG: { pos: 0, target: 0, vel: 0 }
    },

    // 反应堆物理
    reactivityProxy: -ROD_BIAS, // 净反应性（$），供控制台仪表
    rodReactivity: 0,           // 仅控制棒贡献（$）
    powerProxy: 0,              // 稳态功率通道，1.0 = 250 kW
    pulsePowerProxy: 0,         // 脉冲功率通道，1.0 = 250 MW（独立标度）
    period: Infinity,           // 反应堆周期代理（s），供仪表（正=上升，负=下降）
    // 冷停堆时燃料与池水处于热平衡，因此燃料温度代理的初值就是池水环境温度，
    // 不是绝对零点（温度代理只表达定性状态，不标称工程单位）。
    fuelTemperatureProxy: POOL_AMBIENT,
    poolTemperatureProxy: POOL_AMBIENT,
    coolantFlowProxy: 0.0,

    // 脉冲
    pulseId: 0,
    pulseArmed: false,
    pulseReady: false,          // 全部脉冲联锁是否满足（控制台无文字反馈）
    pulse: null                // { clock, peak, sigma, t0, fuelBump, deposited }
  };

  // 点堆内部量（n 与 powerProxy 同步，C 为缓发前驱代理）
  let nPop = 0;
  let cPrec = 0;
  let kinAccum = 0;

  let pendingEvents = [];
  const emit = (type, payload) => pendingEvents.push({ type, ...payload });
  const drain = () => { const out = pendingEvents; pendingEvents = []; return out; };

  // —— 首次交互门：解锁音频/时钟，但不启堆（仍停堆等待控制权分流）——
  const unlock = () => {
    if (state.unlocked) return;
    state.unlocked = true;
    state.sceneClockRunning = true;
    emit("unlocked", {});
  };

  // ————————————————— 设备指令（AUTO 与 MANUAL 共用的唯一实现）—————————————————

  const cmdStartup = () => {
    // 复位联锁并进入运行准备：清除 SCRAM，转入 OPERATE。棒仍在底，由控制方提出。
    if (!state.unlocked) return false;
    state.scrammed = false;
    if (state.mode === "SHUTDOWN") state.mode = "OPERATE";
    emit("startup", {});
    return true;
  };

  const cmdScram = () => {
    state.scrammed = true;
    state.mode = "SHUTDOWN";
    state.pulseArmed = false;
    for (const k in state.rod) { state.rod[k].vel = 0; state.rod[k].target = 0; }
    emit("scram", {});
    return true;
  };

  const cmdSetMode = (mode) => {
    if (state.scrammed || !state.unlocked) return false;
    if (mode !== "OPERATE" && mode !== "PULSE") return false;
    // 进入脉冲模式前不改变棒位；只有点火时才弹 TRANS。
    state.mode = mode;
    state.pulseArmed = mode === "PULSE";
    emit("mode", { mode });
    return true;
  };

  const cmdPumpToggle = () => {
    state.pumpOn = !state.pumpOn;
    emit("pump", { on: state.pumpOn });
    return true;
  };

  // 某根棒的驱动机构当前是否接受指令。控制台用同一条规则压暗对应拨杆
  // （state.rodDriveEnabled），所以"被联锁禁止"在无文字页面上仍可分辨。
  const rodDriveAllowed = name =>
    !state.scrammed && !!state.rod[name] && !(name === "TRANS" && state.mode === "PULSE");

  // 棒驱动：dir=+1 提出，-1 插入；停止调用 cmdRodStop
  const cmdRodStart = (name, dir) => {
    if (!rodDriveAllowed(name)) return false;
    state.rod[name].vel = dir * ROD_DRIVE_RATE;
    return true;
  };
  const cmdRodStop = (name) => {
    if (!state.rod[name]) return false;
    state.rod[name].vel = 0;
    return true;
  };

  // 脉冲点火：仅 PULSE 模式、未停堆、低功率（<100 W 代理）、TRANS 在座时允许
  const cmdPulseFire = () => {
    if (state.mode !== "PULSE" || state.scrammed) return false;
    if (state.pulse) return false;                      // 已有脉冲进行中
    if (state.powerProxy > PULSE_POWER_LIMIT) return false; // 必须从低功率触发（资料约束）
    if (state.rod.TRANS.pos > 0.02) return false;       // TRANS 必须在座
    // 弹出瞬间的净反应性（$）：当前棒反应性 + TRANS 满价值 - 停堆偏置 - 温度反馈
    const rodNow = rodReactivityOf(state.rod);
    const rhoInsert = rodNow + ROD_WORTH.TRANS - ROD_BIAS - ALPHA_FB * state.fuelTemperatureProxy;
    // 只有越过瞬发临界（>1$）才是真正的脉冲。从深度次临界弹 TRANS 只是一次普通的
    // 反应性插入：机构照样动作、水体照样受扰，但功率按缓发中子决定的周期上升，
    // 不会出现毫秒尖峰——所以必须先用 SHIM/REG 把堆带到低功率临界再点火。
    const prompt = rhoInsert > 1;
    const excess = Math.max(0, rhoInsert - 1);          // 越瞬发临界的 $ 数
    // Fuchs–Nordheim 定性关系：峰高随 excess² 增长、脉宽随 excess 收窄、释放能量
    // 随 excess 增长。低功率临界起跳的 ~2$ 插入给出 1.0（=250 MW）峰值、约 68 ms
    // 半高宽，与 Pavia 历史脉冲“约 250 MW、持续数十毫秒”一致。
    state.pulse = {
      clock: 0,
      prompt,
      t0: TRANS_EJECT_TIME + TRANS_DWELL * 0.35,
      peak: prompt ? clamp(0.25 * excess * excess, 0, 1.05) : 0,
      sigma: clamp(0.075 / (0.6 + excess), 0.02, 0.09),
      fuelBump: prompt ? clamp(0.28 + 0.16 * excess, 0, 0.9) : 0,
      deposited: !prompt
    };
    state.pulseId += 1;
    emit("pulse_start", { pulseId: state.pulseId, excess, prompt });
    return true;
  };

  function rodReactivityOf(rod) {
    return ROD_WORTH.SHIM * rodShape(rod.SHIM.pos)
      + ROD_WORTH.REG * rodShape(rod.REG.pos)
      + ROD_WORTH.TRANS * rodShape(rod.TRANS.pos);
  }

  // ————————————————— 控制权 —————————————————

  // 允许重新进入完整 AUTO 的安全停堆条件（PROJECT_SPEC：不能在任意功率状态重放）
  const isSafeShutdown = () =>
    state.scrammed && !state.pulse &&
    state.powerProxy < SAFE_SHUTDOWN_POWER &&
    state.rod.SHIM.pos <= SAFE_SHUTDOWN_ROD &&
    state.rod.REG.pos <= SAFE_SHUTDOWN_ROD &&
    state.rod.TRANS.pos <= SAFE_SHUTDOWN_ROD;

  // 人工接管：停止 AUTO 调度器与它正在发出的棒驱动，但**不改动任何物理状态**。
  function claimManual() {
    if (!state.unlocked) return;
    if (state.controlOwner === "MANUAL") return;
    const previous = state.controlOwner;
    if (previous === "AUTO") {
      auto.abort();
      for (const k in state.rod) state.rod[k].vel = 0;
      state.autoPhase = "MANUAL_TAKEOVER";
    }
    state.controlOwner = "MANUAL";
    emit("control_owner", { owner: "MANUAL", previous });
  }

  // 场景层「控制台以外的交互」入口（点空处、拖玻璃、转相机、滚轮、按键）。
  //
  // 只有**真正的首次分流**——还没有控制权所有者——才请求 AUTO。用户一旦接管为
  // MANUAL，这些操作就只是在看/摆弄场景，不得静默把控制权交回自动程序：从
  // MANUAL 重新进入完整 AUTO 必须由控制台上的无文字 AUTO 方钮显式触发
  // （REACTOR_POOL_SYSTEM.md §4.4）。首次分流与重入 AUTO 是两件事。
  function sceneInteraction() {
    unlock();
    if (state.controlOwner !== "NONE") return false;
    return requestAuto();
  }

  // 请求进入完整 AUTO 连续运行程序（控制台的无文字 AUTO 方钮）
  function requestAuto() {
    if (!state.unlocked) return false;
    if (state.controlOwner === "AUTO") return false;
    if (!isSafeShutdown()) {
      emit("auto_refused", { owner: state.controlOwner });
      return false;
    }
    const previous = state.controlOwner;
    state.controlOwner = "AUTO";
    auto.reset();
    emit("control_owner", { owner: "AUTO", previous });
    emit("auto_start", {});
    return true;
  }

  // AUTO 调度器：与人工共用 cmd*，因此联锁、棒速、动力学、热工完全一致
  const auto = createAutoProgram({
    state,
    emit,
    cmd: {
      startup: cmdStartup,
      scram: cmdScram,
      setMode: cmdSetMode,
      pumpToggle: cmdPumpToggle,
      rodStart: cmdRodStart,
      rodStop: cmdRodStop,
      pulseFire: cmdPulseFire
    },
    limits: { fullPower: FULL_POWER, pulsePowerLimit: PULSE_POWER_LIMIT }
  });

  // 对外的人工指令：先夺取控制权，再执行与 AUTO 相同的实现
  const manual = fn => (...args) => { claimManual(); return fn(...args); };

  // —— 每帧：棒运动 ——
  function stepRods(dt) {
    const r = state.rod;
    if (state.scrammed) {
      for (const k in r) r[k].pos = Math.max(0, r[k].pos - SCRAM_RATE * dt);
      return;
    }
    // SHIM / REG：驱动电机连续提插（TRANS 有自己的气动/驱动分支，见下）
    for (const k in r) {
      if (k === "TRANS") continue;
      if (r[k].vel !== 0) r[k].pos = clamp(r[k].pos + r[k].vel * dt, 0, 1);
    }
    // TRANS 的三种状态：
    //   1. 脉冲进行中 —— 气动时序完全接管（弹出 → 停留 → 复位）；
    //   2. PULSE 工况但未点火 —— 气缸把棒拉回座上待发，人工驱动被联锁禁止
    //      （cmdRodStart 直接拒绝），控制台把该拨杆压暗表示"现在动不了"；
    //   3. 其余工况（OPERATE）—— 和另外两根棒一样由驱动电机连续提插。真实
    //      TRIGA 的瞬发棒在稳态工况下同样可以由驱动机构定位，只有进入脉冲
    //      工况才交给气动系统（REACTOR_POOL_SYSTEM.md RP-005：三套驱动各自
    //      独立）。
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
    } else if (state.mode === "PULSE") {
      r.TRANS.pos = Math.max(0, r.TRANS.pos - SCRAM_RATE * dt);
    } else if (r.TRANS.vel !== 0) {
      r.TRANS.pos = clamp(r.TRANS.pos + r.TRANS.vel * dt, 0, 1);
    }
  }

  // —— 点堆动力学（固定子步长）——
  function stepKinetics() {
    const rodR = rodReactivityOf(state.rod);
    state.rodReactivity = rodR;
    // 真正的瞬发脉冲进行中时，稳态通道不重复计入 TRANS 的爆发贡献（那部分走独立
    // 解析通道），只用在座 SHIM/REG + 反馈评估稳态背景。若这次 TRANS 弹出没有越过
    // 瞬发临界，就不存在解析脉冲通道，TRANS 的反应性必须照常进入稳态通道，否则
    // 这次插入会被凭空吞掉。
    const rodSteady = (state.pulse && state.pulse.prompt)
      ? ROD_WORTH.SHIM * rodShape(state.rod.SHIM.pos) + ROD_WORTH.REG * rodShape(state.rod.REG.pos)
      : rodR;
    const rho = rodSteady - ROD_BIAS - ALPHA_FB * state.fuelTemperatureProxy; // $
    state.reactivityProxy = rho;

    // 单缓发组点堆，$ 归一化，显式欧拉 @ 固定子步长
    const dn = (PROMPT_RATE * (rho - 1) * nPop + LAMBDA * cPrec + SOURCE_N) * KIN_SUBSTEP;
    const dc = (PROMPT_RATE * nPop - LAMBDA * cPrec) * KIN_SUBSTEP;
    nPop = Math.max(0, nPop + dn);
    cPrec = Math.max(0, cPrec + dc);
    nPop = Math.min(nPop, N_MAX);
  }

  // —— 脉冲解析通道 ——
  function stepPulse(dt) {
    if (!state.pulse) {
      // 脉冲通道自然衰减到 0
      state.pulsePowerProxy += (0 - state.pulsePowerProxy) * clamp(6 * dt, 0, 1);
      return;
    }
    const p = state.pulse;
    const tStart = p.clock;
    p.clock += dt;
    // 帧区间取极值：脉冲半高宽只有几十毫秒，渲染帧可能整帧跨过峰值。解析曲线在
    // [tStart, clock] 内的最大值出现在 t0（若落在区间内），否则在离 t0 最近的端点，
    // 因此峰值永远不会因帧率而丢失（PROJECT_SPEC「渲染帧率不能显著改变脉冲输入」）。
    const tEval = clamp(p.t0, tStart, p.clock);
    const d = (tEval - p.t0) / p.sigma;
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

  // —— 热工：两节点能量平衡（燃料热容 << 池水热容）——
  function stepThermal(dt) {
    state.powerProxy = nPop;

    const flow = (state.pumpOn ? PUMP_FLOW : 0)
      + NATCIRC * clamp(state.fuelTemperatureProxy - state.poolTemperatureProxy, 0, 1);
    state.coolantFlowProxy += (clamp(flow, 0, 1) - state.coolantFlowProxy) * clamp(2.5 * dt, 0, 1);

    // 燃料节点：裂变发热 - 向池水导热（脉冲的一次性沉积在 stepPulse 里已加）
    const qGen = K_HEAT * state.powerProxy;
    const qFuelToPool = K_FT * (state.fuelTemperatureProxy - state.poolTemperatureProxy);
    state.fuelTemperatureProxy = Math.max(0,
      state.fuelTemperatureProxy + ((qGen - qFuelToPool) / C_FUEL) * dt);

    // 池水节点：从燃料导入的热 - 经冷却回路排到冷源（排热随冷却流量增强，这才是
    // 泵/自然对流的真实作用）。池水热容是燃料的 12 倍，所以脉冲后燃料温度以约
    // 1.7 s 的时间常数回落，而池水整体温度以约 25 s 的时间常数缓慢上升。
    const qPoolToSink = K_COOL * (0.2 + state.coolantFlowProxy) * (state.poolTemperatureProxy - POOL_AMBIENT);
    state.poolTemperatureProxy = clamp(
      state.poolTemperatureProxy + ((qFuelToPool - qPoolToSink) / C_POOL) * dt,
      POOL_AMBIENT * 0.5, 1.2);
  }

  // 反应堆周期代理（供仪表）：由稳态功率的对数变化率估计
  let lastPower = 0;
  function updatePeriod(dt) {
    const p = state.powerProxy;
    if (p > 1e-6 && lastPower > 1e-6 && dt > 0) {
      const rate = (Math.log(p) - Math.log(lastPower)) / dt;
      state.period = Math.abs(rate) < 1e-3 ? Infinity : 1 / rate;
    } else {
      state.period = Infinity;
    }
    lastPower = p;
  }

  const update = (dt) => {
    if (!state.unlocked) return drain();

    // AUTO 调度先于棒运动：调度器发出的指令在同一帧生效，与人工点击完全同路径
    if (state.controlOwner === "AUTO") auto.update(dt);

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

    // 保护回路：稳态功率越过高功率整定值 → 自动 SCRAM（人工和 AUTO 一视同仁）
    if (!state.scrammed && state.powerProxy > POWER_TRIP) {
      state.protectionTrips += 1;
      cmdScram();
      emit("protection_trip", { power: state.powerProxy });
    }

    for (const k in state.rod) state.rodDriveEnabled[k] = rodDriveAllowed(k);
    state.autoAvailable = state.controlOwner !== "AUTO" && isSafeShutdown();
    // 脉冲联锁的可见状态：控制台据此点亮/压暗脉冲钮，用户不用文字也能看出
    // “现在能不能点火”（PROJECT_SPEC：无文字，但含义必须可辨认）。
    state.pulseReady = state.mode === "PULSE" && !state.scrammed && !state.pulse
      && state.powerProxy <= PULSE_POWER_LIMIT && state.rod.TRANS.pos <= 0.02;

    return drain();
  };

  return {
    state,
    unlock,
    update,
    // 控制权
    requestAuto,
    sceneInteraction,
    isSafeShutdown,
    // 人工操作员指令 API（由控制台点击调用；每次调用都原位夺取控制权）
    startup: manual(cmdStartup),
    scram: manual(cmdScram),
    setMode: manual(cmdSetMode),
    pumpToggle: manual(cmdPumpToggle),
    rodStart: manual(cmdRodStart),
    rodStop: manual(cmdRodStop),
    pulseFire: manual(cmdPulseFire),
    isReduceMotion: () => !!reduceMotion
  };
}
