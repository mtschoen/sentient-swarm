import test from 'node:test';
import assert from 'node:assert/strict';
import { TIME_WARP_RAMP_SECONDS, TIME_WARP_SCALE, TIME_WARP_SECONDS, TimeWarp } from '../../src/game/time-warp.js';

const STEP = 1 / 60;

function advance(warp, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) warp.update(STEP);
}

test('the shipped warp lasts 6 s at 0.3 of normal speed with a 0.35 s ramp', () => {
  assert.equal(TIME_WARP_SECONDS, 6);
  assert.equal(TIME_WARP_SCALE, 0.3);
  assert.equal(TIME_WARP_RAMP_SECONDS, 0.35);
  const warp = new TimeWarp();
  assert.equal(warp.active, false);
  assert.equal(warp.scale, 1);
  assert.equal(warp.strength, 0);
  assert.equal(warp.fraction, 0);
});

test('a started warp ramps in, holds exactly the scale in the middle, ramps out and ends after 6 s of real time', () => {
  const warp = new TimeWarp();
  warp.start();
  assert.equal(warp.active, true);
  assert.equal(warp.fraction, 1);
  advance(warp, 0.1);
  assert.ok(warp.scale > TIME_WARP_SCALE && warp.scale < 1, `ramping in: ${warp.scale}`);
  advance(warp, 2.9);
  assert.equal(warp.scale, TIME_WARP_SCALE);
  assert.ok(Math.abs(warp.fraction - 0.5) < 1e-9, `half drained: ${warp.fraction}`);
  advance(warp, 2.8);
  assert.ok(warp.scale > TIME_WARP_SCALE && warp.scale < 1, `ramping out: ${warp.scale}`);
  assert.equal(warp.active, true);
  advance(warp, 0.2);
  assert.equal(warp.active, false);
  assert.equal(warp.scale, 1);
  assert.equal(warp.fraction, 0);
});

test('a second start while running extends the warp by another full duration without a new ramp', () => {
  const warp = new TimeWarp();
  warp.start();
  advance(warp, 4);
  warp.start();
  assert.equal(warp.scale, TIME_WARP_SCALE, 'no ramp back in');
  assert.equal(warp.fraction, 1, 'the bar refills');
  advance(warp, 7.9);
  assert.equal(warp.active, true);
  advance(warp, 0.2);
  assert.equal(warp.active, false);
});

test('end stops the warp at once', () => {
  const warp = new TimeWarp();
  warp.start();
  advance(warp, 1);
  warp.end();
  assert.equal(warp.active, false);
  assert.equal(warp.scale, 1);
  assert.equal(warp.strength, 0);
});

test('duration and scale are settable within range, and out-of-range values throw', () => {
  const warp = new TimeWarp();
  warp.setDuration(3);
  warp.setScale(0.5);
  assert.equal(warp.durationSeconds, 3);
  assert.equal(warp.targetScale, 0.5);
  warp.start();
  advance(warp, 1);
  assert.equal(warp.scale, 0.5);
  advance(warp, 2.1);
  assert.equal(warp.active, false);
  assert.throws(() => warp.setDuration(0), RangeError);
  assert.throws(() => warp.setScale(0), RangeError);
  assert.throws(() => warp.setScale(1.5), RangeError);
});
