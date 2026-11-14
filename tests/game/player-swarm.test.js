import test from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_SWARM_SHIPS, KILLS_PER_SWARM_SHIP, MAXIMUM_SWARM_SHIPS, PlayerSwarm } from '../../src/game/player-swarm.js';
import {
  SWARM_ATTACK_SECONDS, SWARM_CRUISE_SPEED, SWARM_MAXIMUM_SPEED, SWARM_SPEED_FLOOR, attackPhaseFor, attackTurn, homeRadiusFor,
  slotHash, temperamentFor,
} from '../../src/game/swarm-flocking.js';
import { SWARM_FIRE_CONE_RADIANS } from '../../src/game/swarm-fire.js';
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

test('reset spawns the initial swarm around the point; the cap holds 256 slots', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  assert.equal(swarm.aliveCount, INITIAL_SWARM_SHIPS);
  assert.equal(swarm.ships.length, INITIAL_SWARM_SHIPS);
  assert.equal(MAXIMUM_SWARM_SHIPS, 256);
  swarm.reset(8, 4.5, 1000);
  assert.equal(swarm.aliveCount, MAXIMUM_SWARM_SHIPS);
});

// Steps the swarm for seconds around a fixed point, calling observe after each step.
function hold(swarm, seconds, x, y, observe = () => {}, controls = undefined) {
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) {
    swarm.update(STEP, x, y, controls);
    observe();
  }
}

// The square root of the ratio of the principal axes of the position covariance (1 for a disc).
function axisRatio(ships) {
  let meanX = 0;
  let meanY = 0;
  for (const ship of ships) {
    meanX += ship.x / ships.length;
    meanY += ship.y / ships.length;
  }
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const ship of ships) {
    xx += (ship.x - meanX) ** 2;
    xy += (ship.x - meanX) * (ship.y - meanY);
    yy += (ship.y - meanY) ** 2;
  }
  const half = (xx + yy) / 2;
  const spread = Math.sqrt(((xx - yy) / 2) ** 2 + xy * xy);
  return Math.sqrt((half + spread) / Math.max(half - spread, 1e-12));
}

// 1 minus the length of the mean heading vector: 0 when all ships fly the same way.
function headingSpread(ships) {
  let sumX = 0;
  let sumY = 0;
  for (const ship of ships) {
    sumX += Math.cos(ship.heading);
    sumY += Math.sin(ship.heading);
  }
  return 1 - Math.hypot(sumX, sumY) / ships.length;
}

function centroidDistance(swarm, x, y) {
  const { x: centroidX, y: centroidY } = swarm.centroid;
  return Math.hypot(centroidX - x, centroidY - y);
}

// The stated controllability bound: the centroid stays within one home radius plus this of a still point.
const CENTROID_MARGIN = 0.3;

test('a flock around a still point keeps its centroid within the bound, never stops, and keeps changing shape', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  hold(swarm, 5, 8, 4.5);
  const bound = homeRadiusFor(INITIAL_SWARM_SHIPS) + CENTROID_MARGIN;
  let farthestCentroid = 0;
  let slowest = Infinity;
  const ratios = [];
  const spreads = [];
  let step = 0;
  hold(swarm, 30, 8, 4.5, () => {
    farthestCentroid = Math.max(farthestCentroid, centroidDistance(swarm, 8, 4.5));
    for (const slot of swarm.slots) if (slot.alive) slowest = Math.min(slowest, Math.hypot(slot.velocityX, slot.velocityY));
    step += 1;
    if (step % 15 === 0) {
      ratios.push(axisRatio(swarm.ships));
      spreads.push(headingSpread(swarm.ships));
    }
  });
  assert.ok(farthestCentroid < bound, `centroid strayed ${farthestCentroid} (bound ${bound})`);
  assert.ok(slowest >= SWARM_SPEED_FLOOR * SWARM_CRUISE_SPEED * 0.8 - 1e-9, `slowest ${slowest}`);
  // Not a disc: the shape is clearly elongated for a good share of the samples, and it changes.
  const elongated = ratios.filter((ratio) => ratio > 1.3).length / ratios.length;
  assert.ok(elongated > 0.3, `elongated in ${(elongated * 100).toFixed(0)} percent of samples`);
  assert.ok(Math.max(...ratios) - Math.min(...ratios) > 0.5, 'the shape changes over time');
  // Ships choose their own way: the headings are not one direction.
  const meanSpread = spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
  assert.ok(meanSpread > 0.2, `mean heading spread ${meanSpread}`);
  const ship = swarm.slots.find((slot) => slot.alive);
  assert.ok(Math.abs(Math.sin((ship.course - ship.heading) / 2)) < 0.5, 'heading follows the course');
  assert.equal(swarm.ships[0].heading, swarm.slots.find((slot) => slot.alive).heading);
});

