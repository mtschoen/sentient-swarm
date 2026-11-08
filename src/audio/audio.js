// Owns the AudioContext and the output bus: music and effects gains feed a master gain, a glue
// compressor, a limiter and an output trim, so the mix is loud and dense on small speakers without
// clipping (levels measured offline by tests/browser/audio-render.mjs: the Web Audio compressor
// adds its own makeup gain, so the trim keeps about 1 dB of headroom under full scale). The
// context is created on unlock() only, which the page calls inside a user gesture's handler.
// A failed construction (no Web Audio, blocked device) warns once and leaves the engine silent;
// it never throws into the page.
const MASTER_LEVEL = 1.7;
const GLUE_COMPRESSOR = Object.freeze({ threshold: -16, knee: 8, ratio: 3, attack: 0.006, release: 0.2 });
const LIMITER = Object.freeze({ threshold: -8, knee: 0, ratio: 20, attack: 0.001, release: 0.08 });
const OUTPUT_TRIM = 0.85;
// The settings defaults (music 80, effects 80 percent).
export const DEFAULT_MUSIC_VOLUME = 0.8;
export const DEFAULT_EFFECTS_VOLUME = 0.8;
const VOLUME_SMOOTHING_SECONDS = 0.03;

export class AudioEngine {
  constructor({ contextFactory = () => new AudioContext() } = {}) {
    this.contextFactory = contextFactory;
    this.audioContext = null;
    this.failed = false;
    this.musicVolume = DEFAULT_MUSIC_VOLUME;
    this.effectsVolume = DEFAULT_EFFECTS_VOLUME;
    this.musicOutput = null;
    this.effectsOutput = null;
    this.muteOutput = null;
    this.muted = false;
    this.pendingResume = Promise.resolve();
    this.noiseBuffer = null;
  }

  get context() {
    return this.audioContext;
  }

  // Returns the context, or null if audio is unavailable. Safe to call on every gesture: the
  // context is created once, and each call asks it to resume (a context created outside a real
  // user activation, such as a touch pointerdown, stays suspended until a later gesture).
  unlock() {
    if (this.audioContext !== null) {
      this.resume();
      return this.audioContext;
    }
    if (this.failed) return null;
    try {
      const context = this.contextFactory();
      const trim = context.createGain();
      trim.gain.setValueAtTime(OUTPUT_TRIM, 0);
      trim.connect(context.destination);
      const limiter = createCompressor(context, LIMITER);
      limiter.connect(trim);
      const compressor = createCompressor(context, GLUE_COMPRESSOR);
      compressor.connect(limiter);
      // The mute gain sits after the master so M silences music and effects together.
      this.muteOutput = context.createGain();
      this.muteOutput.gain.setValueAtTime(this.muted ? 0 : 1, 0);
      this.muteOutput.connect(compressor);
      const master = context.createGain();
      master.gain.setValueAtTime(MASTER_LEVEL, 0);
      master.connect(this.muteOutput);
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

  // Mutes or restores everything (music and effects); volumes are kept.
  setMuted(muted) {
    this.muted = Boolean(muted);
    rampGain(this.audioContext, this.muteOutput, this.muted ? 0 : 1);
  }

  // Returns a promise that settles (never rejects) once the context has tried to resume; the latest
  // one is also kept as pendingResume (unlock() resumes without returning it).
  resume() {
    this.pendingResume = Promise.resolve(this.audioContext?.resume?.()).catch(() => {});
    return this.pendingResume;
  }

  suspend() {
    return Promise.resolve(this.audioContext?.suspend?.()).catch(() => {});
  }
}

function createCompressor(context, settings) {
  const compressor = context.createDynamicsCompressor();
  for (const [name, value] of Object.entries(settings)) compressor[name].setValueAtTime(value, 0);
  return compressor;
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
