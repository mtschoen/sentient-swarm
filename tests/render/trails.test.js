import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAXIMUM_TRAIL_DELTA_SECONDS, trailFrameFactors, trailOriginFor } from '../../src/render/trails.js';
import { Viewport } from '../../src/render/viewport.js';

// Steady-state brightness of a pixel that receives one unit of emission per 1/60 second, after
// one simulated second at frames of deltaSeconds: brightness = brightness * decay + emissionScale.
function steadyBrightness(trailDecay, deltaSeconds) {
  const { decay, emissionScale } = trailFrameFactors(trailDecay, deltaSeconds);
  let brightness = 0;
  for (let frame = 0; frame < Math.round(10 / deltaSeconds); frame += 1) brightness = brightness * decay + emissionScale;
  return brightness;
}

test('at 60 Hz the factors are the setting itself and emission 1', () => {
  const { decay, emissionScale } = trailFrameFactors(0.9, 1 / 60);
  assert.ok(Math.abs(decay - 0.9) < 1e-12);
  assert.ok(Math.abs(emissionScale - 1) < 1e-12);
});

test('two 120 Hz frames decay as much as one 60 Hz frame', () => {
  const { decay } = trailFrameFactors(0.9, 1 / 120);
  assert.ok(Math.abs(decay * decay - 0.9) < 1e-12);
});

test('steady-state brightness is the same at 30, 60, 120 and 240 Hz', () => {
  const reference = steadyBrightness(0.9, 1 / 60);
  assert.ok(Math.abs(reference - 10) < 1e-6);
  for (const rate of [30, 120, 240]) {
    assert.ok(Math.abs(steadyBrightness(0.9, 1 / rate) - reference) < 1e-6, `${rate} Hz`);
  }
});

test('trailDecay 0 means no trails and full emission at any rate', () => {
  for (const deltaSeconds of [1 / 240, 1 / 60, 1]) {
    assert.deepEqual(trailFrameFactors(0, deltaSeconds), { decay: 0, emissionScale: 1 });
  }
});

test('a stall is clamped so it does not wipe the trails', () => {
  const stalled = trailFrameFactors(0.9, 5);
  const clamped = trailFrameFactors(0.9, MAXIMUM_TRAIL_DELTA_SECONDS);
  assert.deepEqual(stalled, clamped);
  assert.ok(stalled.decay > 0.5);
});

test('a decay of 1 keeps everything and emits one unit per 1/60 second', () => {
  const { decay, emissionScale } = trailFrameFactors(1, 1 / 30);
  assert.equal(decay, 1);
  assert.ok(Math.abs(emissionScale - 2) < 1e-12);
});

test('trailOriginFor rounds the camera center to whole device pixels at the current scale', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  viewport.setCamera({ centerX: 10.004, centerY: 5.006 });
  assert.deepEqual(trailOriginFor(viewport), { x: 1000, y: 501 });
  viewport.inspectZoom = 2;
  assert.deepEqual(trailOriginFor(viewport), { x: 2001, y: 1001 });
});

test('a camera moving a fraction of a pixel per frame shifts the trails by whole pixels that add up to the true movement', () => {
  const viewport = new Viewport();
  viewport.setCanvasSize(1600, 900);
  let previous = null;
  let total = 0;
  for (let frame = 0; frame <= 100; frame += 1) {
    // 0.3 device pixels per frame to the right (100 device pixels per world unit).
    viewport.setCamera({ centerX: 10 + (frame * 0.3) / 100, centerY: 5 });
    const origin = trailOriginFor(viewport);
    if (previous !== null) {
      const shift = origin.x - previous.x;
      assert.ok(shift === 0 || shift === 1, `shift ${shift}`);
      total += shift;
    }
    previous = origin;
  }
  assert.equal(total, 30);
});

test('trails_decay.wgsl reads the previous scene at the shifted texel and treats texels from outside as empty', () => {
  const source = readFileSync(new URL('../../src/render/shaders/trails_decay.wgsl', import.meta.url), 'utf8');
  assert.match(source, /vec2i\(position\.xy\) \+ vec2i\(i32\(decayUniform\.shiftX\), i32\(decayUniform\.shiftY\)\)/);
  assert.match(source, /any\(source < vec2i\(0\)\) \|\| any\(source >= size\)/);
});
