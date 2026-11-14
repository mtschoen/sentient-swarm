import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnDirector, inAimLane } from '../../src/sim/spawn-director.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';
import { centeredViewBounds } from './centered-view-bounds.js';

// Gate selection favors the far side of the arena from the player (R14, C0b2). The director takes
// no density input: favoring dense coarse cells is the GPU spawn's density bias (spawn.wgsl), whose
// packed defaults are pinned in params.test.js.

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function openGate(x, y, overrides = {}) {
  return {
    x, y, radius: 0.8, species: 0, age: 1, lifetime: 14, closing: false, laneSeconds: 0, driftX: 1, driftY: 0, open: 1, emit: 0, telegraph: 0, ...overrides,
  };
}

const NO_AIM = { playerX: 8, playerY: 4.5, safeDistance: 2, shares: [], aimX: 0, aimY: 0 };

test('pickWaveGate with the random term at zero picks the gate farthest from the player', () => {
  const director = new SpawnDirector({ random: () => 0 });
  director.gates = [openGate(7, 4.5), openGate(1, 1), openGate(12, 8)];
  assert.equal(director.pickWaveGate(NO_AIM), director.gates[1]);
  const farRight = new SpawnDirector({ random: () => 0 });
  farRight.gates = [openGate(7, 4.5), openGate(15, 4.5), openGate(9, 4.5)];
  assert.equal(farRight.pickWaveGate(NO_AIM), farRight.gates[1]);
});

test('pickWaveGate skips the previous wave gate while another can emit, and reuses it when it is the only one', () => {
  const director = new SpawnDirector({ random: () => 0 });
  director.gates = [openGate(1, 1), openGate(12, 8)];
  director.lastWaveGate = director.gates[0];
  assert.equal(director.pickWaveGate(NO_AIM), director.gates[1]);
  director.gates = [director.gates[0]];
  assert.equal(director.pickWaveGate(NO_AIM), director.gates[0]);
});

test('pickWaveGate ignores gates that cannot emit and returns null when none can', () => {
  const director = new SpawnDirector({ random: () => 0 });
  const closing = openGate(1, 1, { closing: true });
  const opening = openGate(2, 2, { age: 0.1 });
  const tooClose = openGate(8.5, 4.5);
  director.gates = [closing, opening, tooClose];
  assert.equal(director.pickWaveGate(NO_AIM), null);
  const farOpen = openGate(14, 8);
  director.gates.push(farOpen);
  assert.equal(director.pickWaveGate(NO_AIM), farOpen);
});

test('a farther gate still wins when the random draw is at its maximum for both', () => {
  const nearer = openGate(1, 4.5);
  const farther = openGate(1, 8);
  const drawsHigh = new SpawnDirector({ random: () => 0.99 });
  drawsHigh.gates = [nearer, farther];
  assert.ok(Math.hypot(farther.x - 8, farther.y - 4.5) > Math.hypot(nearer.x - 8, nearer.y - 4.5));
  assert.equal(drawsHigh.pickWaveGate(NO_AIM), farther);
});

test('placeGate prefers the far side: with the player in a corner the average placement is far from it', () => {
  const corner = { ...NO_AIM, playerX: 1, playerY: 1, safeDistance: 2 };
  let placedDistance = 0;
  let uniformDistance = 0;
  const uniform = seededRandom(99);
  const trials = 200;
  for (let trial = 0; trial < trials; trial += 1) {
    const director = new SpawnDirector({ random: seededRandom(1000 + trial) });
    const point = director.placeGate(corner);
    placedDistance += Math.hypot(point.x - corner.playerX, point.y - corner.playerY);
    uniformDistance += Math.hypot(uniform() * WORLD_WIDTH - corner.playerX, uniform() * WORLD_HEIGHT - corner.playerY);
  }
  assert.ok(placedDistance / trials > uniformDistance / trials * 1.3, `placed ${placedDistance / trials} uniform ${uniformDistance / trials}`);
});

test('placeGate returns placeable points outside the safe radius and inside the gate inset', () => {
  const context = { ...NO_AIM, safeDistance: 3 };
  for (let trial = 0; trial < 100; trial += 1) {
    const director = new SpawnDirector({ random: seededRandom(trial + 1) });
    const point = director.placeGate(context);
    const radius = director.schedule.gateRadius;
    assert.ok(Math.hypot(point.x - context.playerX, point.y - context.playerY) >= context.safeDistance + radius, `trial ${trial}`);
    assert.ok(point.x >= 0.15 + radius - 1e-9 && point.x <= WORLD_WIDTH - 0.15 - radius + 1e-9);
    assert.ok(point.y >= 0.15 + radius - 1e-9 && point.y <= WORLD_HEIGHT - 0.15 - radius + 1e-9);
  }
});

