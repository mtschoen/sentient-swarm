import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntensityTracker } from '../../src/audio/intensity.js';

test('intensity is 0.2 plus 0.4 alive fraction plus 0.4 kill pulse, clamped', () => {
  const tracker = new IntensityTracker();
  assert.equal(tracker.update({ fixedStep: 1 / 60, aliveTotal: 0, capacity: 1000, killsThisFrame: 0 }), 0.2);
  assert.ok(Math.abs(tracker.update({ fixedStep: 1 / 60, aliveTotal: 500, capacity: 1000, killsThisFrame: 0 }) - 0.4) < 1e-9);
  assert.equal(tracker.update({ fixedStep: 1 / 60, aliveTotal: 1000, capacity: 1000, killsThisFrame: 2 }), 1);
});

test('the kill pulse decays to zero over about a second', () => {
  const tracker = new IntensityTracker({ pulseDecaySeconds: 1 });
  tracker.update({ fixedStep: 0.1, aliveTotal: 0, capacity: 100, killsThisFrame: 1 });
  assert.equal(tracker.killPulse, 1);
  for (let index = 0; index < 5; index += 1) tracker.update({ fixedStep: 0.1, aliveTotal: 0, capacity: 100, killsThisFrame: 0 });
  assert.ok(Math.abs(tracker.killPulse - 0.5) < 1e-9);
  for (let index = 0; index < 6; index += 1) tracker.update({ fixedStep: 0.1, aliveTotal: 0, capacity: 100, killsThisFrame: 0 });
  assert.equal(tracker.killPulse, 0);
});

test('a missing capacity counts as an empty arena', () => {
  const tracker = new IntensityTracker();
  assert.equal(tracker.update({ fixedStep: 1 / 60, aliveTotal: 10, capacity: 0, killsThisFrame: 0 }), 0.2);
});
