import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';
import {
  PHONE_WARP_LATTICE, WARP_LINES_PER_WORLD_UNIT, WORLD_WARP_LATTICE, WARP_IMPULSE_CAPACITY, WARP_SHADER_CONSTANTS, WARP_VIEW_BYTES, createWarpViewData, packWarpView, warpGridLatticePoint, warpGridSegmentCount,
} from '../../src/render/warpgrid.js';
import { DEFAULT_IMPULSE_CAPACITY, DEFAULT_IMPULSE_DURATION_SECONDS } from '../../src/render/impulses.js';
import { substituteConstants } from '../../src/gpu/shaders.js';
import { Viewport } from '../../src/render/viewport.js';

test('the world lattice keeps the one-screen line spacing; the phone lattice keeps the one-screen line count', () => {
  assert.equal(WARP_LINES_PER_WORLD_UNIT, 6);
  assert.deepEqual(WORLD_WARP_LATTICE, { columns: WORLD_WIDTH * 6, rows: WORLD_HEIGHT * 6 });
  assert.deepEqual(WORLD_WARP_LATTICE, { columns: 192, rows: 108 });
  assert.deepEqual(PHONE_WARP_LATTICE, { columns: 96, rows: 54 });
});

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

test('packWarpView fills the WarpView layout, impulses included, and matches viewport.worldToClip', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.inspectZoom = 4;
  const impulses = new Float32Array(WARP_IMPULSE_CAPACITY * 4).map((value, index) => index + 1);
  const bytes = packWarpView({ viewport, columns: 96, rows: 54, densityWeight: 0.15, threatWeight: 0.6, time: 2.5, impulses });
  assert.equal(bytes.byteLength, WARP_VIEW_BYTES);
  assert.equal(WARP_VIEW_BYTES, 48 + WARP_IMPULSE_CAPACITY * 16);
  assert.deepEqual(Array.from(new Float32Array(bytes, 48)), Array.from(impulses));
  const floats = new Float32Array(bytes);
  assert.deepEqual(Array.from(floats.slice(4, 7)), Array.from(new Float32Array([0.15, 0.6, 2.5])));
  assert.deepEqual(Array.from(new Uint32Array(bytes, 32, 2)), [96, 54]);
  for (const [x, y] of [[0, 0], [16, 9], [3.5, 7.25]]) {
    const expected = viewport.worldToClip(x, y);
    assert.ok(Math.abs(floats[0] * x + floats[2] - expected.x) < 1e-5);
    assert.ok(Math.abs(floats[1] * y + floats[3] - expected.y) < 1e-5);
  }
});

// Plan D task D2: the impulse capacity and lifetime have one source (impulses.js), substituted
// into warpgrid.wgsl, instead of two literals kept in sync by a comment.
test('warpgrid.wgsl takes the impulse capacity and lifetime from impulses.js', () => {
  const source = readFileSync(new URL('../../src/render/shaders/warpgrid.wgsl', import.meta.url), 'utf8');
  assert.match(source, /const IMPULSE_CAPACITY: u32 = __IMPULSE_CAPACITY__;/);
  assert.match(source, /const IMPULSE_DURATION_SECONDS: f32 = __IMPULSE_DURATION_SECONDS__;/);
  assert.deepEqual(WARP_SHADER_CONSTANTS, {
    IMPULSE_CAPACITY: DEFAULT_IMPULSE_CAPACITY,
    IMPULSE_DURATION_SECONDS: DEFAULT_IMPULSE_DURATION_SECONDS,
  });
  const substituted = substituteConstants(source, WARP_SHADER_CONSTANTS);
  assert.match(substituted, new RegExp(`const IMPULSE_CAPACITY: u32 = ${DEFAULT_IMPULSE_CAPACITY};`));
  assert.match(substituted, new RegExp(`const IMPULSE_DURATION_SECONDS: f32 = ${DEFAULT_IMPULSE_DURATION_SECONDS};`));
});

test('packWarpView refills a passed view and returns its bytes', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  const target = createWarpViewData();
  const options = { viewport, columns: 96, rows: 54, densityWeight: 0.15, threatWeight: 0.6, time: 1 };
  const impulses = new Float32Array(WARP_IMPULSE_CAPACITY * 4).fill(3);
  assert.equal(packWarpView({ ...options, impulses }, target), target.bytes);
  packWarpView({ ...options, time: 2 }, target);
  assert.equal(target.floats[6], 2);
  assert.deepEqual(Array.from(target.words.slice(8, 10)), [96, 54]);
  assert.ok(target.floats.slice(12).every((value) => value === 0), 'omitted impulses clear the old ones');
});
