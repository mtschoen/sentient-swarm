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

test('a gunner ignores cohesion: neighbours inside the cohesion radius leave its step unchanged', () => {
  const context = { targetX: 5, targetY: 5, firing: false, aimX: 0, aimY: 0, time: 0.5, aliveCount: 12, bounds: WORLD_BOUNDS, margin: 0.02 };
  const neighbour = (x) => ({ ...temperamentFor(1), alive: true, x, y: 5, velocityX: 0, velocityY: 0, course: 0, heading: 0, gunnerIndex: -1, stationX: 0, stationY: 0, stationAngle: 0 });
  const stepGunner = (others) => {
    const gunner = { ...gunnerSlot(5, 5), velocityX: 0, velocityY: 0 };
    flockStep([gunner, ...others], STEP, { ...context });
    return [gunner.velocityX, gunner.velocityY];
  };
  // Neighbours 0.6 away: outside the 0.3 separation radius, inside the 0.8 cohesion radius.
  const alone = stepGunner([]);
  const crowded = stepGunner([neighbour(5.6), neighbour(5.65), neighbour(4.4)]);
  assert.deepEqual(crowded, alone);
  // The same ship as a non-gunner is pulled by them.
  const roamer = (others) => {
    const ship = { ...gunnerSlot(5, 5, -1), velocityX: 0, velocityY: 0 };
    flockStep([ship, ...others], STEP, { ...context });
    return [ship.velocityX, ship.velocityY];
  };
  assert.notDeepEqual(roamer([neighbour(5.6), neighbour(5.65), neighbour(4.4)]), roamer([]));
});
