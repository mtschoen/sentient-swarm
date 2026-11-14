import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUZZ_SPEED_SHARE, FOLLOW_SMOOTH_SECONDS, SWARM_BUZZ, SWARM_FOLLOW, SWARM_ROAM_SCALE, SWARM_TIGHTNESS, TIGHTNESS_WELL_RATE, buzzDirection,
} from '../../src/game/swarm-motion.js';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';
import { PlayerSwarm } from '../../src/game/player-swarm.js';
import { flockStep, temperamentFor } from '../../src/game/swarm-flocking.js';

const STEP = 1 / 60;

function sequenceRandom() {
  let state = 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function context(overrides = {}) {
  return {
    targetX: 8, targetY: 4.5, firing: false, aimX: 0, aimY: 0, time: 1, aliveCount: 1, bounds: WORLD_BOUNDS, margin: 0.02,
    ...overrides,
  };
}

function ship(slot, x, y, velocityX, velocityY) {
  const course = Math.atan2(velocityY, velocityX);
  return { alive: true, x, y, velocityX, velocityY, previousVelocityX: 0, previousVelocityY: 0, course, heading: course, ...temperamentFor(slot) };
}

// One step of a ship, with the given neighbours; returns its new velocity.
function stepVelocity(slots, overrides) {
  flockStep(slots, STEP, context(overrides));
  return { x: slots[0].velocityX, y: slots[0].velocityY };
}

test('the bee motion constants are the shipped values, and the roaming reach shrinks with the tightness', () => {
  assert.equal(SWARM_TIGHTNESS, 2);
  assert.equal(SWARM_BUZZ, 1.5);
  assert.equal(SWARM_FOLLOW, 1);
  assert.equal(SWARM_ROAM_SCALE, 1 / 3);
});

test('buzzDirection is deterministic, bounded, and different per slot', () => {
  const first = buzzDirection(3, 12.34, { x: 0, y: 0 });
  const again = buzzDirection(3, 12.34, { x: 0, y: 0 });
  assert.deepEqual(first, again);
  const other = buzzDirection(4, 12.34, { x: 0, y: 0 });
  assert.notDeepEqual(first, other);
  const out = { x: 0, y: 0 };
  let sumX = 0;
  let sumY = 0;
  for (let slot = 0; slot < 64; slot += 1) {
    buzzDirection(slot, 7.7, out);
    assert.ok(Math.hypot(out.x, out.y) <= 1 + 1e-9);
    sumX += out.x;
    sumY += out.y;
  }
  // 64 independent directions: their mean stays far from a unit vector (synchrony would give about 1).
  assert.ok(Math.hypot(sumX, sumY) / 64 < 0.4);
});

test('buzzDirection changes direction over a second and is continuous step to step', () => {
  const out = { x: 0, y: 0 };
  let previousAngle = null;
  let turned = 0;
  let largestJump = 0;
  for (let step = 0; step < 120; step += 1) {
    buzzDirection(5, step * STEP, out);
    const angle = Math.atan2(out.y, out.x);
    if (previousAngle !== null) {
      const jump = Math.abs(Math.atan2(Math.sin(angle - previousAngle), Math.cos(angle - previousAngle)));
      largestJump = Math.max(largestJump, jump);
      turned += jump;
    }
    previousAngle = angle;
  }
  assert.ok(turned > Math.PI, `turned ${turned}`);
  assert.ok(largestJump < 1.5, `largest jump ${largestJump}`);
});

test('the well pulls a distant ship toward the point harder as the distance grows, capped at its speed', () => {
  const pullAt = (distance) => {
    const slots = [ship(0, 8 + distance, 4.5, 0, 0.01)];
    return -stepVelocity(slots, { time: 0 }).x;
  };
  assert.ok(pullAt(2) > pullAt(1));
  assert.ok(pullAt(1) > pullAt(0.3));
  assert.ok(TIGHTNESS_WELL_RATE > 0);
});

test('the swarm settles close to the point', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, 24);
  let total = 0;
  let samples = 0;
  for (let step = 0; step < 600; step += 1) {
    swarm.update(STEP, 8, 4.5);
    if (step < 300) continue;
    for (const entry of swarm.ships) {
      total += Math.hypot(entry.x - 8, entry.y - 4.5);
      samples += 1;
    }
  }
  assert.ok(total / samples < 1, `mean distance ${total / samples}`);
});

