import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BeamShards,
  BEAM_SHARDS_NEEDED,
  BEAM_SHARD_WAVE_INTERVAL,
  MAXIMUM_BEAM_SHARDS_NEEDED,
  MAXIMUM_BEAM_SHARD_WAVE_INTERVAL,
  SHARD_WALL_INSET,
  SHARD_VIEW_MARGIN,
  SHARD_GATE_CLEARANCE,
  SHARD_SPACING,
  SHARD_MAXIMUM_REACH_HALF_DIAGONALS,
  placeShard,
} from '../../src/game/beam-shards.js';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';

const IDLE = { waiting: 0, beamTimeActive: false };

function seededRandom(seed = 12345) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

test('the shipped numbers', () => {
  assert.deepEqual([BEAM_SHARDS_NEEDED, BEAM_SHARD_WAVE_INTERVAL, MAXIMUM_BEAM_SHARDS_NEEDED, MAXIMUM_BEAM_SHARD_WAVE_INTERVAL], [6, 10, 8, 60]);
  const shards = new BeamShards();
  assert.deepEqual([shards.needed, shards.waveInterval, shards.count], [6, 10, 0]);
});

test('with the default interval the tenth wave, not the first, yields a shard', () => {
  const shards = new BeamShards();
  for (let wave = 1; wave <= 9; wave += 1) assert.equal(shards.onWaves(wave, IDLE), 0, `wave ${wave}`);
  assert.equal(shards.onWaves(10, IDLE), 1);
  assert.equal(shards.onWaves(11, IDLE), 0);
});

test('interval 1: one shard per new wave, never a burst', () => {
  const shards = new BeamShards({ waveInterval: 1 });
  assert.equal(shards.onWaves(1, IDLE), 1);
  assert.equal(shards.onWaves(1, IDLE), 0);
  assert.equal(shards.onWaves(3, IDLE), 1);
});

test('interval 3: sequences 1 and 2 give nothing and 3 gives one', () => {
  const shards = new BeamShards({ waveInterval: 3 });
  assert.equal(shards.onWaves(1, IDLE), 0);
  assert.equal(shards.onWaves(2, IDLE), 0);
  assert.equal(shards.onWaves(3, IDLE), 1);
});

test('never more than needed in play, and the tally is kept while full', () => {
  const shards = new BeamShards({ waveInterval: 1 });
  assert.equal(shards.onWaves(1, { waiting: 6, beamTimeActive: false }), 0);
  shards.collect();
  shards.collect();
  assert.equal(shards.onWaves(2, { waiting: 4, beamTimeActive: false }), 0, 'waiting plus count is 6');
  assert.equal(shards.onWaves(2, { waiting: 3, beamTimeActive: false }), 1, 'the banked tally pays out once room appears');
});

test('beam time spawns nothing and banks nothing', () => {
  const shards = new BeamShards({ waveInterval: 3 });
  assert.equal(shards.onWaves(1, IDLE), 0);
  assert.equal(shards.onWaves(2, IDLE), 0);
  assert.equal(shards.onWaves(3, { waiting: 0, beamTimeActive: true }), 0);
  assert.equal(shards.onWaves(5, { waiting: 0, beamTimeActive: true }), 0);
  assert.equal(shards.onWaves(6, IDLE), 0, 'a fresh tally starts: one wave seen');
  assert.equal(shards.onWaves(7, IDLE), 0);
  assert.equal(shards.onWaves(8, IDLE), 1);
});

test('a lower sequence re-bases without spawning, and reset re-bases to zero', () => {
  const shards = new BeamShards({ waveInterval: 1 });
  assert.equal(shards.onWaves(5, IDLE), 1);
  assert.equal(shards.onWaves(2, IDLE), 0);
  assert.equal(shards.onWaves(3, IDLE), 1);
  shards.reset();
  assert.equal(shards.onWaves(1, IDLE), 1);
});

test('setters validate their range', () => {
  const shards = new BeamShards();
  for (const value of [0, 9, 2.5]) assert.throws(() => shards.setNeeded(value), RangeError);
  for (const value of [0, 61, 1.5]) assert.throws(() => shards.setWaveInterval(value), RangeError);
  shards.setNeeded(8);
  shards.setWaveInterval(60);
  assert.deepEqual([shards.needed, shards.waveInterval], [8, 60]);
});

test('six collects complete, finish clears the count and the tally', () => {
  const shards = new BeamShards({ waveInterval: 2 });
  for (let index = 1; index <= 5; index += 1) assert.deepEqual(shards.collect(), { count: index, completed: false });
  assert.deepEqual(shards.collect(), { count: 6, completed: true });
  assert.equal(shards.count, 6);
  shards.onWaves(1, IDLE);
  shards.finish();
  assert.equal(shards.count, 0);
  assert.equal(shards.onWaves(2, IDLE), 0, 'the tally restarted at finish');
  assert.equal(shards.onWaves(3, IDLE), 1);
});

const VIEW = { centerX: 16, centerY: 9, width: 16, height: 9 };
const REACH = SHARD_MAXIMUM_REACH_HALF_DIAGONALS * Math.hypot(VIEW.width, VIEW.height) / 2;

function context(overrides = {}) {
  return { bounds: WORLD_BOUNDS, view: VIEW, anchor: { x: 16, y: 9 }, gates: [], shards: [], densityAt: null, ...overrides };
}

