import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/simulation.js';
import { FULL_ARENA_BOUNDS, arenaBoundsForAspect } from '../../src/sim/layout.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

// The constructor only creates buffers, so a fake device records the SimParams writes.
function fakeSimulation() {
  const writes = [];
  const device = {
    createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }),
    createBindGroup: (descriptor) => descriptor,
    queue: { writeBuffer: (buffer, offset, data) => writes.push({ buffer, data }) },
  };
  const simulation = new Simulation({ device }, { capacity: 64, neighborRadius: 0.25, species: defaultSpecies(), matrix: defaultMatrix(), shares: normalizeShares([1, 1, 1, 1, 1]), particleCapacity: 4 }, '');
  const paramsBounds = () => {
    const write = writes.filter(({ buffer }) => buffer === simulation.paramsBufferValue).at(-1);
    const view = new DataView(write.data);
    return [240, 244, 248, 252].map((offset) => view.getFloat32(offset, true));
  };
  return { simulation, paramsBounds };
}

test('a new simulation packs the whole world as its arena bounds', () => {
  const { simulation, paramsBounds } = fakeSimulation();
  assert.deepEqual(simulation.arenaBounds, FULL_ARENA_BOUNDS);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(paramsBounds(), [0, 0, 16, 9]);
});

test('setArenaBounds reaches the SimParams uniform from the next write', () => {
  const { simulation, paramsBounds } = fakeSimulation();
  simulation.setArenaBounds(arenaBoundsForAspect(1));
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(paramsBounds(), [3.5, 0, 12.5, 9]);
  assert.equal(simulation.arenaBounds.width, 9);
});

test('setArenaBounds throws RangeError and keeps the previous bounds for invalid rectangles', () => {
  const { simulation } = fakeSimulation();
  const narrow = arenaBoundsForAspect(0.5);
  simulation.setArenaBounds(narrow);
  for (const bounds of [null, { minX: 0, minY: 0, maxX: Number.NaN, maxY: 9 }, { minX: 5, minY: 0, maxX: 2, maxY: 9 }, { minX: -1, minY: 0, maxX: 16, maxY: 9 }, { minX: 0, minY: 0, maxX: 16, maxY: 10 }]) {
    assert.throws(() => simulation.setArenaBounds(bounds), RangeError);
  }
  assert.deepEqual(simulation.arenaBounds, { ...narrow });
});

test('the capacity swap carries the arena bounds into the next simulation', () => {
  const { simulation } = fakeSimulation();
  const { simulation: next } = fakeSimulation();
  simulation.setArenaBounds(arenaBoundsForAspect(2));
  next.densityReadback.adopt = () => {};
  simulation.carryStateInto(next);
  assert.deepEqual(next.arenaBounds, simulation.arenaBounds);
});
