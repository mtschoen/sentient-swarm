import test from 'node:test';
import assert from 'node:assert/strict';
import { RunState, RunPhase } from '../../src/game/run.js';

function playing() {
  const run = new RunState({});
  run.start();
  return run;
}

test('playerHit in Ready returns false', () => {
  assert.equal(new RunState({}).playerHit(1), false);
});

test('hit decrements lives and queues clearArena then shockwave', () => {
  const run = playing();
  assert.equal(run.playerHit(1, { x: 3, y: 2 }), true);
  assert.equal(run.lives, 2);
  assert.equal(run.phase, RunPhase.Dying);
  const actions = run.update(0.01);
  assert.deepEqual(actions.map((action) => action.type), ['clearArena', 'shockwave']);
  assert.equal(actions[1].x, 3);
  assert.equal(actions[1].y, 2);
});

test('respawn after 1.4 s with invulnerability that lasts 2 s', () => {
  const run = playing();
  run.playerHit(1);
  run.update(0.7);
  const actions = run.update(0.7);
  assert.equal(run.phase, RunPhase.Playing);
  assert.equal(run.invulnerable, true);
  assert.deepEqual(actions.map((action) => action.type), ['respawn']);
  assert.equal(run.playerHit(2), false);
  run.update(1.9);
  assert.equal(run.invulnerable, true);
  run.update(0.1);
  assert.equal(run.invulnerable, false);
});

test('hit below respawnSequence is rejected', () => {
  const run = playing();
  run.setRespawnSequence(10);
  assert.equal(run.respawnSequence, 10);
  assert.equal(run.playerHit(9), false);
  assert.equal(run.lives, 3);
  assert.equal(run.playerHit(10), true);
});

test('three hits end in GameOver with a gameOver action', () => {
  const run = playing();
  for (let life = 0; life < 2; life += 1) {
    assert.equal(run.playerHit(life), true);
    run.update(1.4);
    run.update(2.1);
  }
  assert.equal(run.playerHit(5), true);
  const actions = run.update(0.8);
  assert.equal(run.phase, RunPhase.GameOver);
  assert.equal(run.lives, 0);
  assert.equal(actions.at(-1).type, 'gameOver');
});

test('useBomb requires bombs and Playing, and queues bomb then shockwave', () => {
  const run = new RunState({ bombs: 1 });
  assert.equal(run.useBomb(), false);
  run.start();
  assert.equal(run.useBomb(), true);
  assert.equal(run.bombs, 0);
  assert.equal(run.useBomb(), false);
  assert.deepEqual(run.update(0.01).map((action) => action.type), ['bomb', 'shockwave']);
  run.addBomb();
  run.addLife();
  assert.equal(run.bombs, 1);
  assert.equal(run.lives, 4);
});

test('playerHit in Dying returns false and leaves lives unchanged', () => {
  const run = playing();
  assert.equal(run.playerHit(1), true);
  assert.equal(run.phase, RunPhase.Dying);
  assert.equal(run.playerHit(2), false);
  assert.equal(run.lives, 2);
});

test('playerHit in Respawning returns false and leaves lives unchanged', () => {
  const run = playing();
  run.playerHit(1);
  run.update(0.8);
  assert.equal(run.phase, RunPhase.Respawning);
  assert.equal(run.playerHit(2), false);
  assert.equal(run.lives, 2);
});

test('late hit below respawnSequence is rejected after invulnerability expires', () => {
  const run = playing();
  run.playerHit(1);
  run.update(1.4);
  run.setRespawnSequence(50);
  run.update(2.1);
  assert.equal(run.phase, RunPhase.Playing);
  assert.equal(run.invulnerable, false);
  assert.equal(run.playerHit(49), false);
  assert.equal(run.lives, 2);
  assert.equal(run.playerHit(50), true);
  assert.equal(run.lives, 1);
});

test('start resets respawnSequence', () => {
  const run = playing();
  run.setRespawnSequence(500);
  run.start();
  assert.equal(run.respawnSequence, 0);
  assert.equal(run.playerHit(1), true);
});

test('useBomb is rejected outside Playing and spends nothing or queues nothing', () => {
  const ready = new RunState({ bombs: 3 });
  assert.equal(ready.useBomb(), false);
  assert.deepEqual(ready.update(0.01), []);
  assert.equal(ready.bombs, 3);

  const run = playing();
  run.playerHit(1);
  run.update(0.01);
  assert.equal(run.phase, RunPhase.Dying);
  assert.equal(run.useBomb(), false);
  run.update(0.8);
  assert.equal(run.phase, RunPhase.Respawning);
  assert.equal(run.useBomb(), false);
  assert.equal(run.bombs, 3);

  const over = new RunState({ lives: 1 });
  over.start();
  over.playerHit(1);
  over.update(0.8);
  assert.equal(over.phase, RunPhase.GameOver);
  assert.deepEqual(over.update(0.01), []);
  assert.equal(over.useBomb(), false);
  assert.deepEqual(over.update(0.01), []);
  assert.equal(over.bombs, 3);
});
