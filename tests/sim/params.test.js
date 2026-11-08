import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIM_PARAMS_BYTES, packSimParams } from '../../src/sim/params.js';

test('packSimParams produces the 112-byte uniform layout', () => {
  const buffer = packSimParams({
    dt: 0.5,
    gridColumns: 160,
    cellSize: 0.25,
    capacity: 4096,
    frameSequence: 7,
    playerPosition: [3, 4],
    spawnPerSpecies: [1, 2, 3, 4, 5],
  });
  assert.equal(SIM_PARAMS_BYTES, 112);
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
    // Same-species cohesion defaults to on the seek scale to 1 (full seek) and the spawn distance to 0.25 of the arena width.
    if (offset === 108) assert.equal(view.getFloat32(offset, true), 1);
    else if (offset === 36) assert.equal(view.getFloat32(offset, true), 0.25);
    else assert.equal(view.getUint32(offset, true), offset === 88 ? 1 : 0);
  }
});

test('packSimParams writes sameSpeciesCohesion at byte offset 88', () => {
  assert.equal(new DataView(packSimParams({ sameSpeciesCohesion: 0 })).getUint32(88, true), 0);
  assert.equal(new DataView(packSimParams({ sameSpeciesCohesion: 1 })).getUint32(88, true), 1);
  assert.equal(new DataView(packSimParams({})).getUint32(88, true), 1);
});

test('packSimParams rejects more spawn counts than species', () => {
  assert.throws(() => packSimParams({ spawnPerSpecies: [1, 1, 1, 1, 1, 1] }), /at most 5 species/);
});

test('packSimParams writes the player contact and kill-all fields', () => {
  const view = new DataView(packSimParams({ playerRadius: 0.25, playerInvulnerable: 1, acknowledgedHitSequence: 77, killAllRequested: 1 }));
  assert.equal(view.getFloat32(92, true), 0.25);
  assert.equal(view.getUint32(96, true), 1);
  assert.equal(view.getUint32(100, true), 77);
  assert.equal(view.getUint32(104, true), 1);
});

test('packSimParams writes seekScale as f32 at byte offset 108', () => {
  assert.equal(new DataView(packSimParams({ seekScale: 0.25 })).getFloat32(108, true), 0.25);
  assert.equal(new DataView(packSimParams({ seekScale: 0 })).getFloat32(108, true), 0);
});

test('packSimParams writes spawnDistanceFraction as f32 at byte offset 36', () => {
  assert.equal(new DataView(packSimParams({ spawnDistanceFraction: 0.375 })).getFloat32(36, true), 0.375);
});
