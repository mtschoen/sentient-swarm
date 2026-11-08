import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotateOverlay } from '../../src/ui/rotateOverlay.js';

function fakeDocument() {
  return { createElement: () => ({ hidden: false, textContent: '', children: [], setAttribute() {}, append() {}, classList: { add() {} } }) };
}

function setup({ isMobile, portrait, lock } = {}) {
  const state = { portrait, lockCalls: 0 };
  const screenObject = {
    orientation: { lock: (orientation) => { state.lockCalls += 1; state.lastOrientation = orientation; return lock ? lock() : Promise.resolve(); } },
  };
  const matchMedia = (query) => ({ matches: query.includes('portrait') ? state.portrait : false });
  const overlay = createRotateOverlay({ screenObject, matchMedia, isMobile, documentObject: fakeDocument() });
  return { overlay, state };
}

test('update is true for a mobile device in portrait and false in landscape', () => {
  const { overlay, state } = setup({ isMobile: true, portrait: true });
  assert.equal(overlay.update(), true);
  assert.equal(overlay.element.hidden, false);
  state.portrait = false;
  assert.equal(overlay.update(), false);
  assert.equal(overlay.element.hidden, true);
});

test('update is false for a desktop in portrait', () => {
  const { overlay } = setup({ isMobile: false, portrait: true });
  assert.equal(overlay.update(), false);
  assert.equal(overlay.element.hidden, true);
});

test('the landscape lock is attempted once however often update runs', () => {
  const { overlay, state } = setup({ isMobile: true, portrait: true });
  overlay.update();
  overlay.update();
  overlay.update();
  assert.equal(state.lockCalls, 1);
  assert.equal(state.lastOrientation, 'landscape');
});

test('a rejected lock is ignored, and so is a lock that throws or is missing', async () => {
  const rejecting = setup({ isMobile: true, portrait: true, lock: () => Promise.reject(new Error('NotSupportedError')) });
  assert.equal(rejecting.overlay.update(), true);
  await new Promise((resolve) => setImmediate(resolve));
  const throwing = setup({ isMobile: true, portrait: false, lock: () => { throw new Error('boom'); } });
  assert.equal(throwing.overlay.update(), false);
  const missing = createRotateOverlay({ screenObject: {}, matchMedia: () => ({ matches: true }), isMobile: true, documentObject: fakeDocument() });
  assert.equal(missing.update(), true);
});
