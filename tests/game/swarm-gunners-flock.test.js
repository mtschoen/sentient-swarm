import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';
import { flockStep, temperamentFor } from '../../src/game/swarm-flocking.js';

const STEP = 1 / 60;

// The station is 0.6 from the point, the real station radius for 12 ships (0.8 of the 0.75 home radius).
function gunnerSlot(stationX, stationY, gunnerIndex = 0) {
  return {
    ...temperamentFor(0), alive: true, x: 5, y: 5, velocityX: 2, velocityY: 0, course: 0, heading: 0,
    gunnerIndex, stationX, stationY, stationAngle: 0,
  };
}

// Runs one slot for steps steps and returns the positions of the last tail steps.
function run(slot, { steps, tail, firing = false, aimX = 0, aimY = 0 }) {
  const context = { targetX: 5, targetY: 5, firing, aimX, aimY, time: 0, aliveCount: 12, bounds: WORLD_BOUNDS, margin: 0.02 };
  const positions = [];
  for (let step = 0; step < steps; step += 1) {
    context.time += STEP;
    flockStep([slot], STEP, context);
    if (step >= steps - tail) positions.push({ x: slot.x, y: slot.y });
  }
  return positions;
}

function meanDistance(positions, x, y) {
  return positions.reduce((sum, position) => sum + Math.hypot(position.x - x, position.y - y), 0) / positions.length;
}

test('a gunner settles within 0.2 of its station', () => {
  const positions = run(gunnerSlot(5.6, 5), { steps: 240, tail: 60 });
  assert.ok(meanDistance(positions, 5.6, 5) < 0.2, String(meanDistance(positions, 5.6, 5)));
});

test('a gunner holds its station while the attack bias would pull it', () => {
  const positions = run(gunnerSlot(5.6, 5), { steps: 240, tail: 60, firing: true, aimX: 1 });
  assert.ok(meanDistance(positions, 5.6, 5) < 0.25, String(meanDistance(positions, 5.6, 5)));
});

test('the same ship as a non-gunner roams', () => {
  const positions = run(gunnerSlot(5.6, 5, -1), { steps: 240, tail: 60 });
  assert.ok(meanDistance(positions, 5.6, 5) > 0.2, String(meanDistance(positions, 5.6, 5)));
});

test("a gunner's wander and buzz are scaled", () => {
  const slot = gunnerSlot(5.6, 5);
  run(slot, { steps: 240, tail: 0 });
  const positions = run(slot, { steps: 120, tail: 120 });
  const meanX = positions.reduce((sum, position) => sum + position.x, 0) / positions.length;
  const meanY = positions.reduce((sum, position) => sum + position.y, 0) / positions.length;
  const variance = positions.reduce((sum, position) => sum + (position.x - meanX) ** 2 + (position.y - meanY) ** 2, 0) / positions.length;
  assert.ok(Math.sqrt(variance) < 0.12, String(Math.sqrt(variance)));
});
