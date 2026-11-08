import test from 'node:test';
import assert from 'node:assert/strict';
import { QualityController, adapterKeyFrom, detectMobile, resolveInitialPreset, settleApply } from '../../src/game/quality.js';
import { PRESETS } from '../../src/settings/presets.js';
import { SettingsStore } from '../../src/settings/storage.js';
import { agentBufferBytes } from '../../src/sim/layout.js';

const GIBIBYTE = 1024 * 1024 * 1024;

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
  };
}

// Scripted probe: each recordFrame returns the next queued decision (null when none).
function fakeProbe() {
  return {
    decisions: [],
    frames: [],
    resets: 0,
    recordFrame(frameMilliseconds, nowSeconds) {
      this.frames.push({ frameMilliseconds, nowSeconds });
      return this.decisions.shift() ?? null;
    },
    reset() { this.resets += 1; },
  };
}

// Same members QualityController uses on Game, Simulation, ParticlePool and Renderer.
function fakeGame(preset = PRESETS.desktop) {
  const calls = [];
  const game = {
    calls,
    acceptsProbeFrames: true,
    simulation: {
      capacity: preset.capacity,
      particlePool: {
        capacity: preset.particleCapacity,
        resize(capacity) { calls.push(['resizeParticles', capacity]); this.capacity = capacity; },
      },
    },
    renderer: {
      bloomQuality: preset.bloomQuality,
      setBloomQuality(quality) { calls.push(['setBloomQuality', quality]); this.bloomQuality = quality; },
    },
    simulationRate: preset.simulationRate,
    async setCapacity(capacity, options) {
      calls.push(['setCapacity', capacity, options]);
      this.simulation.capacity = capacity;
      this.simulation.particlePool.capacity = options.particleCapacity;
      return true;
    },
    setSimulationRate(rate) { calls.push(['setSimulationRate', rate]); this.simulationRate = rate; },
  };
  return game;
}

function createController({ initial = 'desktop', allowUp = true, ceiling } = {}) {
  const game = fakeGame(PRESETS[initial]);
  const store = new SettingsStore({ storage: fakeStorage() });
  const probe = fakeProbe();
  const controller = new QualityController({ game, store, probe, adapterKey: 'vendor|arch|device|desc', ceiling });
  controller.start(initial, { allowUp });
  game.calls.length = 0;
  return { controller, game, store, probe };
}

test('start configures bloom and simulation rate without a capacity swap', () => {
  const game = fakeGame(PRESETS.desktop);
  const controller = new QualityController({ game, store: new SettingsStore({ storage: fakeStorage() }), probe: fakeProbe() });
  controller.start('phoneLow');
  assert.equal(controller.current, 'phoneLow');
  assert.deepEqual(game.calls, [['setBloomQuality', 'low'], ['setSimulationRate', 'half']]);
});

test('a first down halves particles and lowers bloom inside the preset; a second down steps the preset', async () => {
  const { controller, game, probe } = createController();
  probe.decisions.push('down');
  assert.equal(controller.onFrame(30, 10), 'down');
  assert.deepEqual(game.calls, [['resizeParticles', PRESETS.desktop.particleCapacity / 2], ['setBloomQuality', 'medium']]);
  assert.equal(controller.current, 'desktop');
  assert.equal(controller.reduced, true);

  game.calls.length = 0;
  probe.decisions.push('down');
  controller.onFrame(30, 14);
  await controller.settled;
  assert.equal(controller.current, 'phoneHigh');
  assert.equal(controller.reduced, false);
  const { capacity, particleCapacity, neighborRadius } = PRESETS.phoneHigh;
  assert.deepEqual(game.calls[0], ['setCapacity', capacity, { neighborRadius, particleCapacity }]);
  assert.deepEqual(game.calls.slice(1), [['setBloomQuality', 'medium'], ['setSimulationRate', 'full']]);
});

test('a down at the lowest preset, already reduced, changes nothing', async () => {
  const { controller, game, probe } = createController({ initial: 'phoneLow' });
  probe.decisions.push('down', 'down');
  controller.onFrame(30, 10);
  game.calls.length = 0;
  controller.onFrame(30, 14);
  await controller.settled;
  assert.deepEqual(game.calls, []);
  assert.equal(controller.current, 'phoneLow');
});

