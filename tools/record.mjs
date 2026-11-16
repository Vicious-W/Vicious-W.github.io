// Real-time recording: runs the site live (as a viewer sees it, at the real frame rate of the
// GPU) and records the canvas to a WebM video with the browser's own MediaRecorder. If the page
// exposes window.__audioStream (a MediaStream, e.g. from a MediaStreamAudioDestinationNode),
// its sound is recorded too. Only meaningful on a real GPU.
//
//   node tools/record.mjs --query="night&t=380" [--seconds=15] [--size=1920x1080]
//                         [--out=captures/clip.webm] [--fps=60] [--url=...] [--headed]
import fs from "node:fs";
import path from "node:path";
import { CAPTURES, gpuName, launch, parseArgs, parseSize, serve, watchConsole } from "./lib.mjs";

const { options } = parseArgs();
const seconds = Number(options.seconds || 15);
const fps = Number(options.fps || 60);
const { width, height } = parseSize(options.size, "1920x1080");
const file = path.resolve(String(options.out || path.join(CAPTURES, "clip.webm")));

const site = await serve(options);
const browser = await launch(options);
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const issues = watchConsole(page);
await page.goto(`${site.base}/?${options.query || "night"}`, { waitUntil: "commit", timeout: 600000 });
console.log(`GPU: ${await gpuName(page)}`);
// Past the fade-in from black.
await page.waitForFunction(() => (window.__sky?.sky.frame || 0) > 5, null, { timeout: 600000, polling: 100 });
await page.waitForTimeout(2800);
const result = await page.evaluate(
  async ({ seconds, fps }) => {
    const canvas = document.getElementById("view");
    const stream = canvas.captureStream(fps);
    const audio = window.__audioStream ? window.__audioStream.getAudioTracks() : [];
    audio.forEach(t => stream.addTrack(t));
    const wanted = audio.length ? ["video/webm;codecs=vp8,opus", "video/webm"] : ["video/webm;codecs=vp8", "video/webm"];
    const type = wanted.find(t => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 16e6 });
    const chunks = [];
    let error = null;
    rec.onerror = e => (error = String(e.error || e));
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    const frame0 = window.__sky.sky.frame;
    const t0 = performance.now();
    rec.start(1000);
    await new Promise(r => setTimeout(r, seconds * 1000));
    rec.stop();
    await new Promise(r => (rec.onstop = r));
    const elapsed = (performance.now() - t0) / 1000;
    const blob = new Blob(chunks, { type });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { b64: btoa(binary), type, error, fps: (window.__sky.sky.frame - frame0) / elapsed, scale: window.__sky.sky.cloudScale };
  },
  { seconds, fps }
);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, Buffer.from(result.b64, "base64"));
console.log(`${file}  (${result.type}, ${(result.b64.length * 0.75 / 1e6).toFixed(1)} MB, ${result.fps.toFixed(1)} frames/s rendered, cloud scale ${result.scale})${result.error ? `  recorder error: ${result.error}` : ""}`);
const bad = issues();
if (bad.length) console.log(bad.slice(0, 20).join("\n"));
await browser.close();
site.close();
