// 反应堆池机械/气动/水体声音——都绑定到 sessionController 的真实状态和事件，
// 不合成无来源的核反应嗡鸣。来源见 docs/engineering/SOURCE_SCENE.md §4.1、
// docs/engineering/REACTOR_POOL_SYSTEM.md §7。
//
// · 控制棒电机：增益/音高随棒位变化速率（|Δpos/Δt|）驱动，静止不发声；
// · TRANS 气动：由 sessionController 发出的 trans_eject_impulse / trans_reseat_impulse
//   事件触发一次性瞬态，不循环播放；
// · 一回路泵：增益随 coolantFlowProxy 连续跟随；
// · 水面/入水：由 physicalScene 转发的水体冲量事件触发。

const MASTER = 0.4;

export function createReactorAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  let ctx = null, master = null, limiter = null, noiseBuf = null;
  let unlocked = false, disposed = false;

  let shimOsc = null, shimGain = null, shimFilter = null;
  let regOsc = null, regGain = null, regFilter = null;
  let pumpOsc = null, pumpGain = null;
  let prevPos = { SHIM: 0, REG: 0 };

  const makeNoise = () => {
    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  };

  const build = () => {
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = MASTER;
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.ratio.value = 10;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    noiseBuf = makeNoise();

    const buildMotor = (freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 500;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(filt); filt.connect(gain); gain.connect(master);
      osc.start();
      return { osc, gain, filt };
    };
    ({ osc: shimOsc, gain: shimGain, filt: shimFilter } = buildMotor(140));
    ({ osc: regOsc, gain: regGain, filt: regFilter } = buildMotor(210));

    pumpOsc = ctx.createOscillator();
    pumpOsc.type = "triangle";
    pumpOsc.frequency.value = 68;
    pumpGain = ctx.createGain();
    pumpGain.gain.value = 0;
    pumpOsc.connect(pumpGain); pumpGain.connect(master);
    pumpOsc.start();
  };

  const unlock = () => {
    if (disposed) return;
    if (!ctx) build();
    if (ctx.state === "suspended") ctx.resume();
    unlocked = true;
  };
  const suspend = () => { if (ctx && ctx.state === "running") ctx.suspend(); };

  const update = (dt, sessionState) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const shimV = Math.abs(sessionState.rod.SHIM.pos - prevPos.SHIM) / Math.max(dt, 1e-4);
    const regV = Math.abs(sessionState.rod.REG.pos - prevPos.REG) / Math.max(dt, 1e-4);
    prevPos.SHIM = sessionState.rod.SHIM.pos;
    prevPos.REG = sessionState.rod.REG.pos;

    const shimLevel = Math.min(1, shimV * 6);
    const regLevel = Math.min(1, regV * 6);
    shimGain.gain.setTargetAtTime(shimLevel * 0.05, now, 0.08);
    shimFilter.frequency.setTargetAtTime(300 + shimLevel * 500, now, 0.1);
    regGain.gain.setTargetAtTime(regLevel * 0.045, now, 0.06);
    regFilter.frequency.setTargetAtTime(350 + regLevel * 600, now, 0.08);

    const pumpLevel = sessionState.coolantFlowProxy;
    pumpGain.gain.setTargetAtTime(0.015 + pumpLevel * 0.05, now, 0.3);
    pumpOsc.frequency.setTargetAtTime(60 + pumpLevel * 30, now, 0.3);
  };

  function burst({ duration, noiseFreq, toneFreq, peak, pan = 0 }) {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));
    const bus = ctx.createGain();
    (panner || bus).connect(master);
    if (panner) bus.connect(panner);

    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass";
    nFilt.frequency.value = noiseFreq;
    nFilt.Q.value = 0.8;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(peak, now);
    nGain.gain.exponentialRampToValueAtTime(0.0006, now + duration);
    nSrc.connect(nFilt); nFilt.connect(nGain); nGain.connect(bus);
    nSrc.start(now); nSrc.stop(now + duration + 0.02);

    if (toneFreq) {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.value = toneFreq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(peak * 0.6, now);
      g.gain.exponentialRampToValueAtTime(0.0004, now + duration * 0.6);
      osc.connect(g); g.connect(bus);
      osc.start(now); osc.stop(now + duration * 0.6 + 0.02);
    }
  }

  // TRANS 气动瞬发：充气/阀动作噪声 + 止挡低频撞击
  const transEject = () => burst({ duration: 0.22, noiseFreq: 3200, toneFreq: 90, peak: 0.55 });
  const transReseat = () => burst({ duration: 0.14, noiseFreq: 700, toneFreq: 55, peak: 0.35 });
  // 水面冲量/结构振动：低频闷响，随强度变化
  const waterImpulse = (strength, pan = 0) => burst({
    duration: 0.3 + strength * 0.2, noiseFreq: 250 + strength * 300, toneFreq: 0,
    peak: 0.15 + Math.min(strength, 1) * 0.35, pan
  });

  const dispose = () => {
    disposed = true;
    if (ctx) ctx.close();
  };

  return { unlock, suspend, update, transEject, transReseat, waterImpulse, dispose };
}
