import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { substituteConstants } from '../../src/gpu/shaders.js';
import {
  COARSE_CELL_SIZE, COARSE_COLUMNS, COARSE_ROWS, MAXIMUM_GRID_CELLS, SHADER_CONSTANTS, WORKGROUP_SIZE, WORLD_HEIGHT, WORLD_WIDTH,
  boundsAround, gridDimensions,
} from '../../src/sim/layout.js';
import { PRESETS } from '../../src/settings/presets.js';
import { MAXIMUM_GRID_CELLS as GRID_LIMIT } from '../../src/sim/grid.js';

const readShader = (path) => readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8');

test('the coarse field is the world in COARSE_CELL_SIZE cells, whole cells on both axes', () => {
  assert.equal(COARSE_CELL_SIZE, 0.25);
  assert.equal(COARSE_COLUMNS * COARSE_CELL_SIZE, WORLD_WIDTH);
  assert.equal(COARSE_ROWS * COARSE_CELL_SIZE, WORLD_HEIGHT);
  assert.ok(Number.isInteger(COARSE_COLUMNS) && Number.isInteger(COARSE_ROWS));
});

test('common.wgsl takes the world size from SHADER_CONSTANTS, which carry the world.js values', async () => {
  const source = await readShader('sim/shaders/common.wgsl');
  assert.match(source, /const WORLD_WIDTH: f32 = __WORLD_WIDTH__;/);
  assert.match(source, /const WORLD_HEIGHT: f32 = __WORLD_HEIGHT__;/);
  assert.equal(SHADER_CONSTANTS.WORLD_WIDTH, WORLD_WIDTH);
  assert.equal(SHADER_CONSTANTS.WORLD_HEIGHT, WORLD_HEIGHT);
  assert.equal(SHADER_CONSTANTS.COARSE_COLUMNS, COARSE_COLUMNS);
  assert.equal(SHADER_CONSTANTS.COARSE_ROWS, COARSE_ROWS);
  const substituted = substituteConstants(source, SHADER_CONSTANTS);
  assert.ok(substituted.includes(`const WORLD_WIDTH: f32 = ${WORLD_WIDTH};`));
  assert.ok(substituted.includes(`const WORLD_HEIGHT: f32 = ${WORLD_HEIGHT};`));
  assert.ok(substituted.includes(`const COARSE_COLUMNS: u32 = ${COARSE_COLUMNS}u;`));
});

test('no shader spells the world size as a literal', async () => {
  for (const path of ['sim/shaders/common.wgsl', 'render/shaders/warpgrid.wgsl', 'render/shaders/glyphs.wgsl', 'sim/shaders/density_sum.wgsl']) {
    const source = await readShader(path);
    assert.doesNotMatch(source, /ARENA_WIDTH|ARENA_HEIGHT/, path);
    assert.doesNotMatch(source, /vec2f\(16\.0, 9\.0\)/, path);
  }
});

test('the grid cell limit is one workgroup scan of workgroup blocks, the same in grid.js', () => {
  assert.equal(MAXIMUM_GRID_CELLS, WORKGROUP_SIZE * WORKGROUP_SIZE);
  assert.equal(GRID_LIMIT, MAXIMUM_GRID_CELLS);
});

test('every preset neighbor grid fits the cell limit with cells at least the neighbor radius', () => {
  for (const [name, preset] of Object.entries(PRESETS)) {
    const dimensions = gridDimensions(preset.neighborRadius);
    assert.ok(dimensions.cellCount <= MAXIMUM_GRID_CELLS, `${name}: ${dimensions.cellCount} cells`);
    assert.ok(dimensions.cellSize >= preset.neighborRadius, `${name}: cell ${dimensions.cellSize}`);
    assert.ok(dimensions.columns * dimensions.cellSize >= WORLD_WIDTH && dimensions.rows * dimensions.cellSize >= WORLD_HEIGHT, `${name} covers the world`);
  }
});

test('the 32 by 18 world keeps every preset radius as the cell except desktopUltra, which floors to fit', () => {
  assert.equal(WORLD_WIDTH, 32);
  assert.equal(WORLD_HEIGHT, 18);
  assert.deepEqual([COARSE_COLUMNS, COARSE_ROWS], [128, 72]);
  assert.deepEqual(gridDimensions(PRESETS.phoneLow.neighborRadius), { columns: 267, rows: 150, cellSize: 0.12, cellCount: 40050 });
  assert.deepEqual(gridDimensions(PRESETS.phoneHigh.neighborRadius), { columns: 320, rows: 180, cellSize: 0.1, cellCount: 57600 });
  assert.deepEqual(gridDimensions(PRESETS.desktop.neighborRadius), { columns: 320, rows: 180, cellSize: 0.1, cellCount: 57600 });
  const ultra = gridDimensions(PRESETS.desktopUltra.neighborRadius);
  assert.deepEqual([ultra.columns, ultra.rows, ultra.cellCount], [341, 192, 65472]);
  // The plain square-root floor (0.09375) would need 342 by 192 = 65664 cells, over the limit.
  assert.ok(ultra.cellSize > 0.09375 && ultra.cellSize < 0.094, `cell ${ultra.cellSize}`);
});

test('gridDimensions raises the cell only as far as the limit needs', () => {
  const tiny = gridDimensions(0.01);
  assert.ok(tiny.cellCount <= MAXIMUM_GRID_CELLS);
  assert.ok(tiny.cellCount > MAXIMUM_GRID_CELLS * 0.99, `${tiny.cellCount} cells`);
  assert.equal(gridDimensions(0.5).cellSize, 0.5);
});

test('boundsAround centers a frozen rectangle', () => {
  const bounds = boundsAround(10, 5, 4, 2);
  assert.deepEqual(bounds, { minX: 8, minY: 4, maxX: 12, maxY: 6, width: 4, height: 2 });
  assert.ok(Object.isFrozen(bounds));
});
