import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STRIDE_BYTES, AGENT_OFFSETS, ARENA_HEIGHT, ARENA_WIDTH, FULL_ARENA_BOUNDS, MAXIMUM_ARENA_ASPECT, MINIMUM_ARENA_ASPECT,
  agentBufferBytes, arenaBoundsForAspect, gridDimensions,
} from '../../src/sim/layout.js';

test('agent stride is 32 bytes and buffer bytes scale linearly', () => {
  assert.equal(AGENT_STRIDE_BYTES, 32);
  assert.equal(agentBufferBytes(1024), 32768);
});

test('gridDimensions covers the arena', () => {
  const dimensions = gridDimensions(0.1);
  assert.equal(dimensions.columns, 160);
  assert.equal(dimensions.rows, 90);
  assert.equal(dimensions.cellCount, 14400);
});

test('gridDimensions rounds up when the radius does not divide the arena', () => {
  const dimensions = gridDimensions(0.3);
  assert.equal(dimensions.columns, 54);
  assert.equal(dimensions.rows, 30);
  assert.equal(dimensions.cellSize, 0.3);
});

test('agent offsets fit inside the stride', () => {
  assert.equal(AGENT_OFFSETS.hueJitter + 4, AGENT_STRIDE_BYTES);
});

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('a 16:9 aspect plays the whole world', () => {
  const bounds = arenaBoundsForAspect(16 / 9);
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: ARENA_WIDTH, maxY: ARENA_HEIGHT, width: ARENA_WIDTH, height: ARENA_HEIGHT });
  assert.deepEqual(FULL_ARENA_BOUNDS, bounds);
  assert.ok(Object.isFrozen(bounds));
});

test('a narrower aspect plays a centered full-height column', () => {
  const bounds = arenaBoundsForAspect(1.2);
  close(bounds.height, 9, 'height');
  close(bounds.width, 10.8, 'width');
  close(bounds.minX, 2.6, 'minX');
  close(bounds.maxX, 13.4, 'maxX');
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxY, 9);
});

test('a wider aspect plays a centered full-width strip', () => {
  const bounds = arenaBoundsForAspect(2.56);
  assert.equal(bounds.width, 16);
  close(bounds.height, 6.25, 'height');
  close(bounds.minY, 1.375, 'minY');
  close(bounds.maxY, 7.625, 'maxY');
  assert.equal(bounds.minX, 0);
});

test('extreme aspects are clamped and bad aspects give the whole world', () => {
  assert.deepEqual(arenaBoundsForAspect(0.01), arenaBoundsForAspect(MINIMUM_ARENA_ASPECT));
  assert.deepEqual(arenaBoundsForAspect(50), arenaBoundsForAspect(MAXIMUM_ARENA_ASPECT));
  close(arenaBoundsForAspect(MINIMUM_ARENA_ASPECT).width, 2.25, 'thinnest width');
  close(arenaBoundsForAspect(MAXIMUM_ARENA_ASPECT).height, 4, 'shortest height');
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.deepEqual(arenaBoundsForAspect(bad), FULL_ARENA_BOUNDS);
});