test('apply persists the preset with the adapter key', async () => {
  const { controller, store } = createController();
  assert.equal(await controller.apply('phoneHigh'), true);
  const saved = store.load();
  assert.equal(saved.preset, 'phoneHigh');
  assert.equal(saved.adapterKey, 'vendor|arch|device|desc');
});

test('apply does not persist when setCapacity resolves false', async () => {
  const { controller, game, store } = createController();
  game.setCapacity = async (capacity, options) => {
    game.calls.push(['setCapacity', capacity, options]);
    return false;
  };
  assert.equal(await controller.apply('phoneHigh'), false);
  assert.equal(store.load().preset, null);
  assert.equal(controller.current, 'desktop');
  assert.deepEqual(game.calls.map(([name]) => name), ['setCapacity'], 'nothing else of the preset is applied');
  assert.equal(controller.applying, false);
});

test('a timed-out swap rejects apply, which the probe path reports as a warning', async () => {
  const { controller, game, store, probe } = createController();
  game.setCapacity = async () => {
    const error = new Error('Capacity swap did not settle within 10000 ms');
    error.name = 'CapacitySwapTimeout';
    throw error;
  };
  await assert.rejects(controller.apply('phoneHigh'), (error) => error.name === 'CapacitySwapTimeout');
  assert.equal(controller.applying, false);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    probe.decisions.push('down', 'down');
    controller.onFrame(30, 10);
    controller.onFrame(30, 14);
    assert.equal(await controller.settled, false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /phoneHigh could not be applied: Capacity swap did not settle/);
  assert.equal(store.load().preset, null);
});

test('apply of the current preset is a no-op', async () => {
  const { controller, game, store } = createController();
  assert.equal(await controller.apply('desktop'), false);
  assert.deepEqual(game.calls, []);
  assert.equal(store.load().preset, null);
});

test('apply of the current preset after a down restores its full budgets', async () => {
  const { controller, game, probe } = createController();
  probe.decisions.push('down');
  controller.onFrame(30, 10);
  assert.equal(await controller.apply('desktop'), true);
  assert.equal(game.simulation.particlePool.capacity, PRESETS.desktop.particleCapacity);
  assert.equal(game.renderer.bloomQuality, 'high');
  assert.equal(controller.reduced, false);
});

test('an unknown preset name is rejected', async () => {
  const { controller } = createController();
  await assert.rejects(controller.apply('phoneMedium'), /Unknown preset/);
});

test('up steps only when allowed and never past the ceiling', async () => {
  const locked = createController({ allowUp: false });
  locked.probe.decisions.push('up');
  locked.controller.onFrame(4, 10);
  await locked.controller.settled;
  assert.equal(locked.controller.current, 'desktop');
  assert.deepEqual(locked.game.calls, []);

  const capped = createController({ ceiling: 'desktop' });
  capped.probe.decisions.push('up');
  capped.controller.onFrame(4, 10);
  await capped.controller.settled;
  assert.equal(capped.controller.current, 'desktop');

  const open = createController();
  open.probe.decisions.push('up');
  open.controller.onFrame(4, 10);
  await open.controller.settled;
  assert.equal(open.controller.current, 'desktopUltra');
});

test('an up while reduced first restores the current preset', async () => {
  const { controller, game, probe } = createController();
  probe.decisions.push('down', 'up');
  controller.onFrame(30, 10);
  controller.onFrame(4, 14);
  await controller.settled;
  assert.equal(controller.current, 'desktop');
  assert.equal(controller.reduced, false);
  assert.equal(game.simulation.particlePool.capacity, PRESETS.desktop.particleCapacity);
});

test('frames are not recorded unless the game accepts them, nor while a preset is applying', async () => {
  const { controller, game, probe } = createController();
  game.acceptsProbeFrames = false;
  controller.onFrame(30, 10);
  assert.equal(probe.frames.length, 0);
  game.acceptsProbeFrames = true;
  const applying = controller.apply('phoneHigh');
  controller.onFrame(30, 11);
  assert.equal(probe.frames.length, 0);
  await applying;
  controller.onFrame(30, 12);
  assert.equal(probe.frames.length, 1);
});

test('rerunProbe allows up steps again and restarts the probe', async () => {
  const { controller, probe } = createController({ allowUp: false });
  controller.rerunProbe();
  assert.equal(probe.resets, 1);
  probe.decisions.push('up');
  controller.onFrame(4, 10);
  await controller.settled;
  assert.equal(controller.current, 'desktopUltra');
});

