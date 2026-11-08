import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, PRESET_ORDER, initialPresetFor, stepPreset } from '../../src/settings/presets.js';
import { agentBufferBytes } from '../../src/sim/layout.js';

const GIBIBYTE = 1024 * 1024 * 1024;

test('presets are ordered low to high with the specified values', () => {
  assert.deepEqual(PRESET_ORDER, ['phoneLow', 'phoneHigh', 'desktop', 'desktopUltra']);
  assert.deepEqual(PRESETS.phoneLow, { capacity: 65536, particleCapacity: 32768, neighborRadius: 0.12, bloomQuality: 'low', simulationRate: 'half' });
  assert.deepEqual(PRESETS.phoneHigh, { capacity: 131072, particleCapacity: 65536, neighborRadius: 0.1, bloomQuality: 'medium', simulationRate: 'full' });
  assert.deepEqual(PRESETS.desktop, { capacity: 524288, particleCapacity: 131072, neighborRadius: 0.1, bloomQuality: 'high', simulationRate: 'full' });
  assert.deepEqual(PRESETS.desktopUltra, { capacity: 2097152, particleCapacity: 262144, neighborRadius: 0.08, bloomQuality: 'high', simulationRate: 'full' });
});

test('initial preset: mobile gets phoneLow, desktop gets desktop', () => {
  assert.equal(initialPresetFor({ isMobile: true, maxStorageBufferBindingSize: GIBIBYTE }), 'phoneLow');
  assert.equal(initialPresetFor({ isMobile: false, maxStorageBufferBindingSize: GIBIBYTE }), 'desktop');
});

test('initial preset never exceeds half the binding limit', () => {
  const limit = 64 * 1024 * 1024;
  const name = initialPresetFor({ isMobile: false, maxStorageBufferBindingSize: limit });
  assert.equal(name, 'desktop');
  assert.ok(agentBufferBytes(PRESETS[name].capacity) <= limit / 2);
  assert.ok(agentBufferBytes(PRESETS.desktopUltra.capacity) > limit / 2);
  const tiny = initialPresetFor({ isMobile: false, maxStorageBufferBindingSize: 8 * 1024 * 1024 });
  assert.equal(tiny, 'phoneHigh');
  assert.equal(initialPresetFor({ isMobile: true, maxStorageBufferBindingSize: 1024 }), 'phoneLow');
});

test('stepPreset moves one rung and clamps at both ends', () => {
  assert.equal(stepPreset('phoneLow', 'up'), 'phoneHigh');
  assert.equal(stepPreset('desktop', 'down'), 'phoneHigh');
  assert.equal(stepPreset('phoneLow', 'down'), 'phoneLow');
  assert.equal(stepPreset('desktopUltra', 'up'), 'desktopUltra');
});
