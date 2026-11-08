import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../../src/render/renderer.js';
import { Viewport } from '../../src/render/viewport.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 };
globalThis.GPUMapMode ??= { READ: 1 };

// A device that records every buffer, texture and bind group it creates.
function createFakeGpu() {
  const log = { buffers: [], textures: [], bindGroups: [], currentTextureRequests: 0 };
  const destroyable = (object) => Object.assign(object, { destroyed: false, destroy() { object.destroyed = true; } });
  const device = {
    createBuffer: (descriptor) => {
      const buffer = destroyable({ ...descriptor });
      log.buffers.push(buffer);
      return buffer;
    },
    createTexture: (descriptor) => {
      const texture = destroyable({ ...descriptor, width: descriptor.size[0], height: descriptor.size[1] });
      texture.createView = () => ({ texture });
      log.textures.push(texture);
      return texture;
    },
    createBindGroup: (descriptor) => {
      log.bindGroups.push(descriptor);
      return descriptor;
    },
    createSampler: () => ({}),
    queue: { writeBuffer() {} },
  };
  const context = {
    getCurrentTexture: () => {
      log.currentTextureRequests += 1;
      return { width: 1280, height: 720, createView: () => ({}) };
    },
  };
  return { gpu: { device, context, format: 'bgra8unorm' }, log };
}

function createFakeEncoder() {
  const encoder = { passes: [] };
  encoder.beginRenderPass = (descriptor) => {
    const pass = { descriptor, draws: 0, setPipeline() {}, setBindGroup() {}, draw() { pass.draws += 1; }, end() {} };
    encoder.passes.push(pass);
    return pass;
  };
  encoder.copyTextureToBuffer = () => {};
  return encoder;
}

function createFakeSimulation(name, frameSequence) {
  const buffer = (part) => ({ label: `${name}-${part}` });
  return {
    frameSequence,
    capacity: 1024,
    agentsBuffer: buffer('agents'),
    previousAgentsBuffer: buffer('previous-agents'),
    paramsBuffer: buffer('params'),
    fieldBuffer: buffer('field'),
    speciesTableBuffer: buffer('species'),
    particlePool: { capacity: 64, buffers: { particles: buffer('particles') } },
  };
}

// The constructor only allocates; pipelines come from initialize(), which needs real shaders.
function createRenderer(simulation) {
  const { gpu, log } = createFakeGpu();
  const viewport = new Viewport();
  viewport.setCanvasSize(1280, 720);
  const renderer = new Renderer(gpu, { simulation, viewport, common: '', fullscreenHeader: '' });
  const pipeline = { getBindGroupLayout: () => ({}) };
  for (const pass of [renderer.trails, renderer.glyphs, renderer.particles, renderer.warpGrid, renderer.composite]) pass.pipeline = pipeline;
  renderer.bloom.downsamplePipeline = pipeline;
  renderer.bloom.blurPipeline = pipeline;
  renderer.resize(1280, 720);
  return { renderer, log };
}

function boundBuffers(bindGroup) {
  return bindGroup.entries.map((entry) => entry.resource.buffer).filter(Boolean);
}

test('resize rebuilds the scene, grid and bloom textures at the new size and destroys the old ones', () => {
  const { renderer, log } = createRenderer(createFakeSimulation('first', 0));
  const before = log.textures.filter((texture) => !texture.destroyed);
  renderer.resize(800, 450);
  assert.ok(before.every((texture) => texture.destroyed));
  const live = log.textures.filter((texture) => !texture.destroyed);
  const sizes = Object.fromEntries(live.map((texture) => [texture.label, [texture.width, texture.height]]));
  assert.deepEqual(sizes, {
    'scene-0': [800, 450], 'scene-1': [800, 450], 'warp-grid-layer': [800, 450], 'bloom-0': [400, 225], 'bloom-1': [400, 225],
  });
  renderer.resize(0, 0);
  assert.ok(log.textures.filter((texture) => !texture.destroyed).every((texture) => texture.width === 1 && texture.height === 1));
});

test('setSimulation clears the caches and the next frame binds only the new simulation buffers', () => {
  const first = createFakeSimulation('first', 5);
  const { renderer, log } = createRenderer(first);
  assert.equal(renderer.render(createFakeEncoder(), { alpha: 0, time: 0 }), true);
  assert.ok(renderer.glyphs.bindGroupCache.entries.size > 0);

  // commitCapacity builds the new simulation's field, so it draws before its first step.
  const second = createFakeSimulation('second', 5);
  renderer.setSimulation(second);
  for (const pass of [renderer.glyphs, renderer.particles, renderer.warpGrid]) assert.equal(pass.bindGroupCache.entries.size, 0);
  const bindGroupsBefore = log.bindGroups.length;
  const drawn = createFakeEncoder();
  assert.equal(renderer.render(drawn, { alpha: 0, time: 0 }), true);
  assert.ok(drawn.passes.length > 0);
  const created = log.bindGroups.slice(bindGroupsBefore).flatMap(boundBuffers);
  const labels = created.map((buffer) => buffer.label).filter((label) => label?.startsWith('first') || label?.startsWith('second'));
  assert.ok(labels.length > 0);
  assert.ok(labels.every((label) => label.startsWith('second-')), labels.join(', '));
  assert.ok(labels.includes('second-particles') && labels.includes('second-agents') && labels.includes('second-field'));
  assert.ok(labels.includes('second-previous-agents'));
});

