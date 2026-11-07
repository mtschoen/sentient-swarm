import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_PARAMS_BYTES, packSimParams } from '../../src/sim/params.js';

test('packSimParams produces the 96-byte uniform layout', () => {
  const buffer = packSimParams({
    dt: 0.5,
    gridColumns: 160,
    cellSize: 0.25,
    capacity: 4096,
    frameSequence: 7,
    playerPosition: [3, 4],
    spawnPerSpecies: [1, 2, 3, 4, 5],
  });
  assert.equal(SIM_PARAMS_BYTES, 96);
  assert.equal(buffer.byteLength, SIM_PARAMS_BYTES);
  const view = new DataView(buffer);
  assert.equal(view.getFloat32(0, true), 0.5);
  assert.equal(view.getUint32(20, true), 160);
  assert.equal(view.getFloat32(28, true), 0.25);
  assert.equal(view.getUint32(32, true), 4096);
  assert.equal(view.getUint32(84, true), 7);
  assert.equal(view.getFloat32(8, true), 3);
  assert.equal(view.getFloat32(12, true), 4);
  assert.deepEqual([48, 52, 56, 60, 64].map((offset) => view.getUint32(offset, true)), [1, 2, 3, 4, 5]);
});

test('packSimParams defaults missing fields to zero', () => {
  const view = new DataView(packSimParams({}));
  for (let offset = 0; offset < SIM_PARAMS_BYTES; offset += 4) {
    assert.equal(view.getUint32(offset, true), 0);
  }
});

test('packSimParams rejects more spawn counts than species', () => {
  assert.throws(() => packSimParams({ spawnPerSpecies: [1, 1, 1, 1, 1, 1] }), /at most 5 species/);
});