test('the temperament comes from the slot alone, not the random source, and differs per slot', () => {
  const first = new PlayerSwarm({ random: () => 0.1 });
  const second = new PlayerSwarm({ random: () => 0.9 });
  first.reset(8, 4.5);
  second.reset(8, 4.5);
  const character = (slot) => [slot.cruiseSpeed, slot.maximumTurn, slot.flockHold, slot.wander, slot.leash];
  assert.deepEqual(first.slots.slice(0, 12).map(character), second.slots.slice(0, 12).map(character));
  assert.equal(new Set(first.slots.slice(0, 12).map((slot) => slot.cruiseSpeed)).size, 12);
  assert.deepEqual(temperamentFor(5), temperamentFor(5));
  assert.ok(slotHash(3, 1) >= 0 && slotHash(3, 1) < 1);
  assert.notEqual(slotHash(3, 1), slotHash(4, 1));
});

test('the flock catches up after the point jumps', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  hold(swarm, 3, 8, 4.5);
  hold(swarm, 3, 11, 6);
  assert.ok(centroidDistance(swarm, 11, 6) < homeRadiusFor(INITIAL_SWARM_SHIPS) + CENTROID_MARGIN, `centroid ${centroidDistance(swarm, 11, 6)} away`);
});

test('a point moving at the player speed is chased by a flock that keeps up, then settles', () => {
  const bounds = { minX: 0, maxX: 16, minY: 0, maxY: 9, width: 16, height: 9 };
  const swarm = new PlayerSwarm({ random: sequenceRandom(), bounds });
  swarm.reset(2, 4.5);
  hold(swarm, 2, 2, 4.5);
  let x = 2;
  let farthestCentroid = 0;
  for (let step = 0; step < 120; step += 1) {
    x += 6 * STEP;
    swarm.update(STEP, x, 4.5);
    farthestCentroid = Math.max(farthestCentroid, centroidDistance(swarm, x, 4.5));
  }
  assert.ok(farthestCentroid < 1.5, `the centroid fell ${farthestCentroid} behind`);
  hold(swarm, 3, x, 4.5);
  assert.ok(centroidDistance(swarm, x, 4.5) < homeRadiusFor(INITIAL_SWARM_SHIPS) + CENTROID_MARGIN);
  hold(swarm, 5, 16, 9);
  for (const ship of swarm.ships) assert.ok(ship.x <= 16 && ship.y <= 9);
  for (const slot of swarm.slots.filter((entry) => entry.alive)) assert.ok(Math.hypot(slot.velocityX, slot.velocityY) <= SWARM_MAXIMUM_SPEED + 1e-9);
});

