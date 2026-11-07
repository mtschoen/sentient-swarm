import test from 'node:test';
import assert from 'node:assert/strict';
import { WARP_VIEW_BYTES, packWarpView, warpGridLatticePoint, warpGridSegmentCount } from '../../src/render/warpgrid.js';
import { Viewport } from '../../src/render/viewport.js';

test('warpGridSegmentCount counts horizontal and vertical segments', () => {
  assert.equal(warpGridSegmentCount(96, 54), 55 * 96 + 97 * 54);
  assert.equal(warpGridSegmentCount(1, 1), 4);
});

test('warpGridLatticePoint covers every lattice edge exactly once with unit-length segments', () => {
  const columns = 4;
  const rows = 3;
  const edges = new Set();
  const segmentCount = warpGridSegmentCount(columns, rows);
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const start = warpGridLatticePoint(2 * segment, columns, rows);
    const end = warpGridLatticePoint(2 * segment + 1, columns, rows);
    for (const point of [start, end]) {
      assert.ok(point.column >= 0 && point.column <= columns, `column ${point.column} in range`);
      assert.ok(point.row >= 0 && point.row <= rows, `row ${point.row} in range`);
    }
    assert.equal(Math.abs(end.column - start.column) + Math.abs(end.row - start.row), 1, 'segment joins neighbors');
    edges.add(`${start.column},${start.row}-${end.column},${end.row}`);
  }
  assert.equal(edges.size, segmentCount, 'no duplicate segments');
  assert.equal(edges.size, (rows + 1) * columns + (columns + 1) * rows, 'every lattice edge is drawn');
});

test('packWarpView fills the 48-byte WarpView layout and matches viewport.worldToClip', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.inspectZoom = 4;
  const bytes = packWarpView({ viewport, columns: 96, rows: 54, densityWeight: 0.15, threatWeight: 0.6, time: 2.5 });
  assert.equal(bytes.byteLength, WARP_VIEW_BYTES);
  const floats = new Float32Array(bytes);
  assert.deepEqual(Array.from(floats.slice(4, 7)), Array.from(new Float32Array([0.15, 0.6, 2.5])));
  assert.deepEqual(Array.from(new Uint32Array(bytes, 32, 2)), [96, 54]);
  for (const [x, y] of [[0, 0], [16, 9], [3.5, 7.25]]) {
    const expected = viewport.worldToClip(x, y);
    assert.ok(Math.abs(floats[0] * x + floats[2] - expected.x) < 1e-5);
    assert.ok(Math.abs(floats[1] * y + floats[3] - expected.y) < 1e-5);
  }
});
