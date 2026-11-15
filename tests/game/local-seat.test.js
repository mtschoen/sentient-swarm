import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createGame, runFor } from './game-harness.js';
import { framedFocuses } from '../../src/game/seats.js';

test('a local seat index of 1 drives seat index 1 from input.state and seat index 0 from seatTwoState', async () => {
  const { game, input } = await createGame();
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  const before = game.seats.map((seat) => seat.point.x);
  input.state.move = { x: 1, y: 0 };
  runFor(game, 0.5);
  assert.ok(game.seats[1].point.x > before[1] + 0.5);
  assert.equal(game.seats[0].point.x, before[0]);
  input.state.move = { x: 0, y: 0 };
  input.seatTwoState.move = { x: -1, y: 0 };
  runFor(game, 0.5);
  assert.ok(game.seats[0].point.x < before[0] - 0.5);
});

test('the seat 1 getters and the HUD fields follow the local seat', async () => {
  const { game } = await createGame();
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  assert.equal(game.player, game.seats[1].player);
  assert.equal(game.weapons, game.seats[1].weapons);
  game.start();
  game.seats[1].swarm.killShip(game.seats[1].swarm.ships[0].slot);
  assert.equal(game.state.lives, 11);
  assert.equal(game.state.seats[0].ships, 12);
});

test('the fire log samples the local seat', async () => {
  const { game, input } = await createGame();
  const samples = [];
  game.setFireLog({ sample: (deltaSeconds, entry) => samples.push(entry) });
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  input.state.firing = true;
  game.update(STEP);
  assert.equal(samples.at(-1).inputFiring, true);
});

test('with no live seat the camera frames the local seat', () => {
  const seat = (index) => ({ index, down: true, aliveCount: 0, cameraFocus: { x: index, y: 0 } });
  assert.deepEqual(framedFocuses([seat(0), seat(1)], 1), [{ x: 1, y: 0 }]);
  assert.deepEqual(framedFocuses([seat(0), seat(1)]), [{ x: 0, y: 0 }]);
});

test('setLocalSeat works in Ready only and in range; one seat and quitToTitle return it to 0', async () => {
  const { game } = await createGame();
  assert.throws(() => game.setLocalSeat(1), RangeError);
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.start();
  assert.throws(() => game.setLocalSeat(0), /only in Ready/);
  game.quitToTitle();
  assert.equal(game.localSeatIndex, 0);
  game.setPlayerCount(2);
  game.setLocalSeat(1);
  game.setPlayerCount(1);
  assert.equal(game.localSeatIndex, 0);
});