function insideView(point, view, margin) {
  return Math.abs(point.x - view.centerX) <= view.width / 2 + margin && Math.abs(point.y - view.centerY) <= view.height / 2 + margin;
}

test('placement obeys every rule over 200 placements', () => {
  const random = seededRandom();
  const gates = [{ x: 4, y: 4, radius: 1.5 }, { x: 28, y: 14, radius: 1.5 }, { x: 16, y: 1, radius: 1.5 }];
  const shards = [];
  for (let index = 0; index < 200; index += 1) {
    const point = placeShard(context({ gates, shards: shards.slice(-5) }), random);
    assert.ok(point.x >= WORLD_BOUNDS.minX + SHARD_WALL_INSET && point.x <= WORLD_BOUNDS.maxX - SHARD_WALL_INSET, `x ${point.x}`);
    assert.ok(point.y >= WORLD_BOUNDS.minY + SHARD_WALL_INSET && point.y <= WORLD_BOUNDS.maxY - SHARD_WALL_INSET, `y ${point.y}`);
    assert.equal(insideView(point, VIEW, SHARD_VIEW_MARGIN), false, 'off screen');
    assert.ok(Math.hypot(point.x - 16, point.y - 9) <= REACH + 1e-9, 'within reach');
    for (const gate of gates) assert.ok(Math.hypot(point.x - gate.x, point.y - gate.y) >= gate.radius + SHARD_GATE_CLEARANCE - 1e-9, 'gate clearance');
    for (const other of shards.slice(-5)) assert.ok(Math.hypot(point.x - other.x, point.y - other.y) >= SHARD_SPACING - 1e-9, 'spacing');
    shards.push(point);
  }
});

test('with densityAt the lowest density of the first 8 acceptable candidates wins, ties to the earlier', () => {
  const sampled = [];
  const point = placeShard(context({ densityAt: (x, y) => { sampled.push({ x, y }); return x; } }), seededRandom(7));
  assert.equal(sampled.length, 8);
  assert.equal(point.x, Math.min(...sampled.map((candidate) => candidate.x)));
  const tied = [];
  const first = placeShard(context({ densityAt: (x, y) => { tied.push({ x, y }); return 1; } }), seededRandom(7));
  assert.deepEqual(first, tied[0]);
});

test('fallback 1: when the reach limit alone excludes everything it is dropped', () => {
  const anchor = { x: 1, y: 1 };
  const view = { centerX: 1, centerY: 1, width: 16, height: 9 };
  const reach = SHARD_MAXIMUM_REACH_HALF_DIAGONALS * Math.hypot(16, 9) / 2;
  const bounds = { minX: 0, minY: 0, maxX: 60, maxY: 20, width: 60, height: 20 };
  const point = placeShard({ bounds, view, anchor, gates: [], shards: [], densityAt: null }, seededRandom(3));
  assert.equal(insideView(point, view, SHARD_VIEW_MARGIN), false);
  assert.ok(point.x >= 1 && point.x <= 59 && point.y >= 1 && point.y <= 19);
  // Reach is satisfiable here, so the same call stays within it.
  assert.ok(Math.hypot(point.x - 1, point.y - 1) <= reach + 1e-9);
  // Now make reach unsatisfiable: a view that hides every point within reach of the anchor.
  const hiding = { centerX: 1, centerY: 1, width: 2 * (reach + 2), height: 2 * (reach + 2) };
  const far = placeShard({ bounds, view: hiding, anchor, gates: [], shards: [], densityAt: null }, seededRandom(3));
  assert.equal(insideView(far, hiding, SHARD_VIEW_MARGIN), false);
  assert.ok(Math.hypot(far.x - 1, far.y - 1) > reach);
});

test('fallback 2: gate clearance and spacing are dropped when they exclude everything', () => {
  const gates = [{ x: 16, y: 9, radius: 100 }];
  const shards = [{ x: 0, y: 0 }];
  const point = placeShard(context({ gates, shards }), seededRandom(5));
  assert.equal(insideView(point, VIEW, SHARD_VIEW_MARGIN), false);
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.ok(point.x >= 1 && point.x <= WORLD_BOUNDS.maxX - 1);
});

test('fallback 3: a view as large as the world gives the inset corner farthest from the anchor', () => {
  const view = { centerX: 16, centerY: 9, width: 64, height: 36 };
  const point = placeShard(context({ view, anchor: { x: 10, y: 5 } }), seededRandom(9));
  assert.deepEqual(point, { x: WORLD_BOUNDS.maxX - 1, y: WORLD_BOUNDS.maxY - 1 });
  const other = placeShard(context({ view, anchor: { x: 30, y: 17 } }), seededRandom(9));
  assert.deepEqual(other, { x: WORLD_BOUNDS.minX + 1, y: WORLD_BOUNDS.minY + 1 });
});

test('an anchor in a world corner still yields an off-screen point', () => {
  const view = { centerX: 8, centerY: 4.5, width: 16, height: 9 };
  for (let index = 0; index < 50; index += 1) {
    const point = placeShard(context({ view, anchor: { x: 1, y: 1 } }), seededRandom(index + 1));
    assert.equal(insideView(point, view, SHARD_VIEW_MARGIN), false);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});