test('placeGate avoids the aim lane when an equally good lane-free point exists', () => {
  const context = { ...NO_AIM, safeDistance: 2, aimX: 1, aimY: 0 };
  for (let trial = 0; trial < 100; trial += 1) {
    const director = new SpawnDirector({ random: seededRandom(trial + 7) });
    const point = director.placeGate(context);
    assert.equal(inAimLane(point, director.schedule.gateRadius, context), false, `trial ${trial}`);
  }
});

test('placeGate keeps away from existing gates when it can (spacing term)', () => {
  const context = { ...NO_AIM, playerX: 8, playerY: 4.5, safeDistance: 1 };
  let nearCount = 0;
  const trials = 100;
  for (let trial = 0; trial < trials; trial += 1) {
    const director = new SpawnDirector({ random: seededRandom(5000 + trial) });
    director.gates = [openGate(15, 8.5)];
    const point = director.placeGate(context);
    if (Math.hypot(point.x - 15, point.y - 8.5) < 1) nearCount += 1;
  }
  assert.ok(nearCount < trials * 0.1, `${nearCount} of ${trials} placed within 1 unit of the existing gate`);
});

test('wallBandPoint covers the top, bottom, left and right walls within the band depth', () => {
  const inset = 0.95;
  const expected = ['top', 'bottom', 'left', 'right'];
  [0.1, 0.3, 0.55, 0.9].forEach((sideDraw, index) => {
    // Draws: along the wall, inward depth, then the side.
    const draws = [0.5, 0.5, sideDraw];
    let call = 0;
    const point = new SpawnDirector({ random: () => draws[call++] }).wallBandPoint(inset);
    const sides = {
      top: point.y <= inset + 1.2 + 1e-9,
      bottom: point.y >= WORLD_HEIGHT - inset - 1.2 - 1e-9,
      left: point.x <= inset + 1.2 + 1e-9,
      right: point.x >= WORLD_WIDTH - inset - 1.2 - 1e-9,
    };
    assert.ok(sides[expected[index]], `${expected[index]}: ${JSON.stringify(point)}`);
  });
});

test('pickSpecies follows the shares, and falls back to a uniform draw when all shares are zero', () => {
  assert.equal(new SpawnDirector({ random: () => 0.5 }).pickSpecies([0, 0, 1, 0, 0]), 2);
  assert.equal(new SpawnDirector({ random: () => 0.0 }).pickSpecies([0, 1, 0, 0, 0]), 1);
  assert.equal(new SpawnDirector({ random: () => 0.9999 }).pickSpecies([1, 1, 1, 1, 1]), 4);
  assert.equal(new SpawnDirector({ random: () => 0.5 }).pickSpecies([]), 2);
  assert.equal(new SpawnDirector({ random: () => 0.9999 }).pickSpecies([0, 0, 0, 0, 0]), 4);
  assert.equal(new SpawnDirector({ random: () => 0.5 }).pickSpecies([-1, -1, 4, -1, -1]), 2);
});

test('wallBandPoint and placeGate stay inside narrow bounds, on every wall of the bounds', () => {
  const inset = 0.95;
  for (const bounds of [centeredViewBounds(0.5), centeredViewBounds(4)]) {
    const director = new SpawnDirector({ random: seededRandom(31) });
    const sides = new Set();
    const bandDepth = Math.min(1.2, Math.min(bounds.width, bounds.height) / 2 - inset);
    for (let trial = 0; trial < 400; trial += 1) {
      const point = director.wallBandPoint(inset, bounds);
      assert.ok(point.x >= bounds.minX + inset - 1e-9 && point.x <= bounds.maxX - inset + 1e-9, `x ${point.x} in ${JSON.stringify(bounds)}`);
      assert.ok(point.y >= bounds.minY + inset - 1e-9 && point.y <= bounds.maxY - inset + 1e-9, `y ${point.y} in ${JSON.stringify(bounds)}`);
      if (point.y <= bounds.minY + inset + bandDepth + 1e-9) sides.add('top');
      if (point.y >= bounds.maxY - inset - bandDepth - 1e-9) sides.add('bottom');
      if (point.x <= bounds.minX + inset + bandDepth + 1e-9) sides.add('left');
      if (point.x >= bounds.maxX - inset - bandDepth - 1e-9) sides.add('right');
    }
    assert.deepEqual([...sides].sort(), ['bottom', 'left', 'right', 'top']);
    const context = { ...NO_AIM, playerX: (bounds.minX + bounds.maxX) / 2, playerY: (bounds.minY + bounds.maxY) / 2, safeDistance: 0.5, bounds };
    for (let trial = 0; trial < 100; trial += 1) {
      const point = director.placeGate(context);
      assert.ok(point.x >= bounds.minX + inset - 1e-9 && point.x <= bounds.maxX - inset + 1e-9, `gate x ${point.x}`);
      assert.ok(point.y >= bounds.minY + inset - 1e-9 && point.y <= bounds.maxY - inset + 1e-9, `gate y ${point.y}`);
    }
  }
});
