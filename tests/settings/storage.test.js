import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, DEFAULT_SETTINGS } from '../../src/settings/storage.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

test('defaults carry every documented key', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    preset: null, adapterKey: null, effects: 100, shake: 100, trails: 100, music: 80,
    effectsVolume: 80, reducedMotion: false, stickDeadZone: 0.15, stickRadius: 1.0, rumble: true,
  });
});

test('empty storage yields defaults', () => {
  assert.deepEqual(new SettingsStore({ storage: fakeStorage() }).load(), DEFAULT_SETTINGS);
});

test('garbage JSON and non-objects yield defaults', () => {
  for (const raw of ['{not json', '42', 'null', '[1,2]', '"text"']) {
    const store = new SettingsStore({ storage: fakeStorage({ 'murmuration.settings.v1': raw }) });
    assert.deepEqual(store.load(), DEFAULT_SETTINGS, raw);
  }
});

test('save then load round-trips', () => {
  const storage = fakeStorage();
  const settings = { preset: 'phoneHigh', adapterKey: 'vendor:arch', effects: 150, shake: 20, trails: 250, music: 10, effectsVolume: 90, reducedMotion: true, stickDeadZone: 0.3, stickRadius: 1.4, rumble: false };
  new SettingsStore({ storage }).save(settings);
  assert.deepEqual(new SettingsStore({ storage }).load(), settings);
});

test('missing or wrong-typed keys fall back per key', () => {
  const raw = JSON.stringify({ preset: 7, effects: 'loud', music: 33, reducedMotion: 'yes', stickRadius: null, extra: 1 });
  const loaded = new SettingsStore({ storage: fakeStorage({ 'murmuration.settings.v1': raw }) }).load();
  assert.deepEqual(loaded, { ...DEFAULT_SETTINGS, music: 33 });
});

test('throwing storage is tolerated', () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('full'); } };
  const store = new SettingsStore({ storage });
  assert.deepEqual(store.load(), DEFAULT_SETTINGS);
  store.save(DEFAULT_SETTINGS);
});

test('constructing without storage does not touch localStorage', () => {
  assert.doesNotThrow(() => new SettingsStore({}));
});

// Regression (Task C1 minor): an unknown stored preset name loaded as if it were valid.
test('an unknown stored preset loads as absent', () => {
  const raw = JSON.stringify({ preset: 'phoneMedium', adapterKey: 'k', music: 50 });
  const loaded = new SettingsStore({ storage: fakeStorage({ 'murmuration.settings.v1': raw }) }).load();
  assert.equal(loaded.preset, null);
  assert.equal(loaded.adapterKey, 'k');
  assert.equal(loaded.music, 50);
  const known = JSON.stringify({ preset: 'phoneHigh' });
  assert.equal(new SettingsStore({ storage: fakeStorage({ 'murmuration.settings.v1': known }) }).load().preset, 'phoneHigh');
});
