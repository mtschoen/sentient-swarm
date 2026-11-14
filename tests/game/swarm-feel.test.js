import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEES_FEEL, BUZZ_SPEED_SHARE, FEEL_DIALS, FISH_FEEL, FOLLOW_SMOOTH_SECONDS, TIGHTNESS_WELL_RATE, buzzDirection, feelFromSearch, feelToSearch,
  feelToSearchMerged, roamScaleFor,
} from '../../src/game/swarm-feel.js';
import { FULL_ARENA_BOUNDS } from '../../src/sim/layout.js';
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

function context(feel, overrides = {}) {
  return {
    targetX: 8, targetY: 4.5, firing: false, aimX: 0, aimY: 0, time: 1, aliveCount: 1, bounds: FULL_ARENA_BOUNDS, margin: 0.02, feel,
    ...overrides,
  };
}

function ship(slot, x, y, velocityX, velocityY) {
  const course = Math.atan2(velocityY, velocityX);
  return { alive: true, x, y, velocityX, velocityY, previousVelocityX: 0, previousVelocityY: 0, course, heading: course, ...temperamentFor(slot) };
}

// One step of a ship, with the given neighbours, from the given feel; returns its new velocity.
function stepVelocity(slots, feel, overrides) {
  flockStep(slots, STEP, context(feel, overrides));
  return { x: slots[0].velocityX, y: slots[0].velocityY };
}

test('the bees default leans away from fish on every dial; fish is the behaviour before the dials', () => {
  assert.deepEqual({ ...FISH_FEEL }, { alignment: 1, tightness: 0, buzz: 0, follow: 0 });
  assert.ok(BEES_FEEL.follow > FISH_FEEL.follow);
  assert.ok(BEES_FEEL.alignment < FISH_FEEL.alignment);
  assert.ok(BEES_FEEL.tightness > FISH_FEEL.tightness);
  assert.ok(BEES_FEEL.buzz > FISH_FEEL.buzz);
});

test('feelFromSearch reads the dials, clamps them and ignores malformed values', () => {
  assert.deepEqual(feelFromSearch(''), { ...BEES_FEEL });
  assert.deepEqual(feelFromSearch('?swarmAlignment=0&swarmTightness=1.5&swarmBuzz=1&swarmFollow=0.5'), { alignment: 0, tightness: 1.5, buzz: 1, follow: 0.5 });
  assert.deepEqual(feelFromSearch('?swarmAlignment=99&swarmTightness=-3&swarmBuzz=2&swarmFollow=7'), { alignment: 2, tightness: 0, buzz: 2, follow: 1 });
  assert.deepEqual(feelFromSearch('?swarmAlignment=abc&swarmTightness=&swarmBuzz=Infinity'), { ...BEES_FEEL });
  assert.deepEqual(feelFromSearch('?swarmBuzz=0.5', FISH_FEEL), { alignment: 1, tightness: 0, buzz: 0.5, follow: 0 });
});

test('feelToSearch round trips through feelFromSearch, and the merged form keeps other parameters', () => {
  const feel = { alignment: 0.35, tightness: 2.75, buzz: 0.05, follow: 0.6 };
  assert.equal(feelToSearch(feel), '?swarmAlignment=0.35&swarmTightness=2.75&swarmBuzz=0.05&swarmFollow=0.6');
  assert.deepEqual(feelFromSearch(feelToSearch(feel)), feel);
  const merged = feelToSearchMerged('?probe=off&swarmBuzz=3&swarm=12', feel);
  assert.deepEqual(feelFromSearch(merged), feel);
  const parameters = new URLSearchParams(merged);
  assert.equal(parameters.get('probe'), 'off');
  assert.equal(parameters.get('swarm'), '12');
  for (const spec of FEEL_DIALS) assert.ok(spec.minimum < spec.maximum && spec.step > 0);
});

