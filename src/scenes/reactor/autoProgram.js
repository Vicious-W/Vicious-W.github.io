// SOURCE 的 AUTO 连续运行程序。
//
// 这不是第二套反应堆模型，也不是预录动画：本模块只做一件事——像操作员一样，
// 在正确的时刻发出**与人工控制台完全相同的设备指令**（startup / pumpToggle /
// rodStart / rodStop / setMode / pulseFire），然后根据 sessionController 积分出的
// 真实反应性、功率、温度和流量决定下一步。它不直接写 powerProxy、棒位或温度，
// 也不绕过任何联锁。
//
// 工程基线：docs/engineering/REACTOR_POOL_SYSTEM.md §4（AUTO 与 MANUAL 双模式运行）
// 与 docs/engineering/SOURCE_SCENE.md §5。
//
//   INTERLOCKED_RESET        联锁确认：格栅锁定、三棒在底、TRANS 未加压
//     → AUXILIARIES_READY    一回路泵、保护回路复位、控制棒驱动机构小行程确认
//     → LOW_POWER_APPROACH   SHIM 粗调抽出 → REG 细调整定到近临界低功率（<100 W）
//     → PULSE_ARMED          切 PULSE 工况，棒保持不动，TRANS 在座待发
//     → PULSE                TRANS 气动弹出，毫秒功率峰由负温度反馈自终止
//     → POST_PULSE_HEAT_TRANSFER  燃料热量传入池水，自然循环与三回路按各自时间尺度响应
//     → STEADY_POWER_ASCENT  SHIM 粗调 + REG 细调把功率提升到 250 kW
//     → FULL_POWER_EQUILIBRIUM  REG 持续细调维持平衡（池水继续缓慢升温）
//
// 控制结构（两级串级，全部经真实指令执行）：
//   外环  功率/反应性误差 → 棒位需求（带速率限幅与抗积分饱和）
//   内环  棒位需求 → rodStart/rodStop（带死区，避免电机来回抖动）

import * as THREE from "three";

const clamp = THREE.MathUtils.clamp;

export const AUTO_PHASES = [
  "INTERLOCKED_RESET",
  "AUXILIARIES_READY",
  "LOW_POWER_APPROACH",
  "PULSE_ARMED",
  "PULSE",
  "POST_PULSE_HEAT_TRANSFER",
  "STEADY_POWER_ASCENT",
  "FULL_POWER_EQUILIBRIUM"
];

const ROD_NAMES = ["SHIM", "REG", "TRANS"];

// —— 整定点（REALTIME_PROXY；由 sessionController 的棒价值曲线与热工常量反解）——
// SHIM 的 S 形积分价值在中段最陡，0.72 处刚好让 REG 停在 0.6 左右——两根棒都留有
// 双向调节权限，这正是真实“粗调定位、细调保持”的工作点。
const SHIM_CRITICAL = 0.72;   // 低功率临界的 SHIM 粗调位
const SHIM_ASCENT = 0.80;     // 升功率时的 SHIM 粗调位
const LOW_POWER_RHO = -0.012; // 近临界保持点（$）：源倍增给出约 30 W 的可检测低功率
const DEADBAND = 0.012;       // 棒位死区（> 一帧最大行程，避免驱动抖动）
const CONFIRM_TRAVEL = 0.06;  // 驱动机构确认的小行程

