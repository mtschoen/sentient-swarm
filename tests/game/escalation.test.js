import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCALATION_DEFAULTS, ESCALATION_RANGES, Escalation, MAXIMUM_REFILL_MULTIPLIER, NEUTRAL_ESCALATION, escalatedShares, escalationLevels,
} from '../../src/game/escalation.js';
import { DEFAULT_SHARES } from '../../src/sim/species.js';

const RAMP_CEILING = 0.1;
const LEVER_NAMES = ['targetMultiplier', 'refillMultiplier', 'seekMultiplier', 'predatorShift', 'burstMultiplier'];

test('the escalation is neutral at and before the end of the ramp', () => {
  for (const seconds of [-5, 0]) assert.equal(escalationLevels(seconds, ESCALATION_DEFAULTS, RAMP_CEILING), NEUTRAL_ESCALATION);
  assert.deepEqual({ ...NEUTRAL_ESCALATION }, { targetMultiplier: 1, refillMultiplier: 1, seekMultiplier: 1, predatorShift: 0, wavePeriodMultiplier: 1, burstMultiplier: 1 });
});

test('rate 0 is neutral at any time, so the levers are exactly today\'s', () => {
  const settings = { ...ESCALATION_DEFAULTS, rate: 0 };
  for (const seconds of [1, 60, 600, 36000]) assert.equal(escalationLevels(seconds, settings, RAMP_CEILING), NEUTRAL_ESCALATION);
});

test('every lever rises monotonically past the ramp and the wave period falls', () => {
  let previous = NEUTRAL_ESCALATION;
  for (let seconds = 10; seconds <= 3600; seconds += 10) {
    const levels = escalationLevels(seconds, ESCALATION_DEFAULTS, RAMP_CEILING);
    for (const name of LEVER_NAMES) assert.ok(levels[name] >= previous[name], `${name} at ${seconds}`);
    assert.ok(levels.wavePeriodMultiplier < previous.wavePeriodMultiplier, `wave period at ${seconds}`);
    previous = levels;
  }
  assert.ok(escalationLevels(10, ESCALATION_DEFAULTS, RAMP_CEILING).refillMultiplier > 1);
});

test('the pacing points: the target stays under its ceiling, refill grows and is capped', () => {
  const at = (minutes) => escalationLevels(minutes * 60 - 120, ESCALATION_DEFAULTS, RAMP_CEILING);
  assert.ok(Math.abs(at(4).refillMultiplier - Math.exp(0.4)) < 1e-12);
  assert.ok(Math.abs(at(8).wavePeriodMultiplier - 0.625) < 1e-12);
  for (const minutes of [4, 8, 15, 120]) assert.ok(at(minutes).targetMultiplier * RAMP_CEILING < ESCALATION_DEFAULTS.ceilingFraction);
  assert.equal(at(120).refillMultiplier, MAXIMUM_REFILL_MULTIPLIER);
  assert.ok(at(120).seekMultiplier < ESCALATION_DEFAULTS.seekMaximum);
  assert.ok(at(120).predatorShift < ESCALATION_DEFAULTS.predatorShift);
});

test('the rate scales time: rate 2 at t is rate 1 at 2t', () => {
  const doubled = escalationLevels(150, { ...ESCALATION_DEFAULTS, rate: 2 }, RAMP_CEILING);
  assert.deepEqual(doubled, escalationLevels(300, ESCALATION_DEFAULTS, RAMP_CEILING));
});

test('a ramp ceiling at or above the escalated ceiling keeps the target; a zero ramp ceiling keeps it too', () => {
  assert.equal(escalationLevels(600, ESCALATION_DEFAULTS, 0.3).targetMultiplier, 1);
  assert.equal(escalationLevels(600, ESCALATION_DEFAULTS, 0).targetMultiplier, 1);
});

test('escalatedShares moves the shift of the Chaser share to the Predator and passes a zero shift through', () => {
  assert.equal(escalatedShares(DEFAULT_SHARES, 0), DEFAULT_SHARES);
  const shifted = escalatedShares(DEFAULT_SHARES, 0.5);
  assert.ok(Math.abs(shifted[0] - 0.45) < 1e-12);
  assert.ok(Math.abs(shifted[4] - 0.5) < 1e-12);
  assert.deepEqual(shifted.slice(1, 4), [0.03, 0.02, 0]);
  assert.ok(Math.abs(shifted.reduce((sum, share) => sum + share, 0) - 1) < 1e-12);
  assert.deepEqual(Array.from(DEFAULT_SHARES), [0.9, 0.03, 0.02, 0, 0.05], 'the input is untouched');
});

test('Escalation.set validates names and ranges and changes nothing on a bad value', () => {
  const escalation = new Escalation();
  assert.deepEqual(escalation.settings, { ...ESCALATION_DEFAULTS });
  escalation.set('rate', 2);
  assert.equal(escalation.settings.rate, 2);
  assert.throws(() => escalation.set('rate', -1), RangeError);
  assert.throws(() => escalation.set('rate', Number.NaN), RangeError);
  assert.throws(() => escalation.set('unknown', 1), RangeError);
  assert.equal(escalation.settings.rate, 2);
  for (const [name, [minimum, maximum]] of Object.entries(ESCALATION_RANGES)) {
    const value = ESCALATION_DEFAULTS[name];
    assert.ok(value >= minimum && value <= maximum, name);
  }
  assert.deepEqual(new Escalation({ rate: 0 }).levels(500, RAMP_CEILING), NEUTRAL_ESCALATION);
});
