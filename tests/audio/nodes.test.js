// Node lifecycle across every sound the music and effects make: each started source has a stop
// scheduled after its envelope ends, noise sources never run out of buffer before their stop, and
// the 'ended' handler disconnects the per-note nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../../src/audio/audio.js';
import { ProceduralMusic } from '../../src/audio/music.js';
import { EffectsSynth, WEAPON_VOICE_KINDS } from '../../src/audio/sfx.js';
import { FakeAudioContext } from './fake-audio-context.js';

function everySound() {
  const context = new FakeAudioContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  engine.unlock();
  const music = new ProceduralMusic(engine);
  music.setIntensity(1);
  music.start();
  // 48 bars at 134 bpm reach every section (intro, groove, build, drop, breakdown) and every fill.
  for (let time = 0; time < 86; time += 0.05) {
    context.currentTime = time;
    music.update(time);
    if (Math.round(time / 0.05) % 20 === 0) music.hit(4);
  }
  music.cue('pickup');
  music.cue('bomb');
  const effects = new EffectsSynth(engine);
  for (const kind of WEAPON_VOICE_KINDS) {
    for (const tier of [1, 2, 3]) {
      context.currentTime += 1;
      effects.weaponFire(kind, tier);
    }
  }
  effects.kills(12);
  for (const method of ['pickup', 'bomb', 'death', 'expiry']) effects[method]();
  return context;
}

// Last automation time on the gain the source feeds, the end of its envelope.
function envelopeEnd(source) {
  const gain = source.outputs.find((node) => node.kind === 'gain');
  return Math.max(...gain.gain.events.map((event) => event.time));
}

test('every started source has a stop scheduled after its envelope', () => {
  const context = everySound();
  assert.ok(context.started.length > 200);
  for (const source of context.started) {
    assert.notEqual(source.stopTime, null, `${source.kind} has no stop`);
    assert.ok(source.stopTime > source.startTime);
    assert.ok(source.stopTime >= envelopeEnd(source), `${source.kind} stops at ${source.stopTime} before its envelope ends at ${envelopeEnd(source)} (start ${source.startTime})`);
  }
});

test('noise sources cover their whole duration, including the 1.6 s crash', () => {
  const context = everySound();
  const noiseSources = context.started.filter((node) => node.kind === 'buffer-source');
  assert.ok(noiseSources.some((source) => source.stopTime - source.startTime > 1.6), 'a crash was played');
  for (const source of noiseSources) {
    const playbackRate = source.playbackRate.events[0]?.value ?? 1;
    const bufferSeconds = (source.buffer.duration - source.startOffset) / playbackRate;
    assert.ok(source.loop || bufferSeconds >= source.stopTime - source.startTime,
      `noise of ${(source.stopTime - source.startTime).toFixed(3)} s from a ${bufferSeconds.toFixed(3)} s buffer`);
  }
});

test('ended disconnects each source and its per-note nodes', () => {
  const context = everySound();
  for (const source of context.started) {
    const perNote = source.outputs.slice();
    assert.ok(perNote.length > 0);
    source.fireEnded();
    assert.equal(source.outputs.length, 0);
    for (const node of perNote) assert.equal(node.outputs.length, 0, `${node.kind} after ${source.kind} stays connected`);
  }
});
