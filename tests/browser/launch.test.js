import test from 'node:test';
import assert from 'node:assert/strict';
import { webGpuFlagsFor, fallbackAdapterInitScript } from './launch.mjs';

const WIN32_EXPECTED = [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--use-angle=d3d11',
  '--ignore-gpu-blocklist',
  '--disable-dawn-features=use_dxc',
  '--mute-audio',
];

test('win32 flags are the long-standing list', () => {
  assert.deepEqual(webGpuFlagsFor({ platform: 'win32', measuring: false }), WIN32_EXPECTED);
});

test('linux flags follow Chrome guidance for Vulkan', () => {
  assert.deepEqual(webGpuFlagsFor({ platform: 'linux', measuring: false }), [
    '--headless=new',
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--disable-vulkan-surface',
    '--ignore-gpu-blocklist',
    '--mute-audio',
  ]);
});

test('measuring appends the uncapped frame flags on every platform', () => {
  for (const platform of ['win32', 'linux']) {
    const flags = webGpuFlagsFor({ platform, measuring: true });
    assert.deepEqual(flags.slice(-2), ['--disable-gpu-vsync', '--disable-frame-rate-limit']);
    assert.deepEqual(flags.slice(0, -2), webGpuFlagsFor({ platform, measuring: false }));
  }
});

test('flag lists are fresh copies', () => {
  const first = webGpuFlagsFor({ platform: 'win32' });
  first.push('--extra');
  assert.deepEqual(webGpuFlagsFor({ platform: 'win32' }), WIN32_EXPECTED);
});

test('the fallback init script exists only with WEBGPU_ADAPTER=fallback', () => {
  assert.equal(fallbackAdapterInitScript({}), null);
  assert.equal(fallbackAdapterInitScript({ WEBGPU_ADAPTER: 'hardware' }), null);
  const script = fallbackAdapterInitScript({ WEBGPU_ADAPTER: 'fallback' });
  assert.match(script, /forceFallbackAdapter: true/);
  assert.match(script, /requestAdapter/);
});
