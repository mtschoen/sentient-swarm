import test from 'node:test';
import assert from 'node:assert/strict';
import { Hive, HiveHold, Hives, captureStep, feedingGrowth, hiveSites, hiveTarget, shipsInDisc } from '../../src/game/hives.js';
import { HIVE_TUNING } from '../../src/game/hive-tuning.js';
import { VERSUS_START_OFFSET, startsFor } from '../../src/game/versus-seats.js';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';
import { MAXIMUM_SPAWN_GATES } from '../../src/sim/spawn-director.js';
import { SWARM_SHIP_RADIUS } from '../../src/game/player-swarm.js';

const STEP = 1 / 60;
// Peak radius of the 12-ship swarm around its point (AGENTS.md).
const SWARM_PEAK_RADIUS = 1.234;

function stepFor(hive, present, seconds) {
  const taken = [];
  for (let elapsed = 0; elapsed < seconds - 1e-9; elapsed += STEP) {
    const seat = captureStep(hive, present, STEP);
    if (seat !== null) taken.push({ seat, at: elapsed + STEP });
  }
  return taken;
}

test('the three hives sit inside the world, clear of both versus starts, two by the starts and one at the center', () => {
  const sites = hiveSites(WORLD_BOUNDS, VERSUS_START_OFFSET);
  const starts = startsFor({ seats: [{}, {}], worldBounds: WORLD_BOUNDS, versus: true });
  assert.equal(sites.length, 3);
  assert.ok(sites.length <= MAXIMUM_SPAWN_GATES);
  for (const site of sites) {
    assert.ok(site.x - site.radius > WORLD_BOUNDS.minX && site.x + site.radius < WORLD_BOUNDS.maxX, `x ${site.x}`);
    assert.ok(site.y - site.radius > WORLD_BOUNDS.minY && site.y + site.radius < WORLD_BOUNDS.maxY, `y ${site.y}`);
    for (const start of starts) {
      assert.ok(Math.hypot(site.x - start.x, site.y - start.y) > site.radius + SWARM_PEAK_RADIUS + SWARM_SHIP_RADIUS, `site ${site.x},${site.y} clear of start ${start.x}`);
    }
  }
  assert.equal(sites[0].x, starts[0].x);
  assert.equal(sites[1].x, starts[1].x);
  assert.deepEqual([sites[2].x, sites[2].y], [16, 9]);
  // Point-symmetric about the center: neither side is favored.
  assert.deepEqual([sites[0].x + sites[1].x, sites[0].y + sites[1].y], [32, 18]);
});

test('an owned hive aims its agents at the other seat; a neutral one at no seat', () => {
  assert.equal(hiveTarget(null), null);
  assert.equal(hiveTarget(0), 1);
  assert.equal(hiveTarget(1), 0);
});

test('shipsInDisc counts the alive ships inside the radius', () => {
  const hive = new Hive({ x: 0, y: 0, radius: 1 });
  const ships = [{ x: 0.5, y: 0, alive: true }, { x: 0, y: 1, alive: true }, { x: 1.01, y: 0, alive: true }, { x: 0, y: 0, alive: false }];
  assert.equal(shipsInDisc(ships, hive), 2);
});

test('uncontested capture by the 12-ship swarm takes 5 s, a large swarm the 3 s cap, never instant', () => {
  const twelve = new Hive({ x: 0, y: 0, radius: 1.5 });
  const taken = stepFor(twelve, [12, 0], 6);
  assert.equal(taken.length, 1);
  assert.equal(taken[0].seat, 0);
  assert.ok(Math.abs(taken[0].at - 5) < 2 * STEP, `took ${taken[0].at}`);
  assert.equal(twelve.owner, 0);
  const big = new Hive({ x: 0, y: 0, radius: 1.5 });
  const fast = stepFor(big, [0, 200], 4);
  assert.equal(fast[0].seat, 1);
  assert.ok(Math.abs(fast[0].at - 1 / HIVE_TUNING.maximumCaptureRate) < 2 * STEP, `took ${fast[0].at}`);
  assert.ok(1 / HIVE_TUNING.maximumCaptureRate >= 3);
});