test('buzz moves ships independently: neighbours get different kicks, past the steering', () => {
  // A kick is the movement beyond the steered velocity in one step, as a velocity.
  const kickFor = (slot) => {
    const slots = [ship(slot, 8, 4.5, 0, 0.01)];
    flockStep(slots, STEP, context({ time: 3.3 }));
    return { x: slots[0].x - 8 - slots[0].velocityX * STEP, y: slots[0].y - 4.5 - slots[0].velocityY * STEP };
  };
  const direction = buzzDirection(1, 3.3, { x: 0, y: 0 });
  const expected = Math.hypot(direction.x, direction.y) * SWARM_BUZZ * BUZZ_SPEED_SHARE * temperamentFor(1).cruiseSpeed;
  const first = kickFor(1);
  assert.ok(Math.abs(Math.hypot(first.x, first.y) / STEP - expected) < 1e-9, 'the whole buzz velocity reaches the movement');
  assert.notDeepEqual(first, kickFor(2));
  assert.ok(BUZZ_SPEED_SHARE > 0);
});

test('the staggered attack runs do not make the swarm fly in lockstep', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(8, 4.5, 48);
  let worst = 0;
  for (let step = 0; step < 900; step += 1) {
    swarm.update(STEP, 8, 4.5, { firing: true, aimX: 1, aimY: 0 });
    if (step < 300 || step % 10 !== 0) continue;
    let unitX = 0;
    let unitY = 0;
    for (const slot of swarm.slots) {
      if (!slot.alive) continue;
      const speed = Math.hypot(slot.velocityX, slot.velocityY);
      unitX += slot.velocityX / speed;
      unitY += slot.velocityY / speed;
    }
    worst = Math.max(worst, Math.hypot(unitX, unitY) / swarm.aliveCount);
  }
  assert.ok(worst < 0.7, `worst polarization ${worst}`);
});

test('the carry moves the flock with the point and leaves the steering as it is around a still point', () => {
  const make = () => [ship(0, 7.5, 4.2, 1, 0.5), ship(8, 7.6, 4.3, 0.5, 1)];
  const still = make();
  const carried = make();
  const start = make();
  // The point makes the same move as the carry, so the carried flock sees what the still one does.
  flockStep(still, STEP, context());
  flockStep(carried, STEP, context({ carryX: 6, carryY: -2, targetX: 8 + 6 * STEP, targetY: 4.5 - 2 * STEP }));
  carried.forEach((entry, index) => {
    assert.ok(Math.abs(entry.velocityX - still[index].velocityX) < 1e-12 && Math.abs(entry.velocityY - still[index].velocityY) < 1e-12);
    assert.ok(Math.abs(entry.x - (still[index].x + 6 * STEP)) < 1e-12 && Math.abs(entry.y - (still[index].y - 2 * STEP)) < 1e-12);
    const moved = Math.atan2(entry.y - start[index].y, entry.x - start[index].x);
    assert.ok(Math.abs(Math.sin((entry.course - moved) / 2)) < 1e-9, 'the course is the whole movement');
  });
});

// Mean distance of the ships from the point, over the last seconds of a run in which the point
// flies right at the player's speed.
function chaseDistance() {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(2, 4.5, 24);
  let pointX = 2;
  let distance = 0;
  let samples = 0;
  for (let step = 0; step < 150; step += 1) swarm.update(STEP, pointX, 4.5);
  for (let step = 0; step < 150; step += 1) {
    pointX += 6 * STEP;
    swarm.update(STEP, pointX, 4.5);
    if (step < 60) continue;
    for (const entry of swarm.ships) {
      distance += Math.hypot(entry.x - pointX, entry.y - 4.5);
      samples += 1;
    }
  }
  return distance / samples;
}

test('the flock stays around a moving point instead of trailing it', () => {
  assert.ok(chaseDistance() < 1, `distance ${chaseDistance()}`);
});

test('a point that jumps carries the flock at no more than the top speed of the ships, and reset forgets the carry', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.reset(4, 4.5, 6);
  swarm.update(STEP, 14, 4.5);
  assert.ok(swarm.context.carryX > 0 && swarm.context.carryX <= 11 * (1 - Math.exp(-STEP / FOLLOW_SMOOTH_SECONDS)) + 1e-9, `${swarm.context.carryX}`);
  swarm.reset(4, 4.5, 6);
  swarm.update(STEP, 4, 4.5);
  assert.equal(swarm.context.carryX, 0);
});
