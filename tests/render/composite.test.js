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

// Owner ruling R31: the warp tint follows the warp strength (0 to 1) in the first padding slot.
test('packCompositeUniform writes the time warp strength after the exposure, clamped to [0, 1], 0 by default', () => {
  assert.equal(packCompositeUniform({ arenaRect, bloomStrength: 1 })[6], 0);
  assert.equal(packCompositeUniform({ arenaRect, bloomStrength: 1, timeWarp: 0.5 })[6], 0.5);
  assert.equal(packCompositeUniform({ arenaRect, bloomStrength: 1, timeWarp: 3 })[6], 1);
  assert.equal(packCompositeUniform({ arenaRect, bloomStrength: 1, timeWarp: 0.5 })[7], 0);
});
