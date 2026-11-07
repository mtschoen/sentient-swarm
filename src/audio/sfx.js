// Synthesized sound effects on the engine's effects bus: one voice per weapon kind, kill splashes
// that scale with the kill count, and cues for pickup, bomb, death and expiry. Every method is a
// no-op until the engine is unlocked. kills() plays at most KILL_VOICES_PER_SECOND voices in any
// one-second window (on the audio clock), each scaled in gain by log2(1 + count).
import { playNoise, playTone } from './voices.js';

const KILL_VOICES_PER_SECOND = 8;
const WEAPON_VOICES_PER_SECOND = 20;
const KILL_BASE_GAIN = 0.18;
const KILL_MAXIMUM_GAIN = 0.7;

export function killVoiceGain(count) {
  return count > 0 ? KILL_BASE_GAIN * Math.log2(1 + count) : 0;
}

// Counts voices started in the trailing second and refuses past the limit.
class RateLimiter {
  constructor(voicesPerSecond) {
    this.voicesPerSecond = voicesPerSecond;
    this.startTimes = [];
  }

  tryAcquire(time) {
    while (this.startTimes.length > 0 && this.startTimes[0] <= time - 1) this.startTimes.shift();
    if (this.startTimes.length >= this.voicesPerSecond) return false;
    this.startTimes.push(time);
    return true;
  }
}

export class EffectsSynth {
  constructor(engine) {
    this.engine = engine;
    this.killLimiter = new RateLimiter(KILL_VOICES_PER_SECOND);
    this.weaponLimiter = new RateLimiter(WEAPON_VOICES_PER_SECOND);
    this.variation = 0;
  }

  // Returns { context, output, time, noise } or null while audio is locked.
  target() {
    const context = this.engine.context;
    if (context === null || this.engine.effectsOutput === null) return null;
    this.variation += 1;
    return { context, output: this.engine.effectsOutput, time: context.currentTime, noise: this.engine.noiseBuffer };
  }

  // kind: 'blaster' | 'spread' | 'laser' | 'missile'; higher tiers sound brighter.
  weaponFire(kind, tier = 1) {
    const target = this.target();
    if (target === null || !this.weaponLimiter.tryAcquire(target.time)) return false;
    const { context, output, time, noise } = target;
    const lift = 2 ** ((Math.max(1, tier) - 1) / 12 * 2);
    if (kind === 'spread') {
      for (const detuneCents of [-30, 30]) {
        playTone(context, output, time, { type: 'square', fromFrequency: 660 * lift, toFrequency: 330 * lift, glideSeconds: 0.06, level: 0.08, decaySeconds: 0.07, detuneCents });
      }
    } else if (kind === 'laser') {
      playTone(context, output, time, { type: 'sawtooth', fromFrequency: 1800 * lift, toFrequency: 600 * lift, glideSeconds: 0.18, level: 0.09, decaySeconds: 0.2 });
    } else if (kind === 'missile') {
      playNoise(context, noise, output, time, { level: 0.14, attackSeconds: 0.03, decaySeconds: 0.25, seed: this.variation });
      playTone(context, output, time, { type: 'triangle', fromFrequency: 140 * lift, toFrequency: 320 * lift, glideSeconds: 0.25, level: 0.1, decaySeconds: 0.25 });
    } else {
      playTone(context, output, time, { type: 'square', fromFrequency: 880 * lift, toFrequency: 440 * lift, glideSeconds: 0.05, level: 0.07, decaySeconds: 0.06 });
    }
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

  pickup() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time } = target;
    [72, 76, 79, 84].forEach((note, index) => {
      playTone(context, output, time + index * 0.05, { type: 'square', fromFrequency: 440 * 2 ** ((note - 69) / 12), level: 0.1, decaySeconds: 0.09 });
    });
  }

  bomb() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time, noise } = target;
    playTone(context, output, time, { fromFrequency: 90, toFrequency: 28, glideSeconds: 0.6, level: 0.9, attackSeconds: 0.002, decaySeconds: 0.9 });
    playNoise(context, noise, output, time, { level: 0.5, decaySeconds: 0.7, seed: this.variation, playbackRate: 0.5 });
  }

  death() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time, noise } = target;
    playTone(context, output, time, { type: 'sawtooth', fromFrequency: 420, toFrequency: 40, glideSeconds: 0.8, level: 0.3, decaySeconds: 0.85 });
    playNoise(context, noise, output, time, { level: 0.3, decaySeconds: 0.5, seed: this.variation, playbackRate: 0.4 });
  }

  expiry() {
    const target = this.target();
    if (target === null) return;
    const { context, output, time } = target;
    playTone(context, output, time, { type: 'triangle', fromFrequency: 660, level: 0.12, decaySeconds: 0.12 });
    playTone(context, output, time + 0.12, { type: 'triangle', fromFrequency: 440, level: 0.12, decaySeconds: 0.2 });
  }
}
