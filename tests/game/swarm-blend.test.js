import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Camera } from '../../src/game/camera.js';
import { PlayerSwarm } from '../../src/game/player-swarm.js';
import { blendedCoordinate, blendedPoint, blendShips } from '../../src/game/swarm-blend.js';

test('blendedCoordinate extrapolates the last step by alpha', () => {
  assert.equal(blendedCoordinate(5, 3, 0), 5);
  assert.equal(blendedCoordinate(5, 3, 0.5), 6);
  assert.equal(blendedCoordinate(5, 5, 0.9), 5);
});

test('blendShips copies other fields and reuses the output entries', () => {
  const out = [];
  const ships = [{ slot: 2, x: 1, y: 1, previousX: 0, previousY: 2, age: 4, heading: 0.5 }];
  const first = blendShips(ships, 0.5, out)[0];
  assert.deepEqual([first.x, first.y, first.slot, first.heading, first.age], [1.5, 0.5, 2, 0.5, 4]);
  assert.equal(blendShips(ships, 1, out)[0], first);
  assert.equal(first.x, 2);
  assert.equal(blendShips([], 0.5, out).length, 0);
});

test('blendedPoint agrees with Camera.sample along the same velocity', () => {
  const camera = new Camera();
  camera.centerX = 0;
  camera.velocityX = 2;
  camera.lastDeltaSeconds = 0.5;
  const sampled = camera.sample(0.4);
  const point = blendedPoint({ x: 0, y: 0 }, 2, 0, 0.4, 0.5);
  assert.equal(point.x, sampled.centerX);
  assert.equal(point.y, 0);
  assert.deepEqual(blendedPoint({ x: 1, y: 2 }, 9, 9, 0.7, 0), { x: 1, y: 2 });
});

test('a fresh ship is drawn where it is, and a moved ship extrapolates by its last step', () => {
  const swarm = new PlayerSwarm({ random: () => 0.5 });
  swarm.reset(10, 5, 1);
  const spawned = swarm.ships[0];
  assert.deepEqual([spawned.previousX, spawned.previousY], [spawned.x, spawned.y]);
  const fresh = swarm.shipsAt(1)[0];
  assert.deepEqual([fresh.x, fresh.y], [spawned.x, spawned.y]);
  swarm.update(1 / 60, 10, 5);
  const moved = swarm.ships[0];
  const startX = moved.previousX;
  assert.notEqual(startX, moved.x);
  const drawn = swarm.shipsAt(0.5)[0];
  assert.equal(drawn.x, moved.x + (moved.x - startX) * 0.5);
  assert.equal(swarm.shipsAt(0)[0].x, moved.x);
});

test('a ship grown after a step has no streak, and a reset cuts every ship', () => {
  const swarm = new PlayerSwarm({ random: () => 0.25 });
  swarm.reset(0, 0, 2);
  swarm.update(1 / 60, 3, 3);
  swarm.addKills(100);
  const grown = swarm.shipsAt(1).find((ship) => ship.slot === 2);
  assert.ok(grown);
  const raw = swarm.ships.find((ship) => ship.slot === 2);
  assert.deepEqual([grown.x, grown.y], [raw.x, raw.y]);
  swarm.reset(20, 20, 3);
  swarm.ships.forEach((ship) => assert.deepEqual([ship.previousX, ship.previousY], [ship.x, ship.y]));
});
