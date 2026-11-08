import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../../src/audio/audio.js';
import { EffectsSynth, killVoiceGain, WEAPON_VOICE_KINDS } from '../../src/audio/sfx.js';
import { WEAPON_TYPE_NAMES } from '../../src/game/weaponTypes.js';
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
  assert.equal(locked.weaponFire('base', 1), false);

  const { context, effects } = unlockedEffects();
  for (const method of ['pickup', 'bomb', 'death', 'expiry']) {
    const before = context.started.length;
    effects[method]();
    assert.ok(context.started.length > before, `${method} starts a source`);
  }
});

// The type and first frequency of each started oscillator, plus the noise sources, sorted.
function fingerprint(kind, tier) {
  const { context, effects } = unlockedEffects();
  assert.equal(effects.weaponFire(kind, tier), true, `${kind} tier ${tier} plays`);
  return context.started.map((node) => (node.kind === 'oscillator' ? `${node.type}:${Math.round(node.frequency.events[0].value)}` : node.kind)).sort().join(' ');
}

test('every weapon kind (the base gun and all five upgrades) has its own voice, and tiers sound different', () => {
  assert.deepEqual([...WEAPON_VOICE_KINDS].sort(), ['base', ...WEAPON_TYPE_NAMES].sort());
  const tierOne = WEAPON_VOICE_KINDS.map((kind) => fingerprint(kind, 1));
  assert.equal(new Set(tierOne).size, WEAPON_VOICE_KINDS.length, 'one distinct voice per kind');
  for (const kind of WEAPON_TYPE_NAMES) {
    const tiers = [1, 2, 3].map((tier) => fingerprint(kind, tier));
    assert.equal(new Set(tiers).size, 3, `${kind} tiers differ: ${tiers.join(' | ')}`);
    assert.ok(tiers[2].split(' ').length > tiers[0].split(' ').length, `${kind} tier 3 layers more voices`);
  }
});

test('a beam fired every frame plays a bounded number of voices per second', () => {
  const { context, effects } = unlockedEffects();
  let voices = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    context.currentTime = frame / 60;
    if (effects.weaponFire('beam', 3)) voices += 1;
  }
  assert.ok(voices >= 6 && voices <= 10, `beam voices ${voices}`);
});

test('a scatter shot plays one voice per shot however many pellets, and every shot at the fire rate plays', () => {
  const { context, effects } = unlockedEffects();
  let voices = 0;
  for (let shot = 0; shot < 5; shot += 1) {
    context.currentTime = shot * 0.2;
    if (effects.weaponFire('scatter', 3)) voices += 1;
  }
  assert.equal(voices, 5);
});

test('weapon voices stay under 20 per second across kinds', () => {
  const { context, effects } = unlockedEffects();
  let voices = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    context.currentTime = frame / 60;
    for (const kind of WEAPON_VOICE_KINDS) if (effects.weaponFire(kind, 1)) voices += 1;
  }
  assert.ok(voices <= 20, `voices ${voices}`);
});
