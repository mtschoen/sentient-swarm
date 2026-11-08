import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../../src/sim/simulation.js';
import { Projectiles } from '../../src/game/projectiles.js';
import { ParticleRenderer } from '../../src/render/particles.js';
import { ParticlePool } from '../../src/sim/particles.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

function fakeGpu() {
  const device = {
    createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }),
    createBindGroup: (descriptor) => descriptor,
    queue: { writeBuffer() {} },
  };
  return { device };
}

const layoutSource = { getBindGroupLayout: () => 'layout' };
const bindings = (cache) => cache.entries.size;

test('a particle pool resize evicts the kill passes bind groups naming the old buffer', () => {
  const simulation = new Simulation(fakeGpu(), { capacity: 64, neighborRadius: 0.25, species: defaultSpecies(), matrix: defaultMatrix(), shares: normalizeShares([1, 1, 1, 1, 1]), particleCapacity: 4 }, '');
  const { killPass, killAllPass, playerContactPass, particlePool } = simulation;
  [killPass, killAllPass, playerContactPass].forEach((pass) => { pass.pipeline = layoutSource; });
  killAllPass.countPipeline = layoutSource;
  const caches = [killPass.bindGroupCache, killAllPass.bindGroupCache, killAllPass.countBindGroupCache, playerContactPass.bindGroupCache];
  caches.forEach((cache) => cache.get([{ label: 'params' }, particlePool.buffers.particles]));
  assert.deepEqual(caches.map(bindings), [1, 1, 1, 1]);
  particlePool.resize(8);
  assert.deepEqual(caches.map(bindings), [0, 0, 0, 0]);
});

test('encoding the projectile collide pass and the particle draw registers their caches with the pool', () => {
  const gpu = fakeGpu();
  const pool = new ParticlePool(gpu, { capacity: 4, common: '' });
  const projectiles = new Projectiles(gpu, { capacity: 8, common: '' });
  const noop = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, draw() {}, end() {} };
  projectiles.collideLayout = 'layout';
  projectiles.pipelines = { step: layoutSource, collide: layoutSource, rings: layoutSource, beam: layoutSource };
  const encoder = { beginComputePass: () => noop, copyBufferToBuffer() {} };
  const buffer = (label) => ({ label });
  projectiles.encode(encoder, {
    agentsBuffer: buffer('agents'),
    gridBuffers: { cellCounts: buffer('counts'), cellOffsets: buffer('offsets'), sortedIndices: buffer('sorted') },
    fieldBuffers: { threatAccumulator: buffer('threat'), blurred: buffer('blurred') },
    particlePool: pool,
    statsBuffer: buffer('stats'),
    paramsBuffer: buffer('params'),
    speciesTableBuffer: buffer('table'),
  });
  const renderer = new ParticleRenderer(gpu, { viewport: { worldToClip: () => ({ x: 0, y: 0 }), canvasWidth: 1, canvasHeight: 1, effectiveZoom: 1 }, common: '' });
  renderer.pipeline = layoutSource;
  renderer.encode(noop, pool);
  assert.deepEqual([renderer.bindGroupCache, projectiles.collideBindGroupCache].map(bindings), [1, 1]);
  pool.resize(8);
  assert.deepEqual([renderer.bindGroupCache, projectiles.collideBindGroupCache].map(bindings), [0, 0]);
});
