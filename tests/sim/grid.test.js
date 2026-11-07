import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_GRID_CELLS, SpatialGrid } from '../../src/sim/grid.js';

test('SpatialGrid allows at most 256 scan blocks of 256 cells', () => {
  assert.equal(MAXIMUM_GRID_CELLS, 65536);
});

test('SpatialGrid rejects grids larger than the two-level scan supports', () => {
  const gpu = { device: {} };
  assert.throws(
    () => new SpatialGrid(gpu, { columns: 257, rows: 256, capacity: 1, common: '' }),
    /at most 65536 cells; 257 by 256 is 65792/,
  );
});
