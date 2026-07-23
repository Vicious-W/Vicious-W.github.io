// 第一页玻璃层的物理声音（Web Audio API）。
//
// 声音必须由**实际物理事件**驱动，而不是循环背景音效：
//   · 撞击声：由碰撞法向冲击速度触发，强度/亮度随冲击大小变化；
//   · 滑动声：由持续接触时的切向相对速度驱动（一个常驻噪声 voice）；
//   · 声像：由接触点的水平位置映射到左右声道。
//
// 约束（避免物理引擎在静止接触时制造噪声风暴）：
//   · AudioContext 只在用户首次手势后解锁；
//   · 撞击有最小冲击阈值、全局节流和 voice 上限；
//   · 主链路末端有压缩/限幅，限制峰值音量。
//
// 这里只负责**合成**；具体用什么物理量触发由 physicalScene.js 计算后传进来，
// 于是「碰撞事件 → 声音」之间有一条可审查的数据映射。

const MAX_VOICES = 8;        // 同时发声的撞击 voice 上限
const MIN_INTERVAL = 0.022;  // 撞击全局最小间隔（秒），压掉密集接触抖动
const MASTER = 0.5;          // 主增益（限幅前）

export function createGlassAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  let ctx = null;
  let master = null;
  let limiter = null;
  let noiseBuf = null;
  let slideSrc = null;
  let slideGain = null;
  let slidePan = null;
  let slideFilter = null;
  let activeVoices = 0;
  let lastImpact = 0;
  let unlocked = false;
  let disposed = false;

  const makeNoise = () => {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  };

  const build = () => {
    ctx = new Ctx();
    master = ctx.createGain();
    master.gain.value = MASTER;
    // 限幅器：把峰值压住，避免多声叠加时爆音
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master.connect(limiter);
    limiter.connect(ctx.destination);
    noiseBuf = makeNoise();

    // 常驻滑动 voice：循环噪声 → 低通 → 声像 → 增益，默认静音，靠 setSlide 拉起
    slideSrc = ctx.createBufferSource();
    slideSrc.buffer = noiseBuf;
    slideSrc.loop = true;
    slideFilter = ctx.createBiquadFilter();
    slideFilter.type = "bandpass";
    slideFilter.frequency.value = 1600;
    slideFilter.Q.value = 0.7;
    slidePan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    slideGain = ctx.createGain();
    slideGain.gain.value = 0;
    slideSrc.connect(slideFilter);
    if (slidePan) { slideFilter.connect(slidePan); slidePan.connect(slideGain); }
    else slideFilter.connect(slideGain);
    slideGain.connect(master);
    slideSrc.start();
  };

  const unlock = () => {
    if (disposed) return;
    if (!ctx) build();
    if (ctx.state === "suspended") ctx.resume();
    unlocked = true;
  };

  // strength: 0..1 冲击强度（已由物理侧归一）；velocity: 归一相对速度（决定亮度）；pan: -1..1
  const impact = ({ strength, velocity, pan }) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    if (strength <= 0.02) return;                 // 最小冲击过滤
    const now = ctx.currentTime;
    if (now - lastImpact < MIN_INTERVAL) return;  // 全局节流
    if (activeVoices >= MAX_VOICES) return;       // voice 上限
    lastImpact = now;
    activeVoices++;

    const s = Math.min(strength, 1);
    const v = Math.min(Math.max(velocity, 0), 1);
    const peak = 0.12 + s * 0.7;
    const dur = 0.05 + s * 0.13;

    const vGain = ctx.createGain();
    const panner = slidePan ? ctx.createStereoPanner() : null;
    if (panner) { panner.pan.value = Math.max(-1, Math.min(1, pan || 0)); }
    (panner || vGain).connect(master);
    if (panner) vGain.connect(panner);

    // 1) 噪声瞬态：撞击的「碎响」，亮度随冲击速度上升
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    nSrc.playbackRate.value = 0.8 + Math.random() * 0.5;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass";
    nFilt.frequency.value = 1400 + v * 4200;
    nFilt.Q.value = 0.9;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(peak, now);
    nGain.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    nSrc.connect(nFilt); nFilt.connect(nGain); nGain.connect(vGain);
    nSrc.start(now); nSrc.stop(now + dur + 0.02);

    // 2) 玻璃质「叮」：两个高频正弦分音，快速衰减
    const partials = [2600 + v * 1800, 4300 + v * 2600];
    partials.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f * (0.99 + Math.random() * 0.02);
      const g = ctx.createGain();
      const pk = peak * (i === 0 ? 0.5 : 0.28);
      g.gain.setValueAtTime(pk, now);
      g.gain.exponentialRampToValueAtTime(0.0006, now + dur * (1.6 - i * 0.4));
      osc.connect(g); g.connect(vGain);
      osc.start(now); osc.stop(now + dur * 1.7);
    });

    setTimeout(() => { activeVoices = Math.max(0, activeVoices - 1); }, (dur + 0.1) * 1000);
  };

  // level: 0..1 滑动强度；pan: -1..1。平滑跟随，避免开关噪声。
  const setSlide = (level, pan) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const target = Math.min(Math.max(level, 0), 1) * 0.09;
    slideGain.gain.setTargetAtTime(target, now, 0.05);
    slideFilter.frequency.setTargetAtTime(900 + level * 2200, now, 0.05);
    if (slidePan) slidePan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan || 0)), now, 0.08);
  };

  const suspend = () => { if (ctx && ctx.state === "running") ctx.suspend(); };

  const dispose = () => {
    disposed = true;
    if (slideSrc) { try { slideSrc.stop(); } catch (e) { /* 已停 */ } }
    if (ctx) ctx.close();
  };

  return { unlock, impact, setSlide, suspend, dispose };
}
