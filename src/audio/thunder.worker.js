// Makes the thunder of each flash off the main thread (a channel of hundreds of parts and
// several strokes take tens of milliseconds: on the main thread they stalled frames).
import { synthesize } from "./thundersynth.js";

self.onmessage = e => {
  const { id, job } = e.data;
  const out = synthesize(job);
  if (out) self.postMessage({ id, channels: out.channels, delay: out.delay }, out.channels.map(c => c.buffer));
  else self.postMessage({ id, channels: null });
};
