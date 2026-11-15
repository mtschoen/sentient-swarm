import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../game/game-harness.js';
import { applyHostState, buildHostState } from '../../src/net/host-state.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot-codec.js';
import { seatAt } from './net-fixtures.js';

async function hivesGame() {
  const { game, simulation, projectiles } = await createGame();
  simulation.setVersusProjectiles = () => {};
  projectiles.buffer = {};
  game.setPlayerCount(2);
  game.setMode('hives');
  game.start();
  return game;
}

function stateWith(sequence, progress, overrides = {}) {
  return {
    sequence,
    hives: [{ owner: null, capturer: null, progress: 0 }, { owner: 1, capturer: null, progress: 0 }, { owner: null, capturer: 0, progress }],
    holder: null,
    holdSeconds: 0,
    score: 1200,
    multiplier: 2,
    bombs: 3,
    ...overrides,
  };
}

test('an older host state after a newer one changes nothing', async () => {
  const game = await hivesGame();
  const hives = game.versusMatch.hives;
  assert.equal(applyHostState(game, stateWith(5, 0.6), 0), 5);
  assert.equal(hives.hives[2].progress, 0.6);
  assert.equal(hives.hives[2].capturer, 0);
  assert.equal(hives.hives[1].owner, 1);
  assert.equal(applyHostState(game, stateWith(4, 0.2), 5), 5);
  assert.equal(hives.hives[2].progress, 0.6);
  assert.equal(applyHostState(game, stateWith(5, 0.1), 5), 5, 'the same sequence again is not newer');
  assert.equal(hives.hives[2].progress, 0.6);
});

test('a newer host state writes every hive and the hold', async () => {
  const game = await hivesGame();
  const hives = game.versusMatch.hives;
  applyHostState(game, stateWith(1, 0.3, { hives: [{ owner: 0, capturer: null, progress: 0 }, { owner: 0, capturer: 1, progress: 0.25 }, { owner: 0, capturer: null, progress: 0 }], holder: 0, holdSeconds: 7.5 }), 0);
  assert.deepEqual(hives.owners, [0, 0, 0]);
  assert.equal(hives.hives[1].capturer, 1);
  assert.equal(hives.hives[1].progress, 0.25);
  assert.equal(hives.hold.holder, 0);
  assert.equal(hives.hold.seconds, 7.5);
  assert.equal(game.state.hives.holdRemainingSeconds, 12.5);
});

test('outside hives a host state carries no hives and applying one only moves the sequence', async () => {
  const { game } = await createGame();
  game.start();
  const state = buildHostState(game, 3);
  assert.deepEqual(state, { sequence: 3, hives: null, holder: null, holdSeconds: 0, score: 0, multiplier: game.score.multiplier, bombs: 3 });
  assert.equal(applyHostState(game, stateWith(4, 0.5), 3), 4);
});

test('the host state of a hives match round trips through a snapshot', async () => {
  const game = await hivesGame();
  const hives = game.versusMatch.hives;
  Object.assign(hives.hives[0], { owner: 0 });
  Object.assign(hives.hives[2], { capturer: 1, progress: 0.5 });
  Object.assign(hives.hold, { holder: null, seconds: 0 });
  const state = buildHostState(game, 9);
  assert.deepEqual(state.hives, [{ owner: 0, capturer: null, progress: 0 }, { owner: null, capturer: null, progress: 0 }, { owner: null, capturer: 1, progress: 0.5 }]);
  const decoded = decodeSnapshot(encodeSnapshot({ ...seatAt({ sequence: 1, matchSeconds: 0, x: 6 }), hostState: state })).hostState;
  assert.equal(decoded.sequence, 9);
  assert.deepEqual(decoded.hives.map(({ owner, capturer }) => [owner, capturer]), [[0, null], [null, null], [null, 1]]);
  assert.ok(Math.abs(decoded.hives[2].progress - 0.5) <= 1 / 65535);
});
