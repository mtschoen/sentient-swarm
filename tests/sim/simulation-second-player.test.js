import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSimulation } from './fake-simulation.js';

function lastParams({ simulation, writes }) {
  const write = writes.filter(({ buffer }) => buffer === simulation.paramsBufferValue).at(-1);
  const view = new DataView(write.data);
  return { active: view.getUint32(68, true), position: [view.getFloat32(72, true), view.getFloat32(76, true)] };
}

test('setSecondPlayer reaches the uniform from the next write and clearSecondPlayer zeroes it', () => {
  const fake = fakeSimulation();
  const { simulation } = fake;
  assert.equal(simulation.secondPlayerPosition, null);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(lastParams(fake), { active: 0, position: [0, 0] });
  simulation.setSecondPlayer(20, 7);
  assert.deepEqual(simulation.secondPlayerPosition, [20, 7]);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(lastParams(fake), { active: 1, position: [20, 7] });
  simulation.clearSecondPlayer();
  assert.equal(simulation.secondPlayerPosition, null);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(lastParams(fake), { active: 0, position: [0, 0] });
});

test('carryStateInto keeps the second player', () => {
  const { simulation } = fakeSimulation();
  const target = fakeSimulation().simulation;
  simulation.setSecondPlayer(12, 3);
  simulation.carryStateInto(target);
  assert.deepEqual(target.secondPlayerPosition, [12, 3]);
  simulation.clearSecondPlayer();
  simulation.carryStateInto(target);
  assert.equal(target.secondPlayerPosition, null);
});
