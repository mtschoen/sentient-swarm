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

// The right-button inspect zoom is a lab feature (viewport.inspectZoomEnabled, off in play); most
// pointer tests run with it on, as in the lab.
function createFixture({ inspectZoomEnabled = true } = {}) {
  const canvas = createFakeCanvas();
  const windowObject = new EventTarget();
  const gamepads = [null];
  const navigatorObject = { getGamepads: () => gamepads };
  const viewport = { inspectZoom: 1, inspectZoomEnabled, screenToWorld: (x, y) => ({ x: x / 100, y: y / 100 }) };
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
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 100, buttons: 0 }));
  input.update();
  assert.deepEqual(input.state.pointerWorld, { x: 3, y: 1 });
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 0, buttons: 1 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, true);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 0, buttons: 0 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, false);
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 2, buttons: 2 }));
  assert.equal(viewport.inspectZoom, 4);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 2, buttons: 0 }));
  assert.equal(viewport.inspectZoom, 1);
  const menu = new Event('contextmenu', { cancelable: true });
  canvas.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, true);
});

test('outside the lab the right button bombs without zooming', () => {
  const { canvas, windowObject, viewport, input } = createFixture({ inspectZoomEnabled: false });
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 2, buttons: 2 }));
  input.update();
  assert.equal(input.state.bomb, true);
  assert.equal(viewport.inspectZoom, 1);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 2, buttons: 0 }));
  input.update();
  assert.equal(input.state.bomb, false);
  assert.equal(viewport.inspectZoom, 1);
});

test('chord: down 0, down 2, up 0 with buttons 2, up 2 ends neutral', () => {
  const { canvas, windowObject, viewport, input } = createFixture();
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, buttons: 1 }));
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 2, buttons: 3 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, true);
  assert.equal(viewport.inspectZoom, 4);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 0, buttons: 2 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, false);
  assert.equal(viewport.inspectZoom, 4);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 2, buttons: 0 }));
  input.update();
  assert.equal(input.state.pointerPrimaryDown, false);
  assert.equal(viewport.inspectZoom, 1);
});

test('chord as a browser sends it (inner changes arrive as pointermove) ends neutral in both orders', () => {
  for (const [first, second] of [[1, 2], [2, 1]]) {
    const { canvas, windowObject, viewport, input } = createFixture();
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: first === 1 ? 0 : 2, buttons: first }));
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 10, button: second === 1 ? 0 : 2, buttons: 3 }));
    input.update();
    assert.equal(input.state.pointerPrimaryDown, true);
    assert.equal(viewport.inspectZoom, 4);
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 10, button: first === 1 ? 0 : 2, buttons: second }));
    windowObject.dispatchEvent(pointerEvent('pointerup', { button: second === 1 ? 0 : 2, buttons: 0 }));
    input.update();
    assert.equal(input.state.pointerPrimaryDown, false, `order ${first} then ${second}`);
    assert.equal(viewport.inspectZoom, 1, `order ${first} then ${second}`);
  }
});

test('pointercancel, lostpointercapture and window blur each release both buttons', () => {
  for (const [target, type] of [['canvas', 'pointercancel'], ['canvas', 'lostpointercapture'], ['window', 'blur']]) {
    const fixture = createFixture();
    const { canvas, windowObject, viewport, input } = fixture;
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, buttons: 3 }));
    input.update();
    assert.equal(input.state.pointerPrimaryDown, true);
    const releaseEvent = type === 'blur' ? new Event('blur') : pointerEvent(type, { buttons: 0 });
    (target === 'canvas' ? canvas : windowObject).dispatchEvent(releaseEvent);
    input.update();
    assert.equal(input.state.pointerPrimaryDown, false, type);
    assert.equal(viewport.inspectZoom, 1, type);
  }
});

test('the world point is recomputed every update, so zoom and resize changes apply without a move', () => {
  const { canvas, viewport, input } = createFixture();
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 300, clientY: 100, buttons: 0 }));
  input.update();
  assert.deepEqual(input.state.pointerWorld, { x: 3, y: 1 });
  viewport.screenToWorld = (x, y) => ({ x: x / 50, y: y / 50 });
  input.update();
  assert.deepEqual(input.state.pointerWorld, { x: 6, y: 2 });
});

test('pointerdown captures the pointer so the release reaches the canvas', () => {
  const { canvas, input } = createFixture();
  const captured = [];
  canvas.setPointerCapture = (pointerId) => captured.push(pointerId);
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, buttons: 1, pointerId: 7 }));
  input.update();
  assert.deepEqual(captured, [7]);
});

test('dispose removes every listener', () => {
  const { canvas, windowObject, input } = createFixture();
  input.dispose();
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, clientX: 700, clientY: 250 }]));
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 1, clientY: 1, button: 0, buttons: 1 }));
  input.update();
  assert.equal(input.state.firing, false);
  assert.equal(input.state.pointerPrimaryDown, false);
  const menu = new Event('contextmenu', { cancelable: true });
  canvas.dispatchEvent(menu);
  assert.equal(menu.defaultPrevented, false);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 0, buttons: 0 }));
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

test('Space and the right mouse button hold the bomb button', () => {
  const { canvas, windowObject, input } = createFixture();
  const space = keyEvent('keydown', ' ');
  windowObject.dispatchEvent(space);
  input.update();
  assert.equal(input.state.bomb, true);
  windowObject.dispatchEvent(keyEvent('keyup', ' '));
  input.update();
  assert.equal(input.state.bomb, false);
  windowObject.dispatchEvent(keyEvent('keydown', ' ', { tagName: 'INPUT' }));
  input.update();
  assert.equal(input.state.bomb, false);
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, clientY: 100, button: 2, buttons: 2 }));
  input.update();
  assert.equal(input.state.bomb, true);
  windowObject.dispatchEvent(pointerEvent('pointerup', { button: 2, buttons: 0 }));
  input.update();
  assert.equal(input.state.bomb, false);
});

test('a stationary touch on either half reports touching until it ends', () => {
  const { canvas, input } = createFixture();
  input.update();
  assert.equal(input.state.touching, false);
  canvas.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, clientX: 200, clientY: 250 }]));
  input.update();
  assert.equal(input.state.touching, true);
  assert.deepEqual(input.state.move, { x: 0, y: 0 });
  canvas.dispatchEvent(touchEvent('touchend', [{ identifier: 1, clientX: 200, clientY: 250 }]));
  input.update();
  assert.equal(input.state.touching, false);
});

test('gamepad triggers (buttons 6 and 7) bomb like the face buttons', () => {
  const { gamepads, input } = createFixture();
  for (const triggerIndex of [6, 7]) {
    const buttons = Array.from({ length: 8 }, () => ({ pressed: false }));
    buttons[triggerIndex] = { pressed: true };
    gamepads[0] = { axes: [0, 0, 0, 0], buttons };
    input.update();
    assert.equal(input.state.bomb, true, `button ${triggerIndex}`);
  }
  gamepads[0] = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 8 }, (unused, index) => ({ pressed: index === 4 || index === 5 })) };
  input.update();
  assert.equal(input.state.bomb, false);
});
