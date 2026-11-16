// Frame cost.
// - GPU-synced (default): steps frames one by one and waits for the GPU after each, so the time
//   is the true cost of a complete frame, whatever the display's refresh rate.
// - --live: runs the site normally for a few seconds and reports the frame rate a viewer gets and
//   the cloud resolution the safety net settled on (1 = full).
//
//   node tools/bench.mjs [--size=1920x1080] [--live] [--seconds=8] "night&t=60" "night&t=267" ""
//   (an empty query is the day scene)
import { gpuName, launch, parseArgs, parseSize, serve, stepFrames } from "./lib.mjs";

const { options, rest } = parseArgs();
const queries = rest.length ? rest : ["", "night&t=60", "night&t=267", "night&t=400"];
const { width, height } = parseSize(options.size, "1920x1080");
const site = await serve(options);
const browser = await launch(options);
let shown = false;

for (const query of queries) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  if (!options.live) await stepFrames(page);
  await page.goto(`${site.base}/?${options.live ? query : `still&motion&frames=1000000&${query}`}`, { waitUntil: "commit", timeout: 600000 });
  if (!shown) {
    shown = true;
    console.log(`GPU: ${await gpuName(page)}  size ${width}x${height}`);
  }
  let line;
  if (options.live) {
    await page.waitForFunction(() => (window.__sky?.sky.frame || 0) > 5, null, { timeout: 600000, polling: 100 });
    const r = await page.evaluate(async seconds => {
      const times = [];
      let last = performance.now();
      const end = last + seconds * 1000;
      await new Promise(resolve => {
        const tick = now => {
          times.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      times.sort((a, b) => a - b);
      const mean = times.reduce((s, v) => s + v, 0) / times.length;
      return { fps: 1000 / mean, p95: times[Math.floor(times.length * 0.95)], scale: window.__sky.sky.cloudScale };
    }, Number(options.seconds || 8));
    line = `${r.fps.toFixed(1)} frames/s, 95% of frames under ${r.p95.toFixed(1)} ms, cloud scale ${r.scale.toFixed(2)}`;
  } else {
    await page.waitForFunction(() => window.__queue && window.__queue.length > 0, null, { timeout: 600000, polling: 100 });
    const ms = await page.evaluate(() => {
      const gl = window.__sky.renderer.getContext();
      const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 5; i++) {
        window.__step();
        sync();
      }
      const n = 20;
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        window.__step();
        sync();
      }
      return (performance.now() - t0) / n;
    });
    line = `${ms.toFixed(1)} ms per frame (${(1000 / ms).toFixed(0)} frames/s possible)`;
  }
  console.log(`${(query || "(day)").padEnd(28)} ${line}`);
  await page.close();
}
await browser.close();
site.close();
