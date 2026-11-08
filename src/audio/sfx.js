// Synthesized sound effects on the engine's effects bus: one voice per weapon kind (the base gun
// and the five upgrades, each tier layering more on top), kill splashes that scale with the kill
// count, and cues for pickup, bomb, death and expiry. Every method is a no-op until the engine is
// unlocked. Rate limits run on the audio clock over a trailing second: kills() at most
// KILL_VOICES_PER_SECOND voices, each scaled in gain by log2(1 + count); weaponFire() at most
// WEAPON_VOICES_PER_SECOND across kinds and a per-kind cap, so a beam (called every frame) or a
// scatter does not stack voices without bound.
import { playNoise, playTone } from './voices.js';

const KILL_VOICES_PER_SECOND = 8;
const WEAPON_VOICES_PER_SECOND = 20;
// The beam is continuous: it retriggers a buzz at this rate while it is on.
const BEAM_VOICES_PER_SECOND = 8;
const KIND_VOICES_PER_SECOND = 12;
const KILL_BASE_GAIN = 0.18;
const KILL_MAXIMUM_GAIN = 0.7;
const WEAPON_LEVEL = 0.22;

export function killVoiceGain(count) {
  return count > 0 ? KILL_BASE_GAIN * Math.log2(1 + count) : 0;
}

// Counts voices started in the trailing second and refuses past the limit.
class RateLimiter {
  constructor(voicesPerSecond) {
    this.voicesPerSecond = voicesPerSecond;
    this.startTimes = [];
  }

  prune(time) {
    while (this.startTimes.length > 0 && this.startTimes[0] <= time - 1) this.startTimes.shift();
  }

  available(time) {
    this.prune(time);
    return this.startTimes.length < this.voicesPerSecond;
  }

  tryAcquire(time) {
    if (!this.available(time)) return false;
    this.startTimes.push(time);
    return true;
  }
}

const semitones = (count) => 2 ** (count / 12);

// Each voice gets (context, output, time, noise, tier, level, variation). Tier 2 adds a layer an
// octave or a fifth up and tier 3 another, so tiers differ in pitch, weight and brightness.
const WEAPON_VOICES = Object.freeze({
  // Base gun: a short square blip, fast and light (it fires eight times a second).
  base: ({ context, output, time, level }) => {
    playTone(context, output, time, { type: 'square', fromFrequency: 1320, toFrequency: 520, glideSeconds: 0.045, level: level * 0.6, decaySeconds: 0.055 });
  },
  // Beam: a low detuned saw buzz that retriggers while the beam is on; higher tiers are thicker.
  beam: ({ context, output, time, tier, level }) => {
    const root = 110 * semitones(3 * (tier - 1));
    for (let layer = 0; layer < tier; layer += 1) {
      const frequency = root * [1, 1.5, 2][layer];
      playTone(context, output, time, { type: 'sawtooth', fromFrequency: frequency, level: level * 0.4, attackSeconds: 0.02, decaySeconds: 0.14, detuneCents: layer === 0 ? -8 : 8 });
    }
  },
  // Scatter: a noise burst with falling squares; each tier adds a wider detuned pair.
  scatter: ({ context, output, time, noise, tier, level, variation }) => {
    playNoise(context, noise, output, time, { level: level * 0.55, decaySeconds: 0.06 + 0.02 * tier, seed: variation, playbackRate: 1.4 });
    for (let layer = 0; layer < tier; layer += 1) {
      const from = 760 * semitones(-4 * layer);
      playTone(context, output, time, { type: 'square', fromFrequency: from, toFrequency: from / 2, glideSeconds: 0.06, level: level * 0.3, decaySeconds: 0.07, detuneCents: 25 * (layer + 1) });
    }
  },
  // Rail: a bright saw zap sweeping down, with a sine crack; tiers add parallel zaps.
  rail: ({ context, output, time, tier, level }) => {
    playTone(context, output, time, { type: 'sine', fromFrequency: 3200, toFrequency: 1200, glideSeconds: 0.02, level: level * 0.4, decaySeconds: 0.03 });
    for (let layer = 0; layer < tier; layer += 1) {
      const from = 2000 * semitones(7 * layer);
      playTone(context, output, time, { type: 'sawtooth', fromFrequency: from, toFrequency: from / 3, glideSeconds: 0.18, level: level * 0.4, decaySeconds: 0.2 });
    }
  },
  // Pulse: a round sine thump with a rising triangle bloop; tiers stack a fifth and an octave.
  pulse: ({ context, output, time, tier, level }) => {
    playTone(context, output, time, { fromFrequency: 180, toFrequency: 70, glideSeconds: 0.12, level: level * 0.9, decaySeconds: 0.2 });
    for (let layer = 0; layer < tier; layer += 1) {
      const from = 330 * [1, 1.5, 2][layer];
      playTone(context, output, time, { type: 'triangle', fromFrequency: from, toFrequency: from * 1.5, glideSeconds: 0.15, level: level * 0.45, decaySeconds: 0.18 });
    }
  },
  // Sidewinders: a whooshing noise and upward chirps, one more chirp per tier.
  sidewinders: ({ context, output, time, noise, tier, level, variation }) => {
    playNoise(context, noise, output, time, { level: level * 0.4, attackSeconds: 0.03, decaySeconds: 0.22, seed: variation, playbackRate: 0.8 });
    for (let layer = 0; layer < tier; layer += 1) {
      const from = 240 * semitones(5 * layer);
      playTone(context, output, time + layer * 0.03, { type: 'triangle', fromFrequency: from, toFrequency: from * 2.5, glideSeconds: 0.2, level: level * 0.45, decaySeconds: 0.22 });
    }
  },
});

