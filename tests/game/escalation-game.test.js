// The escalation's Game wiring: neutral during the ramp, in Ready and in watch mode; past the ramp in a
// Playing run it raises the seek scale, the target, the refill, the Predator share and the wave rate;
// it restarts with the ramp, and rate 0 is the unescalated game exactly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRAL_ESCALATION, escalationLevels } from '../../src/game/escalation.js';
import { DEFAULT_GATE_SCHEDULE } from '../../src/sim/spawn-director.js';
import { STEP, createGame, runFor } from './game-harness.js';

// Puts the play ramp this many seconds into the run (the ramp's clock is SpawnPressure.elapsed).
function jumpRampTo(game, seconds) {
  game.spawnPressure.elapsed = seconds;
}

test('during the ramp the escalation is neutral and the seek scale is the ramp\'s exactly', async () => {
  const { game, simulation } = await createGame();
  game.start();
  jumpRampTo(game, 100);
  runFor(game, 1);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale);
  assert.equal(game.spawnPressure.targetMultiplier, 1);
  assert.equal(game.spawnDirector.wavePeriodSeconds, DEFAULT_GATE_SCHEDULE.wavePeriodSeconds);
});

test('past the ramp a Playing run escalates every lever from the ramp\'s clock', async () => {
  const { game, simulation } = await createGame();
  game.start();
  jumpRampTo(game, 360);
  game.update(STEP);
  const expected = escalationLevels(game.spawnPressure.secondsPastRamp - STEP, game.escalation.settings, game.spawnPressure.ramp.ceilingFraction);
  assert.ok(Math.abs(game.escalationLevels.refillMultiplier - expected.refillMultiplier) < 1e-9);
  assert.ok(game.escalationLevels.seekMultiplier > 1.4);
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale * game.escalationLevels.seekMultiplier);
  assert.equal(game.spawnPressure.refillMultiplier, game.escalationLevels.refillMultiplier);
  assert.ok(game.spawnPressure.targetMultiplier > 1);
  assert.ok(game.spawnDirector.wavePeriodSeconds < DEFAULT_GATE_SCHEDULE.wavePeriodSeconds);
  assert.ok(game.spawnDirector.burstFraction > DEFAULT_GATE_SCHEDULE.burstFraction);
});

test('the escalated shares reach the spawn pressure; the simulation\'s shares stay as set', async () => {
  const { game, simulation } = await createGame();
  const seen = [];
  const update = game.spawnPressure.update.bind(game.spawnPressure);
  game.spawnPressure.update = (deltaSeconds, stats, shares, ...rest) => { seen.push(shares); return update(deltaSeconds, stats, shares, ...rest); };
  const original = Array.from(simulation.shares);
  game.start();
  game.update(STEP);
  assert.equal(seen.at(-1), simulation.shares, 'during the ramp the shares pass through untouched');
  jumpRampTo(game, 600);
  game.update(STEP);
  assert.ok(seen.at(-1)[4] > original[4], 'more Predators');
  assert.ok(seen.at(-1)[0] < original[0], 'fewer Chasers');
  assert.deepEqual(Array.from(simulation.shares), original);
});

test('Ready (the title arena) and watch mode stay neutral however long the ramp clock has run', async () => {
  const { game, simulation } = await createGame();
  jumpRampTo(game, 900);
  runFor(game, 0.5);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale);
  game.setWatch(0.1);
  game.activeSpawnPressure.elapsed = 900;
  runFor(game, 0.5);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  assert.equal(game.activeSpawnPressure.targetMultiplier, 1);
});

test('a restart and quit to title restart the escalation with the ramp', async () => {
  const { game } = await createGame();
  game.start();
  jumpRampTo(game, 600);
  game.update(STEP);
  assert.ok(game.escalationLevels.refillMultiplier > 1);
  game.restart();
  game.update(STEP);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  jumpRampTo(game, 600);
  game.update(STEP);
  game.quitToTitle();
  game.update(STEP);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  assert.equal(game.spawnPressure.refillMultiplier, 1);
});

test('rate 0 plays the unescalated game: seek, target, refill, shares and waves exactly as the ramp gives them', async () => {
  const { game, simulation } = await createGame();
  game.escalation.set('rate', 0);
  game.start();
  jumpRampTo(game, 900);
  runFor(game, 1);
  assert.equal(game.escalationLevels, NEUTRAL_ESCALATION);
  assert.equal(simulation.seekScales.at(-1), game.spawnPressure.seekScale);
  assert.equal(game.spawnPressure.targetAlive, game.capacity * game.spawnPressure.ramp.ceilingFraction);
  assert.equal(game.spawnDirector.wavePeriodSeconds, DEFAULT_GATE_SCHEDULE.wavePeriodSeconds);
  assert.equal(game.spawnDirector.burstFraction, DEFAULT_GATE_SCHEDULE.burstFraction);
});

test('a time warp slows the escalation: its clock is the warped simulation delta', async () => {
  const { game } = await createGame();
  game.start();
  jumpRampTo(game, 200);
  game.timeWarp.start();
  // Let the warp ease to its full slow-down first.
  runFor(game, 1);
  const before = game.spawnPressure.secondsPastRamp;
  runFor(game, 1);
  const advanced = game.spawnPressure.secondsPastRamp - before;
  assert.ok(advanced > 0 && advanced < 0.9, `advanced ${advanced}`);
});
