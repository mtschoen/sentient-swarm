import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HIVE_VIEW_BYTES, isHiveTable, packHiveView } from '../../src/render/gates.js';
import { SEAT_COLORS } from '../../src/game/seat-colors.js';

const wgsl = readFileSync(new URL('../../src/render/shaders/gates.wgsl', import.meta.url), 'utf8');

test('only a table with hive rows takes the hive pipeline', () => {
  assert.equal(isHiveTable(null), false);
  assert.equal(isHiveTable({ gates: [{ x: 0, y: 0, radius: 1 }] }), false);
  assert.equal(isHiveTable({ gates: [{ x: 0, y: 0, radius: 1, hive: { owner: null, capturer: null, progress: 0 } }] }), true);
});

test('packHiveView writes the seat colors then (hive, owner, progress, capturer) per row, seats plus 1', () => {
  assert.equal(HIVE_VIEW_BYTES, 96);
  assert.ok(wgsl.includes('struct HiveView {\n  seatColors: array<vec4f, 2>,\n  rows: array<vec4f, 4>,\n}'));
  const floats = packHiveView({ gates: [
    { hive: { owner: null, capturer: 1, progress: 0.25 } },
    { hive: { owner: 0, capturer: null, progress: 0 } },
    {},
  ] });
  assert.deepEqual(Array.from(floats.subarray(0, 3)), SEAT_COLORS[0].body);
  assert.deepEqual(Array.from(floats.subarray(4, 7)), SEAT_COLORS[1].body.map(Math.fround));
  assert.deepEqual(Array.from(floats.subarray(8, 12)), [1, 0, 0.25, 2]);
  assert.deepEqual(Array.from(floats.subarray(12, 16)), [1, 1, 0, 0]);
  assert.deepEqual(Array.from(floats.subarray(16, 24)), [0, 0, 0, 0, 0, 0, 0, 0]);
});

test('the plain gate fragment never reads the hive uniform', () => {
  const gateBody = wgsl.slice(wgsl.indexOf('fn gateFragment('), wgsl.indexOf('const NEUTRAL_HIVE_TINT'));
  assert.ok(!gateBody.includes('hives.'));
  assert.ok(wgsl.includes('@group(0) @binding(1) var<uniform> hives: HiveView;'));
});