test('roamScaleFor is 1 at tightness 0 and shrinks as tightness grows', () => {
  assert.equal(roamScaleFor(0), 1);
  assert.ok(roamScaleFor(2) < roamScaleFor(1));
  assert.ok(roamScaleFor(4) > 0);
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

test('without a feel in the context the step is the fish step', () => {
  const make = () => [ship(0, 7.5, 4.2, 1, 0.5), ship(8, 7.6, 4.3, 0.5, 1)];
  const withoutFeel = make();
  const withFish = make();
  for (let step = 0; step < 30; step += 1) {
    flockStep(withoutFeel, STEP, { ...context(undefined), feel: undefined });
    flockStep(withFish, STEP, context(FISH_FEEL));
  }
  assert.deepEqual(withoutFeel.map((entry) => [entry.x, entry.y]), withFish.map((entry) => [entry.x, entry.y]));
});

test('alignment scales the pull toward neighbours velocity: 0 ignores it, more follows it harder', () => {
  // Ship 0 sits still-ish at the point, a same-group neighbour (slot 8) flies up close by.
  const velocityOf = (alignment) => {
    const slots = [ship(0, 8, 4.5, 0.1, 0), ship(8, 8.05, 4.5, 0, 2)];
    slots[1].previousVelocityY = 2;
    return stepVelocity(slots, { alignment, tightness: 0, buzz: 0 }).y;
  };
  const none = velocityOf(0);
  const some = velocityOf(1);
  const more = velocityOf(2);
  assert.ok(some > none, `${some} vs ${none}`);
  assert.ok(more > some, `${more} vs ${some}`);
});

test('tightness pulls a distant ship toward the point harder, growing with distance, capped at its speed', () => {
  const pullAt = (distance, tightness) => {
    const slots = [ship(0, 8 + distance, 4.5, 0, 0.01)];
    return -stepVelocity(slots, { alignment: 0, tightness, buzz: 0 }, { time: 0 }).x;
  };
  assert.ok(pullAt(1, 3) > pullAt(1, 0));
  assert.ok(pullAt(1, 3) > pullAt(1, 1));
  assert.ok(pullAt(2, 1) > pullAt(1, 1));
  assert.ok(TIGHTNESS_WELL_RATE > 0);
});

test('tightness shrinks the swarm: a tight swarm settles closer to the point than a loose one', () => {
  const radiusFor = (feel) => {
    const swarm = new PlayerSwarm({ random: sequenceRandom() });
    swarm.setFeel(feel);
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
    return total / samples;
  };
  const loose = radiusFor({ alignment: 0.1, tightness: 0, buzz: 1 });
  const tight = radiusFor({ alignment: 0.1, tightness: 3, buzz: 1 });
  assert.ok(tight < loose * 0.7, `tight ${tight} loose ${loose}`);
});

test('buzz moves ships independently: neighbours get different kicks, scaled by the dial, past the steering', () => {
  // The kick is the buzz's own movement in one step, as a velocity; the steered velocity is untouched.
  const kickFor = (slot, buzz) => {
    const slots = [ship(slot, 8, 4.5, 0, 0.01)];
    flockStep(slots, STEP, context({ alignment: 0, tightness: 0, buzz }, { time: 3.3 }));
    const calm = [ship(slot, 8, 4.5, 0, 0.01)];
    flockStep(calm, STEP, context({ alignment: 0, tightness: 0, buzz: 0 }, { time: 3.3 }));
    assert.ok(Math.abs(slots[0].velocityX - calm[0].velocityX) < 1e-12 && Math.abs(slots[0].velocityY - calm[0].velocityY) < 1e-12);
    return { x: (slots[0].x - calm[0].x) / STEP, y: (slots[0].y - calm[0].y) / STEP };
  };
  const direction = buzzDirection(1, 3.3, { x: 0, y: 0 });
  const expected = Math.hypot(direction.x, direction.y) * 2 * BUZZ_SPEED_SHARE * temperamentFor(1).cruiseSpeed;
  assert.ok(Math.abs(Math.hypot(kickFor(1, 2).x, kickFor(1, 2).y) - expected) < 1e-9, 'the whole buzz velocity reaches the movement');
  const first = kickFor(1, 2);
  const second = kickFor(2, 2);
  assert.notDeepEqual(first, second);
  assert.ok(Math.hypot(kickFor(1, 2).x, kickFor(1, 2).y) > Math.hypot(kickFor(1, 1).x, kickFor(1, 1).y));
  assert.equal(Math.hypot(kickFor(1, 0).x, kickFor(1, 0).y), 0);
  assert.ok(BUZZ_SPEED_SHARE > 0);
});

test('at alignment 0 the staggered attack runs do not make the swarm fly in lockstep', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.setFeel({ alignment: 0, tightness: 2, buzz: 1 });
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
  // The point makes the same move as the carry, so the carried flock sees what the still one does.
  flockStep(still, STEP, context(FISH_FEEL));
  flockStep(carried, STEP, context(FISH_FEEL, { carryX: 6, carryY: -2, targetX: 8 + 6 * STEP, targetY: 4.5 - 2 * STEP }));
  carried.forEach((entry, index) => {
    assert.ok(Math.abs(entry.velocityX - still[index].velocityX) < 1e-12 && Math.abs(entry.velocityY - still[index].velocityY) < 1e-12);
    assert.ok(Math.abs(entry.x - (still[index].x + 6 * STEP)) < 1e-12 && Math.abs(entry.y - (still[index].y - 2 * STEP)) < 1e-12);
    assert.ok(Math.abs(entry.course - Math.atan2(entry.velocityY - 2, entry.velocityX + 6)) < 1e-12, 'the course is the whole movement');
  });
});

// Mean distance of the ships from the point and their mean spread about their centroid, over the
// last seconds of a run in which the point flies right at the player's speed.
function chase(feel) {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.setFeel(feel);
  swarm.reset(2, 4.5, 24);
  let pointX = 2;
  let distance = 0;
  let spread = 0;
  let samples = 0;
  for (let step = 0; step < 150; step += 1) swarm.update(STEP, pointX, 4.5);
  for (let step = 0; step < 150; step += 1) {
    pointX += 6 * STEP;
    swarm.update(STEP, pointX, 4.5);
    if (step < 60) continue;
    const centroid = swarm.centroid;
    for (const entry of swarm.ships) {
      distance += Math.hypot(entry.x - pointX, entry.y - 4.5);
      spread += Math.hypot(entry.x - centroid.x, entry.y - centroid.y);
      samples += 1;
    }
  }
  return { distance: distance / samples, spread: spread / samples };
}

test('follow keeps the flock around a moving point; without it the ships trail the point in a clump', () => {
  const trailing = chase({ ...FISH_FEEL, follow: 0 });
  const following = chase({ ...FISH_FEEL, follow: 1 });
  assert.ok(trailing.distance > 1, `trailing distance ${trailing.distance}`);
  assert.ok(following.distance < trailing.distance * 0.7, `following ${following.distance} trailing ${trailing.distance}`);
  assert.ok(following.spread > trailing.spread * 1.5, `following spread ${following.spread} trailing ${trailing.spread}`);
});

test('on the move the tightness dial shows only with follow', () => {
  const ratio = (follow) => chase({ ...FISH_FEEL, tightness: 4, follow }).distance / chase({ ...FISH_FEEL, follow }).distance;
  assert.ok(ratio(0) > 0.95, `without follow ${ratio(0)}`);
  assert.ok(ratio(1) < 0.9, `with follow ${ratio(1)}`);
});

test('a point that jumps carries the flock at no more than the ships\' top speed, and reset forgets the carry', () => {
  const swarm = new PlayerSwarm({ random: sequenceRandom() });
  swarm.setFeel({ ...FISH_FEEL, follow: 1 });
  swarm.reset(4, 4.5, 6);
  swarm.update(STEP, 14, 4.5);
  assert.ok(swarm.context.carryX > 0 && swarm.context.carryX <= 11 * (1 - Math.exp(-STEP / FOLLOW_SMOOTH_SECONDS)) + 1e-9, `${swarm.context.carryX}`);
  swarm.reset(4, 4.5, 6);
  swarm.update(STEP, 4, 4.5);
  assert.equal(swarm.context.carryX, 0);
});
