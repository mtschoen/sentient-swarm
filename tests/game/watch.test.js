import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchPressure, moveWatchPoint } from '../../src/game/watch.js';
import { PlayerShip } from '../../src/game/player.js';
import { InputState } from '../../src/input/input.js';

test('moveWatchPoint puts the point on the pointer, clamped inside the arena', () => {
  const player = new PlayerShip();
  const inputState = new InputState();
  inputState.pointerWorld = { x: 3, y: 4 };
  moveWatchPoint(player, 1 / 60, inputState, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false });
  assert.deepEqual(player.position, { x: 3, y: 4 });
  inputState.pointerWorld = { x: -50, y: 500 };
  moveWatchPoint(player, 1 / 60, inputState, { move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, firing: false });
  assert.ok(player.position.x > player.bounds.minX && player.position.x < 1);
  assert.ok(player.position.y < player.bounds.maxY);
});

test('moveWatchPoint moves with the stick when there is no pointer', () => {
  const player = new PlayerShip();
  const before = player.position;
  const inputState = new InputState();
  moveWatchPoint(player, 0.5, inputState, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 }, firing: true });
  assert.ok(player.position.x > before.x);
});

test('createWatchPressure validates the fraction and carries over the previous estimate', () => {
  assert.throws(() => createWatchPressure(1000, 2), RangeError);
  assert.throws(() => createWatchPressure(1000, 'x'), RangeError);
  const first = createWatchPressure(1000, 0.5);
  first.requests = [1, 2];
  first.filling = true;
  const next = createWatchPressure(1000, 0.25, first);
  assert.deepEqual(next.requests, [1, 2]);
  assert.equal(next.filling, true);
  assert.equal(next.newestStats, first.newestStats);
});
