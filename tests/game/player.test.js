import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerShip, turnAimToward } from '../../src/game/player.js';
import { centeredViewBounds } from '../sim/centered-view-bounds.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

const CENTER = { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };

const ARENA = {};

function input(moveX, moveY, aimX = 0, aimY = 0) {
  return { move: { x: moveX, y: moveY }, aim: { x: aimX, y: aimY } };
}

test('PlayerShip starts at the world center', () => {
  const ship = new PlayerShip(ARENA);
  assert.deepEqual(ship.position, CENTER);
});

test('PlayerShip moving right for 1 s at speed 6 from the center moves 6 units', () => {
  const ship = new PlayerShip(ARENA);
  ship.update(1, input(1, 0));
  assert.ok(Math.abs(ship.position.x - (CENTER.x + 6)) < 1e-9, `x ${ship.position.x}`);
  assert.equal(ship.position.y, CENTER.y);
});

test('PlayerShip is clamped inside the arena by its radius', () => {
  const ship = new PlayerShip({ ...ARENA, radius: 0.12 });
  ship.update(10, input(1, -1));
  assert.ok(Math.abs(ship.position.x - (WORLD_WIDTH - 0.12)) < 1e-9, `x ${ship.position.x}`);
  assert.ok(Math.abs(ship.position.y - 0.12) < 1e-9, `y ${ship.position.y}`);
  ship.update(10, input(-1, 1));
  assert.ok(Math.abs(ship.position.x - 0.12) < 1e-9);
  assert.ok(Math.abs(ship.position.y - (WORLD_HEIGHT - 0.12)) < 1e-9);
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
  assert.deepEqual(ship.position, CENTER);
});

test('PlayerShip exposes copies, so callers cannot move it', () => {
  const ship = new PlayerShip(ARENA);
  ship.position.x = 0;
  ship.aim.x = 5;
  assert.equal(ship.position.x, CENTER.x);
  assert.notEqual(ship.aim.x, 5);
});

test('velocity is the clamped displacement over the step, and zero against a wall', () => {
  const player = new PlayerShip();
  player.update(1 / 60, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 } });
  assert.ok(Math.abs(player.velocity.x - 6) < 1e-9);
  assert.equal(player.velocity.y, 0);
  for (let step = 0; step < 1200; step += 1) player.update(1 / 60, { move: { x: 1, y: 0 }, aim: { x: 0, y: 0 } });
  assert.equal(player.velocity.x, 0);
});

test('narrow bounds: respawn goes to the bounds center and movement clamps inside them', () => {
  const bounds = centeredViewBounds(1);
  const ship = new PlayerShip({ bounds, radius: 0.12 });
  assert.ok(Math.abs(ship.position.x - CENTER.x) < 1e-9 && Math.abs(ship.position.y - CENTER.y) < 1e-9);
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
  const bounds = centeredViewBounds(1);
  ship.setBounds(bounds);
  assert.ok(Math.abs(ship.position.x - (bounds.maxX - 0.12)) < 1e-9);
  assert.equal(ship.bounds, bounds);
});

test('bounds narrower than the ship diameter throw, in the constructor and in setBounds', () => {
  const tiny = { minX: 0, minY: 0, maxX: 0.2, maxY: 5, width: 0.2, height: 5 };
  assert.throws(() => new PlayerShip({ bounds: tiny }), /wider and taller/);
  const ship = new PlayerShip();
  assert.throws(() => ship.setBounds(tiny), /wider and taller/);
  assert.equal(ship.bounds.width, WORLD_WIDTH);
});

test('turnAimToward lands exactly on a target within the limit and keeps its length', () => {
  assert.deepEqual(turnAimToward(1, 0, 0, 3, Math.PI), { x: 0, y: 3 });
  assert.deepEqual(turnAimToward(1, 0, 0, 3, Math.PI / 2), { x: 0, y: 3 });
  assert.deepEqual(turnAimToward(1, 0, 0.5, 0.5, Infinity), { x: 0.5, y: 0.5 });
});

test('turnAimToward turns by exactly the limit the shortest way, both directions', () => {
  const limit = 0.1;
  const counterclockwise = turnAimToward(1, 0, 0, 2, limit);
  assert.ok(Math.abs(Math.atan2(counterclockwise.y, counterclockwise.x) - limit) < 1e-12);
  assert.ok(Math.abs(Math.hypot(counterclockwise.x, counterclockwise.y) - 2) < 1e-12);
  const clockwise = turnAimToward(1, 0, 0, -2, limit);
  assert.ok(Math.abs(Math.atan2(clockwise.y, clockwise.x) + limit) < 1e-12);
});

test('turnAimToward takes the short way across the plus or minus pi seam', () => {
  const angle = Math.PI - 0.05;
  const across = turnAimToward(Math.cos(angle), Math.sin(angle), Math.cos(-angle), Math.sin(-angle), 0.02);
  assert.ok(Math.abs(across.x - Math.cos(angle + 0.02)) < 1e-12 && Math.abs(across.y - Math.sin(angle + 0.02)) < 1e-12);
  const back = turnAimToward(Math.cos(-angle), Math.sin(-angle), Math.cos(angle), Math.sin(angle), 0.02);
  assert.ok(Math.abs(back.x - Math.cos(-angle - 0.02)) < 1e-12 && Math.abs(back.y - Math.sin(-angle - 0.02)) < 1e-12);
});

test('turnAimToward turns an exactly opposite target the same way every time', () => {
  for (const [x, y] of [[1, 0], [0, 1], [-1, 0], [0.6, -0.8]]) {
    const first = turnAimToward(x, y, -x, -y, 0.1);
    assert.deepEqual(first, turnAimToward(x, y, -x, -y, 0.1));
    const turned = Math.atan2(x * first.y - y * first.x, x * first.x + y * first.y);
    assert.ok(Math.abs(turned - 0.1) < 1e-12, `${x},${y} turned ${turned}`);
  }
});

test('PlayerShip.update without a limit snaps the aim, with a limit it turns by at most that much', () => {
  const ship = new PlayerShip(ARENA);
  ship.update(0.1, input(0, 0, 0, 5));
  assert.deepEqual(ship.aim, { x: 0, y: 5 });
  const limited = new PlayerShip(ARENA);
  limited.update(0.1, input(0, 0, 0, 5), { maximumTurnRadians: 0.2 });
  assert.ok(Math.abs(limited.facing - 0.2) < 1e-12);
  limited.update(0.1, input(0, 0, 0.5, 0), { maximumTurnRadians: 0.5 });
  assert.deepEqual(limited.aim, { x: 0.5, y: 0 });
});
