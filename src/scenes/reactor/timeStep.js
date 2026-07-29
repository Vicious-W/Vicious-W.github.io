// 帧步长与循环参数的纯函数工具。
//
// 存在的原因是一个真实缺陷：`requestAnimationFrame` 回调收到的时间戳是**本帧开始**
// 的时刻，它可能早于紧邻其前调用的 `performance.now()`。因此启动帧的
// `now - last` 会是负数，负步长会进入点堆动力学、`world.step`、水体和音频，并让
// 沿管线前进的流向光珠相位变成负数 —— `CatmullRomCurve3.getPointAt(负值)` 会索引到
// `points[-1]`，抛出 `Cannot read properties of undefined (reading 'x')`。该异常从
// rAF 回调里逃逸后，帧尾的 `requestAnimationFrame` 不再执行，整个渲染循环永久停住。
//
// 这两个函数把"步长非负"和"相位落在 [0,1)"变成可单测的不变量。

/**
 * 把两个时间戳换算成秒制步长，并保证结果是 [0, max] 内的有限数。
 * 负步长（rAF 时间戳早于 last）夹为 0：宁可丢掉一帧的推进，也不让积分器倒退。
 */
export function frameDelta(now, last, max = 0.05) {
  const raw = (now - last) / 1000;
  if (!Number.isFinite(raw)) return 0;
  if (raw < 0) return 0;
  return raw > max ? max : raw;
}

/**
 * 把任意实数折到 [0, 1)。JS 的 `%` 保留被除数符号，`-0.2 % 1` 得到 `-0.2`，
 * 直接当曲线参数用会越界，因此不能只写 `x % 1`。
 */
export function wrap01(x) {
  if (!Number.isFinite(x)) return 0;
  const m = x % 1;
  return m < 0 ? m + 1 : m;
}
