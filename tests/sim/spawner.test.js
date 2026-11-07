import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnPressure } from '../../src/sim/spawner.js';

const CAPACITY = 60000;
const EQUAL_SHARES = [0.2, 0.2, 0.2, 0.2, 0.2];
const STEP_SECONDS = 1 / 60;

function total(counts) {
  return counts.reduce((sum, count) => sum + count, 0);
}

function statsWith(aliveTotal, frameSequence) {
  return { aliveTotal, frameSequence };
}

test('target alive at elapsed 0 is the floor fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  assert.equal(pressure.targetAlive, CAPACITY * 0.05);
});

test('target alive at 90 seconds is the ceiling fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(90, statsWith(CAPACITY, 0), EQUAL_SHARES, 1);
  assert.equal(pressure.targetAlive, CAPACITY * 0.9);
});

test('target alive stops rising after the ramp', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(500, statsWith(CAPACITY, 0), EQUAL_SHARES, 1);
  assert.equal(pressure.targetAlive, CAPACITY * 0.9);
});

test('a frame never spawns more than capacity / 60 in total', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(90, null, EQUAL_SHARES, 1);
  const counts = pressure.update(1 / 60, null, EQUAL_SHARES, 2);
  assert.equal(total(counts), CAPACITY / 60);
});

test('the frame spawn closes the deficit when it is under the cap and splits it exactly', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(0, statsWith(CAPACITY * 0.05 - 7, 0), [0.5, 0.25, 0.25, 0, 0], 1);
  // Quotas 3.5, 1.75, 1.75: floors 3, 1, 1 and the two leftover units go to the largest remainders.
  assert.equal(counts.length, 5);
  assert.deepEqual([...counts], [3, 2, 2, 0, 0]);
});

test('shares [1, 0, 0, 0, 0] spawn only species 0', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(1 / 60, null, [1, 0, 0, 0, 0], 1);
  assert.ok(counts[0] > 0);
  assert.deepEqual([...counts.slice(1)], [0, 0, 0, 0]);
});

test('nothing spawns once alive count reaches the target', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(1 / 60, statsWith(CAPACITY, 0), EQUAL_SHARES, 1);
  assert.equal(total(counts), 0);
});

test('requests for steps newer than the stats count as alive until stats cover them', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const floor = CAPACITY * 0.05;
  // Step 1 requests 700 against stats that show floor - 700; step 2 sees the same stale stats and
  // must not request them again; step 3 sees stats from step 1 that already count them.
  assert.equal(total(pressure.update(0, statsWith(floor - 700, 0), EQUAL_SHARES, 1)), 700);
  assert.equal(total(pressure.update(0, statsWith(floor - 700, 0), EQUAL_SHARES, 2)), 0);
  assert.equal(pressure.estimatedAlive, floor);
  assert.equal(total(pressure.update(0, statsWith(floor, 1), EQUAL_SHARES, 3)), 0);
  assert.equal(pressure.requests.size, 0);
});

test('stats older than ones already seen are ignored', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const floor = CAPACITY * 0.05;
  pressure.update(0, statsWith(floor, 5), EQUAL_SHARES, 6);
  assert.equal(total(pressure.update(0, statsWith(0, 3), EQUAL_SHARES, 7)), 0);
});

test('setCapacity keeps the ramp position and rescales the target and the frame cap', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(45, null, EQUAL_SHARES, 1);
  const fraction = pressure.targetAlive / CAPACITY;
  pressure.setCapacity(CAPACITY * 4);
  assert.equal(pressure.elapsed, 45);
  assert.ok(Math.abs(pressure.targetAlive - fraction * CAPACITY * 4) < 1e-6);
  assert.equal(pressure.maximumPerFrame, (CAPACITY * 4) / 60);
});

test('reset() returns elapsed to 0', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(45, null, EQUAL_SHARES, 1);
  pressure.reset();
  assert.equal(pressure.elapsed, 0);
  assert.equal(pressure.targetAlive, CAPACITY * 0.05);
});

test('repeated small frames keep every species at its share in the long run', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const totals = new Array(5).fill(0);
  for (let frame = 1; frame <= 5; frame += 1) {
    // Each frame's stats already count the previous frame's 11, so the deficit stays 11.
    const counts = pressure.update(0, statsWith(CAPACITY * 0.05 - 11, frame - 1), EQUAL_SHARES, frame);
    assert.equal(total(counts), 11);
    counts.forEach((count, species) => { totals[species] += count; });
  }
  assert.deepEqual(totals, [11, 11, 11, 11, 11]);
});

// Model of the GPU: every requested agent spawns in its step (up to capacity), nothing dies
// unless clearAtStep empties the arena (then reset() restarts the ramp, as after a death clear).
// Stats for step n become readable lag steps later. Returns the peak alive / target ratio, where
// target is the one in force when the step was requested.
function peakRatio({ capacity, lag, steps, clearAtStep = null }) {
  const pressure = new SpawnPressure({ capacity });
  const aliveAfterStep = [0];
  let alive = 0;
  let peak = 0;
  for (let step = 1; step <= steps; step += 1) {
    if (step === clearAtStep) {
      alive = 0;
      pressure.reset();
    }
    const seen = step - 1 - (lag - 1);
    const stats = seen >= 1 ? statsWith(aliveAfterStep[seen], seen) : null;
    const counts = pressure.update(STEP_SECONDS, stats, EQUAL_SHARES, step);
    alive = Math.min(capacity, alive + total(counts));
    aliveAfterStep.push(alive);
    if (clearAtStep === null || step >= clearAtStep) peak = Math.max(peak, alive / pressure.targetAlive);
  }
  return peak;
}

test('no overshoot above 1.02 of the target on a cold start at stats lags of 1, 2, 3 and 5 steps', () => {
  for (const lag of [1, 2, 3, 5]) {
    const peak = peakRatio({ capacity: 262144, lag, steps: 600 });
    assert.ok(peak <= 1.02, `lag ${lag}: peak ${peak.toFixed(3)}`);
  }
});

test('no overshoot above 1.02 of the target when refilling after a clear at a lag of 2 steps', () => {
  const peak = peakRatio({ capacity: 262144, lag: 2, steps: 4200, clearAtStep: 3600 });
  assert.ok(peak <= 1.02, `peak ${peak.toFixed(3)}`);
});
