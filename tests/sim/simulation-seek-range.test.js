import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSimulation } from './fake-simulation.js';

function packedSeekRange({ simulation, writes }) {
  simulation.writeParams(0, new Uint32Array(5));
  const write = writes.filter(({ buffer }) => buffer === simulation.paramsBufferValue).at(-1);
  return new DataView(write.data).getFloat32(256, true);
}

test('the seek range is unlimited by default and reaches the uniform from the next write', () => {
  const fake = fakeSimulation();
  assert.equal(fake.simulation.seekRange, 0);
  assert.equal(packedSeekRange(fake), 0);
  fake.simulation.setSeekRange(12);
  assert.equal(packedSeekRange(fake), 12);
});

test('an out-of-range seek range throws and changes nothing', () => {
  const fake = fakeSimulation();
  fake.simulation.setSeekRange(12);
  assert.throws(() => fake.simulation.setSeekRange(41), RangeError);
  assert.equal(fake.simulation.seekRange, 12);
});

test('carryStateInto keeps the seek range', () => {
  const { simulation } = fakeSimulation();
  const target = fakeSimulation().simulation;
  simulation.setSeekRange(12);
  simulation.carryStateInto(target);
  assert.equal(target.seekRange, 12);
});
