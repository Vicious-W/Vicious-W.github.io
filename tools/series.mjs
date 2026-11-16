// Motion capture, frame by frame: the flight advances exactly 1/60 s per frame with the live
// temporal filter ("still&motion"), and every n-th frame is saved. Deterministic, so it shows
// flicker, smearing and turbulence exactly as a viewer would get them, at any GPU speed.
//
//   node tools/series.mjs --query="night&t=384" [--frames=120] [--every=6] [--name=series]
//                         [--size=960x540] [--sheet] [--url=...] [--headed] [--software]
import path from "node:path";
import { CAPTURES, gpuName, launch, makeSheet, parseArgs, parseSize, saveCanvas, serve, stepFrames, watchConsole } from "./lib.mjs";

const { options } = parseArgs();
const name = String(options.name || "series");
const frames = Number(options.frames || 120);
const every = Number(options.every || 6);
const { width, height } = parseSize(options.size, "960x540");
const out = path.join(path.resolve(String(options.out || CAPTURES)), name);

const site = await serve(options);
const browser = await launch(options);
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const issues = watchConsole(page);
await stepFrames(page);
await page.goto(`${site.base}/?still&motion&frames=1000000&${options.query || "night"}`, { waitUntil: "commit", timeout: 600000 });
console.log(`GPU: ${await gpuName(page)}`);
await page.waitForFunction(() => window.__queue && window.__queue.length > 0, null, { timeout: 600000, polling: 100 });
const files = [];
for (let f = 1; f <= frames; f++) {
  await page.evaluate(() => window.__step());
  if (f % every === 0) {
    const file = path.join(out, `${name}-${String(f).padStart(4, "0")}.png`);
    await saveCanvas(page, file);
    files.push(file);
    const t = await page.evaluate(() => window.__sky.flight.state.time);
    process.stdout.write(`${f}:${t.toFixed(2)} `);
  }
}
console.log();
const bad = issues();
if (bad.length) console.log(bad.slice(0, 20).join("\n"));
if (options.sheet) {
  await makeSheet(browser, files, path.join(out, `${name}-sheet.jpg`), { cols: Number(options.cols || 6), width: 320 });
  console.log(`sheet: ${path.join(out, `${name}-sheet.jpg`)}`);
}
await browser.close();
site.close();
