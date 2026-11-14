import test from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_SWARM_SPAWNS_PER_UPDATE, SWARM_FIRE_CONE_RADIANS, SwarmFire } from '../../src/game/swarm-fire.js';
import { aggregateShotsPerSecond, perShipInterval } from '../../src/game/swarm-fire-rate.js';
import { BASE_SHOTS_PER_SECOND, swarmShotRecipe } from '../../src/game/swarm-shots.js';

const ORIGIN = { x: 8, y: 4.5 };
const STEP = 1 / 60;
const DEGREES = Math.PI / 180;

// A small deterministic random in [0, 1) (a linear congruential generator), injected into SwarmFire.
function seededRandom(seed = 12345) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// count ships on a row, each pointing at the given heading (radians).
function shipsHeading(count, headingFor = () => 0) {
  return Array.from({ length: count }, (_, index) => ({ slot: index, x: 8 + index * 0.01, y: 4.5 - index * 0.01, heading: headingFor(index) }));
}

const NO_FIRE = { spawns: [], turretSpawns: [], beam: null, expired: false };
const AIM_RIGHT = { firing: true, aimX: 1, aimY: 0, deltaSeconds: STEP, kind: 'base', tier: 1 };

// Runs distribute for seconds at the fixed step; returns the spawns of each update.
function fireFor(fire, ships, seconds, control = AIM_RIGHT) {
  const perUpdate = [];
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) perUpdate.push(fire.distribute(NO_FIRE, ships, ORIGIN, ORIGIN, control).spawns);
  return perUpdate;
}

function total(perUpdate) {
  return perUpdate.reduce((sum, spawns) => sum + spawns.length, 0);
}

test('the rate law gives 65 shots per second at 12 ships and about 3.4 times that at 256', () => {
  assert.equal(aggregateShotsPerSecond(BASE_SHOTS_PER_SECOND, 0.4, 12), 65);
  const at256 = aggregateShotsPerSecond(BASE_SHOTS_PER_SECOND, 0.4, 256);
  assert.ok(Math.abs(at256 / 65 - (256 / 12) ** 0.4) < 1e-12);
  assert.ok(at256 > 215 && at256 < 225, `${at256}`);
  assert.ok(Math.abs(perShipInterval(65, 0.4, 12) - 12 / 65) < 1e-12);
  assert.ok(aggregateShotsPerSecond(65, 0.4, 6) < 65, 'fewer ships fire less in total');
});

test('an exponent of 0 gives the same aggregate at any ship count, and nothing for no ships', () => {
  for (const count of [1, 12, 64, 256]) assert.equal(aggregateShotsPerSecond(5, 0, count), 5);
  assert.equal(aggregateShotsPerSecond(5, 0, 0), 0);
  assert.equal(perShipInterval(5, 0, 0), Infinity);
  assert.equal(perShipInterval(5, 0, 10), 2);
});

test('recipes: scatter pellets 1, 2, 3, the beam has none, tiers clamp', () => {
  assert.deepEqual([1, 2, 3].map((tier) => swarmShotRecipe('scatter', tier).pelletCount), [1, 2, 3]);
  assert.equal(swarmShotRecipe('beam', 1), null);
  assert.equal(swarmShotRecipe('rail', 1), null);
  assert.equal(swarmShotRecipe('pulse', 9).baseShotsPerSecond, 6.7);
  assert.deepEqual([1, 2, 3].map((tier) => swarmShotRecipe('sidewinders', tier).extra), [5, 7, 9]);
  assert.equal(swarmShotRecipe('base', 1).radius, 0.1);
  assert.equal(swarmShotRecipe('base', 1).lifetime, 2);
  assert.equal(swarmShotRecipe('scatter', 1).baseShotsPerSecond, 1.6 * 65);
});

