// Shared helpers for the capture, benchmark and check tools (development only, never deployed).
// - serve(): a static server for the built site (dist/), or use --url to point at a running
//   dev server (npm run dev) instead;
// - launch(): Chrome on the real GPU on a desktop (the installed Chrome, through
//   playwright-core); software rendering (SwiftShader) only where there is no GPU, e.g. a cloud
//   container that has Playwright's own Chromium under /opt/pw-browsers;
// - gpuName(): the GPU that WebGL actually uses (always check it: a fallback to software
//   rendering makes every timing meaningless);
// - writePng(), makeSheet(): images without Python or other tools.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CAPTURES = path.join(ROOT, "captures");

/** --key=value and --flag options, and the positional arguments. */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  const rest = [];
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) options[m[1]] = m[2] ?? true;
    else rest.push(a);
  }
  return { options, rest };
}

/** "1280x720" -> { width, height } */
export function parseSize(text, fallback = "1280x720") {
  const [w, h] = String(text || fallback).split("x").map(Number);
  return { width: w, height: h };
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm"
};

/**
 * The site to load: { base, close() }. With options.url, that server (e.g. the Vite dev
 * server); otherwise a static server for dist/ (run `npm run build` first).
 */
export async function serve(options = {}) {
  if (options.url) return { base: String(options.url).replace(/\/$/, ""), close() {} };
  const root = path.resolve(options.dist ? String(options.dist) : path.join(ROOT, "dist"));
  if (!fs.existsSync(path.join(root, "index.html"))) throw new Error(`No built site in ${root}: run "npm run build" first, or pass --url=http://localhost:5173`);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.resolve(root, rel);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/**
 * A browser. On a desktop: the installed Chrome with the real GPU (headless by default;
 * --headed shows the window, which some drivers need for the GPU to be used). --software
 * forces SwiftShader. Audio may start without a click, for recordings.
 */
export async function launch(options = {}) {
  const noGpu = options.software || (process.platform === "linux" && fs.existsSync("/opt/pw-browsers"));
  const common = ["--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];
  if (noGpu) {
    return chromium.launch({ args: [...common, "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  }
  return chromium.launch({
    channel: options.channel || "chrome",
    headless: !options.headed,
    args: [...common, "--ignore-gpu-blocklist", "--enable-gpu-rasterization"]
  });
}

/** The GPU WebGL renders with, as the page sees it. */
export async function gpuName(page) {
  return page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return "no WebGL2";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/** Console messages worth reading (the usual noise of read-backs and software GL dropped). */
export function watchConsole(page) {
  const logs = [];
  page.on("console", m => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", e => logs.push(`pageerror: ${e.message}`));
  return () => logs.filter(l => !/GPU stall due to ReadPixels|Automatic fallback to software WebGL|GroupMarkerNotSet/.test(l));
}

/** Saves the page's canvas (still mode keeps its drawing buffer) as a PNG. */
export async function saveCanvas(page, file) {
  const dataUrl = await page.evaluate(() => document.getElementById("view").toDataURL("image/png"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
}

/**
 * Replaces requestAnimationFrame so that frames advance only on window.__step(): each step is
 * exactly one frame (with "still&motion" in the query, 1/60 s of flight).
 */
export async function stepFrames(page) {
  await page.addInitScript(() => {
    window.__queue = [];
    window.requestAnimationFrame = cb => {
      window.__queue.push(cb);
      return 1;
    };
    window.__step = () => {
      const q = window.__queue;
      window.__queue = [];
      const now = performance.now();
      q.forEach(cb => cb(now));
      return q.length;
    };
  });
}

// ---- PNG without dependencies ----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Writes an 8-bit RGB image (rgb: width * height * 3 bytes) as a PNG. */
export function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
  );
}

/** Tiles images into one JPEG (drawn in the browser, so no image library is needed). */
export async function makeSheet(browser, files, out, { cols = 3, width = 640 } = {}) {
  if (!files.length) return;
  const page = await browser.newPage();
  const images = files.map(f => `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`);
  const dataUrl = await page.evaluate(
    async ({ images, cols, width }) => {
      const loaded = await Promise.all(
        images.map(
          src =>
            new Promise((resolve, reject) => {
              const im = new Image();
              im.onload = () => resolve(im);
              im.onerror = reject;
              im.src = src;
            })
        )
      );
      const gap = 6;
      const w = width;
      const h = Math.round((width * loaded[0].height) / loaded[0].width);
      const n = Math.min(cols, loaded.length);
      const rows = Math.ceil(loaded.length / n);
      const c = document.createElement("canvas");
      c.width = n * (w + gap) - gap;
      c.height = rows * (h + gap) - gap;
      const g = c.getContext("2d");
      g.fillStyle = "#222";
      g.fillRect(0, 0, c.width, c.height);
      loaded.forEach((im, i) => g.drawImage(im, (i % n) * (w + gap), Math.floor(i / n) * (h + gap), w, h));
      return c.toDataURL("image/jpeg", 0.9);
    },
    { images, cols, width }
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
  await page.close();
}
