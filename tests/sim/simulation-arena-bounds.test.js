import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';
import { centeredViewBounds } from './centered-view-bounds.js';
import { fakeSimulation } from './fake-simulation.js';

test('a new simulation packs the whole world as its world bounds', () => {
  const { simulation, paramsBounds } = fakeSimulation();
  assert.deepEqual(simulation.worldBounds, WORLD_BOUNDS);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(paramsBounds(), [0, 0, WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxY]);
});

test('setWorldBounds reaches the SimParams uniform from the next write', () => {
  const { simulation, paramsBounds } = fakeSimulation();
  const narrow = centeredViewBounds(1);
  simulation.setWorldBounds(narrow);
  simulation.writeParams(0, new Uint32Array(5));
  assert.deepEqual(paramsBounds(), [narrow.minX, narrow.minY, narrow.maxX, narrow.maxY]);
  assert.equal(simulation.worldBounds.width, 9);
});

test('setWorldBounds throws RangeError and keeps the previous bounds for invalid rectangles', () => {
  const { simulation } = fakeSimulation();
  const narrow = centeredViewBounds(0.5);
  simulation.setWorldBounds(narrow);
  for (const bounds of [null, { minX: 0, minY: 0, maxX: Number.NaN, maxY: 9 }, { minX: 5, minY: 0, maxX: 2, maxY: 9 }, { minX: -1, minY: 0, maxX: 16, maxY: 9 }, { minX: 0, minY: 0, maxX: 16, maxY: WORLD_BOUNDS.maxY + 1 }]) {
    assert.throws(() => simulation.setWorldBounds(bounds), RangeError);
  }
  assert.deepEqual(simulation.worldBounds, { ...narrow });
});

test('the capacity swap carries the world bounds into the next simulation', () => {
  const { simulation } = fakeSimulation();
  const { simulation: next } = fakeSimulation();
  simulation.setWorldBounds(centeredViewBounds(2));
  next.densityReadback.adopt = () => {};
  simulation.carryStateInto(next);
  assert.deepEqual(next.worldBounds, simulation.worldBounds);
});

test('of two radial kills requested for one step the larger radius wins, whatever the order', () => {
  const { simulation } = fakeSimulation();
  simulation.requestRadialKill(1, 2, 11);
  simulation.requestRadialKill(3, 4, 1.5);
  assert.deepEqual(simulation.radialKill, { x: 1, y: 2, radius: 11 });
  simulation.radialKill = null;
  simulation.requestRadialKill(3, 4, 1.5);
  simulation.requestRadialKill(1, 2, 11);
  assert.deepEqual(simulation.radialKill, { x: 1, y: 2, radius: 11 });
});

test('the minimum spawn distance packs as the fraction times the spawn view width, which must be positive', () => {
  const { simulation, writes } = fakeSimulation();
  simulation.setSpawnDistanceFraction(0.4);
  simulation.setSpawnViewWidth(10);
  simulation.writeParams(0, new Uint32Array(5));
  const write = writes.filter(({ buffer }) => buffer === simulation.paramsBufferValue).at(-1);
  assert.equal(new DataView(write.data).getFloat32(36, true), Math.fround(4));
  for (const bad of [0, -1, Number.NaN, Infinity]) assert.throws(() => simulation.setSpawnViewWidth(bad), RangeError);
  assert.equal(simulation.spawnViewWidth, 10);
});
