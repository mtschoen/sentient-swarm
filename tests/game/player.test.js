import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerShip } from '../../src/game/player.js';

const ARENA = { arenaWidth: 16, arenaHeight: 9 };

function input(moveX, moveY, aimX = 0, aimY = 0) {
  return { move: { x: moveX, y: moveY }, aim: { x: aimX, y: aimY } };
}

test('PlayerShip starts at the arena center', () => {
  const ship = new PlayerShip(ARENA);
  assert.deepEqual(ship.position, { x: 8, y: 4.5 });
});

test('PlayerShip moving right for 1 s at speed 6 from the center reaches x = 14', () => {
  const ship = new PlayerShip(ARENA);
  ship.update(1, input(1, 0));
  assert.ok(Math.abs(ship.position.x - 14) < 1e-9, `x ${ship.position.x}`);
  assert.equal(ship.position.y, 4.5);
});

test('PlayerShip is clamped inside the arena by its radius', () => {
  const ship = new PlayerShip({ ...ARENA, radius: 0.12 });
  ship.update(10, input(1, -1));
  assert.ok(Math.abs(ship.position.x - (16 - 0.12)) < 1e-9, `x ${ship.position.x}`);
  assert.ok(Math.abs(ship.position.y - 0.12) < 1e-9, `y ${ship.position.y}`);
  ship.update(10, input(-1, 1));
  assert.ok(Math.abs(ship.position.x - 0.12) < 1e-9);
  assert.ok(Math.abs(ship.position.y - (9 - 0.12)) < 1e-9);
});

test('PlayerShip aim holds the last direction when the stick is released', () => {
  const ship = new PlayerShip(ARENA);
  ship.update(1 / 60, input(0, 0, 0, 1));
  assert.deepEqual(ship.aim, { x: 0, y: 1 });
  ship.update(1 / 60, input(0, 0, 0.1, 0.1));
  assert.deepEqual(ship.aim, { x: 0, y: 1 });
  ship.update(1 / 60, input(0, 0, 0, 0));
  assert.deepEqual(ship.aim, { x: 0, y: 1 });
  assert.ok(Math.abs(ship.facing - Math.PI / 2) < 1e-9);
  ship.update(1 / 60, input(0, 0, -0.5, 0));
  assert.deepEqual(ship.aim, { x: -0.5, y: 0 });
  assert.ok(Math.abs(ship.facing - Math.PI) < 1e-9);
});

test('PlayerShip respawn returns to the center', () => {
  const ship = new PlayerShip({ ...ARENA, speed: 2 });
  ship.update(1, input(1, 1));
  ship.respawn();
  assert.deepEqual(ship.position, { x: 8, y: 4.5 });
});

test('PlayerShip exposes copies, so callers cannot move it', () => {
  const ship = new PlayerShip(ARENA);
  ship.position.x = 0;
  ship.aim.x = 5;
  assert.equal(ship.position.x, 8);
  assert.notEqual(ship.aim.x, 5);
});