test('a full swarm stays within its bound and does not collapse into a blob', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, MAXIMUM_SWARM_SHIPS);
  hold(swarm, 5, 8, 4.5);
  let farthestCentroid = 0;
  hold(swarm, 10, 8, 4.5, () => { farthestCentroid = Math.max(farthestCentroid, centroidDistance(swarm, 8, 4.5)); });
  assert.ok(farthestCentroid < homeRadiusFor(MAXIMUM_SWARM_SHIPS) + CENTROID_MARGIN, `centroid strayed ${farthestCentroid}`);
  const ships = swarm.ships;
  let nearestSum = 0;
  for (const ship of ships) {
    let nearest = Infinity;
    for (const other of ships) if (other !== ship) nearest = Math.min(nearest, Math.hypot(ship.x - other.x, ship.y - other.y));
    nearestSum += nearest;
  }
  assert.ok(nearestSum / ships.length > 0.03, `mean nearest neighbour ${nearestSum / ships.length}`);
});

test('firing makes attack runs: more ships fly within the fire cone of the aim', () => {
  const coneShare = (controls) => {
    const swarm = new PlayerSwarm({ random: sequenceRandom() });
    swarm.reset(8, 4.5, 64);
    hold(swarm, 3, 8, 4.5, () => {}, controls);
    let inside = 0;
    let samples = 0;
    hold(swarm, 10, 8, 4.5, () => {
      for (const ship of swarm.ships) {
        samples += 1;
        if (Math.abs(Math.atan2(Math.sin(ship.heading), Math.cos(ship.heading))) <= SWARM_FIRE_CONE_RADIANS) inside += 1;
      }
    }, controls);
    return inside / samples;
  };
  const idle = coneShare(undefined);
  const attacking = coneShare({ firing: true, aimX: 1, aimY: 0 });
  assert.ok(attacking > idle + 0.03, `cone share ${attacking} firing against ${idle} idle`);
});

test('attack phases are evenly spread over the cycle for any number of slots', () => {
  for (const count of [3, 12, 32, 256]) {
    const phases = Array.from({ length: count }, (unused, slot) => attackPhaseFor(slot)).sort((first, second) => first - second);
    let widestGap = phases[0] + 1 - phases[count - 1];
    for (let index = 1; index < count; index += 1) widestGap = Math.max(widestGap, phases[index] - phases[index - 1]);
    assert.ok(phases[0] >= 0 && phases[count - 1] < 1);
    assert.ok(widestGap < 3 / count, `${count} slots leave a gap of ${widestGap}`);
  }
  assert.equal(temperamentFor(7).attackPhase, attackPhaseFor(7));
});

test('the attack turn swings along and against the aim once per cycle, offset by the phase', () => {
  assert.ok(Math.abs(attackTurn(0, 0) - 1) < 1e-9);
  assert.ok(Math.abs(attackTurn(SWARM_ATTACK_SECONDS / 2, 0) + 1) < 1e-9);
  assert.ok(Math.abs(attackTurn(SWARM_ATTACK_SECONDS, 0) - 1) < 1e-9);
  assert.ok(Math.abs(attackTurn(SWARM_ATTACK_SECONDS / 4, 0.75) - 1) < 1e-9);
  assert.ok(Math.abs(attackTurn(1.3, 0.2) - attackTurn(1.3 + 3 * SWARM_ATTACK_SECONDS, 0.2)) < 1e-9);
});

test('attack runs are staggered: some of a small swarm faces the aim in every step', () => {
  const controls = { firing: true, aimX: 1, aimY: 0 };
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5);
  hold(swarm, 4, 8, 4.5, () => {}, controls);
  let fewest = Infinity;
  let inside = 0;
  let steps = 0;
  hold(swarm, 30, 8, 4.5, () => {
    let facing = 0;
    for (const ship of swarm.ships) {
      if (Math.abs(Math.atan2(Math.sin(ship.heading), Math.cos(ship.heading))) <= SWARM_FIRE_CONE_RADIANS) facing += 1;
    }
    fewest = Math.min(fewest, facing);
    inside += facing;
    steps += 1;
  }, controls);
  assert.ok(fewest >= 1, 'no ship faced the aim in some step');
  assert.ok(inside / steps / INITIAL_SWARM_SHIPS > 0.3, `mean share facing the aim ${inside / steps / INITIAL_SWARM_SHIPS}`);
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
