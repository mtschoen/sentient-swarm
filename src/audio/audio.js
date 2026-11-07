// Owns the AudioContext and the output bus: music and effects gains feed a master gain and a
// compressor, so the mix can be loud without clipping. The context is created on unlock() only,
// which the page calls from a user gesture (browsers keep audio suspended until one happens).
// A failed construction (no Web Audio, blocked device) warns once and leaves the engine silent;
// it never throws into the page.
const MASTER_LEVEL = 0.9;
const VOLUME_SMOOTHING_SECONDS = 0.03;

export class AudioEngine {
  constructor({ contextFactory = () => new AudioContext() } = {}) {
    this.contextFactory = contextFactory;
    this.audioContext = null;
    this.failed = false;
    this.musicVolume = 1;
    this.effectsVolume = 1;
    this.musicOutput = null;
    this.effectsOutput = null;
    this.noiseBuffer = null;
  }

  get context() {
    return this.audioContext;
  }

  // Returns the context, or null if audio is unavailable.
  unlock() {
    if (this.audioContext !== null || this.failed) return this.audioContext;
    try {
      const context = this.contextFactory();
      const compressor = context.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-12, 0);
      compressor.knee.setValueAtTime(6, 0);
      compressor.ratio.setValueAtTime(4, 0);
      compressor.attack.setValueAtTime(0.003, 0);
      compressor.release.setValueAtTime(0.15, 0);
      compressor.connect(context.destination);
      const master = context.createGain();
      master.gain.setValueAtTime(MASTER_LEVEL, 0);
      master.connect(compressor);
      this.musicOutput = context.createGain();
      this.musicOutput.gain.setValueAtTime(this.musicVolume, 0);
      this.musicOutput.connect(master);
      this.effectsOutput = context.createGain();
      this.effectsOutput.gain.setValueAtTime(this.effectsVolume, 0);
      this.effectsOutput.connect(master);
      this.noiseBuffer = createNoiseBuffer(context);
      this.audioContext = context;
      this.resume();
    } catch (error) {
      this.failed = true;
      console.warn(`murmuration: audio unavailable (${error?.message ?? error})`);
    }
    return this.audioContext;
  }

  setMusicVolume(volume) {
    this.musicVolume = clampUnit(volume);
    rampGain(this.audioContext, this.musicOutput, this.musicVolume);
  }

  setEffectsVolume(volume) {
    this.effectsVolume = clampUnit(volume);
    rampGain(this.audioContext, this.effectsOutput, this.effectsVolume);
  }

  resume() {
    this.audioContext?.resume?.()?.catch?.(() => {});
  }

  suspend() {
    this.audioContext?.suspend?.()?.catch?.(() => {});
  }
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, value));
}

function rampGain(context, node, value) {
  if (context === null || node === null) return;
  node.gain.cancelScheduledValues(context.currentTime);
  node.gain.setTargetAtTime(value, context.currentTime, VOLUME_SMOOTHING_SECONDS);
}

// One second of deterministic white noise, shared by hats, claps, risers and effects. A small
// linear congruential generator keeps it reproducible without Math.random.
function createNoiseBuffer(context) {
  const length = context.sampleRate;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const samples = buffer.getChannelData(0);
  let seed = 22222;
  for (let index = 0; index < length; index += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    samples[index] = seed / 2147483648 - 1;
  }
  return buffer;
}
