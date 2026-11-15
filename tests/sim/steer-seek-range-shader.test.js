import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const steer = readFileSync(new URL('../../src/sim/shaders/steer.wgsl', import.meta.url), 'utf8');
const occurrences = (needle) => steer.split(needle).length - 1;

test('steer fades seek by a range helper whose smoothstep edges ascend', () => {
  assert.equal(occurrences('fn seekRangeFactor('), 1);
  assert.equal(occurrences('SEEK_RANGE_FULL_FRACTION: f32 = 0.6'), 1);
  assert.equal(occurrences('params.seekRange <= 0.0'), 1);
  assert.equal(occurrences('1.0 - smoothstep(params.seekRange * SEEK_RANGE_FULL_FRACTION, params.seekRange, distance)'), 1);
  assert.equal(occurrences('smoothstep(params.seekRange, params.seekRange *'), 0, 'reversed edges are indeterminate in WGSL');
});

test('main applies the range to the seek term using the nearest-player distance', () => {
  const line = steer.split('\n').find((text) => text.trim().startsWith('var desired = seek * speciesField(species, FIELD_SEEK) * params.seekScale'));
  assert.ok(line, 'the seek line exists');
  assert.ok(line.includes('seekRangeFactor(nearestPlayerDistance(agent.position, params))'), line);
});
