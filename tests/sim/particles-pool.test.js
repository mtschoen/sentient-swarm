import test from 'node:test';
import assert from 'node:assert/strict';
import { ParticlePool } from '../../src/sim/particles.js';
import { BindGroupCache } from '../../src/gpu/bind-group-cache.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

function fakeGpu() {
  const destroyed = [];
  const device = {
    createBuffer: (descriptor) => ({ ...descriptor, destroy: () => destroyed.push(descriptor.label) }),
    createBindGroup: (descriptor) => descriptor,
  };
  return { gpu: { device }, destroyed };
}

function poolWithPipeline(gpu) {
  const pool = new ParticlePool(gpu, { capacity: 4, common: '' });
  pool.pipeline = { getBindGroupLayout: () => 'layout' };
  return pool;
}

test('particle pool resize evicts its bind group cache entries', () => {
  const { gpu } = fakeGpu();
  const pool = poolWithPipeline(gpu);
  const params = { label: 'params' };
  const stale = pool.bindGroupCache.get([params]);
  const previous = pool.buffers.particles;
  const dependent = new BindGroupCache((buffers) => ({ buffers }));
  dependent.get([params, previous]);
  dependent.get([params]);
  pool.registerBindGroupCache(dependent);
  pool.resize(8);
  assert.equal(pool.bindGroupCache.entries.size, 0);
  assert.notEqual(pool.bindGroupCache.get([params]), stale);
  assert.equal(dependent.entries.size, 1, 'only the entries naming the replaced buffer go');
});
