import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAXIMUM_SWARM_SPAWNS_PER_UPDATE, SWARM_FIRE_CONE_RADIANS, SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL, SWARM_PROJECTILE_RADIUS_SCALE,
  SWARM_VOLLEY_BURST, SwarmFire,
} from '../../src/game/swarm-fire.js';
import { WeaponState } from '../../src/game/weapons.js';

const ORIGIN = { x: 8, y: 4.5 };
const STEP = 1 / 60;
const INTERVAL = 0.12;

// count ships on a row, each flying at the given heading (radians).
function shipsHeading(count, headingFor = () => 0) {
  return Array.from({ length: count }, (_, index) => ({ slot: index, x: 8 + index * 0.01, y: 4.5 - index * 0.01, heading: headingFor(index) }));
}

function volley(spawns, turretSpawns = [], beam = null) {
  return { spawns, turretSpawns, beam, expired: false };
}

// One base-gun volley along +x from the origin: three balls in a fan.
function baseVolley() {
  const weapons = new WeaponState({ random: () => 0.5 });
  return weapons.update(INTERVAL, { firing: true, aimX: 1, aimY: 0, x: ORIGIN.x, y: ORIGIN.y });
}

const AIM_RIGHT = { firing: true, aimX: 1, aimY: 0, fireInterval: INTERVAL, deltaSeconds: STEP, kind: 'base' };

// Runs distribute for seconds with a fresh template every frame.
function fireFor(fire, ships, seconds, control = AIM_RIGHT) {
  const template = baseVolley();
  const perUpdate = [];
  const steps = Math.round(seconds / STEP);
  for (let step = 0; step < steps; step += 1) perUpdate.push(fire.distribute(template, ships, ORIGIN, ORIGIN, control).spawns);
  return perUpdate;
}

test('each shot leaves its ship along that ship\'s heading, small', () => {
  const fire = new SwarmFire();
  const heading = 0.3;
  const ships = shipsHeading(1, () => heading);
  const spawns = fireFor(fire, ships, 1).flat();
  assert.ok(spawns.length >= 3);
  const template = baseVolley().spawns;
  const middle = spawns[1];
  // The middle ball of the fan flies exactly along the heading; all start at the ship.
  assert.ok(Math.abs(Math.atan2(middle.velocityY, middle.velocityX) - heading) < 1e-9);
  assert.ok(Math.abs(Math.hypot(middle.velocityX, middle.velocityY) - Math.hypot(template[1].velocityX, template[1].velocityY)) < 1e-9);
  for (const spawn of spawns) {
    assert.ok(Math.hypot(spawn.x - ships[0].x, spawn.y - ships[0].y) < 1e-9);
    assert.equal(spawn.radius, template[0].radius * SWARM_PROJECTILE_RADIUS_SCALE);
  }
  assert.equal(SWARM_PROJECTILE_RADIUS_SCALE, 0.25);
});

test('no ship outside the aim cone fires, and nothing fires without the trigger or a template', () => {
  const fire = new SwarmFire();
  const outside = shipsHeading(8, (index) => SWARM_FIRE_CONE_RADIANS + 0.05 + index * 0.3);
  assert.equal(fireFor(fire, outside, 2).flat().length, 0);
  const inside = shipsHeading(4, () => SWARM_FIRE_CONE_RADIANS - 0.01);
  assert.equal(fireFor(new SwarmFire(), inside, 1, { ...AIM_RIGHT, firing: false }).flat().length, 0);
  assert.equal(new SwarmFire().distribute(volley([]), inside, ORIGIN, ORIGIN, AIM_RIGHT).spawns.length, 0, 'no volley seen yet');
  assert.ok(fireFor(new SwarmFire(), inside, 1).flat().length > 0);
});

test('each ship waits its own cooldown, so shots are staggered', () => {
  const fire = new SwarmFire();
  const ships = shipsHeading(1);
  const perUpdate = fireFor(fire, ships, 2);
  const firingFrames = perUpdate.map((spawns, frame) => (spawns.length > 0 ? frame : -1)).filter((frame) => frame >= 0);
  const gaps = firingFrames.slice(1).map((frame, index) => (frame - firingFrames[index]) * STEP);
  assert.ok(gaps.length >= 10);
  assert.ok(gaps.every((gap) => gap >= INTERVAL * 0.8 - STEP), `gaps ${gaps.join(', ')}`);
});

test('a 256-ship swarm all inside the cone is held to the global budget and the per-update cap', () => {
  const fire = new SwarmFire();
  const ships = shipsHeading(256);
  const seconds = 5;
  const perUpdate = fireFor(fire, ships, seconds);
  const volleys = perUpdate.reduce((sum, spawns) => sum + spawns.length, 0) / 3;
  const allowed = (SWARM_MAXIMUM_VOLLEYS_PER_INTERVAL * seconds) / INTERVAL + SWARM_VOLLEY_BURST;
  assert.ok(volleys <= allowed, `${volleys} volleys against ${allowed}`);
  assert.ok(volleys > allowed * 0.8, 'the budget is used');
  assert.ok(perUpdate.every((spawns) => spawns.length <= (SWARM_VOLLEY_BURST + 2) * 3 && spawns.length <= MAXIMUM_SWARM_SPAWNS_PER_UPDATE));
  // Rotation spreads the shots over the ships.
  const shooters = new Set(perUpdate.flat().map((spawn) => Math.round((spawn.x - 8) * 100)));
  assert.ok(shooters.size > 100, `${shooters.size} distinct shooters`);
});

test('a new weapon kind waits for its own first volley', () => {
  const fire = new SwarmFire();
  const ships = shipsHeading(2);
  fireFor(fire, ships, 0.5);
  const switched = fire.distribute(volley([]), ships, ORIGIN, ORIGIN, { ...AIM_RIGHT, kind: 'scatter', fireInterval: 0.2 });
  assert.equal(switched.spawns.length, 0);
});

test('turret volleys fire once from one rotating ship, at full size; the beam leaves the centroid', () => {
  const fire = new SwarmFire();
  const ships = shipsHeading(4);
  const turret = { x: 8, y: 4.5, velocityX: -40, velocityY: 0, radius: 0.05, lifetime: 0.6, kind: 2, seed: 0.5, extra: 0 };
  const beam = { x: 8, y: 4.5, directionX: 1, directionY: 0, halfWidth: 0.12 };
  const control = { ...AIM_RIGHT, firing: false };
  const result = fire.distribute(volley([], [turret, turret], beam), ships, ORIGIN, { x: 9, y: 5 }, control);
  assert.equal(result.spawns.length, 0);
  assert.deepEqual(result.turretSpawns.map((spawn) => [spawn.x, spawn.radius, spawn.velocityX]), [[8, 0.05, -40], [8, 0.05, -40]]);
  assert.deepEqual([result.beam.x, result.beam.y, result.beam.halfWidth], [9, 5, 0.12]);
  const next = fire.distribute(volley([], [turret]), ships, ORIGIN, ORIGIN, control);
  assert.equal(next.turretSpawns[0].x, 8.01);
});

test('no ships fire nothing, and reset restarts the rotation and the budget', () => {
  const fire = new SwarmFire();
  const empty = fire.distribute(volley([], [], { x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 }), [], ORIGIN, ORIGIN, AIM_RIGHT);
  assert.deepEqual(empty, { spawns: [], turretSpawns: [], beam: null });
  fireFor(fire, shipsHeading(12), 1);
  fire.reset();
  assert.deepEqual([fire.rotation, fire.tokens, fire.template], [0, 0, null]);
});
