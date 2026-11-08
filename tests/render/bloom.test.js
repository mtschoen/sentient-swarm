import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOOM_DIVISORS, bloomTextureSize } from '../../src/render/bloom.js';
import { Renderer } from '../../src/render/renderer.js';
import { Viewport } from '../../src/render/viewport.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };

function createRenderer() {
  const log = { textures: [], bindGroups: [] };
  const device = {
    createBuffer: (descriptor) => ({ ...descriptor, destroy() {} }),
    createTexture: (descriptor) => {
      const texture = { ...descriptor, width: descriptor.size[0], height: descriptor.size[1], destroyed: false };
      texture.destroy = () => { texture.destroyed = true; };
      texture.createView = () => ({ texture });
      log.textures.push(texture);
      return texture;
    },
    createBindGroup: (descriptor) => { log.bindGroups.push(descriptor); return descriptor; },
    createSampler: () => ({}),
    queue: { writeBuffer() {} },
  };
  const gpu = { device, context: { getCurrentTexture: () => ({}) }, format: 'bgra8unorm' };
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  const simulation = {
    capacity: 1024, agentsBuffer: {}, previousAgentsBuffer: {}, paramsBuffer: {}, fieldBuffer: {}, speciesTableBuffer: {},
    particlePool: { capacity: 64, buffers: { particles: {} } },
  };
  const renderer = new Renderer(gpu, { simulation, viewport, common: '', fullscreenHeader: '' });
  const pipeline = { getBindGroupLayout: () => ({}) };
  for (const pass of [renderer.trails, renderer.glyphs, renderer.particles, renderer.warpGrid, renderer.composite]) pass.pipeline = pipeline;
  renderer.bloom.downsamplePipeline = pipeline;
  renderer.bloom.blurPipeline = pipeline;
  renderer.resize(1280, 720);
  return { renderer, log };
}

function liveBloomSize(log) {
  const texture = log.textures.find((candidate) => !candidate.destroyed && candidate.label === 'bloom-0');
  return [texture.width, texture.height];
}

test('bloomTextureSize divides the scene by the quality divisor and floors at one texel', () => {
  assert.deepEqual(BLOOM_DIVISORS, { high: 2, medium: 3, low: 4 });
  assert.deepEqual(bloomTextureSize(1280, 720, 'high'), [640, 360]);
  assert.deepEqual(bloomTextureSize(1280, 720, 'medium'), [426, 240]);
  assert.deepEqual(bloomTextureSize(1280, 720, 'low'), [320, 180]);
  assert.deepEqual(bloomTextureSize(1, 1, 'low'), [1, 1]);
  assert.deepEqual(bloomTextureSize(0, 0, 'medium'), [1, 1]);
  assert.throws(() => bloomTextureSize(1280, 720, 'ultra'), /Unknown bloom quality: ultra/);
});

test('setBloomQuality resizes the bloom textures to each divisor', () => {
  const { renderer, log } = createRenderer();
  assert.deepEqual(liveBloomSize(log), [640, 360]);
  renderer.setBloomQuality('medium');
  assert.deepEqual(liveBloomSize(log), [426, 240]);
  renderer.setBloomQuality('low');
  assert.deepEqual(liveBloomSize(log), [320, 180]);
  renderer.setBloomQuality('high');
  assert.deepEqual(liveBloomSize(log), [640, 360]);
});

test('setBloomQuality throws on an unknown quality and keeps the current one', () => {
  const { renderer, log } = createRenderer();
  const texturesBefore = log.textures.length;
  assert.throws(() => renderer.setBloomQuality('ultra'), /Unknown bloom quality: ultra/);
  assert.equal(renderer.bloomQuality, 'high');
  assert.equal(log.textures.length, texturesBefore);
});

test('setBloomQuality with the unchanged quality returns early without rebuilding anything', () => {
  const { renderer, log } = createRenderer();
  renderer.setBloomQuality('low');
  const texturesBefore = log.textures.length;
  const bindGroupsBefore = log.bindGroups.length;
  renderer.setBloomQuality('low');
  assert.equal(log.textures.length, texturesBefore);
  assert.equal(log.bindGroups.length, bindGroupsBefore);
});