test('setBloomQuality resizes only the bloom textures and rebinds the composite', () => {
  const { renderer, log } = createRenderer(createFakeSimulation('first', 0));
  assert.equal(renderer.bloomQuality, 'high');
  const scenes = log.textures.filter((texture) => texture.label.startsWith('scene-'));
  const bindGroupsBefore = log.bindGroups.length;
  renderer.setBloomQuality('low');
  assert.equal(renderer.bloomQuality, 'low');
  const live = log.textures.filter((texture) => !texture.destroyed);
  const sizes = Object.fromEntries(live.map((texture) => [texture.label, [texture.width, texture.height]]));
  assert.deepEqual(sizes['bloom-0'], [320, 180]);
  assert.ok(scenes.every((texture) => !texture.destroyed), 'trails survive');
  assert.ok(log.bindGroups.slice(bindGroupsBefore).some((group) => group.label === 'composite-0'));
  renderer.setBloomQuality('medium');
  const medium = log.textures.filter((texture) => !texture.destroyed && texture.label === 'bloom-0');
  assert.deepEqual([medium[0].width, medium[0].height], [426, 240]);
  renderer.resize(800, 450);
  assert.deepEqual(log.textures.filter((texture) => !texture.destroyed && texture.label === 'bloom-0').map((texture) => texture.width), [266]);
  assert.throws(() => renderer.setBloomQuality('ultra'), /Unknown bloom quality/);
});

test('destroy destroys every texture and the pass uniform buffers', () => {
  const { renderer, log } = createRenderer(createFakeSimulation('first', 0));
  renderer.destroy();
  assert.ok(log.textures.every((texture) => texture.destroyed));
  const uniformLabels = ['glyph-view', 'particle-view', 'warp-view', 'trail-decay', 'composite', 'bloom-blur-horizontal', 'bloom-blur-vertical'];
  for (const label of uniformLabels) {
    assert.ok(log.buffers.filter((buffer) => buffer.label === label).every((buffer) => buffer.destroyed), label);
  }
});

test('render writes the exposure setting into the composite uniform every frame', () => {
  const { renderer } = createRenderer(createFakeSimulation('first', 0));
  const writes = [];
  renderer.device.queue.writeBuffer = (buffer, offset, data) => { if (buffer === renderer.composite.uniformBuffer) writes.push(Array.from(data)); };
  renderer.render(createFakeEncoder(), { alpha: 0, time: 0 });
  renderer.settings.exposure = 2;
  renderer.render(createFakeEncoder(), { alpha: 0, time: 0 });
  assert.deepEqual(writes.map((floats) => floats[5]), [Math.fround(0.15), Math.fround(0.3)]);
});

// Plan D task D2: every pass keeps one view array and refills it, so a frame allocates no typed
// array for its uniforms.
test('render refills the same view array per uniform buffer every frame', () => {
  const { renderer } = createRenderer(createFakeSimulation('first', 0));
  const pipeline = { getBindGroupLayout: () => ({}) };
  for (const pass of [renderer.projectileRenderer, renderer.pickupRenderer, renderer.ship]) pass.pipeline = pipeline;
  renderer.pickupRenderer.bindGroup = {};
  renderer.ship.bindGroup = {};
  const scene = {
    projectiles: { buffer: { label: 'projectiles' }, capacity: 8 },
    pickups: [{ x: 3, y: 4, type: 'scatter', fade: 1 }],
    ship: { x: 8, y: 4.5, facing: 0, charge: 0.5, armed: 'pulse', invulnerable: false },
  };
  const frames = [new Map(), new Map()];
  let frame = 0;
  renderer.device.queue.writeBuffer = (buffer, offset, data) => { frames[frame].set(buffer.label, data); };
  renderer.render(createFakeEncoder(), { alpha: 0, time: 1, scene, impulses: [{ x: 1, y: 1, strength: 1, time: 1 }] });
  frame = 1;
  renderer.render(createFakeEncoder(), { alpha: 0, time: 2, scene });
  const labels = ['warp-view', 'trail-decay', 'glyph-view', 'projectile-view', 'pickup-view', 'particle-view', 'ship-view', 'composite'];
  for (const label of labels) {
    assert.ok(frames[0].has(label) && frames[1].has(label), `${label} written in both frames`);
    assert.equal(frames[1].get(label), frames[0].get(label), `${label} reuses its array`);
  }
  assert.equal(renderer.impulses.toUniformArray(2, renderer.impulseUniform), renderer.impulseUniform);
});
