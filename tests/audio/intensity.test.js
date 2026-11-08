import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntensityTracker } from '../../src/audio/intensity.js';
import { REFERENCE_CAPACITY } from '../../src/game/score.js';

const STEP = 1 / 60;

// Plays seconds of injected time: kills per second spread evenly over the steps.
function playFor(tracker, seconds, { multiplier = 1, killsPerSecond = 0, capacity = REFERENCE_CAPACITY, playing = true } = {}) {
  let intensity = tracker.intensity;
  let owed = 0;
  for (let step = 0; step < Math.round(seconds / STEP); step += 1) {
    owed += killsPerSecond * STEP;
    const killsThisFrame = Math.floor(owed + 1e-9);
    owed -= killsThisFrame;
    intensity = tracker.update({ fixedStep: STEP, playing, multiplier, killsThisFrame, capacity });
  }
  return intensity;
}

test('intensity starts at the 0.2 floor and stays there outside play', () => {
  const tracker = new IntensityTracker();
  assert.equal(tracker.intensity, 0.2);
  assert.equal(playFor(tracker, 20, { playing: false, killsPerSecond: 50 }), 0.2);
});

test('survival alone builds: 0.2 + 0.35 * playing seconds / 45, capped', () => {
  const tracker = new IntensityTracker();
  assert.ok(Math.abs(playFor(tracker, 15) - (0.2 + 0.35 / 3)) < 1e-6);
  assert.ok(Math.abs(playFor(tracker, 15) - (0.2 + 0.35 * 2 / 3)) < 1e-6);
  assert.ok(Math.abs(playFor(tracker, 60) - 0.55) < 1e-6);
});

test('a weak player (multiplier 2 after 10 s, 3 kills a second) passes 0.5 within 30 s, and it keeps rising', () => {
  const tracker = new IntensityTracker();
  const atTen = playFor(tracker, 10, { killsPerSecond: 3 });
  const atThirty = playFor(tracker, 20, { killsPerSecond: 3, multiplier: 2 });
  assert.ok(atTen > 0.3 && atTen < 0.45, `at 10 s ${atTen}`);
  assert.ok(atThirty >= 0.5, `at 30 s ${atThirty}`);
  const atSixty = playFor(tracker, 30, { killsPerSecond: 3, multiplier: 3 });
  assert.ok(atSixty > atThirty + 0.1, `at 60 s ${atSixty}`);
});

test('a strong run (multiplier 10, 40 kills a second, a minute in) reaches the top', () => {
  const tracker = new IntensityTracker();
  assert.ok(playFor(tracker, 60, { killsPerSecond: 40, multiplier: 10 }) > 0.95);
});

test('kills are normalized to the reference capacity: half the agents count each kill double', () => {
  const full = new IntensityTracker();
  const half = new IntensityTracker();
  const atFull = playFor(full, 5, { killsPerSecond: 6 });
  const atHalf = playFor(half, 5, { killsPerSecond: 3, capacity: REFERENCE_CAPACITY / 2 });
  assert.ok(Math.abs(atFull - atHalf) < 0.01, `${atFull} vs ${atHalf}`);
});

test('a death halves the survival build, and a new run starts from the floor', () => {
  const tracker = new IntensityTracker();
  playFor(tracker, 30);
  tracker.onDeath();
  assert.ok(Math.abs(tracker.survivalSeconds - 15) < 1e-6);
  tracker.reset();
  assert.equal(tracker.survivalSeconds, 0);
  assert.equal(playFor(tracker, 1, { playing: false }), 0.2);
});
