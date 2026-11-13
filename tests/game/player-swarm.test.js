import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_SWARM_SHIPS, KILLS_PER_SWARM_SHIP, MAXIMUM_SWARM_SHIPS, PlayerSwarm, SWARM_LOOP_SECONDS_MAXIMUM, SWARM_LOOP_SECONDS_MINIMUM,
  SWARM_LOOP_SIZE_MAXIMUM, SWARM_MAXIMUM_SPEED, SWARM_SEPARATION_RADIUS, SWARM_WANDER_SIZE, slotHash,
} from '../../src/game/player-swarm.js';
import { SWARM_HIT_MASK_WORDS } from '../../src/sim/layout.js';

const STEP = 1 / 60;

// A deterministic sequence in [0, 1) for the spawn offsets, so tests never use Math.random.
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

// Steps the swarm for seconds around a fixed point, calling observe after each step.
function hold(swarm, seconds, x, y, observe = () => {}) {
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) {
    swarm.update(STEP, x, y);
    observe();
  }
}

// Bound on a settled ship's distance from the point for a 12-ship swarm: the biggest loop, the
// wander and a margin for the spring's overshoot.
const IDLE_BOUND = SWARM_LOOP_SIZE_MAXIMUM + SWARM_WANDER_SIZE + 0.25;

test('reset spawns the initial swarm around the point; the cap holds 256 slots', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  assert.equal(swarm.aliveCount, INITIAL_SWARM_SHIPS);
  assert.equal(swarm.ships.length, INITIAL_SWARM_SHIPS);
  assert.equal(MAXIMUM_SWARM_SHIPS, 256);
  swarm.reset(8, 4.5, 1000);
  assert.equal(swarm.aliveCount, MAXIMUM_SWARM_SHIPS);
});

test('idle ships stay near a still point, loop both ways and keep turning both ways (figure eights)', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  hold(swarm, 5, 8, 4.5);
  const alive = swarm.slots.filter((slot) => slot.alive);
  const left = new Array(alive.length).fill(0);
  const right = new Array(alive.length).fill(0);
  const previous = alive.map((ship) => [ship.velocityX, ship.velocityY]);
  let farthest = 0;
  hold(swarm, 20, 8, 4.5, () => {
    alive.forEach((ship, index) => {
      const turn = previous[index][0] * ship.velocityY - previous[index][1] * ship.velocityX;
      if (turn > 0) left[index] += 1;
      else if (turn < 0) right[index] += 1;
      previous[index] = [ship.velocityX, ship.velocityY];
      farthest = Math.max(farthest, Math.hypot(ship.x - 8, ship.y - 4.5));
    });
  });
  assert.ok(farthest < IDLE_BOUND, `farthest ${farthest}`);
  // A circling ship always turns one way; a figure eight turns both ways in every loop.
  alive.forEach((ship, index) => {
    const share = left[index] / (left[index] + right[index]);
    assert.ok(share > 0.2 && share < 0.8, `slot ${index} turned left ${(share * 100).toFixed(0)} percent of the time`);
  });
  assert.deepEqual([...new Set(alive.map((ship) => ship.loopDirection))].sort(), [-1, 1]);
  const periods = alive.map((ship) => (2 * Math.PI) / ship.loopRadiansPerSecond);
  assert.ok(periods.every((period) => period >= SWARM_LOOP_SECONDS_MINIMUM && period <= SWARM_LOOP_SECONDS_MAXIMUM));
  assert.equal(new Set(periods).size, alive.length, 'every ship has its own loop speed');
  // The heading follows the velocity.
  const ship = alive[0];
  assert.ok(Math.abs(Math.atan2(ship.velocityY, ship.velocityX) - ship.heading) < 1e-9);
  assert.equal(swarm.ships[0].heading, ship.heading);
});

test('the idle character comes from the slot alone, not the random source', () => {
  const first = new PlayerSwarm({ random: () => 0.1 });
  const second = new PlayerSwarm({ random: () => 0.9 });
  first.reset(8, 4.5);
  second.reset(8, 4.5);
  const character = (slot) => [slot.loopRadiansPerSecond, slot.loopSizeFraction, slot.loopDirection, slot.axisAngle, slot.axisDrift];
  assert.deepEqual(first.slots.slice(0, 12).map(character), second.slots.slice(0, 12).map(character));
  assert.ok(slotHash(3, 1) >= 0 && slotHash(3, 1) < 1);
  assert.notEqual(slotHash(3, 1), slotHash(4, 1));
});

test('the swarm converges back on the point after it jumps', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  hold(swarm, 3, 8, 4.5);
  hold(swarm, 4, 11, 6);
  const centroid = swarm.centroid;
  assert.ok(Math.hypot(centroid.x - 11, centroid.y - 6) < 0.35, `centroid ${centroid.x}, ${centroid.y}`);
  for (const ship of swarm.ships) assert.ok(Math.hypot(ship.x - 11, ship.y - 6) < IDLE_BOUND, `ship at ${ship.x}, ${ship.y}`);
});

test('a point moving at the player speed stretches the flock behind it, still close, then it settles', () => {
  const bounds = { minX: 0, maxX: 16, minY: 0, maxY: 9, width: 16, height: 9 };
  const swarm = new PlayerSwarm({ random: sequenceRandom(), bounds });
  swarm.reset(2, 4.5);
  hold(swarm, 2, 2, 4.5);
  let x = 2;
  for (let step = 0; step < 120; step += 1) {
    x += 6 * STEP;
    swarm.update(STEP, x, 4.5);
  }
  const trailing = x - swarm.centroid.x;
  assert.ok(trailing > 0.2 && trailing < 1.2, `the flock trails by ${trailing}`);
  hold(swarm, 4, x, 4.5);
  assert.ok(Math.abs(swarm.centroid.x - x) < 0.35, `settled centroid ${swarm.centroid.x} vs point ${x}`);
  hold(swarm, 5, 16, 9);
  for (const ship of swarm.ships) assert.ok(ship.x <= 16 && ship.y <= 9);
  for (const slot of swarm.slots.filter((entry) => entry.alive)) assert.ok(Math.hypot(slot.velocityX, slot.velocityY) <= SWARM_MAXIMUM_SPEED + 1e-9);
});

test('a full swarm spreads wider than a small one without blobbing', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, MAXIMUM_SWARM_SHIPS);
  hold(swarm, 10, 8, 4.5);
  const ships = swarm.ships;
  let nearestSum = 0;
  for (const ship of ships) {
    let nearest = Infinity;
    for (const other of ships) if (other !== ship) nearest = Math.min(nearest, Math.hypot(ship.x - other.x, ship.y - other.y));
    nearestSum += nearest;
  }
  assert.ok(nearestSum / ships.length > SWARM_SEPARATION_RADIUS * 0.5, `mean nearest neighbour ${nearestSum / ships.length}`);
  const farthest = Math.max(...ships.map((ship) => Math.hypot(ship.x - 8, ship.y - 4.5)));
  assert.ok(farthest > SWARM_LOOP_SIZE_MAXIMUM && farthest < 4, `farthest ${farthest}`);
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
