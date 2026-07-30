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
//
// 损伤阶段影响音色（SOURCE_SCENE.md §7.5）：完整玻璃碰撞明亮清脆；已开裂玻璃碰撞
// 更闷（低通更低）；裂纹扩展叠加一次高频短促声；破碎瞬态是独立的宽带爆发声；
// 碎片二次碰撞音色更薄更高（有效质量更小）。视觉破碎与音频共用同一次碰撞/损伤
// 事件计算结果，不使用互不相关的计时器。

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
  // 只读发声计数（验收可见性）：证明声音由实际物理事件触发，而不是循环背景音，
  // 也证明解锁前不发声。不参与合成，只在三个发声入口通过守卫后自增。
  const fired = { impact: 0, crack: 0, fracture: 0 };

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

  // strength: 0..1 冲击强度；velocity: 归一相对速度（决定亮度）；pan: -1..1；
  // stage: 当前损伤阶段（影响音色明暗）；shard: 是否为碎片（音色更薄更高）。
  const impact = ({ strength, velocity, pan, stage = "INTACT", shard = false }) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    if (strength <= 0.02) return;                 // 最小冲击过滤
    const now = ctx.currentTime;
    if (now - lastImpact < MIN_INTERVAL) return;  // 全局节流
    if (activeVoices >= MAX_VOICES) return;       // voice 上限
    lastImpact = now;
    activeVoices++;
    fired.impact++;

    const s = Math.min(strength, 1);
    const v = Math.min(Math.max(velocity, 0), 1);
    const peak = 0.12 + s * 0.7;
    const dur = 0.05 + s * 0.13;
    // 已开裂/损伤玻璃更闷（低通下移）；碎片更薄更高（有效质量更小，共振频率更高）
    const dull = stage === "CRACKED" ? 0.55 : stage === "MICRO_DAMAGED" ? 0.8 : 1.0;
    const shardMul = shard ? 1.6 : 1.0;

    const vGain = ctx.createGain();
    const panner = slidePan ? ctx.createStereoPanner() : null;
    if (panner) { panner.pan.value = Math.max(-1, Math.min(1, pan || 0)); }
    (panner || vGain).connect(master);
    if (panner) vGain.connect(panner);

    // 1) 噪声瞬态：撞击的「碎响」，亮度随冲击速度上升
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    nSrc.playbackRate.value = (0.8 + Math.random() * 0.5) * shardMul;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = "bandpass";
    nFilt.frequency.value = (1400 + v * 4200) * dull * shardMul;
    nFilt.Q.value = 0.9;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(peak, now);
    nGain.gain.exponentialRampToValueAtTime(0.0008, now + dur);
    nSrc.connect(nFilt); nFilt.connect(nGain); nGain.connect(vGain);
    nSrc.start(now); nSrc.stop(now + dur + 0.02);

    // 2) 玻璃质「叮」：两个高频正弦分音，快速衰减
    const partials = [2600 + v * 1800, 4300 + v * 2600].map(f => f * dull * shardMul);
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

  // 裂纹扩展：短促高频「咔」，叠加在触发它的撞击声之上，不使用独立计时器。
  const crackTick = (pan = 0) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    fired.crack++;
    const now = ctx.currentTime;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));
    const g = ctx.createGain();
    (panner || g).connect(master);
    if (panner) g.connect(panner);
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(5200, now);
    osc.frequency.exponentialRampToValueAtTime(2200, now + 0.05);
    g.gain.setValueAtTime(0.18, now);
    g.gain.exponentialRampToValueAtTime(0.0004, now + 0.07);
    osc.connect(g); osc.start(now); osc.stop(now + 0.08);
  };

  // 破碎瞬态：独立的宽带爆发声，区别于普通撞击。
  const fracture = (pan = 0) => {
    if (!unlocked || disposed || !ctx || ctx.state !== "running") return;
    fired.fracture++;
    const now = ctx.currentTime;
    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));
    const bus = ctx.createGain();
    (panner || bus).connect(master);
    if (panner) bus.connect(panner);
    const nSrc = ctx.createBufferSource();
    nSrc.buffer = noiseBuf;
    const nFilt = ctx.createBiquadFilter();
    nFilt.type = "highpass";
    nFilt.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.75, now);
    g.gain.exponentialRampToValueAtTime(0.0006, now + 0.28);
    nSrc.connect(nFilt); nFilt.connect(g); g.connect(bus);
    nSrc.start(now); nSrc.stop(now + 0.3);
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

  // 只读状态：解锁前 `state` 是 "NONE"（连 AudioContext 都还没建，因此不可能触发
  // 浏览器的自动播放拦截）；解锁后是 AudioContext 自己的状态。
  const status = () => ({
    unlocked,
    state: ctx ? ctx.state : "NONE",
    sampleRate: ctx ? ctx.sampleRate : 0,
    voices: activeVoices,
    maxVoices: MAX_VOICES,
    minInterval: MIN_INTERVAL,
    fired: { ...fired }
  });

  return { unlock, impact, crackTick, fracture, setSlide, suspend, dispose, status };
}
