import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnPressure } from '../../src/sim/spawner.js';

const CAPACITY = 60000;
const EQUAL_SHARES = [0.2, 0.2, 0.2, 0.2, 0.2];

function total(counts) {
  return counts.reduce((sum, count) => sum + count, 0);
}

test('target alive at elapsed 0 is the floor fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  assert.equal(pressure.targetAlive, CAPACITY * 0.05);
});

test('target alive at 90 seconds is the ceiling fraction of capacity', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(90, CAPACITY, EQUAL_SHARES);
  assert.equal(pressure.targetAlive, CAPACITY * 0.9);
});

test('target alive stops rising after the ramp', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(500, CAPACITY, EQUAL_SHARES);
  assert.equal(pressure.targetAlive, CAPACITY * 0.9);
});

test('a frame never spawns more than capacity / 60 in total', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  pressure.update(90, 0, EQUAL_SHARES);
  const counts = pressure.update(1 / 60, 0, EQUAL_SHARES);
  assert.equal(total(counts), CAPACITY / 60);
});

test('the frame spawn closes the deficit when it is under the cap and splits it exactly', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(0, CAPACITY * 0.05 - 7, [0.5, 0.25, 0.25, 0, 0]);
  // Quotas 3.5, 1.75, 1.75: floors 3, 1, 1 and the two leftover units go to the largest remainders.
  assert.equal(counts.length, 5);
  assert.deepEqual([...counts], [3, 2, 2, 0, 0]);
});

test('shares [1, 0, 0, 0, 0] spawn only species 0', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(1 / 60, 0, [1, 0, 0, 0, 0]);
  assert.ok(counts[0] > 0);
  assert.deepEqual([...counts.slice(1)], [0, 0, 0, 0]);
});

test('nothing spawns once alive count reaches the target', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const counts = pressure.update(1 / 60, CAPACITY, EQUAL_SHARES);
  assert.equal(total(counts), 0);
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
  pressure.update(45, 0, EQUAL_SHARES);
  pressure.reset();
  assert.equal(pressure.elapsed, 0);
  assert.equal(pressure.targetAlive, CAPACITY * 0.05);
});

test('repeated small frames keep every species at its share in the long run', () => {
  const pressure = new SpawnPressure({ capacity: CAPACITY });
  const totals = new Array(5).fill(0);
  for (let frame = 0; frame < 5; frame += 1) {
    const counts = pressure.update(0, CAPACITY * 0.05 - 11, EQUAL_SHARES);
    assert.equal(total(counts), 11);
    counts.forEach((count, species) => { totals[species] += count; });
  }
  assert.deepEqual(totals, [11, 11, 11, 11, 11]);
});
