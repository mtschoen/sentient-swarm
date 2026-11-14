import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_STRIDE_BYTES, AGENT_OFFSETS, MAXIMUM_VIEW_ASPECT, MINIMUM_VIEW_ASPECT, VIEW_HEIGHT, VIEW_WIDTH, WORLD_BOUNDS,
  WORLD_HEIGHT, WORLD_WIDTH, agentBufferBytes, gridDimensions, viewSizeForAspect,
} from '../../src/sim/layout.js';

test('agent stride is 32 bytes and buffer bytes scale linearly', () => {
  assert.equal(AGENT_STRIDE_BYTES, 32);
  assert.equal(agentBufferBytes(1024), 32768);
});

test('gridDimensions covers the arena', () => {
  const dimensions = gridDimensions(0.1);
  assert.equal(dimensions.columns, 320);
  assert.equal(dimensions.rows, 180);
  assert.equal(dimensions.cellCount, 57600);
});

test('gridDimensions rounds up when the radius does not divide the arena', () => {
  const dimensions = gridDimensions(0.3);
  assert.equal(dimensions.columns, 107);
  assert.equal(dimensions.rows, 60);
  assert.equal(dimensions.cellSize, 0.3);
});

test('agent offsets fit inside the stride', () => {
  assert.equal(AGENT_OFFSETS.hueJitter + 4, AGENT_STRIDE_BYTES);
});

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test('a 16:9 aspect sees the 16 by 9 view, and the world bounds are the whole world', () => {
  assert.deepEqual(viewSizeForAspect(16 / 9), { width: VIEW_WIDTH, height: VIEW_HEIGHT });
  assert.deepEqual(WORLD_BOUNDS, { minX: 0, minY: 0, maxX: WORLD_WIDTH, maxY: WORLD_HEIGHT, width: WORLD_WIDTH, height: WORLD_HEIGHT });
  assert.ok(Object.isFrozen(WORLD_BOUNDS));
});

test('a narrower aspect sees a full-height column', () => {
  const view = viewSizeForAspect(1.2);
  close(view.height, 9, 'height');
  close(view.width, 10.8, 'width');
});

test('a wider aspect sees a full-width strip', () => {
  const view = viewSizeForAspect(2.56);
  assert.equal(view.width, 16);
  close(view.height, 6.25, 'height');
});

test('extreme aspects are clamped and bad aspects give the 16:9 view', () => {
  assert.deepEqual(viewSizeForAspect(0.01), viewSizeForAspect(MINIMUM_VIEW_ASPECT));
  assert.deepEqual(viewSizeForAspect(50), viewSizeForAspect(MAXIMUM_VIEW_ASPECT));
  close(viewSizeForAspect(MINIMUM_VIEW_ASPECT).width, 2.25, 'thinnest width');
  close(viewSizeForAspect(MAXIMUM_VIEW_ASPECT).height, 4, 'shortest height');
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.deepEqual(viewSizeForAspect(bad), { width: VIEW_WIDTH, height: VIEW_HEIGHT });
});