test('resolveInitialPreset starts at a stored preset for this adapter and then only steps down', () => {
  const adapterKey = 'a|b|c|d';
  const base = { adapterKey, isMobile: false, maxStorageBufferBindingSize: GIBIBYTE };
  assert.deepEqual(resolveInitialPreset({ ...base, settings: { preset: 'phoneHigh', adapterKey } }), { name: 'phoneHigh', allowUp: false, ceiling: 'desktopUltra' });
  assert.deepEqual(resolveInitialPreset({ ...base, settings: { preset: 'phoneHigh', adapterKey: 'other' } }), { name: 'desktop', allowUp: true, ceiling: 'desktopUltra' });
  assert.deepEqual(resolveInitialPreset({ ...base, settings: { preset: null, adapterKey: null } }), { name: 'desktop', allowUp: true, ceiling: 'desktopUltra' });
  assert.deepEqual(resolveInitialPreset({ ...base, settings: { preset: 'phoneMedium', adapterKey } }), { name: 'desktop', allowUp: true, ceiling: 'desktopUltra' });
});

test('resolveInitialPreset caps the ceiling and a stored preset at the binding limit', () => {
  const limit = 64 * 1024 * 1024;
  assert.ok(agentBufferBytes(PRESETS.desktopUltra.capacity) > limit / 2);
  const settings = { preset: 'desktopUltra', adapterKey: 'k' };
  assert.deepEqual(resolveInitialPreset({ settings, adapterKey: 'k', isMobile: false, maxStorageBufferBindingSize: limit }), { name: 'desktop', allowUp: false, ceiling: 'desktop' });
});

test('detectMobile prefers userAgentData and falls back to a coarse pointer with touch points', () => {
  const fine = () => ({ matches: false });
  const coarse = () => ({ matches: true });
  assert.equal(detectMobile({ navigatorObject: { userAgentData: { mobile: true }, maxTouchPoints: 0 }, matchMedia: fine }), true);
  assert.equal(detectMobile({ navigatorObject: { userAgentData: { mobile: false }, maxTouchPoints: 5 }, matchMedia: coarse }), false);
  assert.equal(detectMobile({ navigatorObject: { maxTouchPoints: 5 }, matchMedia: coarse }), true);
  assert.equal(detectMobile({ navigatorObject: { maxTouchPoints: 5 }, matchMedia: fine }), false);
  assert.equal(detectMobile({ navigatorObject: { maxTouchPoints: 0 }, matchMedia: coarse }), false);
  assert.equal(detectMobile({ navigatorObject: {}, matchMedia: undefined }), false);
});

test('adapterKeyFrom joins vendor, architecture, device and description', () => {
  assert.equal(adapterKeyFrom({ vendor: 'nvidia', architecture: 'ampere', device: '2204', description: 'RTX 3090' }), 'nvidia|ampere|2204|RTX 3090');
  assert.equal(adapterKeyFrom({ vendor: 'apple' }), 'apple|||');
  assert.equal(adapterKeyFrom(undefined), 'unknown');
});

test('a preset swap settling applies the live settings, not the snapshot', async () => {
  const { controller } = createController();
  let live = { preset: 'desktopUltra', music: 10 };
  const applied = [];
  const settlePreset = settleApply({ quality: controller, liveSettings: () => live, applySettings: (value) => applied.push(value) });
  const snapshot = live;
  const settled = settlePreset(snapshot);
  live = { preset: 'desktopUltra', music: 90 };
  await settled;
  assert.deepEqual(applied, [live]);
  assert.notEqual(applied[0], snapshot);
  assert.equal(controller.current, 'desktopUltra');
  // The preset now in effect is not re-applied by a later slider move.
  assert.equal(settlePreset(live), null);
  assert.equal(settlePreset({ preset: null }), null);
});

test('a preset swap that fails is swallowed and applies nothing', async () => {
  const { controller } = createController();
  const applied = [];
  const settlePreset = settleApply({ quality: controller, liveSettings: () => ({}), applySettings: (value) => applied.push(value) });
  await settlePreset({ preset: 'phoneMedium' });
  assert.deepEqual(applied, []);
});
