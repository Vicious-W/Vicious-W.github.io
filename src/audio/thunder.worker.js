// Makes the thunder of each flash off the main thread (a channel of hundreds of parts, several
// strokes and the echoes take tens of milliseconds: on the main thread they stalled frames).
import { synthesize } from "./thundersynth.js";

self.onmessage = e => {
  const { id, job } = e.data;
  const out = synthesize(job);
  if (out) self.postMessage({ id, left: out.left, right: out.right, delay: out.delay }, [out.left.buffer, out.right.buffer]);
  else self.postMessage({ id, left: null });
};
