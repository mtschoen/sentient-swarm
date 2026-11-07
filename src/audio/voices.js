// Synth voices for the procedural music. Each call builds a few short-lived nodes, schedules them at
// a given audio time, and lets them stop on their own; nothing persists between notes. Shared by
// music.js (drums, bass, lead, risers) and sfx.js (via playTone and playNoise).

const SILENT = 0.0001;

export function midiToFrequency(note) {
  return 440 * 2 ** ((note - 69) / 12);
}

// Attack then exponential decay to silence on a gain parameter.
export function pluckEnvelope(param, time, peak, attackSeconds, decaySeconds) {
  param.setValueAtTime(SILENT, time);
  param.linearRampToValueAtTime(peak, time + attackSeconds);
  param.exponentialRampToValueAtTime(SILENT, time + attackSeconds + decaySeconds);
}

// A deterministic offset into the shared noise buffer so repeated hits do not sound identical.
function noiseOffset(seed) {
  return ((seed * 0.137) % 0.8 + 0.8) % 0.8;
}

export function playNoise(context, noiseBuffer, destination, time, { level, decaySeconds, seed = 0, attackSeconds = 0.001, playbackRate = 1 }) {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer;
  source.playbackRate.setValueAtTime(playbackRate, time);
  const gain = context.createGain();
  pluckEnvelope(gain.gain, time, level, attackSeconds, decaySeconds);
  source.connect(gain);
  gain.connect(destination);
  source.start(time, noiseOffset(seed));
  source.stop(time + attackSeconds + decaySeconds + 0.02);
  return gain;
}

// One oscillator with a pitch glide and a pluck envelope.
export function playTone(context, destination, time, { type = 'sine', fromFrequency, toFrequency = fromFrequency, glideSeconds = 0.05, level, attackSeconds = 0.002, decaySeconds, detuneCents = 0 }) {
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(fromFrequency, time);
  if (toFrequency !== fromFrequency) oscillator.frequency.exponentialRampToValueAtTime(toFrequency, time + glideSeconds);
  if (detuneCents !== 0) oscillator.detune.setValueAtTime(detuneCents, time);
  const gain = context.createGain();
  pluckEnvelope(gain.gain, time, level, attackSeconds, decaySeconds);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(time);
  oscillator.stop(time + attackSeconds + decaySeconds + 0.02);
  return oscillator;
}

// Kick: a sine whose pitch drops 150 to 50 Hz in about 110 ms, with a short square click on top.
export function playKick(context, destination, time, level) {
  playTone(context, destination, time, { fromFrequency: 150, toFrequency: 50, glideSeconds: 0.11, level, attackSeconds: 0.001, decaySeconds: 0.42 });
  playTone(context, destination, time, { type: 'square', fromFrequency: 900, toFrequency: 200, glideSeconds: 0.012, level: level * 0.12, attackSeconds: 0.0005, decaySeconds: 0.012 });
}

// Hats: noise bursts into the shared highpass. Open hats ring longer.
export function playHat(context, noiseBuffer, hatFilter, time, { level, open, seed }) {
  playNoise(context, noiseBuffer, hatFilter, time, { level, decaySeconds: open ? 0.24 : 0.045, seed });
}

// Clap: three quick noise bursts into the shared bandpass, the last one with a short tail.
export function playClap(context, noiseBuffer, clapFilter, time, { level, seed }) {
  playNoise(context, noiseBuffer, clapFilter, time, { level: level * 0.7, decaySeconds: 0.01, seed });
  playNoise(context, noiseBuffer, clapFilter, time + 0.012, { level: level * 0.8, decaySeconds: 0.01, seed: seed + 1 });
  playNoise(context, noiseBuffer, clapFilter, time + 0.024, { level, decaySeconds: 0.16, seed: seed + 2 });
}

// Crash: a long, bright noise wash.
export function playCrash(context, noiseBuffer, destination, time, { level, seed = 7 }) {
  const filter = context.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.setValueAtTime(4500, time);
  filter.connect(destination);
  playNoise(context, noiseBuffer, filter, time, { level, decaySeconds: 1.6, seed, playbackRate: 0.9 });
}

// Bass: a resonant sawtooth through its own lowpass with a filter pluck, plus a sine sub.
export function playBass(context, destination, time, { note, level, cutoff, lengthSeconds }) {
  const frequency = midiToFrequency(note);
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.setValueAtTime(9, time);
  filter.frequency.setValueAtTime(cutoff * 3, time);
  filter.frequency.exponentialRampToValueAtTime(cutoff, time + 0.12);
  filter.connect(destination);
  playTone(context, filter, time, { type: 'sawtooth', fromFrequency: frequency, level: level * 0.6, attackSeconds: 0.004, decaySeconds: lengthSeconds });
  playTone(context, destination, time, { fromFrequency: frequency, level: level * 0.7, attackSeconds: 0.004, decaySeconds: lengthSeconds });
}

// Lead: two sawtooths detuned by 12 cents either way into the shared lead filter.
export function playLead(context, leadFilter, time, { note, level, lengthSeconds }) {
  const frequency = midiToFrequency(note);
  for (const detuneCents of [-12, 12]) {
    playTone(context, leadFilter, time, { type: 'sawtooth', fromFrequency: frequency, level: level * 0.5, attackSeconds: 0.004, decaySeconds: lengthSeconds, detuneCents });
  }
}

// Riser: filtered noise sweeping up over durationSeconds, cut at the end.
export function playRiser(context, noiseBuffer, destination, time, { level, durationSeconds }) {
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.setValueAtTime(3, time);
  filter.frequency.setValueAtTime(400, time);
  filter.frequency.exponentialRampToValueAtTime(9000, time + durationSeconds);
  filter.connect(destination);
  const source = context.createBufferSource();
  source.buffer = noiseBuffer;
  source.loop = true;
  const gain = context.createGain();
  gain.gain.setValueAtTime(SILENT, time);
  gain.gain.exponentialRampToValueAtTime(level, time + durationSeconds);
  gain.gain.setValueAtTime(SILENT, time + durationSeconds + 0.01);
  source.connect(gain);
  gain.connect(filter);
  source.start(time);
  source.stop(time + durationSeconds + 0.02);
}
