// The live lab: one visible Chrome window, maximised on the main screen (the owner's external
// monitor, on the NVIDIA GPU), kept open on the dev server and driven over a small local HTTP
// API. Each look at a change costs a page load rather than a browser launch, and the page runs
// in real time, as a viewer sees it (the dev server reloads it by itself after every edit).
//
//   npm run dev                                   (in the background)
//   node tools/lab.mjs [--url=http://localhost:5173] [--port=9333]      (keep it running)
//   curl "localhost:9333/goto?q=night%26t=150"     open the site with these parameters
//   curl "localhost:9333/shot?name=a"              screenshot of the window: captures/lab/a.jpg
//   curl "localhost:9333/burst?name=b&n=8&ms=250"  n screenshots in real time, ms apart, as a sheet
//   curl "localhost:9333/perf?s=5"                 frame rate and pacing over s seconds
//   curl "localhost:9333/console"                  console messages since the last page load
//   curl "localhost:9333/eval" --data "window.__sky.flight.state.time"
// Screenshots are at the page's CSS size (the window is 1.5x that in pixels on the owner's screen)
// unless &full=1.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { CAPTURES, parseArgs } from "./lib.mjs";

const { options } = parseArgs();
const base = String(options.url || "http://localhost:5173").replace(/\/$/, "");
const port = Number(options.port || 9333);
const out = path.join(CAPTURES, "lab");
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: [
    "--start-maximized",
    "--window-position=0,0",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--ignore-gpu-blocklist"
  ]
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
// Maximised, as the owner runs it (the canvas is then about 2560x1308 pixels on his monitor).
{
  const cdp = await context.newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
}
let logs = [];
page.on("console", m => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", e => logs.push(`pageerror: ${e.message}`));
page.on("load", () => (logs = []));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFrames(n = 30, timeout = 120000) {
  await page.waitForFunction(k => (window.__sky?.sky.frame || 0) > k, n, { timeout, polling: 100 });
}

async function state() {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    const s = window.__sky;
    return {
      gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "?",
      url: location.search,
      size: [innerWidth, innerHeight, devicePixelRatio],
      frame: s?.sky.frame,
      time: s?.flight.state.time,
      scale: s?.sky.cloudScale
    };
  });
}

async function shot(name, full) {
  const file = path.join(out, `${name}.jpg`);
  await page.screenshot({ path: file, type: "jpeg", quality: 88, scale: full ? "device" : "css" });
  return file;
}

// A contact sheet of images, composed in the page's own canvas.
async function sheet(files, file, cols) {
  const imgs = files.map(f => fs.readFileSync(f).toString("base64"));
  const data = await page.evaluate(
    async ({ imgs, cols }) => {
      const first = new Image();
      first.src = "data:image/jpeg;base64," + imgs[0];
      await first.decode();
      const w = 640;
      const h = Math.round((first.height / first.width) * w);
      const rows = Math.ceil(imgs.length / cols);
      const c = document.createElement("canvas");
      c.width = w * cols;
      c.height = h * rows;
      const g = c.getContext("2d");
      for (let i = 0; i < imgs.length; i++) {
        const img = new Image();
        img.src = "data:image/jpeg;base64," + imgs[i];
        await img.decode();
        g.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h, w, h);
      }
      return c.toDataURL("image/jpeg", 0.85).split(",")[1];
    },
    { imgs, cols }
  );
  fs.writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

async function perf(seconds) {
  return page.evaluate(async seconds => {
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
    return {
      fps: +(1000 / mean).toFixed(1),
      p95: +times[Math.floor(times.length * 0.95)].toFixed(1),
      max: +times[times.length - 1].toFixed(1),
      scale: window.__sky?.sky.cloudScale
    };
  }, seconds);
}

const routes = {
  async goto(q) {
    const query = q.get("q") || "";
    await page.goto(`${base}/?${query}`, { waitUntil: "commit" });
    // A still capture stops by itself once it has converged.
    if (/(^|&)still(&|$)/.test(query) && !/(^|&)motion(&|$)/.test(query)) {
      await page.waitForFunction(() => window.__stillDone === true, null, { timeout: 180000, polling: 100 });
    } else {
      await waitFrames(Number(q.get("frames") || 30));
    }
    if (q.get("wait")) await sleep(Number(q.get("wait")));
    return state();
  },
  async reload(q) {
    await page.reload({ waitUntil: "commit" });
    await waitFrames(Number(q.get("frames") || 30));
    return state();
  },
  state: () => state(),
  async shot(q) {
    if (q.get("wait")) await sleep(Number(q.get("wait")));
    return { file: await shot(q.get("name") || "shot", q.get("full") === "1"), ...(await state()) };
  },
  async burst(q) {
    const name = q.get("name") || "burst";
    const n = Number(q.get("n") || 8);
    const ms = Number(q.get("ms") || 250);
    const files = [];
    const t0 = Date.now();
    for (let i = 0; i < n; i++) {
      const due = t0 + i * ms;
      if (Date.now() < due) await sleep(due - Date.now());
      files.push(await shot(`${name}-${String(i).padStart(2, "0")}`, q.get("full") === "1"));
    }
    return { sheet: await sheet(files, path.join(out, `${name}-sheet.jpg`), Number(q.get("cols") || 4)), files: files.length };
  },
  perf: q => perf(Number(q.get("s") || 5)),
  console: () => ({ logs }),
  async quit() {
    setTimeout(async () => {
      await browser.close();
      process.exit(0);
    }, 50);
    return { bye: true };
  }
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const name = url.pathname.replace(/^\//, "");
    try {
      let result;
      if (name === "eval") {
        const body = await new Promise(r => {
          let b = "";
          req.on("data", c => (b += c));
          req.on("end", () => r(b));
        });
        result = await page.evaluate(body);
      } else if (routes[name]) {
        result = await routes[name](url.searchParams);
      } else {
        throw new Error(`unknown: ${name} (${Object.keys(routes).join(", ")}, eval)`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result, null, 1));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`lab on http://127.0.0.1:${port}, site ${base}`));
