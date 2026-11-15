import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createGame } from './game-harness.js';

test('the full-rate lock overrides half rate and gives it back', async () => {
  const { game, simulation } = await createGame();
  game.setSimulationRate('half');
  game.setFullRateLock(true);
  assert.equal(game.simulationRate, 'full');
  const steps = simulation.frameSequence;
  game.update(STEP);
  game.update(STEP);
  assert.equal(simulation.frameSequence - steps, 2);
  game.setSimulationRate('half');
  assert.equal(game.simulationRate, 'full', 'a preset applied while locked stays full');
  game.setFullRateLock(false);
  assert.equal(game.simulationRate, 'half');
});

test('unlocking with full requested stays full, and an unlocked game takes every rate', async () => {
  const { game } = await createGame();
  game.setFullRateLock(true);
  game.setFullRateLock(false);
  assert.equal(game.simulationRate, 'full');
  game.setSimulationRate('half');
  assert.equal(game.simulationRate, 'half');
  game.setSimulationRate('full');
  assert.equal(game.simulationRate, 'full');
});
