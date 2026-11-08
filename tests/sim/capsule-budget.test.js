// Pins CAPSULE_CELL_BUDGET in projectiles_collide.wgsl against the weapon tables: a JavaScript model
// of collideCapsule's cell walk (same column loop, same spans) counts the cells one projectile step
// visits, worst case over headings and grid offsets, for every capsule kind and tier at every
// quality preset's cell size (neighborRadius) and step (half simulation rate steps twice the delta).
// A walk past the budget silently skips cells, which would leave survivors inside a ball's sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROJECTILE_KINDS, WEAPON_TYPES } from '../../src/game/weaponTypes.js';
import { PRESETS } from '../../src/settings/presets.js';
import { ARENA_HEIGHT, ARENA_WIDTH } from '../../src/sim/layout.js';

const FIXED_STEP_SECONDS = 1 / 60;
const HEADING_SAMPLES = 180;
const OFFSET_SAMPLES = 12;

async function shaderConstant(name) {
  const source = await readFile(new URL('../../src/sim/shaders/projectiles_collide.wgsl', import.meta.url), 'utf8');
  const match = source.match(new RegExp(`const ${name}: (?:u32|f32) = ([0-9.]+)u?;`));
  assert.ok(match, `${name} not found in projectiles_collide.wgsl`);
  return Number(match[1]);
}

// Cells collideCapsule walks for the segment from start to end with the given reach.
function capsuleCellCount(start, end, reach, cellSize) {
  const columns = Math.ceil(ARENA_WIDTH / cellSize);
  const rows = Math.ceil(ARENA_HEIGHT / cellSize);
  const majorIsX = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
  const startAxes = majorIsX ? start : [start[1], start[0]];
  const endAxes = majorIsX ? end : [end[1], end[0]];
  const majorCount = majorIsX ? columns : rows;
  const minorCount = majorIsX ? rows : columns;
  const lowMajor = Math.min(startAxes[0], endAxes[0]);
  const highMajor = Math.max(startAxes[0], endAxes[0]);
  const slope = highMajor > lowMajor ? (endAxes[1] - startAxes[1]) / (endAxes[0] - startAxes[0]) : 0;
  const coordinate = (value, count) => Math.min(Math.max(Math.floor(value / cellSize), 0), count - 1);
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  let cells = 0;
  for (let major = coordinate(lowMajor - reach, majorCount); major <= coordinate(highMajor + reach, majorCount); major += 1) {
    const nearLow = clamp(major * cellSize - reach, lowMajor, highMajor);
    const nearHigh = clamp((major + 1) * cellSize + reach, lowMajor, highMajor);
    const minorAtLow = startAxes[1] + (nearLow - startAxes[0]) * slope;
    const minorAtHigh = startAxes[1] + (nearHigh - startAxes[0]) * slope;
    cells += coordinate(Math.max(minorAtLow, minorAtHigh) + reach, minorCount) - coordinate(Math.min(minorAtLow, minorAtHigh) - reach, minorCount) + 1;
  }
  return cells;
}

// Worst cell count over headings in one octant (the walk is symmetric) and start offsets in a cell.
function worstCellCount(travel, reach, cellSize) {
  let worst = 0;
  for (let heading = 0; heading <= HEADING_SAMPLES; heading += 1) {
    const angle = (heading / HEADING_SAMPLES) * (Math.PI / 4);
    for (let offsetX = 0; offsetX < OFFSET_SAMPLES; offsetX += 1) {
      for (let offsetY = 0; offsetY < OFFSET_SAMPLES; offsetY += 1) {
        const start = [ARENA_WIDTH / 2 + (offsetX / OFFSET_SAMPLES) * cellSize, ARENA_HEIGHT / 2 + (offsetY / OFFSET_SAMPLES) * cellSize];
        const end = [start[0] + Math.cos(angle) * travel, start[1] + Math.sin(angle) * travel];
        worst = Math.max(worst, capsuleCellCount(start, end, reach, cellSize));
      }
    }
  }
  return worst;
}

const CAPSULE_KINDS = new Set([PROJECTILE_KINDS.bullet, PROJECTILE_KINDS.scatter, PROJECTILE_KINDS.rail, PROJECTILE_KINDS.pulseOrb, PROJECTILE_KINDS.sidewinder]);

test('the capsule walk model counts small segments exactly', () => {
  // Reach 0.04 around (1.05, 1.05) to (1.15, 1.05) at cell size 0.1: columns 10 to 11, row 10 only.
  assert.equal(capsuleCellCount([1.05, 1.05], [1.15, 1.05], 0.04, 0.1), 2);
  // A point with reach 0.06 at a cell center spans the 3 by 3 cells around it.
  assert.equal(capsuleCellCount([1.05, 1.05], [1.05, 1.05], 0.06, 0.1), 9);
});

test('CAPSULE_CELL_BUDGET covers every capsule kind and tier at every preset', async () => {
  const budget = await shaderConstant('CAPSULE_CELL_BUDGET');
  const margin = await shaderConstant('CAPSULE_KILL_MARGIN');
  const failures = [];
  let worstSeen = { cells: 0 };
  for (const [presetName, preset] of Object.entries(PRESETS)) {
    const stepSeconds = FIXED_STEP_SECONDS * (preset.simulationRate === 'half' ? 2 : 1);
    for (const [typeName, type] of Object.entries(WEAPON_TYPES)) {
      if (!CAPSULE_KINDS.has(type.kind)) continue;
      type.tiers.forEach((tier, index) => {
        const cells = worstCellCount(tier.speed * stepSeconds, tier.radius + margin, preset.neighborRadius);
        if (cells > worstSeen.cells) worstSeen = { cells, presetName, typeName, tier: index + 1 };
        if (cells > budget) failures.push(`${typeName} tier ${index + 1} at ${presetName}: ${cells} cells`);
      });
    }
  }
  assert.deepEqual(failures, [], `budget ${budget}; worst ${JSON.stringify(worstSeen)}`);
});

test('CAPSULE_CELL_BUDGET covers a reference ball of radius 0.2 at speed 10, cell size 0.08 to 0.12', async () => {
  const budget = await shaderConstant('CAPSULE_CELL_BUDGET');
  const margin = await shaderConstant('CAPSULE_KILL_MARGIN');
  for (const cellSize of [0.08, 0.1, 0.12]) {
    for (const stepSeconds of [FIXED_STEP_SECONDS, 2 * FIXED_STEP_SECONDS]) {
      const cells = worstCellCount(10 * stepSeconds, 0.2 + margin, cellSize);
      assert.ok(cells <= budget, `cell size ${cellSize}, step ${stepSeconds.toFixed(4)} s: ${cells} cells against budget ${budget}`);
    }
  }
});