test('each base shot is one ball from the ship along its heading within the jitter', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const heading = 0.3;
  const ships = shipsHeading(3, () => heading);
  const spawns = fireFor(fire, ships, 2).flat();
  assert.ok(spawns.length >= 10);
  const recipe = swarmShotRecipe('base', 1);
  for (const spawn of spawns) {
    assert.ok(Math.abs(Math.atan2(spawn.velocityY, spawn.velocityX) - heading) <= 2 * DEGREES + 1e-9);
    assert.ok(Math.abs(Math.hypot(spawn.velocityX, spawn.velocityY) - recipe.speed) < 1e-9);
    assert.equal(spawn.radius, 0.1);
    assert.equal(spawn.lifetime, 2);
    assert.equal(spawn.kind, recipe.kind);
    assert.ok(ships.some((ship) => ship.x === spawn.x && ship.y === spawn.y), 'at a ship position');
  }
});

test('scatter tiers fire 1, 2 and 3 pellets per ship shot in a tight fan', () => {
  for (const tier of [1, 2, 3]) {
    const fire = new SwarmFire({ random: seededRandom(tier) });
    const ships = shipsHeading(1);
    const perUpdate = fireFor(fire, ships, 3, { ...AIM_RIGHT, kind: 'scatter', tier });
    const bursts = perUpdate.filter((spawns) => spawns.length > 0);
    assert.ok(bursts.length > 0);
    for (const spawns of bursts) {
      assert.equal(spawns.length, tier);
      const angles = spawns.map((spawn) => Math.atan2(spawn.velocityY, spawn.velocityX));
      assert.ok(Math.max(...angles) - Math.min(...angles) <= 0.25 + 1e-9);
      assert.equal(spawns[0].radius, 0.07);
      assert.equal(spawns[0].lifetime, 1.2);
      const centre = angles.reduce((sum, angle) => sum + angle, 0) / angles.length;
      assert.ok(Math.abs(centre) <= [10, 16, 22][tier - 1] * DEGREES + 1e-9);
    }
  }
});

test('a ten second run fires the law\'s aggregate at 12 and at 256 ships', () => {
  for (const count of [12, 256]) {
    const fire = new SwarmFire({ random: seededRandom(count) });
    const perUpdate = fireFor(fire, shipsHeading(count), 10);
    const expected = aggregateShotsPerSecond(BASE_SHOTS_PER_SECOND, 0.4, count) * 10;
    const measured = total(perUpdate);
    assert.ok(Math.abs(measured / expected - 1) < 0.05, `${count} ships: ${measured} against ${expected}`);
    assert.ok(perUpdate.every((spawns) => spawns.length <= MAXIMUM_SWARM_SPAWNS_PER_UPDATE));
  }
});

test('the 256-ship drizzle spreads over many ships', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const shooters = new Set(fireFor(fire, shipsHeading(256), 5).flat().map((spawn) => spawn.x));
  assert.ok(shooters.size > 100, `${shooters.size} distinct shooters`);
});

test('pulse aggregate is the same at 12 and 256 ships and rotates across ships', () => {
  const counts = [12, 256].map((count) => {
    const fire = new SwarmFire({ random: seededRandom() });
    const spawns = fireFor(fire, shipsHeading(count), 10, { ...AIM_RIGHT, kind: 'pulse', tier: 2 }).flat();
    return { count, spawns, shooters: new Set(spawns.map((spawn) => spawn.x)) };
  });
  for (const { count, spawns, shooters } of counts) {
    assert.ok(Math.abs(spawns.length / 50 - 1) < 0.2, `${count} ships fired ${spawns.length} orbs in 10 s, law 50`);
    assert.ok(shooters.size >= Math.min(count, spawns.length) * 0.8, `${shooters.size} shooters`);
  }
  assert.equal(counts[0].spawns[0].extra, 40);
});

test('sidewinder tiers raise the aggregate and the homing', () => {
  const rates = [1, 2, 3].map((tier) => {
    const fire = new SwarmFire({ random: seededRandom() });
    const spawns = fireFor(fire, shipsHeading(24), 5, { ...AIM_RIGHT, kind: 'sidewinders', tier }).flat();
    assert.equal(spawns[0].extra, [5, 7, 9][tier - 1]);
    return spawns.length / 5;
  });
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2], rates.join(', '));
  assert.ok(Math.abs(rates[2] / 24 - 1) < 0.1);
});