test('the rate follows the advantage; equal ships freeze the progress; nobody present decays it', () => {
  const hive = new Hive({ x: 0, y: 0, radius: 1.5 });
  stepFor(hive, [10, 4], 1);
  assert.ok(Math.abs(hive.progress - 6 * HIVE_TUNING.captureRatePerShip) < 1e-9);
  const before = hive.progress;
  stepFor(hive, [5, 5], 2);
  assert.equal(hive.progress, before);
  assert.equal(hive.capturer, 0);
  stepFor(hive, [0, 0], 1);
  assert.ok(Math.abs(hive.progress - Math.max(0, before - HIVE_TUNING.decayRate)) < 1e-9);
  stepFor(hive, [0, 0], 10);
  assert.equal(hive.progress, 0);
  assert.equal(hive.capturer, null);
});

test('a contesting seat unwinds the other seat\'s progress before building its own', () => {
  const hive = new Hive({ x: 0, y: 0, radius: 1.5 });
  stepFor(hive, [12, 0], 2.5);
  assert.equal(hive.capturer, 0);
  assert.ok(Math.abs(hive.progress - 0.5) < 0.02);
  stepFor(hive, [0, 12], 2.5);
  assert.ok(hive.progress < 0.02);
  stepFor(hive, [0, 12], 1);
  assert.equal(hive.capturer, 1);
  assert.equal(hive.owner, null);
});

test('an owned hive is taken back the same way, and its owner unwinds an attempt on it', () => {
  const hive = new Hive({ x: 0, y: 0, radius: 1.5 });
  stepFor(hive, [12, 0], 5.1);
  assert.equal(hive.owner, 0);
  stepFor(hive, [0, 12], 2);
  assert.equal(hive.capturer, 1);
  stepFor(hive, [12, 0], 3);
  assert.equal(hive.capturer, null);
  assert.equal(hive.progress, 0);
  assert.equal(hive.owner, 0, 'the owner present does not build progress on its own hive');
  const taken = stepFor(hive, [0, 12], 5.1);
  assert.deepEqual(taken.map(({ seat }) => seat), [1]);
  assert.equal(hive.owner, 1);
});

test('the hold wins after holding every hive for 20 s and restarts when a hive is lost', () => {
  const hold = new HiveHold();
  assert.equal(hold.update([0, 0, null], 5), null);
  assert.equal(hold.holder, null);
  assert.equal(hold.update([0, 0, 0], 19), null);
  assert.equal(hold.remainingSeconds, 1);
  assert.equal(hold.update([0, 0, 1], 1), null);
  assert.equal(hold.holder, null);
  assert.equal(hold.update([1, 1, 1], 10), null);
  assert.equal(hold.update([1, 1, 1], 10), 1);
  assert.equal(HIVE_TUNING.holdSecondsToWin, 20);
});

test('Hives captures from each seat\'s ships and reports the capture and the hold winner', () => {
  const hives = new Hives(hiveSites(WORLD_BOUNDS, VERSUS_START_OFFSET));
  const parked = hives.hives.map((hive) => Array.from({ length: 12 }, () => ({ x: hive.x, y: hive.y, alive: true })));
  let result = null;
  for (let elapsed = 0; elapsed < 5.1; elapsed += STEP) {
    result = hives.update([parked[2], []], STEP);
    if (result.captured.length > 0) break;
  }
  assert.deepEqual(result.captured, [{ hive: 2, seat: 0 }]);
  assert.deepEqual(hives.owners, [null, null, 0]);
  hives.hives.forEach((hive) => { hive.owner = 0; });
  let winner = null;
  for (let elapsed = 0; elapsed < 21 && winner === null; elapsed += STEP) winner = hives.update([[], []], STEP).winner;
  assert.equal(winner, 0);
  assert.equal(hives.view.holder, 0);
  hives.reset();
  assert.deepEqual(hives.owners, [null, null, null]);
  assert.equal(hives.view.holdRemainingSeconds, null);
});

test('feeding ground kills count double toward growth', () => {
  assert.equal(feedingGrowth(10, 0), 10);
  assert.equal(feedingGrowth(10, 4), 14);
  assert.equal(HIVE_TUNING.feedingGrowthMultiplier, 2);
});
