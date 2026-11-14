import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerSwarm } from '../../src/game/player-swarm.js';
import {
  SWARM_FACING_CONE_SHARE, SWARM_FACING_LIMIT_RADIANS, SWARM_FACING_TURN_RADIANS_PER_SECOND, faceStep, facingFor, turnHeadingToward,
  wrapAngle,
} from '../../src/game/swarm-facing.js';
import { SWARM_FIRE_CONE_RADIANS } from '../../src/game/swarm-fire.js';

const STEP = 1 / 60;
const DEGREE = Math.PI / 180;

function close(actual, expected, message) {
  assert.ok(Math.abs(wrapAngle(actual - expected)) < 1e-9, message ?? `${actual} against ${expected}`);
}

// A deterministic sequence in [0, 1) for the spawn offsets, so tests never use Math.random.
function sequenceRandom() {
  let state = 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

test('wrapAngle folds any angle into (-PI, PI]', () => {
  close(wrapAngle(3 * Math.PI), Math.PI);
  assert.equal(wrapAngle(-Math.PI), Math.PI);
  assert.ok(Math.abs(wrapAngle(2 * Math.PI + 0.25) - 0.25) < 1e-9);
  assert.ok(Math.abs(wrapAngle(-0.25 - 4 * Math.PI) + 0.25) < 1e-9);
});

test('a course within the limit of the aim points inside the fire cone, further out the further off it flies', () => {
  const aim = 0.4;
  const spread = SWARM_FIRE_CONE_RADIANS * SWARM_FACING_CONE_SHARE;
  close(facingFor(aim, aim), aim, 'flying along the aim points along it');
  let previous = 0;
  for (const offCourse of [20, 60, 90, 120, 150].map((degrees) => degrees * DEGREE)) {
    for (const side of [1, -1]) {
      const facing = wrapAngle(facingFor(aim + side * offCourse, aim) - aim);
      assert.ok(Math.abs(facing) < SWARM_FIRE_CONE_RADIANS, `${offCourse} off course points ${facing} off the aim`);
      assert.equal(Math.sign(facing), side, 'on the course\'s side of the aim');
      assert.ok(Math.abs(wrapAngle(aim + facing - (aim + side * offCourse))) <= SWARM_FACING_LIMIT_RADIANS + 1e-9, 'within the limit of the course');
      if (side === 1) {
        assert.ok(facing > previous, 'further out for a course further off');
        previous = facing;
      }
    }
  }
  close(facingFor(aim + SWARM_FACING_LIMIT_RADIANS + spread, aim), aim + spread, 'the last course that fires points at the edge of the spread');
});

test('the shipped limit lets a ship flying straight away from the aim point inside the fire cone', () => {
  for (const course of [Math.PI, Math.PI - 1 * DEGREE, -Math.PI + 1 * DEGREE]) {
    const facing = facingFor(course, 0);
    assert.ok(Math.abs(wrapAngle(facing)) <= SWARM_FIRE_CONE_RADIANS + 1e-9, `course ${course} points ${facing}`);
    assert.ok(Math.abs(wrapAngle(facing - course)) <= SWARM_FACING_LIMIT_RADIANS + 1e-9);
  }
});

test('with a lower limit a course beyond it points the full limit toward the aim and stays outside the cone', () => {
  const limit = 90 * DEGREE;
  const course = Math.PI - 5 * DEGREE;
  const facing = facingFor(course, 0, limit);
  close(facing, course - limit);
  assert.ok(Math.abs(wrapAngle(facing)) > SWARM_FIRE_CONE_RADIANS);
  close(facingFor(-course, 0, limit), -course + limit, 'mirrored on the other side');
  close(facingFor(1.2, 0.5, 0), 1.2, 'a zero limit keeps a course outside the cone on its course');
});

test('the heading turns toward its target by the shorter way, at most one step', () => {
  assert.equal(turnHeadingToward(0.1, 0.3, 0.5), 0.3);
  assert.ok(Math.abs(turnHeadingToward(0.1, 1.3, 0.5) - 0.6) < 1e-9);
  assert.ok(Math.abs(turnHeadingToward(0.1, -1.3, 0.5) + 0.4) < 1e-9);
  // From 170 degrees to -170 degrees the shorter way is on through 180.
  close(turnHeadingToward(170 * DEGREE, -170 * DEGREE, 5 * DEGREE), 175 * DEGREE);
});

test('faceStep turns alive ships toward the aim while firing and back to the course otherwise', () => {
  const ship = { alive: true, course: Math.PI / 2, heading: Math.PI / 2 };
  const dead = { alive: false, course: 1, heading: 2 };
  const controls = { firing: true, aimX: 1, aimY: 0 };
  faceStep([ship, dead], STEP, controls);
  close(ship.heading, Math.PI / 2 - SWARM_FACING_TURN_RADIANS_PER_SECOND * STEP, 'one step of the turn rate toward the aim');
  assert.equal(dead.heading, 2);
  for (let step = 0; step < 120; step += 1) faceStep([ship], STEP, controls);
  close(ship.heading, facingFor(Math.PI / 2, 0));
  assert.ok(Math.abs(wrapAngle(ship.heading)) < SWARM_FIRE_CONE_RADIANS, 'a ship flying across the aim ends inside the fire cone');
  faceStep([ship], STEP, { firing: true, aimX: 0, aimY: 0 });
  assert.ok(Math.abs(wrapAngle(ship.heading - ship.course)) < Math.abs(wrapAngle(facingFor(Math.PI / 2, 0) - ship.course)), 'no aim turns back to the course');
  for (let step = 0; step < 120; step += 1) faceStep([ship], STEP, { firing: false, aimX: 1, aimY: 0 });
  close(ship.heading, ship.course);
});

test('a swarm chasing a point that flees straight from the aim keeps ships facing the aim in every step', () => {
  // The point runs left at the player speed while the aim stays right: every course is about
  // opposite the aim.
  const bounds = { minX: -200, maxX: 200, minY: -200, maxY: 200, width: 400, height: 400 };
  const controls = { firing: true, aimX: 1, aimY: 0 };
  const swarm = new PlayerSwarm({ random: sequenceRandom(), bounds });
  swarm.reset(0, 0);
  let x = 0;
  let fewest = Infinity;
  let facing = 0;
  let fleeing = 0;
  let samples = 0;
  for (let step = 0; step < 60 * 12; step += 1) {
    x -= 6 * STEP;
    swarm.update(STEP, x, 0, controls);
    if (step < 60 * 2) continue;
    let inside = 0;
    for (const ship of swarm.ships) if (Math.abs(wrapAngle(ship.heading)) <= SWARM_FIRE_CONE_RADIANS) inside += 1;
    for (const slot of swarm.slots) if (slot.alive && Math.abs(wrapAngle(slot.course)) > Math.PI / 2) fleeing += 1;
    fewest = Math.min(fewest, inside);
    facing += inside;
    samples += swarm.aliveCount;
  }
  assert.ok(fleeing / samples > 0.9, `share of ships flying away from the aim ${fleeing / samples}`);
  assert.ok(fewest >= 1, 'no ship faced the aim in some step');
  assert.ok(facing / samples > 0.9, `mean share facing the aim ${facing / samples}`);
});