test('no ship outside the aim cone fires, and nothing fires without the trigger or for the beam', () => {
  const outside = shipsHeading(8, (index) => SWARM_FIRE_CONE_RADIANS + 0.05 + index * 0.3);
  assert.equal(total(fireFor(new SwarmFire({ random: seededRandom() }), outside, 2)), 0);
  const inside = shipsHeading(4, () => SWARM_FIRE_CONE_RADIANS - 0.01);
  assert.equal(total(fireFor(new SwarmFire({ random: seededRandom() }), inside, 1, { ...AIM_RIGHT, firing: false })), 0);
  assert.equal(total(fireFor(new SwarmFire({ random: seededRandom() }), inside, 1, { ...AIM_RIGHT, kind: 'beam' })), 0);
  assert.ok(total(fireFor(new SwarmFire({ random: seededRandom() }), inside, 1)) > 0);
});

test('a ship that turns into the cone fires at once, and the first shots are phased over the interval', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const perUpdate = fireFor(fire, shipsHeading(12), 0.18);
  const firingFrames = perUpdate.filter((spawns) => spawns.length > 0).length;
  assert.ok(firingFrames >= 4, `${firingFrames} frames with shots in the first interval`);
});

test('turret volleys fire once from one rotating ship, at full size; the beam leaves the centroid', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const ships = shipsHeading(4);
  const turret = { x: 8, y: 4.5, velocityX: -40, velocityY: 0, radius: 0.05, lifetime: 0.6, kind: 2, seed: 0.5, extra: 0 };
  const beam = { x: 8, y: 4.5, directionX: 1, directionY: 0, halfWidth: 0.12 };
  const control = { ...AIM_RIGHT, firing: false };
  const volley = { spawns: [], turretSpawns: [turret, turret], beam, expired: false };
  const result = fire.distribute(volley, ships, ORIGIN, { x: 9, y: 5 }, control);
  assert.equal(result.spawns.length, 0);
  assert.deepEqual(result.turretSpawns.map((spawn) => [spawn.x, spawn.radius, spawn.velocityX]), [[8, 0.05, -40], [8, 0.05, -40]]);
  assert.deepEqual([result.beam.x, result.beam.y, result.beam.halfWidth], [9, 5, 0.12]);
  const next = fire.distribute({ ...NO_FIRE, turretSpawns: [turret] }, ships, ORIGIN, ORIGIN, control);
  assert.equal(next.turretSpawns[0].x, 8.01);
});

test('no ships fire nothing, and reset restarts the rotation and the cooldowns', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const beam = { x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 };
  const empty = fire.distribute({ ...NO_FIRE, beam }, [], ORIGIN, ORIGIN, AIM_RIGHT);
  assert.deepEqual(empty, { spawns: [], turretSpawns: [], beam: null });
  fireFor(fire, shipsHeading(12), 1);
  fire.reset();
  assert.equal(fire.rotation, 0);
  assert.ok(fire.cooldowns.every((cooldown) => cooldown === 0));
  assert.ok(fire.scheduled.every((flag) => flag === 0));
});

test('fire held through a weapon change follows the new weapon\'s law at once: no burst arming pulse, no silence after it', () => {
  const fire = new SwarmFire({ random: seededRandom() });
  const ships = shipsHeading(60);
  fireFor(fire, ships, 2);
  const pulse = fireFor(fire, ships, 10, { ...AIM_RIGHT, kind: 'pulse', tier: 1 });
  const largestPulseUpdate = Math.max(...pulse.map((spawns) => spawns.length));
  assert.ok(largestPulseUpdate <= 2, `${largestPulseUpdate} orbs in one update as pulse arms`);
  assert.ok(Math.abs(total(pulse) / 33 - 1) < 0.2, `${total(pulse)} orbs in 10 s, law 33`);
  const base = fireFor(fire, ships, 0.5);
  const expected = aggregateShotsPerSecond(BASE_SHOTS_PER_SECOND, 0.4, 60) * 0.5;
  assert.ok(Math.abs(total(base) / expected - 1) < 0.15, `${total(base)} base shots in the half second after pulse, law ${expected}`);
});
