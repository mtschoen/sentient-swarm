import test from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_SWARM_SHOOTERS_PER_VOLLEY, MAXIMUM_SWARM_SPAWNS_PER_UPDATE, SWARM_PROJECTILE_RADIUS_SCALE, SwarmFire } from '../../src/game/swarm-fire.js';
import { WeaponState } from '../../src/game/weapons.js';

const ORIGIN = { x: 8, y: 4.5 };

function shipsAround(count) {
  return Array.from({ length: count }, (_, index) => ({ slot: index, x: 8 + index * 0.01, y: 4.5 - index * 0.01 }));
}

function volley(spawns, turretSpawns = [], beam = null) {
  return { spawns, turretSpawns, beam, expired: false };
}

const SHOT = { x: 8.1, y: 4.5, velocityX: 10, velocityY: 0, radius: 0.2, lifetime: 3, kind: 0, seed: 0.5, extra: 0 };

test('a quarter of the ships fire half-size copies from their own positions, in rotation', () => {
  const fire = new SwarmFire();
  const ships = shipsAround(12);
  const first = fire.distribute(volley([SHOT]), ships, ORIGIN, ORIGIN);
  assert.equal(first.spawns.length, 3);
  assert.deepEqual(first.spawns.map((spawn) => Math.round((spawn.x - 0.1 - 8) * 100)), [0, 1, 2]);
  assert.ok(first.spawns.every((spawn) => spawn.radius === SHOT.radius * SWARM_PROJECTILE_RADIUS_SCALE && spawn.velocityX === 10));
  const second = fire.distribute(volley([SHOT]), ships, ORIGIN, ORIGIN);
  assert.deepEqual(second.spawns.map((spawn) => Math.round((spawn.x - 0.1 - 8) * 100)), [3, 4, 5]);
  assert.equal(fire.distribute(volley([SHOT]), shipsAround(1), ORIGIN, ORIGIN).spawns.length, 1);
});

test('a 256-ship swarm fires no more copies than the shooter cap, and a scatter III volley fits the ceiling', () => {
  const fire = new SwarmFire();
  const weapons = new WeaponState({ random: () => 0.5 });
  weapons.collect('scatter');
  weapons.collect('scatter');
  weapons.collect('scatter');
  const result = weapons.update(0.2, { firing: true, aimX: 1, aimY: 0, x: ORIGIN.x, y: ORIGIN.y });
  assert.equal(result.spawns.length, 17);
  const shots = fire.distribute(result, shipsAround(256), ORIGIN, ORIGIN);
  assert.equal(shots.spawns.length, 17 * MAXIMUM_SWARM_SHOOTERS_PER_VOLLEY);
  assert.ok(shots.spawns.length <= MAXIMUM_SWARM_SPAWNS_PER_UPDATE);
});

test('the per-update ceiling bounds a huge volley', () => {
  const fire = new SwarmFire();
  const many = Array.from({ length: 100 }, () => SHOT);
  assert.equal(fire.distribute(volley(many), shipsAround(256), ORIGIN, ORIGIN).spawns.length, MAXIMUM_SWARM_SPAWNS_PER_UPDATE);
});

test('turret volleys fire once from one rotating ship, at full size; the beam leaves the centroid', () => {
  const fire = new SwarmFire();
  const ships = shipsAround(4);
  const turret = { ...SHOT, x: 8, kind: 2, radius: 0.05 };
  const beam = { x: 8, y: 4.5, directionX: 1, directionY: 0, halfWidth: 0.12 };
  const result = fire.distribute(volley([], [turret, turret], beam), ships, ORIGIN, { x: 9, y: 5 });
  assert.equal(result.spawns.length, 0);
  assert.deepEqual(result.turretSpawns.map((spawn) => [spawn.x, spawn.radius]), [[8, 0.05], [8, 0.05]]);
  assert.deepEqual([result.beam.x, result.beam.y, result.beam.halfWidth], [9, 5, 0.12]);
  const next = fire.distribute(volley([], [turret]), ships, ORIGIN, ORIGIN);
  assert.equal(next.turretSpawns[0].x, 8.01);
});

test('no ships fire nothing, and reset restarts the rotation', () => {
  const fire = new SwarmFire();
  const empty = fire.distribute(volley([SHOT], [SHOT], { x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 }), [], ORIGIN, ORIGIN);
  assert.deepEqual(empty, { spawns: [], turretSpawns: [], beam: null });
  fire.distribute(volley([SHOT]), shipsAround(12), ORIGIN, ORIGIN);
  fire.reset();
  assert.equal(fire.rotation, 0);
});
