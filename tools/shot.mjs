// Still captures: each one a converged still frame of the site (the "still" query mode).
//
//   node tools/shot.mjs [options] name "query" [name "query" ...]
//   node tools/shot.mjs [options] --list=shots.txt        (one "name query" per line)
//
// Options: --size=1280x720  --jobs=2 (parallel pages)  --out=captures  --sheet[=name]
//          --cols=3  --url=http://localhost:5173 (instead of dist/)  --headed  --software
// Example: node tools/shot.mjs --sheet hall "night&t=250&flash=near&ft=8" exit "night&t=500&yaw=1.9"
// Queries are the site's capture parameters (see CLAUDE.md); "still" is added if missing.
import fs from "node:fs";
import path from "node:path";
import { CAPTURES, gpuName, launch, makeSheet, parseArgs, parseSize, saveCanvas, serve, watchConsole } from "./lib.mjs";

const { options, rest } = parseArgs();
const jobs = [];
if (options.list) {
  for (const line of fs.readFileSync(String(options.list), "utf8").split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf(" ");
    jobs.push({ name: i < 0 ? l : l.slice(0, i), query: i < 0 ? "" : l.slice(i + 1).trim() });
  }
}
for (let i = 0; i + 1 < rest.length; i += 2) jobs.push({ name: rest[i], query: rest[i + 1] });
if (!jobs.length) {
  console.log('usage: node tools/shot.mjs [--size=1280x720] [--sheet] name "query" ...');
  process.exit(1);
}

const out = path.resolve(String(options.out || CAPTURES));
const { width, height } = parseSize(options.size);
const site = await serve(options);
const browser = await launch(options);
let gpuShown = false;
let next = 0;
const done = [];

async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const issues = watchConsole(page);
    const t0 = Date.now();
    const query = /(^|&)still(&|$)/.test(job.query) ? job.query : `still&${job.query}`;
    try {
      await page.goto(`${site.base}/?${query}`, { waitUntil: "commit", timeout: 600000 });
      if (!gpuShown) {
        gpuShown = true;
        console.log(`GPU: ${await gpuName(page)}`);
      }
      await page.waitForFunction(() => window.__stillDone === true, null, { timeout: 1800000, polling: 250 });
      const file = path.join(out, `${job.name}.png`);
      await saveCanvas(page, file);
      done.push(file);
      const bad = issues();
      console.log(`${job.name}  ${((Date.now() - t0) / 1000).toFixed(1)} s${bad.length ? `\n  ${bad.slice(0, 10).join("\n  ")}` : ""}`);
    } catch (e) {
      console.log(`${job.name}  FAILED: ${String(e.message).split("\n")[0]}`);
    }
    await page.close();
  }
}

await Promise.all(Array.from({ length: Math.max(1, Number(options.jobs || 2)) }, worker));
if (options.sheet && done.length) {
  const name = options.sheet === true ? "sheet" : String(options.sheet);
  const order = jobs.map(j => path.join(out, `${j.name}.png`)).filter(f => done.includes(f));
  await makeSheet(browser, order, path.join(out, `${name}.jpg`), { cols: Number(options.cols || 3), width: Math.min(width, 960) });
  console.log(`sheet: ${path.join(out, `${name}.jpg`)}`);
}
await browser.close();
site.close();
