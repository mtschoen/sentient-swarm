import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameTimeProbe } from '../../src/settings/probe.js';

const FRAME_SECONDS = 1 / 60;

function feed(probe, clock, count, milliseconds) {
  const results = [];
  for (let index = 0; index < count; index += 1) {
    clock.now += FRAME_SECONDS;
    results.push(probe.recordFrame(milliseconds, clock.now));
  }
  return results;
}

test('returns null during warmup even for slow frames', () => {
  const probe = new FrameTimeProbe({});
  const clock = { now: 0 };
  assert.ok(feed(probe, clock, 120, 16).every((result) => result === null));
});

test('steps down after a slow window, waits out the interval, then steps up after a fast window', () => {
  const probe = new FrameTimeProbe({});
  const clock = { now: 0 };
  feed(probe, clock, 120, 16);
  const slow = feed(probe, clock, 180, 16);
  assert.equal(slow.filter((result) => result === 'down').length, 1);
  assert.equal(slow[slow.length - 1], 'down');
  const fast = feed(probe, clock, 150, 4);
  assert.ok(fast.every((result) => result === null), 'no step within 3 seconds of the last');
  const later = feed(probe, clock, 150, 4);
  assert.ok(later.includes('up'));
  assert.equal(later.filter((result) => result !== null).length, 1);
});

test('mid-range frame times never step', () => {
  const probe = new FrameTimeProbe({});
  const clock = { now: 0 };
  assert.ok(feed(probe, clock, 1000, 10).every((result) => result === null));
});

test('the 90th percentile decides, not the mean', () => {
  const probe = new FrameTimeProbe({ warmupFrames: 0, windowFrames: 100 });
  const clock = { now: 10 };
  const results = [];
  for (let index = 0; index < 100; index += 1) {
    clock.now += FRAME_SECONDS;
    results.push(probe.recordFrame(index % 5 === 0 ? 30 : 5, clock.now));
  }
  assert.equal(results[results.length - 1], 'down');
});

test('reset restarts warmup', () => {
  const probe = new FrameTimeProbe({});
  const clock = { now: 0 };
  feed(probe, clock, 300, 16);
  probe.reset();
  assert.ok(feed(probe, clock, 120, 16).every((result) => result === null));
});
