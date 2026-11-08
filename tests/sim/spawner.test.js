import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnPressure } from '../../src/sim/spawner.js';

const CAPACITY = 60000;
const EQUAL_SHARES = [0.2, 0.2, 0.2, 0.2, 0.2];
const STEP_SECONDS = 1 / 60;
// The tuned defaults (Plan C task C0): 1 percent of capacity at the start, easing in (exponent 2)
// to 90 percent over 120 seconds; seek starts at 10 percent strength and the spawn distance from
// the player at 0.4 of the arena width, and both ramp with the count (to full seek and 0.25).
const DEFAULT_FLOOR = 0.01;
const DEFAULT_CEILING = 0.9;
const DEFAULT_RAMP_SECONDS = 120;
const DEFAULT_SEEK_FLOOR = 0.1;
const DEFAULT_SPAWN_DISTANCE_START = 0.4;
// Owner ruling R13 (Plan C task C0b): after the first fill, killed agents refill at this fraction of
// the alive target per second, so a cleared corridor stays clear for several seconds.
const DEFAULT_REFILL_FRACTION = 0.15;
// The spec's minimum: spawns land at least a quarter of the arena width from the player.
const SPEC_SPAWN_DISTANCE = 0.25;
// The older deficit and rounding tests need a floor well above their deficits.
const WIDE_FLOOR = { floorFraction: 0.05 };

function total(counts) {
  return counts.reduce((sum, count) => sum + count, 0);
}

function statsWith(aliveTotal, frameSequence) {
  return { aliveTotal, frameSequence };
}

