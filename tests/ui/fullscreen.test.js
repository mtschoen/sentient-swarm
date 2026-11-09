import test from 'node:test';
import assert from 'node:assert/strict';
import { createFullscreenController } from '../../src/ui/fullscreen.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A document whose fullscreen state changes as a browser's would, firing fullscreenchange.
function setup({ enabled = true, request, hasApi = true, lock } = {}) {
  const state = { requests: [], exits: 0, lockCalls: [], externalExits: 0, listeners: [] };
  const documentObject = {
    fullscreenElement: null,
    documentElement: {},
    addEventListener: (type, listener) => { if (type === 'fullscreenchange') state.listeners.push(listener); },
    exitFullscreen: () => {
      state.exits += 1;
      state.leave();
      return Promise.resolve();
    },
  };
  state.change = () => state.listeners.forEach((listener) => listener());
  state.leave = () => { documentObject.fullscreenElement = null; state.change(); };
  if (hasApi) {
    documentObject.documentElement.requestFullscreen = (options) => {
      state.requests.push(options);
      if (request) return request();
      documentObject.fullscreenElement = documentObject.documentElement;
      state.change();
      return Promise.resolve();
    };
  }
  const screenObject = {
    orientation: { lock: (orientation) => { state.lockCalls.push(orientation); return lock ? lock() : Promise.resolve(); } },
  };
  const controller = createFullscreenController({
    enabled, documentObject, screenObject, onExternalExit: () => { state.externalExits += 1; },
  });
  return { controller, state, documentObject };
}

test('enter requests fullscreen without navigation UI, then locks landscape', async () => {
  const { controller, state } = setup();
  assert.equal(await controller.enter(), true);
  assert.deepEqual(state.requests, [{ navigationUI: 'hide' }]);
  assert.equal(controller.active, true);
  await settle();
  assert.deepEqual(state.lockCalls, ['landscape']);
});

test('enter while already fullscreen asks for nothing', async () => {
  const { controller, state } = setup();
  await controller.enter();
  assert.equal(await controller.enter(), true);
  assert.equal(state.requests.length, 1);
});

test('a disabled controller, or a browser without the API, never requests', async () => {
  const disabled = setup({ enabled: false });
  assert.equal(await disabled.controller.enter(), false);
  assert.equal(disabled.state.requests.length, 0);
  assert.equal(disabled.controller.supported, false);
  disabled.controller.exit();
  assert.equal(disabled.state.exits, 0);
  const missing = setup({ hasApi: false });
  assert.equal(await missing.controller.enter(), false);
  assert.equal(missing.controller.active, false);
});

test('a refused request (rejection or throw) resolves false and skips the lock', async () => {
  const rejecting = setup({ request: () => Promise.reject(new TypeError('no activation')) });
  assert.equal(await rejecting.controller.enter(), false);
  const throwing = setup({ request: () => { throw new Error('boom'); } });
  assert.equal(await throwing.controller.enter(), false);
  await settle();
  assert.deepEqual(rejecting.state.lockCalls, []);
  assert.deepEqual(throwing.state.lockCalls, []);
});

test('a refused landscape lock is ignored', async () => {
  const { controller } = setup({ lock: () => Promise.reject(new Error('NotSupportedError')) });
  assert.equal(await controller.enter(), true);
  await settle();
  assert.equal(controller.active, true);
});

test('exit leaves fullscreen once and is not an external exit', async () => {
  const { controller, state } = setup();
  controller.exit();
  assert.equal(state.exits, 0);
  await controller.enter();
  controller.exit();
  controller.exit();
  assert.equal(state.exits, 1);
  assert.equal(controller.active, false);
  assert.equal(state.externalExits, 0);
});

test('leaving fullscreen any other way reports an external exit, once per fullscreen session', async () => {
  const { controller, state } = setup();
  await controller.enter();
  state.leave();
  assert.equal(state.externalExits, 1);
  state.change();
  assert.equal(state.externalExits, 1);
  await controller.enter();
  controller.exit();
  await controller.enter();
  state.leave();
  assert.equal(state.externalExits, 2);
});

test('onRefused names why enter did not go fullscreen', async () => {
  const reasons = [];
  const build = (options, hasApi = true, request = null) => {
    const documentObject = { fullscreenElement: null, documentElement: hasApi ? { requestFullscreen: request ?? (() => Promise.resolve()) } : {}, addEventListener() {} };
    return createFullscreenController({ ...options, documentObject, screenObject: {}, onRefused: (reason) => reasons.push(reason) });
  };
  await build({ enabled: false }).enter();
  await build({ enabled: true }, false).enter();
  await build({ enabled: true }, true, () => Promise.reject(new TypeError('Permissions check failed'))).enter();
  await build({ enabled: true }, true, () => { throw new Error('boom'); }).enter();
  assert.deepEqual(reasons, ['not a touch device', 'no Fullscreen API', 'TypeError: Permissions check failed', 'Error: boom']);
});
