export function createFlyAudio() {
  let context = null;
  let master = null;
  const voices = new Map();
  let unlocked = false;
  let lastContact = 0;
  let lastTension = 0;

  const addVoice = (name, type, frequency) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.value = 0;
    oscillator.connect(gain).connect(master);
    oscillator.start();
    voices.set(name, { oscillator, gain });
  };

  const unlock = async () => {
    if (unlocked) { if (context?.state === "suspended") await context.resume(); return true; }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    context = new AudioContextClass();
    master = context.createGain();
    master.gain.value = 0.22;
    master.connect(context.destination);
    addVoice("burner", "sawtooth", 83);
    addVoice("wind", "sine", 132);
    addVoice("fabric", "triangle", 47);
    addVoice("suspension", "sine", 310);
    unlocked = true;
    if (context.state === "suspended") await context.resume();
    return true;
  };

  const setGain = (name, value, seconds = 0.05) => {
    const voice = voices.get(name);
    if (!voice || !context) return;
    voice.gain.gain.setTargetAtTime(Math.max(0, value), context.currentTime, seconds);
  };

  const contactSound = impulse => {
    if (!context || impulse < 120 || context.currentTime - lastContact < 0.16) return;
    lastContact = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(105, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(48, context.currentTime + 0.18);
    gain.gain.setValueAtTime(Math.min(0.38, impulse / 9000), context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.2);
    oscillator.connect(gain).connect(master);
    oscillator.start(); oscillator.stop(context.currentTime + 0.21);
  };

  const update = snapshot => {
    if (!unlocked || !context) return;
    const vehicle = snapshot.vehicle;
    const air = snapshot.atmosphere;
    const vx = vehicle.basket.velocity.x - air.windVelocityMps.x;
    const vy = vehicle.basket.velocity.y - air.windVelocityMps.y;
    const vz = vehicle.basket.velocity.z - air.windVelocityMps.z;
    const relativeWind = Math.hypot(vx, vy, vz);
    setGain("burner", vehicle.burnerValve * 0.26, 0.025);
    setGain("wind", Math.max(0, relativeWind - 1.5) * 0.012, 0.12);
    setGain("fabric", Math.min(0.07, (Math.abs(vehicle.swingRadians.x) + Math.abs(vehicle.swingRadians.z)) * 0.3), 0.1);
    const tensionRate = Math.abs(vehicle.suspensionTensionN - lastTension);
    setGain("suspension", Math.min(0.045, tensionRate / 160000), 0.06);
    lastTension = vehicle.suspensionTensionN;
    contactSound(vehicle.contactImpulseNs);
  };

  return {
    unlock,
    update,
    async suspend() { if (context?.state === "running") await context.suspend(); },
    async resume() { if (unlocked && context?.state === "suspended") await context.resume(); },
    status() { return { unlocked, contextState: context?.state || "NONE", voices: voices.size }; },
    dispose() {
      voices.forEach(voice => { try { voice.oscillator.stop(); } catch (error) { /* already stopped */ } voice.oscillator.disconnect(); voice.gain.disconnect(); });
      voices.clear();
      master?.disconnect();
      context?.close();
      context = null; master = null; unlocked = false;
    }
  };
}
