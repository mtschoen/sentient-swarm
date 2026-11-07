import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../../src/audio/audio.js';
import { EffectsSynth, killVoiceGain } from '../../src/audio/sfx.js';
import { FakeAudioContext } from './fake-audio-context.js';

function unlockedEffects() {
  const context = new FakeAudioContext();
  const engine = new AudioEngine({ contextFactory: () => context });
  engine.unlock();
  return { context, effects: new EffectsSynth(engine) };
}

test('kills plays at most 8 voices per second', () => {
  const { context, effects } = unlockedEffects();
  let voices = 0;
  for (let index = 0; index < 20; index += 1) if (effects.kills(3)) voices += 1;
  assert.equal(voices, 8);
  context.currentTime = 0.5;
  assert.equal(effects.kills(3), false);
  context.currentTime = 1.01;
  assert.equal(effects.kills(3), true);
});

test('kill voice gain scales with log2(1 + count)', () => {
  assert.equal(killVoiceGain(0), 0);
  assert.ok(Math.abs(killVoiceGain(1) / killVoiceGain(3) - 1 / 2) < 1e-9);
  assert.ok(Math.abs(killVoiceGain(7) / killVoiceGain(1) - 3) < 1e-9);
});

test('every cue is callable, and silent before unlock', () => {
  const locked = new EffectsSynth(new AudioEngine({ contextFactory: () => new FakeAudioContext() }));
  assert.equal(locked.kills(4), false);
  for (const method of ['pickup', 'bomb', 'death', 'expiry']) locked[method]();
  locked.weaponFire('blaster', 1);

  const { context, effects } = unlockedEffects();
  for (const method of ['pickup', 'bomb', 'death', 'expiry']) {
    const before = context.started.length;
    effects[method]();
    assert.ok(context.started.length > before, `${method} starts a source`);
  }
  for (const kind of ['blaster', 'spread', 'laser', 'missile', 'unknown']) {
    context.currentTime += 1;
    const before = context.started.length;
    effects.weaponFire(kind, 2);
    assert.ok(context.started.length > before, `${kind} starts a source`);
  }
});
