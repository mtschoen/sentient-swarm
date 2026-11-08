import test from 'node:test';
import assert from 'node:assert/strict';
import { createTouchOverlay, withHaptics } from '../../src/ui/touchOverlay.js';

test('bomb and death vibrate for ten milliseconds and still reach the effects', () => {
  const calls = [];
  const effects = { bomb: () => calls.push('bomb'), death: () => calls.push('death'), kills: (count) => calls.push(`kills ${count}`) };
  const wrapped = withHaptics(effects, { vibrate: (milliseconds) => calls.push(`vibrate ${milliseconds}`) });
  wrapped.bomb();
  wrapped.death();
  wrapped.kills(3);
  assert.deepEqual(calls, ['vibrate 10', 'bomb', 'vibrate 10', 'death', 'kills 3']);
});

test('withHaptics works when vibrate is unavailable', () => {
  const calls = [];
  const wrapped = withHaptics({ bomb: () => calls.push('bomb') }, {});
  wrapped.bomb();
  assert.deepEqual(calls, ['bomb']);
});

test('withHaptics also rumbles the gamepad on bomb, death and pickup', () => {
  const calls = [];
  const rumble = { bomb: () => calls.push('rumble bomb'), death: () => calls.push('rumble death'), pickup: () => calls.push('rumble pickup') };
  const effects = { bomb() {}, death() {}, pickup() {}, kills() {} };
  const wrapped = withHaptics(effects, {}, rumble);
  wrapped.bomb();
  wrapped.death();
  wrapped.pickup();
  wrapped.kills(2);
  assert.deepEqual(calls, ['rumble bomb', 'rumble death', 'rumble pickup']);
});

function createFakeOverlayDocument() {
  return {
    createElement: () => ({
      hidden: false, className: '', textContent: '', style: {}, attributes: {}, listeners: {},
      classList: { toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    }),
  };
}

test('the bomb button lets go of a held bomb when it hides as the phase leaves playing', () => {
  const touch = {
    origins: { move: null, aim: null }, move: { x: 0, y: 0 }, aim: { x: 0, y: 0 }, radius: 60,
    held: false, pressBomb() { this.held = true; }, releaseBomb() { this.held = false; },
  };
  const overlay = createTouchOverlay({ append() {} }, {
    touch, canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, documentObject: createFakeOverlayDocument(),
  });
  overlay.update({ phase: 'playing', bombs: 2 });
  overlay.bombButton.listeners.touchstart({});
  overlay.update({ phase: 'playing', bombs: 2 });
  assert.equal(touch.held, true, 'held while playing');
  overlay.update({ phase: 'dying', bombs: 2 });
  assert.equal(overlay.bombButton.hidden, true);
  assert.equal(touch.held, false, 'released when hidden');
});
