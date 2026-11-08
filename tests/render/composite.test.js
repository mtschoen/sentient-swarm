import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_EXPOSURE, packCompositeUniform } from '../../src/render/composite.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';

const arenaRect = { x: 10, y: 20, width: 1600, height: 900 };

test('the shipped exposure is the old composite.wgsl constant 0.15, as setting 1', () => {
  assert.equal(BASE_EXPOSURE, 0.15);
  assert.equal(DEFAULT_RENDER_SETTINGS.exposure, 1);
  const floats = packCompositeUniform({ arenaRect, bloomStrength: 0.8, exposure: DEFAULT_RENDER_SETTINGS.exposure });
  assert.equal(floats[5], Math.fround(0.15));
  assert.equal(packCompositeUniform({ arenaRect, bloomStrength: 0.8 })[5], Math.fround(0.15));
});

test('packCompositeUniform: arena rect, bloom strength, then the exposure setting times BASE_EXPOSURE', () => {
  const floats = packCompositeUniform({ arenaRect, bloomStrength: 1.5, exposure: 4 });
  assert.equal(floats.byteLength, 32);
  assert.deepEqual(Array.from(floats.slice(0, 5)), [10, 20, 1600, 900, 1.5]);
  assert.equal(floats[5], Math.fround(0.6));
  assert.deepEqual(Array.from(floats.slice(6)), [0, 0]);
});
