import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameLoop } from '../../src/game/loop.js';

function createHarness(options = {}) {
  let time = 0;
  let pending = null;
  const calls = { update: [], render: [] };
  const loop = new FrameLoop({
    update: (step) => calls.update.push(step),
    render: (alpha) => calls.render.push(alpha),
    now: () => time,
    requestFrame: (callback) => {
      pending = callback;
      return 1;
    },
    ...options,
  });
  return {
    loop,
    calls,
    advance(milliseconds) {
      time += milliseconds;
      const callback = pending;
      pending = null;
      callback(time);
    },
    hasPending: () => pending !== null,
  };
}

test('a 50 ms gap runs three fixed updates and one render', () => {
  const harness = createHarness();
  harness.loop.start();
  harness.advance(50);
  assert.equal(harness.calls.update.length, 3);
  assert.equal(harness.calls.update[0], 1 / 60);
  assert.equal(harness.calls.render.length, 1);
  const expectedAlpha = (50 / 1000 - 3 / 60) * 60;
  assert.ok(Math.abs(harness.calls.render[0] - expectedAlpha) < 1e-9);
  assert.equal(harness.loop.frameCount, 1);
});

test('a 1 s gap clamps to maximumSubsteps updates', () => {
  const harness = createHarness();
  harness.loop.start();
  harness.advance(1000);
  assert.equal(harness.calls.update.length, 4);
  assert.equal(harness.calls.render.length, 1);
  assert.ok(harness.calls.render[0] >= 0 && harness.calls.render[0] < 1);
});

test('stop prevents further scheduling', () => {
  const harness = createHarness();
  harness.loop.start();
  harness.advance(16);
  assert.ok(harness.hasPending());
  harness.loop.stop();
  harness.advance(16);
  assert.equal(harness.hasPending(), false);
  assert.equal(harness.calls.render.length, 1);
});