export function createAutoProgram({ state, cmd, emit, limits }) {
  const fullPower = limits.fullPower;
  const pulsePowerLimit = limits.pulsePowerLimit;

  let phase = "INTERLOCKED_RESET";
  let tPhase = 0;
  let stable = 0;               // 判据连续满足时间
  let confirm = 0;              // 驱动机构确认子状态
  let fuelPeak = 0;             // 脉冲后燃料温度峰（用于传热判据）
  const demand = { SHIM: 0, REG: 0 };

  function reset() {
    phase = "INTERLOCKED_RESET";
    tPhase = 0;
    stable = 0;
    confirm = 0;
    fuelPeak = 0;
    demand.SHIM = state.rod.SHIM.pos;
    demand.REG = state.rod.REG.pos;
    state.autoPhase = phase;
  }

  // 人工接管：只停止调度，不触碰任何物理状态
  function abort() {
    stable = 0;
  }

  function setPhase(next) {
    phase = next;
    tPhase = 0;
    stable = 0;
    state.autoPhase = next;
    onEnter(next);
    emit("auto_phase", { phase: next });
  }

  function onEnter(next) {
    if (next === "AUXILIARIES_READY") {
      confirm = 0;
    } else if (next === "LOW_POWER_APPROACH") {
      demand.SHIM = state.rod.SHIM.pos;
      demand.REG = state.rod.REG.pos;
    } else if (next === "PULSE_ARMED") {
      ROD_NAMES.forEach(n => cmd.rodStop(n));
      cmd.setMode("PULSE");
    } else if (next === "POST_PULSE_HEAT_TRANSFER") {
      cmd.setMode("OPERATE");
      fuelPeak = state.fuelTemperatureProxy;
    }
  }

  // 内环：把棒开到需求位置（死区内停车）
  function driveTo(name, target) {
    const pos = state.rod[name].pos;
    if (pos < target - DEADBAND) cmd.rodStart(name, +1);
    else if (pos > target + DEADBAND) cmd.rodStart(name, -1);
    else cmd.rodStop(name);
  }

  // 外环：按反应性误差调整棒位需求。需求被限制在实际棒位附近（抗积分饱和），
  // 所以调度器永远只是“按住提/插棒开关”，不会凭空跳到某个棒位。
  function trimTo(name, targetRho, dt, gain = 1.0, rate = 0.25) {
    const err = targetRho - state.reactivityProxy;
    const pos = state.rod[name].pos;
    const step = clamp(err * gain, -rate, rate) * dt;
    demand[name] = clamp(clamp(demand[name] + step, pos - 0.06, pos + 0.06), 0, 1);
    driveTo(name, demand[name]);
  }

  // 功率提升/保持：对数功率误差 → 目标反应性（远离目标时正周期，接近时归零），
  // 再由 SHIM 粗调 / REG 细调实现。
  function holdPower(dt) {
    const err = Math.log(fullPower / Math.max(state.powerProxy, 1e-9));
    const targetRho = clamp(err * 0.18, -0.25, 0.30);
    if (targetRho > 0.02 && demand.REG > 0.66 && state.rod.SHIM.pos < SHIM_ASCENT - DEADBAND) {
      demand.SHIM = SHIM_ASCENT;
      driveTo("SHIM", demand.SHIM);
    } else if (targetRho < -0.02 && demand.REG < 0.35 && state.rod.SHIM.pos > SHIM_CRITICAL + DEADBAND) {
      demand.SHIM = SHIM_CRITICAL;
      driveTo("SHIM", demand.SHIM);
    } else {
      cmd.rodStop("SHIM");
    }
    trimTo("REG", targetRho, dt, 1.2, 0.25);
  }

  function update(dt) {
    tPhase += dt;

    switch (phase) {
      // 4.1 联锁复位：只确认状态，不动设备
      case "INTERLOCKED_RESET": {
        if (tPhase > 0.8 && state.gratingLocked && state.rod.TRANS.pos <= DEADBAND) {
          setPhase("AUXILIARIES_READY");
        }
        break;
      }

      // 4.2 辅助设备就绪：一回路泵、保护回路复位、驱动机构小行程确认
      case "AUXILIARIES_READY": {
        if (!state.pumpOn && tPhase > 0.2) cmd.pumpToggle();
        if (state.scrammed && tPhase > 0.6) cmd.startup();
        if (!state.scrammed) {
          if (confirm === 0) {
            driveTo("SHIM", CONFIRM_TRAVEL);
            if (state.rod.SHIM.pos >= CONFIRM_TRAVEL - DEADBAND) confirm = 1;
          } else if (confirm === 1) {
            driveTo("SHIM", 0);
            if (state.rod.SHIM.pos <= DEADBAND) { cmd.rodStop("SHIM"); confirm = 2; }
          }
        }
        if (confirm === 2 && state.pumpOn && !state.scrammed && state.coolantFlowProxy > 0.25) {
          setPhase("LOW_POWER_APPROACH");
        }
        break;
      }

      // 4.3 低功率临界接近：SHIM 分步粗调 → REG 细调整定，功率保持在脉冲联锁以下
      case "LOW_POWER_APPROACH": {
        if (state.rod.SHIM.pos < SHIM_CRITICAL - DEADBAND) {
          demand.SHIM = SHIM_CRITICAL;
          driveTo("SHIM", demand.SHIM);
          break;   // 粗调完成前不动 REG（真实操作顺序：一次只提一根棒）
        }
        cmd.rodStop("SHIM");
        trimTo("REG", LOW_POWER_RHO, dt, 1.0, 0.25);
        const onTarget = Math.abs(state.reactivityProxy - LOW_POWER_RHO) < 0.02
          && state.powerProxy < pulsePowerLimit * 0.9
          && state.powerProxy > 1e-5;
        stable = onTarget ? stable + dt : 0;
        if (stable > 1.2) setPhase("PULSE_ARMED");
        break;
      }

      // 4.4 脉冲就绪：其他棒不动，TRANS 在座，等待联锁全部满足后点火
      case "PULSE_ARMED": {
        if (state.powerProxy > pulsePowerLimit) { setPhase("LOW_POWER_APPROACH"); break; }
        if (tPhase > 1.2 && state.mode === "PULSE" && state.rod.TRANS.pos <= DEADBAND) {
          cmd.pulseFire();
          if (state.pulse) { setPhase("PULSE"); break; }
        }
        if (tPhase > 8) setPhase("LOW_POWER_APPROACH");  // 联锁长期不满足→回去重新整定
        break;
      }

      // 4.5 脉冲：毫秒事件，由负温度反馈自终止；调度器只等它结束
      case "PULSE": {
        if (!state.pulse) setPhase("POST_PULSE_HEAT_TRANSFER");
        break;
      }

      // 4.6 脉冲后传热：棒保持不动，燃料热量传入池水，自然循环与三回路响应
      case "POST_PULSE_HEAT_TRANSFER": {
        const decayed = state.fuelTemperatureProxy < Math.max(0.25 * fuelPeak, 0.06);
        if ((tPhase > 3 && decayed) || tPhase > 25) setPhase("STEADY_POWER_ASCENT");
        break;
      }

      // 4.7 稳态功率提升 → 250 kW
      case "STEADY_POWER_ASCENT": {
        holdPower(dt);
        const onPower = Math.abs(state.powerProxy - fullPower) < 0.05 * fullPower;
        stable = onPower ? stable + dt : 0;
        if (stable > 2) setPhase("FULL_POWER_EQUILIBRIUM");
        break;
      }

      // 全功率平衡：REG 持续细调保持 250 kW（池水仍在缓慢升温，需要真实的微调）
      case "FULL_POWER_EQUILIBRIUM": {
        holdPower(dt);
        break;
      }

      default:
        break;
    }
  }

  return { update, reset, abort, get phase() { return phase; } };
}
