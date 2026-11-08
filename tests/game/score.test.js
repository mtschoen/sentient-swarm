import test from 'node:test';
import assert from 'node:assert/strict';
import { ScoreKeeper, Awards, REFERENCE_CAPACITY } from '../../src/game/score.js';

test('points per kill scale inversely with capacity', () => {
  assert.equal(new ScoreKeeper({ capacity: 262144 }).pointsPerKill, 10);
  assert.equal(new ScoreKeeper({ capacity: 1048576 }).pointsPerKill, 2.5);
});

test('50 kills at reference capacity step the multiplier and set one milestone', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  keeper.recordKills(49);
  assert.equal(keeper.multiplier, 1);
  assert.equal(keeper.consumeMilestone(), false);
  keeper.recordKills(1);
  assert.equal(keeper.multiplier, 2);
  assert.equal(keeper.nextMultiplierAt, 150);
  assert.equal(keeper.consumeMilestone(), true);
  assert.equal(keeper.consumeMilestone(), false);
});

test('kills score at the multiplier before the batch steps it', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  keeper.recordKills(50);
  assert.equal(keeper.score, 500);
  keeper.recordKills(1);
  assert.equal(keeper.score, 520);
});

test('thresholds scale with capacity', () => {
  const keeper = new ScoreKeeper({ capacity: 524288 });
  keeper.recordKills(299);
  assert.equal(keeper.multiplier, 2);
  keeper.recordKills(1);
  assert.equal(keeper.multiplier, 3);
});

test('recordHit resets multiplier and streak but keeps score', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  keeper.recordKills(60);
  const score = keeper.score;
  keeper.recordHit();
  assert.equal(keeper.multiplier, 1);
  assert.equal(keeper.streak, 0);
  assert.equal(keeper.score, score);
});

test('top step has no next threshold and reset clears everything', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  keeper.recordKills(15000);
  assert.equal(keeper.multiplier, 10);
  assert.equal(keeper.nextMultiplierAt, null);
  keeper.reset();
  assert.equal(keeper.score, 0);
  assert.equal(keeper.multiplier, 1);
  assert.equal(keeper.consumeMilestone(), false);
});

test('awards report newly earned lives and bombs once', () => {
  const awards = new Awards();
  assert.deepEqual(awards.update(76000), { lives: 1, bombs: 1 });
  assert.deepEqual(awards.update(76000), { lives: 0, bombs: 0 });
  assert.deepEqual(awards.update(100000), { lives: 0, bombs: 1 });
});

test('setCapacity changes only later kills: past score and the tier stay, the streak carries in reference units', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY * 4 });
  keeper.recordKills(600);
  assert.equal(keeper.multiplier, 3);
  assert.equal(keeper.streak, 150);
  const score = keeper.score;
  keeper.setCapacity(REFERENCE_CAPACITY);
  assert.equal(keeper.score, score);
  assert.equal(keeper.multiplier, 3);
  assert.equal(keeper.nextMultiplierAt, 400);
  keeper.recordKills(249);
  assert.equal(keeper.multiplier, 3);
  keeper.recordKills(1);
  assert.equal(keeper.multiplier, 4);
  assert.equal(keeper.score, score + 250 * 10 * 3);
});

test('capacity is read-only outside setCapacity', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  assert.throws(() => { keeper.capacity = 1; }, TypeError);
});

test('recordHit clears a pending milestone', () => {
  const keeper = new ScoreKeeper({ capacity: REFERENCE_CAPACITY });
  keeper.recordKills(50);
  keeper.recordHit();
  assert.equal(keeper.consumeMilestone(), false);
});
