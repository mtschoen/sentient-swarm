import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SWARM_SHIPS, KILLS_PER_SWARM_SHIP, MAXIMUM_SWARM_SHIPS, PlayerSwarm, SWARM_MAXIMUM_SPEED, SWARM_ORBIT_RADIUS_MAXIMUM,
  SWARM_SEPARATION_RADIUS,
} from '../../src/game/player-swarm.js';
import { SWARM_HIT_MASK_WORDS } from '../../src/sim/layout.js';

const STEP = 1 / 60;

// A deterministic sequence in [0, 1), so orbits differ per ship without Math.random.
function sequenceRandom() {
  let state = 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function maskFor(slots) {
  const mask = new Uint32Array(SWARM_HIT_MASK_WORDS);
  for (const slot of slots) mask[Math.floor(slot / 32)] |= (1 << (slot % 32)) >>> 0;
  return mask;
}

test('reset spawns the initial swarm around the point; the cap holds 256 slots', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  assert.equal(swarm.aliveCount, INITIAL_SWARM_SHIPS);
  assert.equal(swarm.ships.length, INITIAL_SWARM_SHIPS);
  assert.equal(MAXIMUM_SWARM_SHIPS, 256);
  swarm.reset(8, 4.5, 1000);
  assert.equal(swarm.aliveCount, MAXIMUM_SWARM_SHIPS);
});

test('the swarm settles into a cohesive orbit around a still point without stacking', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  for (let step = 0; step < 600; step += 1) swarm.update(STEP, 8, 4.5);
  const ships = swarm.ships;
  const distances = ships.map((ship) => Math.hypot(ship.x - 8, ship.y - 4.5));
  assert.ok(Math.max(...distances) < SWARM_ORBIT_RADIUS_MAXIMUM * 1.5, `farthest ${Math.max(...distances)}`);
  let closest = Infinity;
  for (const first of ships) for (const second of ships) if (first !== second) closest = Math.min(closest, Math.hypot(first.x - second.x, first.y - second.y));
  assert.ok(closest > SWARM_SEPARATION_RADIUS * 0.2, `closest pair ${closest}`);
  // It keeps circling: positions still change.
  const before = ships.map((ship) => [ship.x, ship.y]);
  swarm.update(STEP, 8, 4.5);
  assert.ok(swarm.ships.some((ship, index) => ship.x !== before[index][0] || ship.y !== before[index][1]));
});

test('the swarm follows a point moving at the player speed and stays inside the bounds', () => {
  const bounds = { minX: 0, maxX: 16, minY: 0, maxY: 9, width: 16, height: 9 };
  const swarm = new PlayerSwarm({ random: sequenceRandom(), bounds });
  swarm.reset(2, 4.5);
  let x = 2;
  for (let step = 0; step < 120; step += 1) {
    x += 6 * STEP;
    swarm.update(STEP, x, 4.5);
  }
  const centroid = swarm.centroid;
  assert.ok(Math.abs(centroid.x - x) < 0.6, `centroid ${centroid.x} vs point ${x}`);
  for (let step = 0; step < 300; step += 1) swarm.update(STEP, 16, 9);
  for (const ship of swarm.ships) assert.ok(ship.x <= 16 && ship.y <= 9);
  for (const slot of swarm.slots.filter((entry) => entry.alive)) assert.ok(Math.hypot(slot.velocityX, slot.velocityY) <= SWARM_MAXIMUM_SPEED + 1e-9);
});

test('a hit kills an alive ship once and only from a frame at or after its first upload', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, 3);
  const table = swarm.contactShips(10);
  assert.deepEqual(table.slice(0, 4).map((ship) => [ship.alive, ship.fresh]), [[true, true], [true, true], [true, true], [false, false]]);
  assert.equal(swarm.contactShips(11)[0].fresh, false);
  assert.deepEqual(swarm.applyHits(maskFor([0]), 9), [], 'a frame before the first upload');
  const killed = swarm.applyHits(maskFor([0, 2, 200]), 12);
  assert.deepEqual(killed.map((ship) => ship.slot), [0, 2]);
  assert.equal(swarm.aliveCount, 1);
  assert.deepEqual(swarm.applyHits(maskFor([0, 2]), 13), [], 'already dead');
  // A ship grown into slot 0 is not killed by the old bit from an earlier frame.
  assert.equal(swarm.spawnShip(8, 4.5), 0);
  swarm.contactShips(20);
  assert.deepEqual(swarm.applyHits(maskFor([0]), 19), []);
  assert.deepEqual(swarm.applyHits(maskFor([0]), 20).map((ship) => ship.slot), [0]);
});

test('high slots map to the later mask words', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, MAXIMUM_SWARM_SHIPS);
  swarm.contactShips(5);
  assert.deepEqual(swarm.applyHits(maskFor([31, 32, 255]), 5).map((ship) => ship.slot), [31, 32, 255]);
  assert.equal(swarm.aliveCount, MAXIMUM_SWARM_SHIPS - 3);
});

test('kills grow one ship per hundred, up to the cap, dropping credit while full', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  assert.equal(swarm.addKills(KILLS_PER_SWARM_SHIP - 1), 0);
  assert.equal(swarm.addKills(1), 1);
  assert.equal(swarm.addKills(KILLS_PER_SWARM_SHIP * 3 + 20), 3);
  assert.equal(swarm.aliveCount, INITIAL_SWARM_SHIPS + 4);
  swarm.reset(8, 4.5, MAXIMUM_SWARM_SHIPS - 1);
  assert.equal(swarm.addKills(KILLS_PER_SWARM_SHIP * 5), 1);
  assert.equal(swarm.aliveCount, MAXIMUM_SWARM_SHIPS);
  assert.equal(swarm.killCredit, 0);
});

test('update, contactShips and ships reuse their arrays', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  const table = swarm.contactShips(1);
  const ships = swarm.ships;
  swarm.update(STEP, 8, 4.5);
  assert.equal(swarm.contactShips(2), table);
  assert.equal(swarm.ships, ships);
  assert.equal(swarm.centroid.x > 0, true);
  swarm.update(0, 8, 4.5);
});
