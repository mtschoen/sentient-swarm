import test from 'node:test';
import assert from 'node:assert/strict';
import { createInput } from '../../src/input/input.js';

function createFakeCanvas(width = 1000, height = 500) {
  const canvas = new EventTarget();
  canvas.clientWidth = width;
  canvas.clientHeight = height;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
  return canvas;
}

function createFixture() {
  const canvas = createFakeCanvas();
  const windowObject = new EventTarget();
  const gamepads = [null];
  const navigatorObject = { getGamepads: () => gamepads };
  const viewport = { inspectZoom: 1, screenToWorld: (x, y) => ({ x: x / 100, y: y / 100 }) };
  const input = createInput(canvas, viewport, { windowObject, navigatorObject });
  return { canvas, windowObject, gamepads, viewport, input };
}

function touchEvent(type, touches) {
  const event = new Event(type, { cancelable: true });
  event.changedTouches = touches;
  event.touches = touches;
  return event;
}

function pointerEvent(type, fields) {
  const event = new Event(type, { cancelable: true });
  return Object.assign(event, { pointerType: 'mouse', ...fields });
}

test('left-half touch drags the move stick from a floating origin', () => {
  const { canvas, input } = createFixture();
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 200, clientY: 250 }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 240, clientY: 250 }]));
  input.update();
  assert.ok(input.state.move.x > 0);
  assert.ok(Math.abs(input.state.move.x - 40 / 60) < 1e-9);
  assert.equal(input.state.firing, false);
});

test('right-half touch aims and fires, release clears both', () => {
  const { canvas, input } = createFixture();
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientX: 700, clientY: 250 }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 2, clientX: 700, clientY: 290 }]));
  input.update();
  assert.equal(input.state.firing, true);
  assert.ok(input.state.aim.x !== 0 || input.state.aim.y !== 0);
  canvas.dispatchEvent(touchEvent('touchend', [{ identifier: 2, clientX: 700, clientY: 290 }]));
  input.update();
  assert.equal(input.state.firing, false);
  assert.deepEqual(input.state.aim, { x: 0, y: 0 });
});

test('touch stick values clamp to unit length', () => {
  const { canvas, input } = createFixture();
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 100, clientY: 250 }]));
  canvas.dispatchEvent(touchEvent('touchmove', [{ identifier: 1, clientX: 400, clientY: 250 }]));
  input.update();
  assert.ok(Math.abs(input.state.move.x - 1) < 1e-9);
});

test('gamepad dead zone zeroes a 0.1 stick and a 0.6 right stick fires', () => {
  const { gamepads, input } = createFixture();
  gamepads[0] = { axes: [0.1, 0, 0.6, 0], buttons: [{ pressed: false }] };
  input.update();
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
  assert.equal(input.state.firing, true);
  assert.ok(input.state.aim.x > 0);
  assert.equal(input.state.bomb, false);
  gamepads[0] = { axes: [0, 0, 0.1, 0], buttons: [{ pressed: true }] };
  input.update();
  assert.equal(input.state.firing, false);
  assert.equal(input.state.bomb, true);
});

test('pointer converts to world, tracks primary button and right-button zoom', () => {
  const { canvas, windowObject, viewport, input } = createFixture();
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 100 }));
  input.update();
  assert.deepEqual(input.state.pointerWorld, { x: 3, y: 1 });
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 0 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, true);
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 2 }));
  assert.equal(viewport.inspectZoom, 4);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 2 }));
  assert.equal(viewport.inspectZoom, 1);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 0 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, false);
  const menu = new Event('contextmenu', { cancelable: true });
  canvas.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
});

test('dispose removes every listener', () => {
  const { canvas, windowObject, input } = createFixture();
  input.dispose();
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientX: 700, clientY: 250 }]));
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 1, clientY: 1, button: 0 }));
  input.update();
  assert.equal(input.state.firing, false);
  assert.equal(input.state.pointerPrimaryDown, false);
  const menu = new Event('contextmenu', { cancelable: true });
  canvas.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 0 }));
});

function keyEvent(type, key, target = null) {
  const event = Object.assign(new Event(type), { key });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

test('WASD and arrow keys move, diagonals stay unit length, release stops', () => {
  const { windowObject, input } = createFixture();
  windowObject.dispatchEvent(keyEvent('keydown', 'd'));
  input.update();
  assert.deepEqual(input.state.move, { x: 1, y: 0 });
  windowObject.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
  input.update();
  assert.ok(Math.abs(Math.hypot(input.state.move.x, input.state.move.y) - 1) < 1e-9);
  assert.ok(input.state.move.y < 0);
  windowObject.dispatchEvent(keyEvent('keyup', 'd'));
  windowObject.dispatchEvent(keyEvent('keyup', 'ArrowUp'));
  input.update();
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
});

test('keys typed into a form field do not move, blur releases held keys', () => {
  const { windowObject, input } = createFixture();
  windowObject.dispatchEvent(keyEvent('keydown', 'a', { tagName: 'INPUT' }));
  input.update();
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
  windowObject.dispatchEvent(keyEvent('keydown', 'a'));
  windowObject.dispatchEvent(new Event('blur'));
  input.update();
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
});

test('dispose removes the keyboard listeners', () => {
  const { windowObject, input } = createFixture();
  input.dispose();
  windowObject.dispatchEvent(keyEvent('keydown', 'w'));
  input.update();
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
});
