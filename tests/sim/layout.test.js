import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STRIDE_BYTES, AGENT_OFFSETS, agentBufferBytes, gridDimensions } from '../../src/sim/layout.js';

test('agent stride is 32 bytes and buffer bytes scale linearly', () => {
  assert.equal(AGENT_STRIDE_BYTES, 32);
  assert.equal(agentBufferBytes(1024), 32768);
});

test('gridDimensions covers the arena', () => {
  const g = gridDimensions(0.1);
  assert.equal(g.columns, 160);
  assert.equal(g.rows, 90);
  assert.equal(g.cellCount, 14400);
});

test('gridDimensions rounds up when the radius does not divide the arena', () => {
  const g = gridDimensions(0.3);
  assert.equal(g.columns, 54);
  assert.equal(g.rows, 30);
  assert.equal(g.cellSize, 0.3);
});

test('agent offsets fit inside the stride', () => {
  assert.equal(AGENT_OFFSETS.hueJitter + 4, AGENT_STRIDE_BYTES);
});