export const WEAPON_VOICE_KINDS = Object.freeze(Object.keys(WEAPON_VOICES));

// MIDI notes of the pickup cue's rising run, and the time warp's falling one below it.
const WEAPON_PICKUP_NOTES = Object.freeze([72, 76, 79, 84]);
const TIME_WARP_PICKUP_NOTES = Object.freeze([67, 62, 58, 55]);

export class EffectsSynth {
  constructor(engine) {
    this.engine = engine;
    this.killLimiter = new RateLimiter(KILL_VOICES_PER_SECOND);
    this.weaponLimiter = new RateLimiter(WEAPON_VOICES_PER_SECOND);
    this.kindLimiters = new Map(WEAPON_VOICE_KINDS.map((kind) => [kind, new RateLimiter(kind === 'beam' ? BEAM_VOICES_PER_SECOND : KIND_VOICES_PER_SECOND)]));
    this.variation = 0;
  }

  // Returns { context, output, time, noise } or null while audio is locked.
  target() {
    const context = this.engine.context;
    if (context === null || this.engine.effectsOutput === null) return null;
    this.variation += 1;
    return { context, output: this.engine.effectsOutput, time: context.currentTime, noise: this.engine.noiseBuffer };
  }

  // kind: a WEAPON_VOICE_KINDS name (an unknown one plays the base gun); tier 1 to 3. Returns
  // whether a voice played.
  weaponFire(kind, tier = 1) {
    const voiceKind = Object.hasOwn(WEAPON_VOICES, kind) ? kind : 'base';
    const context = this.engine.context;
    if (context === null || this.engine.effectsOutput === null) return false;
    const kindLimiter = this.kindLimiters.get(voiceKind);
    if (!kindLimiter.available(context.currentTime) || !this.weaponLimiter.available(context.currentTime)) return false;
    kindLimiter.tryAcquire(context.currentTime);
    this.weaponLimiter.tryAcquire(context.currentTime);
    const target = this.target();
    const clampedTier = Math.min(3, Math.max(1, Math.round(tier)));
    WEAPON_VOICES[voiceKind]({ ...target, tier: clampedTier, level: WEAPON_LEVEL, variation: this.variation });
    return true;
  }

  // A splash for count kills this frame; returns whether a voice played.
  kills(count) {
    if (!(count > 0)) return false;
    const target = this.target();
    if (target === null || !this.killLimiter.tryAcquire(target.time)) return false;
    const { context, output, time, noise } = target;
    const gain = Math.min(KILL_MAXIMUM_GAIN, killVoiceGain(count));
    const pitch = 1 + (this.variation % 5) * 0.06;
    playNoise(context, noise, output, time, { level: gain, decaySeconds: 0.12 + 0.03 * Math.log2(1 + count), seed: this.variation, playbackRate: 0.7 * pitch });
    playTone(context, output, time, { type: 'square', fromFrequency: 520 * pitch, toFrequency: 90, glideSeconds: 0.1, level: gain * 0.5, decaySeconds: 0.11 });
    return true;
  }

  // type 'timewarp' (owner ruling R31) plays the same run falling and an octave and a half lower.
  pickup(type = null) {
    const target = this.target();
    if (target === null) return;
    const { context, output, time } = target;
    const notes = type === 'timewarp' ? TIME_WARP_PICKUP_NOTES : WEAPON_PICKUP_NOTES;
    notes.forEach((note, index) => {
      playTone(context, output, time + index * 0.05, { type: 'square', fromFrequency: 440 * 2 ** ((note - 69) / 12), level: 0.22, decaySeconds: 0.1 });
    });
  }

  bomb() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time, noise } = target;
    playTone(context, output, time, { fromFrequency: 90, toFrequency: 28, glideSeconds: 0.6, level: 0.9, attackSeconds: 0.002, decaySeconds: 0.9 });
    playNoise(context, noise, output, time, { level: 0.6, decaySeconds: 0.7, seed: this.variation, playbackRate: 0.5 });
  }

  death() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time, noise } = target;
    playTone(context, output, time, { type: 'sawtooth', fromFrequency: 420, toFrequency: 40, glideSeconds: 0.8, level: 0.45, decaySeconds: 0.85 });
    playNoise(context, noise, output, time, { level: 0.4, decaySeconds: 0.5, seed: this.variation, playbackRate: 0.4 });
  }

  expiry() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time } = target;
    playTone(context, output, time, { type: 'triangle', fromFrequency: 660, level: 0.3, decaySeconds: 0.12 });
    playTone(context, output, time + 0.12, { type: 'triangle', fromFrequency: 440, level: 0.3, decaySeconds: 0.2 });
  }
}
