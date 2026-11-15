import test from 'node:test';
import assert from 'node:assert/strict';
import { BeamTime, BEAM_TIME_SECONDS, BEAM_TIME_TIER } from '../../src/game/beam-time.js';

test('constants', () => {
  assert.equal(BEAM_TIME_SECONDS, 8);
  assert.equal(BEAM_TIME_TIER, 1);
});

test('idle update returns false and fraction is 0', () => {
  const beamTime = new BeamTime();
  assert.equal(beamTime.update(1), false);
  assert.equal(beamTime.fraction, 0);
  assert.equal(beamTime.active, false);
  assert.equal(beamTime.remainingSeconds, 0);
});

test('start gives a full fraction and update counts down', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  assert.equal(beamTime.fraction, 1);
  assert.equal(beamTime.active, true);
  assert.equal(beamTime.update(4), false);
  assert.equal(beamTime.fraction, 0.5);
});

test('the crossing update returns true exactly once', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  assert.equal(beamTime.update(7), false);
  assert.equal(beamTime.update(2), true);
  assert.equal(beamTime.active, false);
  assert.equal(beamTime.update(1), false);
  assert.equal(beamTime.fraction, 0);
});

test('start mid-run refills', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  beamTime.update(6);
  beamTime.start();
  assert.equal(beamTime.fraction, 1);
});

test('end stops the timer without reporting an expiry', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  beamTime.end();
  assert.equal(beamTime.active, false);
  assert.equal(beamTime.update(1), false);
});

test('setDuration rejects bad values', () => {
  const beamTime = new BeamTime();
  for (const value of [0, NaN, -1]) assert.throws(() => beamTime.setDuration(value), RangeError);
});

test('durationSeconds reports the configured duration', () => {
  const beamTime = new BeamTime();
  assert.equal(beamTime.durationSeconds, 8);
  beamTime.setDuration(5);
  assert.equal(beamTime.durationSeconds, 5);
  beamTime.start();
  beamTime.update(5);
  assert.equal(beamTime.active, false);
});

test('480 updates of 1/60 end within one update of 8 seconds', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  let endedAt = -1;
  for (let index = 1; index <= 480; index += 1) {
    if (beamTime.update(1 / 60)) {
      endedAt = index;
      break;
    }
  }
  assert.ok(endedAt >= 479 && endedAt <= 480, `ended at ${endedAt}`);
  assert.equal(beamTime.active, false);
});

test('a non-finite or negative delta makes no progress and the timer still ends later', () => {
  const beamTime = new BeamTime();
  beamTime.start();
  for (const delta of [Number.NaN, Infinity, -Infinity, -3]) {
    assert.equal(beamTime.update(delta), false, String(delta));
    assert.equal(beamTime.active, true);
    assert.equal(beamTime.fraction, 1);
  }
  assert.equal(beamTime.update(BEAM_TIME_SECONDS), true);
  assert.equal(beamTime.active, false);
});
