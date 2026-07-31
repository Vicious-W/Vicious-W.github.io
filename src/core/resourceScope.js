export function createResourceScope(name = "scene") {
  const cleanups = [];
  let disposed = false;

  const add = cleanup => {
    if (disposed) {
      cleanup();
      return cleanup;
    }
    cleanups.push(cleanup);
    return cleanup;
  };

  const listen = (target, type, listener, options) => {
    target.addEventListener(type, listener, options);
    add(() => target.removeEventListener(type, listener, options));
    return listener;
  };

  const timeout = (listener, delay) => {
    const id = window.setTimeout(listener, delay);
    add(() => window.clearTimeout(id));
    return id;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { cleanups[i](); } catch (error) {
        console.warn(`${name}: cleanup failed`, error);
      }
    }
    cleanups.length = 0;
  };

  return {
    name,
    add,
    listen,
    timeout,
    dispose,
    get disposed() { return disposed; },
    get count() { return cleanups.length; }
  };
}
