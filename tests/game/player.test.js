import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerShip } from '../../src/game/player.js';
import { arenaBoundsForAspect } from '../../src/sim/layout.js';

const ARENA = {};

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

test('velocity is the clamped displacement over the step, and zero against a wall', () => {
  const player = new PlayerShip();
  player.update(1 / 60, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 } });
  assert.ok(Math.abs(player.velocity.x - 6) < 1e-9);
  assert.equal(player.velocity.y, 0);
  for (let step = 0; step < 600; step += 1) player.update(1 / 60, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 } });
  assert.equal(player.velocity.x, 0);
});

test('narrow bounds: respawn goes to the bounds center and movement clamps inside them', () => {
  const bounds = arenaBoundsForAspect(1);
  const ship = new PlayerShip({ bounds, radius: 0.12 });
  assert.ok(Math.abs(ship.position.x - 8) < 1e-9 && Math.abs(ship.position.y - 4.5) < 1e-9);
  ship.update(10, input(-1, 1));
  assert.ok(Math.abs(ship.position.x - (bounds.minX + 0.12)) < 1e-9);
  assert.ok(Math.abs(ship.position.y - (bounds.maxY - 0.12)) < 1e-9);
  assert.equal(ship.bounds, bounds);
});

test('a bounds rectangle off the world origin centers the respawn on its own center', () => {
  const bounds = { minX: 2, minY: 1, maxX: 6, maxY: 5, width: 4, height: 4 };
  const ship = new PlayerShip({ bounds });
  assert.deepEqual(ship.position, { x: 4, y: 3 });
});

test('setBounds pulls a ship outside the new bounds back inside and keeps it there', () => {
  const ship = new PlayerShip({ radius: 0.12 });
  ship.update(10, input(1, 0));
  const bounds = arenaBoundsForAspect(1);
  ship.setBounds(bounds);
  assert.ok(Math.abs(ship.position.x - (bounds.maxX - 0.12)) < 1e-9);
  assert.equal(ship.bounds, bounds);
});

test('bounds narrower than the ship diameter throw, in the constructor and in setBounds', () => {
  const tiny = { minX: 0, minY: 0, maxX: 0.2, maxY: 5, width: 0.2, height: 5 };
  assert.throws(() => new PlayerShip({ bounds: tiny }), /wider and taller/);
  const ship = new PlayerShip();
  assert.throws(() => ship.setBounds(tiny), /wider and taller/);
  assert.equal(ship.bounds.width, 16);
});
