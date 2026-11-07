import test from 'node:test';
import assert from 'node:assert/strict';
import { MAXIMUM_TRAIL_DELTA_SECONDS, trailFrameFactors } from '../../src/render/trails.js';

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