function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`);
}

// Advances the ramp in fixed 1/60 second steps with no stats, as the game does every step.
function advance(pressure, seconds) {
  const steps = Math.round(seconds / STEP_SECONDS);
  for (let step = 0; step < steps; step += 1) pressure.update(STEP_SECONDS, null, EQUAL_SHARES, step + 1);
}

test('target alive at elapsed 0 is the floor fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  assert.equal(pressure.targetAlive, CAPACITY * DEFAULT_FLOOR);
});

test('target alive at the end of the ramp is the ceiling fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(DEFAULT_RAMP_SECONDS, statsWith(CAPACITY, 0), EQUAL_SHARES, 1);
  near(pressure.targetAlive, CAPACITY * DEFAULT_CEILING, 'ramp end');
});

test('target alive stops rising after the ramp', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(500, statsWith(CAPACITY, 0), EQUAL_SHARES, 1);
  near(pressure.targetAlive, CAPACITY * DEFAULT_CEILING, 'past the ramp');
});

test('the ramp eases in: halfway through it covers a quarter of the climb', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  advance(pressure, DEFAULT_RAMP_SECONDS / 2);
  near(pressure.rampProgress, 0.25, 'progress');
  near(pressure.targetAlive, CAPACITY * (DEFAULT_FLOOR + (DEFAULT_CEILING - DEFAULT_FLOOR) * 0.25), 'target');
});

test('the first ten seconds stay within 2 percent of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  advance(pressure, 10);
  assert.ok(pressure.targetAlive < CAPACITY * 0.02, `target ${pressure.targetAlive}`);
});

test('seek scale ramps with the count from the seek floor to 1', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  near(pressure.seekScale, DEFAULT_SEEK_FLOOR, 'start');
  advance(pressure, DEFAULT_RAMP_SECONDS / 2);
  near(pressure.seekScale, DEFAULT_SEEK_FLOOR + (1 - DEFAULT_SEEK_FLOOR) * 0.25, 'halfway');
  advance(pressure, DEFAULT_RAMP_SECONDS);
  near(pressure.seekScale, 1, 'end');
});

test('the spawn distance starts far from the player and ramps to a quarter of the arena width', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  near(pressure.spawnDistanceFraction, DEFAULT_SPAWN_DISTANCE_START, 'start');
  advance(pressure, DEFAULT_RAMP_SECONDS / 2);
  near(pressure.spawnDistanceFraction, DEFAULT_SPAWN_DISTANCE_START + (SPEC_SPAWN_DISTANCE - DEFAULT_SPAWN_DISTANCE_START) * 0.25, 'halfway');
  advance(pressure, DEFAULT_RAMP_SECONDS);
  near(pressure.spawnDistanceFraction, SPEC_SPAWN_DISTANCE, 'end');
  pressure.reset();
  near(pressure.spawnDistanceFraction, DEFAULT_SPAWN_DISTANCE_START, 'after reset');
});

test('reset after a death returns the target and the seek scale to the floor and ramps back', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  advance(pressure, 30);
  const thirtySecondTarget = pressure.targetAlive;
  pressure.reset();
  assert.equal(pressure.elapsed, 0);
  assert.equal(pressure.targetAlive, CAPACITY * DEFAULT_FLOOR);
  near(pressure.seekScale, DEFAULT_SEEK_FLOOR, 'seek after reset');
  advance(pressure, 30);
  near(pressure.targetAlive, thirtySecondTarget, 'ramped back');
});

test('setRamp replaces the given ramp parameters and keeps the ramp position', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  advance(pressure, 30);
  const elapsed = pressure.elapsed;
  pressure.setRamp({ floorFraction: 0.02, rampSeconds: 60, ceilingFraction: 0.5 });
  assert.equal(pressure.elapsed, elapsed);
  assert.deepEqual(pressure.ramp, {
    floorFraction: 0.02, rampSeconds: 60, ceilingFraction: 0.5, curveExponent: 2, seekFloorFraction: DEFAULT_SEEK_FLOOR,
    spawnDistanceStartFraction: DEFAULT_SPAWN_DISTANCE_START, refillFractionPerSecond: DEFAULT_REFILL_FRACTION,
  });
  near(pressure.targetAlive, CAPACITY * (0.02 + (0.5 - 0.02) * 0.25), 'target at 30 of 60 seconds');
  pressure.setRamp({ curveExponent: 1, seekFloorFraction: 0.5 });
  near(pressure.targetAlive, CAPACITY * (0.02 + (0.5 - 0.02) * 0.5), 'linear target');
  near(pressure.seekScale, 0.75, 'linear seek');
});

test('the constructor takes the same ramp options as setRamp', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, floorFraction: 0.1, rampSeconds: 10, ceilingFraction: 0.3, curveExponent: 1, seekFloorFraction: 1 });
  advance(pressure, 5);
  near(pressure.targetAlive, CAPACITY * 0.2, 'target');
  assert.equal(pressure.seekScale, 1);
});

test('setRamp rejects values outside their ranges and leaves the ramp unchanged', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const before = pressure.ramp;
  for (const bad of [{ rampSeconds: 0 }, { floorFraction: -0.1 }, { ceilingFraction: 1.5 }, { curveExponent: 0 }, { seekFloorFraction: 2 }, { spawnDistanceStartFraction: 0.2 }, { spawnDistanceStartFraction: 0.6 }, { rampSeconds: Number.NaN }]) {
    assert.throws(() => pressure.setRamp(bad), RangeError, JSON.stringify(bad));
  }
  assert.deepEqual(pressure.ramp, before);
});

test('a floor above the ceiling ramps down rather than failing (sliders may cross)', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, floorFraction: 0.5, ceilingFraction: 0.1, curveExponent: 1 });
  advance(pressure, DEFAULT_RAMP_SECONDS / 2);
  near(pressure.targetAlive, CAPACITY * 0.3, 'crossed sliders');
});

test('a frame never spawns more than capacity / 60 in total', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(DEFAULT_RAMP_SECONDS, null, EQUAL_SHARES, 1);
  const counts = pressure.update(1 / 60, null, EQUAL_SHARES, 2);
  assert.equal(total(counts), CAPACITY / 60);
});

test('the frame spawn closes the deficit when it is under the cap and splits it exactly', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(0, statsWith(CAPACITY * DEFAULT_FLOOR - 7, 0), [0.5, 0.25, 0.25, 0, 0], 1);
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
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR });
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
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR });
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
  assert.equal(pressure.targetAlive, CAPACITY * DEFAULT_FLOOR);
});

test('repeated small frames keep every species at its share in the long run', () => {
  // Past its first fill (stats at the target), with steps of 0.05 s at a refill of the whole target
  // per second: 30 a step, well above 11.
  const pressure = new SpawnPressure({ capacity: CAPACITY, refillFractionPerSecond: 1 });
  pressure.update(0, statsWith(CAPACITY * DEFAULT_FLOOR, 0), EQUAL_SHARES, 1);
  const totals = new Array(5).fill(0);
  for (let frame = 1; frame <= 5; frame += 1) {
    // Each frame's stats already count the previous frame's 11, so the deficit stays 11.
    const counts = pressure.update(0.05, statsWith(CAPACITY * DEFAULT_FLOOR - 11, frame), EQUAL_SHARES, frame + 1);
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

// Fills the arena to the target (stats at the target end the first fill), then holds the alive
// count at target - deficit with fresh stats every step, so nothing is in flight. Returns the
// total spawned over the given seconds in steps of stepSeconds.
function refillOver(pressure, { seconds, stepSeconds, deficit }) {
  pressure.update(0, statsWith(pressure.targetAlive, 0), EQUAL_SHARES, 1);
  let spawned = 0;
  const steps = Math.round(seconds / stepSeconds);
  for (let step = 1; step <= steps; step += 1) {
    spawned += total(pressure.update(stepSeconds, statsWith(Math.floor(pressure.targetAlive) - deficit, step), EQUAL_SHARES, step + 1));
  }
  return spawned;
}

test('the default refill fraction is a tenth to a fifth of the alive target per second', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  assert.equal(pressure.ramp.refillFractionPerSecond, DEFAULT_REFILL_FRACTION);
  assert.ok(DEFAULT_REFILL_FRACTION >= 0.1 && DEFAULT_REFILL_FRACTION <= 0.2);
});

test('after the first fill, killed agents refill at refillFractionPerSecond of the target per second', () => {
  // A huge ramp keeps the target still over the measured second.
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 });
  const target = CAPACITY * 0.05;
  const spawned = refillOver(pressure, { seconds: 1, stepSeconds: STEP_SECONDS, deficit: 1000 });
  assert.ok(Math.abs(spawned - DEFAULT_REFILL_FRACTION * target) <= 1, `spawned ${spawned}, expected ${DEFAULT_REFILL_FRACTION * target}`);
});

test('the refill rate is per second, so half-rate steps refill as fast as full-rate ones', () => {
  const full = refillOver(new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 }), { seconds: 2, stepSeconds: STEP_SECONDS, deficit: 2000 });
  const half = refillOver(new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 }), { seconds: 2, stepSeconds: 2 * STEP_SECONDS, deficit: 2000 });
  assert.ok(Math.abs(full - half) <= 1, `full rate ${full}, half rate ${half}`);
});

test('setRamp changes the refill fraction', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 });
  pressure.setRamp({ refillFractionPerSecond: 0.5 });
  const spawned = refillOver(pressure, { seconds: 1, stepSeconds: STEP_SECONDS, deficit: 2000 });
  assert.ok(Math.abs(spawned - 0.5 * CAPACITY * 0.05) <= 1, `spawned ${spawned}`);
});

test('a refill fraction of 0 never refills and one outside [0, 1] is rejected', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, refillFractionPerSecond: 0 });
  assert.equal(refillOver(pressure, { seconds: 1, stepSeconds: STEP_SECONDS, deficit: 500 }), 0);
  for (const refillFractionPerSecond of [-0.1, 1.5, Number.NaN]) {
    assert.throws(() => pressure.setRamp({ refillFractionPerSecond }), RangeError);
  }
  assert.equal(pressure.ramp.refillFractionPerSecond, 0);
});

test('an idle refill does not bank: a sudden deficit after a calm minute refills at the rate', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 });
  const target = CAPACITY * 0.05;
  pressure.update(0, statsWith(target, 0), EQUAL_SHARES, 1);
  for (let step = 1; step <= 3600; step += 1) pressure.update(STEP_SECONDS, statsWith(target, step), EQUAL_SHARES, step + 1);
  const counts = pressure.update(STEP_SECONDS, statsWith(target - 1000, 3601), EQUAL_SHARES, 3602);
  assert.ok(total(counts) <= Math.ceil(DEFAULT_REFILL_FRACTION * target * STEP_SECONDS) + 1, `spawned ${total(counts)} in one step`);
});

test('the first fill after a start or a death is not rate limited, only capped at capacity / 60 a frame', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY, ...WIDE_FLOOR, rampSeconds: 1e9 });
  const target = CAPACITY * 0.05;
  assert.equal(total(pressure.update(STEP_SECONDS, statsWith(0, 0), EQUAL_SHARES, 1)), CAPACITY / 60);
  // The fill ends once the estimate reaches the target; then the refill rate applies.
  pressure.update(STEP_SECONDS, statsWith(target, 1), EQUAL_SHARES, 2);
  assert.ok(total(pressure.update(STEP_SECONDS, statsWith(0, 2), EQUAL_SHARES, 3)) <= Math.ceil(DEFAULT_REFILL_FRACTION * target * STEP_SECONDS) + 1);
  pressure.reset();
  assert.equal(total(pressure.update(STEP_SECONDS, statsWith(0, 3), EQUAL_SHARES, 4)), CAPACITY / 60);
});
