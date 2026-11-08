import test from 'node:test';
import assert from 'node:assert/strict';
import { createTouchSource } from '../../src/input/touch.js';
import { createInput } from '../../src/input/input.js';

function createFakeCanvas(exclusiveRectangles = []) {
  const canvas = new EventTarget();
  canvas.clientWidth = 1000;
  canvas.clientHeight = 500;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  // The overlay and the HUD mark their elements data-touch-exclusive; the source looks them up
  // through the canvas's document and tests each touch point against their rectangles.
  canvas.ownerDocument = {
    querySelectorAll: (selector) => (selector === '[data-touch-exclusive]'
      ? exclusiveRectangles.map((rectangle) => ({ getBoundingClientRect: () => rectangle }))
      : []),
  };
  return canvas;
}

function touchEvent(type, touches) {
  const event = new Event(type, { cancelable: true });
  event.changedTouches = touches;
  event.touches = touches;
  return event;
}

const exclusiveTarget = { closest: (selector) => (selector === '[data-touch-exclusive]' ? {} : null) };

test('a touch that starts on an exclusive element yields no stick', () => {
  const canvas = createFakeCanvas();
  const source = createTouchSource(canvas);
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 800, clientY: 250, target: exclusiveTarget }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 840, clientY: 250, target: exclusiveTarget }]));
  assert.equal(source.firing, false);
  assert.equal(source.touching, false);
  assert.deepEqual(source.aim, { x: 0, y: 0 });
  assert.equal(source.origins.aim, null);
});

test('a touch that lands inside an exclusive rectangle (the HUD) yields no stick', () => {
  const canvas = createFakeCanvas([{ left: 900, top: 0, right: 1000, bottom: 80, width: 100, height: 80 }]);
  const source = createTouchSource(canvas);
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 950, clientY: 40 }]));
  assert.equal(source.firing, false);
  assert.equal(source.touching, false);
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientX: 950, clientY: 200 }]));
  assert.equal(source.firing, true);
});

test('a right-half touch produces aim and fires', () => {
  const canvas = createFakeCanvas();
  const source = createTouchSource(canvas);
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 700, clientY: 250 }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 700, clientY: 280 }]));
  assert.equal(source.firing, true);
  assert.deepEqual(source.origins.aim, { x: 700, y: 250 });
  assert.ok(source.aim.y > 0.4 && source.aim.y < 0.6);
  assert.deepEqual(source.move, { x: 0, y: 0 });
});

test('two simultaneous touches drive both sticks', () => {
  const canvas = createFakeCanvas();
  const source = createTouchSource(canvas);
  canvas.dispatchEvent(touchEvent('touchstart', [
    { identifier: 1, clientX: 200, clientY: 250 },
    { identifier: 2, clientX: 800, clientY: 250 },
  ]));
  canvas.dispatchEvent(touchEvent('touchmove', [
    { identifier: 1, clientX: 230, clientY: 250 },
    { identifier: 2, clientX: 800, clientY: 220 },
  ]));
  assert.ok(source.move.x > 0.4 && source.aim.y < -0.4);
  assert.notEqual(source.origins.move, null);
  assert.notEqual(source.origins.aim, null);
  canvas.dispatchEvent(touchEvent('touchend', [{ identifier: 1, clientX: 230, clientY: 250 }]));
  assert.equal(source.origins.move, null);
  assert.ok(source.aim.y < -0.4);
});

test('the bomb button press survives a release before the next input sample', () => {
  const canvas = createFakeCanvas();
  const windowObject = new EventTarget();
  const input = createInput(canvas, { inspectZoom: 1, screenToWorld: () => ({ x: 0, y: 0 }) }, { windowObject, navigatorObject: { getGamepads: () => [null] } });
  input.touch.pressBomb();
  input.touch.releaseBomb();
  input.update();
  assert.equal(input.state.bomb, true);
  input.update();
  assert.equal(input.state.bomb, false);
  assert.deepEqual(input.state.aim, { x: 0, y: 0 });
  assert.equal(input.state.firing, false);
});

test('setTuning applies the stick dead zone and radius', () => {
  const canvas = createFakeCanvas();
  const source = createTouchSource(canvas);
  source.setTuning({ deadZone: 0.25, radius: 100 });
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 800, clientY: 250 }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 810, clientY: 250 }]));
  assert.deepEqual(source.aim, { x: 0, y: 0 });
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 900, clientY: 250 }]));
  assert.equal(source.aim.x, 1);
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 850, clientY: 250 }]));
  assert.ok(source.aim.x > 0.3 && source.aim.x < 0.4, String(source.aim.x));
});
