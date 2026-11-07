import test from 'node:test';
import assert from 'node:assert/strict';
import { PARTICLE_DEVICE_PIXELS, PARTICLE_VIEW_BYTES, packParticleView } from '../../src/render/particles.js';
import { Viewport } from '../../src/render/viewport.js';

test('packParticleView fills the 32-byte ParticleView layout', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  const view = packParticleView({ viewport, emissionScale: 0.25 });
  assert.equal(view.byteLength, PARTICLE_VIEW_BYTES);
  assert.deepEqual(Array.from(view.slice(4)), Array.from(new Float32Array([2 / 1600, 2 / 900, PARTICLE_DEVICE_PIXELS, 0.25])));
});

test('packParticleView world-to-clip matches viewport.worldToClip and the size grows with the zoom', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(2000, 1000);
  viewport.inspectZoom = 4;
  const view = packParticleView({ viewport, particleDevicePixels: 3 });
  for (const [x, y] of [[0, 0], [16, 9], [3.5, 7.25]]) {
    const expected = viewport.worldToClip(x, y);
    assert.ok(Math.abs(view[0] * x + view[2] - expected.x) < 1e-5);
    assert.ok(Math.abs(view[1] * y + view[3] - expected.y) < 1e-5);
  }
  assert.equal(view[6], 12);
});
