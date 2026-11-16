// Runs the site live for each query, drags the view a little (like turning the head), and
// reports console errors, the GPU in use and the state reached. Use it before every push.
//
//   node tools/check.mjs [--size=1280x720] [--frames=40] "night" "night&t=388" ""
import { gpuName, launch, parseArgs, parseSize, serve, watchConsole } from "./lib.mjs";

const { options, rest } = parseArgs();
const queries = rest.length ? rest : ["", "night", "night&t=250", "night&t=400"];
const { width, height } = parseSize(options.size, "1280x720");
const frames = Number(options.frames || 40);
const site = await serve(options);
const browser = await launch(options);
let failed = false;
let shown = false;

for (const query of queries) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const issues = watchConsole(page);
  try {
    await page.goto(`${site.base}/?${query}`, { waitUntil: "commit", timeout: 600000 });
    if (!shown) {
      shown = true;
      console.log(`GPU: ${await gpuName(page)}`);
    }
    await page.waitForFunction(n => (window.__sky?.sky.frame || 0) >= n, frames, { timeout: 1800000, polling: 250 });
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.down();
    await page.mouse.move(width / 2 - 150, height / 2 + 50, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(n => window.__sky.sky.frame >= n, frames + 10, { timeout: 1800000, polling: 250 });
    const info = await page.evaluate(() => ({
      frame: window.__sky.sky.frame,
      time: +window.__sky.flight.state.time.toFixed(1),
      scale: window.__sky.sky.cloudScale,
      veil: getComputedStyle(document.getElementById("veil")).opacity
    }));
    const bad = issues();
    if (bad.length) failed = true;
    console.log(`${(query || "(day)").padEnd(24)} ${JSON.stringify(info)}  ${bad.length ? `\n  ${bad.slice(0, 20).join("\n  ")}` : "console clean"}`);
  } catch (e) {
    failed = true;
    console.log(`${(query || "(day)").padEnd(24)} FAILED: ${String(e.message).split("\n")[0]}`);
  }
  await page.close();
}
await browser.close();
site.close();
process.exit(failed ? 1 : 0);
