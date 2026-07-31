export const DEFAULT_FIXED_STEP = 1 / 120;

export function createSimulationClock({
  step = DEFAULT_FIXED_STEP,
  maxSubsteps = 12,
  onStep,
  getSnapshot = () => null
} = {}) {
  let accumulator = 0;
  let simTime = 0;
  let paused = true;
  let disposed = false;
  let droppedTime = 0;
  let previous = getSnapshot();
  let current = previous;
  const actions = [];

  const queue = (at, action) => {
    if (disposed) return;
    actions.push({ at: Math.max(simTime, Number(at) || 0), action });
    actions.sort((a, b) => a.at - b.at);
  };

  const tick = () => {
    while (actions.length && actions[0].at <= simTime + 1e-9) {
      const item = actions.shift();
      item.action();
    }
    previous = current;
    onStep(step, simTime);
    simTime += step;
    current = getSnapshot();
  };

  const update = realDelta => {
    if (paused || disposed) return { steps: 0, alpha: accumulator / step };
    const delta = Math.max(0, Math.min(Number(realDelta) || 0, step * maxSubsteps * 2));
    accumulator += delta;
    let steps = 0;
    while (accumulator + 1e-12 >= step && steps < maxSubsteps) {
      tick();
      accumulator -= step;
      steps++;
    }
    if (accumulator >= step) {
      const kept = accumulator % step;
      droppedTime += accumulator - kept;
      accumulator = kept;
    }
    return { steps, alpha: accumulator / step };
  };

  const advance = seconds => {
    if (disposed) return 0;
    const count = Math.max(0, Math.floor((Number(seconds) || 0) / step + 1e-9));
    for (let i = 0; i < count; i++) tick();
    return count;
  };

  return {
    update,
    advance,
    queue,
    pause() { paused = true; },
    resume() { if (!disposed) paused = false; },
    resetAccumulator() { accumulator = 0; },
    dispose() { disposed = true; paused = true; actions.length = 0; accumulator = 0; },
    get step() { return step; },
    get simTime() { return simTime; },
    get paused() { return paused; },
    get alpha() { return accumulator / step; },
    get previousSnapshot() { return previous; },
    get currentSnapshot() { return current; },
    get droppedTime() { return droppedTime; },
    get pendingActions() { return actions.length; }
  };
}
