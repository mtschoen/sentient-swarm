import test from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_MIXES, SAVED_MIXES_KEY, decodeMix, encodeMix, listMixes, saveMix } from '../../src/ui/labPresets.js';
import { defaultMatrix, defaultSpecies } from '../../src/sim/species.js';

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

function encodeRaw(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('encode then decode round-trips every bundled mix', () => {
  for (const [name, mix] of Object.entries(BUNDLED_MIXES)) {
    assert.deepEqual(decodeMix(encodeMix(mix)), mix, name);
  }
});

test('encoded text is URL-safe base64 without padding', () => {
  const text = encodeMix(BUNDLED_MIXES.mixedFive);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
});

test('the default mix equals the shipped species table', () => {
  const mix = BUNDLED_MIXES.default;
  assert.deepEqual(mix.matrix, Array.from(defaultMatrix()));
  defaultSpecies().forEach((row, index) => {
    assert.equal(mix.rules[index][0], row.seek);
    assert.equal(mix.rules[index][3], row.separation);
  });
  assert.deepEqual(mix.shares, [0.2, 0.2, 0.2, 0.2, 0.2]);
});

test('knobs round-trip', () => {
  const mix = { ...BUNDLED_MIXES.default, knobs: { rampSeconds: 60, spawnDensityBias: 0.25, killBurstParticles: 8, effects: 150 } };
  assert.deepEqual(decodeMix(encodeMix(mix)), mix);
});

test('decodeMix returns null for malformed text', () => {
  for (const text of ['%%%', '', 'abc$', encodeRaw('plain string'), encodeRaw(null), encodeRaw([1, 2]), '{"version":1}']) {
    assert.equal(decodeMix(text), null, text);
  }
  assert.equal(decodeMix(undefined), null);
  assert.equal(decodeMix(42), null);
});

test('decodeMix returns null for wrong shapes', () => {
  const good = BUNDLED_MIXES.default;
  const cases = {
    version: { ...good, version: 2 },
    sharesLength: { ...good, shares: [1, 1, 1, 1] },
    sharesNegative: { ...good, shares: [-1, 1, 1, 1, 1] },
    sharesAllZero: { ...good, shares: [0, 0, 0, 0, 0] },
    rulesRows: { ...good, rules: good.rules.slice(0, 4) },
    rulesColumns: { ...good, rules: good.rules.map((row) => row.slice(1)) },
    matrixLength: { ...good, matrix: good.matrix.slice(1) },
    matrixRange: { ...good, matrix: good.matrix.map(() => 9) },
    nonFinite: { ...good, neighborRadius: null },
    radiusRange: { ...good, neighborRadius: 0 },
    rate: { ...good, simulationRate: 'double' },
    unknownKey: { ...good, extra: 1 },
    unknownKnob: { ...good, knobs: { nonsense: 1 } },
    knobRange: { ...good, knobs: { spawnDensityBias: 5 } },
    knobType: { ...good, knobs: { rampSeconds: '60' } },
    knobsArray: { ...good, knobs: [1] },
  };
  for (const [name, mix] of Object.entries(cases)) {
    assert.equal(decodeMix(encodeRaw(mix)), null, name);
  }
});

test('decodeMix rejects non-finite numbers, which JSON cannot carry', () => {
  const text = Buffer.from('{"version":1,"shares":[1,1,1,1,1],"rules":[],"matrix":[],"neighborRadius":1e999,"simulationRate":"full"}').toString('base64url');
  assert.equal(decodeMix(text), null);
});

test('listMixes returns bundled names then saved names', () => {
  const storage = fakeStorage();
  assert.deepEqual(listMixes(storage), Object.keys(BUNDLED_MIXES));
  saveMix(storage, 'mine', BUNDLED_MIXES.latticeStorm);
  assert.deepEqual(listMixes(storage), [...Object.keys(BUNDLED_MIXES), 'mine']);
});

test('saved mixes persist under their own key and load back', () => {
  const storage = fakeStorage();
  assert.equal(saveMix(storage, 'mine', BUNDLED_MIXES.allChasers), true);
  assert.ok(storage.getItem(SAVED_MIXES_KEY) !== null);
  assert.deepEqual(JSON.parse(storage.getItem(SAVED_MIXES_KEY)).mine, BUNDLED_MIXES.allChasers);
});

test('saveMix refuses invalid mixes, bundled names and empty names', () => {
  const storage = fakeStorage();
  assert.equal(saveMix(storage, 'bad', { version: 1 }), false);
  assert.equal(saveMix(storage, 'default', BUNDLED_MIXES.default), false);
  assert.equal(saveMix(storage, '  ', BUNDLED_MIXES.default), false);
  assert.deepEqual(listMixes(storage), Object.keys(BUNDLED_MIXES));
});

test('listMixes survives garbage storage and drops invalid saved entries', () => {
  assert.deepEqual(listMixes(fakeStorage({ [SAVED_MIXES_KEY]: '{oops' })), Object.keys(BUNDLED_MIXES));
  const raw = JSON.stringify({ good: BUNDLED_MIXES.default, bad: { version: 3 } });
  assert.deepEqual(listMixes(fakeStorage({ [SAVED_MIXES_KEY]: raw })), [...Object.keys(BUNDLED_MIXES), 'good']);
});

test('saveMix tolerates a storage that throws', () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('full'); } };
  assert.equal(saveMix(storage, 'mine', BUNDLED_MIXES.default), false);
});

test('decodeMix rejects shares past the finite cap, which would normalize to NaN in a Float32Array', () => {
  const good = BUNDLED_MIXES.default;
  assert.equal(decodeMix(encodeRaw({ ...good, shares: [3.5e38, 1, 1, 1, 1] })), null);
  assert.equal(decodeMix(encodeRaw({ ...good, shares: [1e7, 1, 1, 1, 1] })), null);
  assert.notEqual(decodeMix(encodeRaw({ ...good, shares: [1e6, 1, 1, 1, 1] })), null, 'the cap itself is valid');
});
