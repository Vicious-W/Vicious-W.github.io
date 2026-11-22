// Bakes the second storm (storm.js) off the main thread: it takes most of a second, and is
// needed only minutes into the journey (though it shows on the horizon long before).
import { bakeStorm, SECOND } from "./storm.js";

self.onmessage = () => {
  const s = bakeStorm(SECOND, undefined, { noTexture: true });
  self.postMessage({ data: s.data, field: s.field }, [s.data.buffer, s.field.buffer]);
};
