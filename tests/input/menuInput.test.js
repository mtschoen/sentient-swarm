import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuInput } from '../../src/input/menuInput.js';

function setup() {
  const listeners = {};
  const windowObject = {
    addEventListener: (type, listener) => { (listeners[type] ??= new Set()).add(listener); },
    removeEventListener: (type, listener) => listeners[type]?.delete(listener),
  };
  const pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  const navigatorObject = { getGamepads: () => [pad] };
  const press = (key, target = {}) => [...(listeners.keydown ?? [])].forEach((listener) => listener({ key, target, repeat: false }));
  return { input: createMenuInput({ windowObject, navigatorObject }), pad, press, listeners };
}

test('keyboard arrows, Enter, Space and Escape become menu actions in order', () => {
  const { input, press } = setup();
  ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Escape'].forEach((key) => press(key));
  assert.deepEqual(input.poll(), ['down', 'up', 'confirm', 'confirm', 'pause']);
  assert.deepEqual(input.poll(), [], 'drained');
});

test('keys typed into a form field are ignored', () => {
  const { input, press } = setup();
  press('ArrowDown', { tagName: 'INPUT' });
  assert.deepEqual(input.poll(), []);
});

test('gamepad d-pad and face buttons fire once per press (edge detected)', () => {
  const { input, pad } = setup();
  input.poll();
  pad.buttons[13].pressed = true;
  assert.deepEqual(input.poll(), ['down']);
  assert.deepEqual(input.poll(), [], 'held does not repeat');
  pad.buttons[13].pressed = false;
  input.poll();
  pad.buttons[0].pressed = true;
  assert.deepEqual(input.poll(), ['confirm']);
  pad.buttons[0].pressed = false;
  pad.buttons[2].pressed = true;
  assert.deepEqual(input.poll(), ['altConfirm']);
  pad.buttons[2].pressed = false;
  pad.buttons[1].pressed = true;
  assert.deepEqual(input.poll(), ['back', 'altConfirm']);
});

test('the Options button (9) pauses', () => {
  const { input, pad } = setup();
  input.poll();
  pad.buttons[9].pressed = true;
  assert.deepEqual(input.poll(), ['pause']);
  assert.deepEqual(input.poll(), []);
});

test('the left stick navigates with edge detection past a threshold', () => {
  const { input, pad } = setup();
  input.poll();
  pad.axes[1] = 0.9;
  assert.deepEqual(input.poll(), ['down']);
  assert.deepEqual(input.poll(), []);
  pad.axes[1] = 0.1;
  input.poll();
  pad.axes[1] = -0.9;
  assert.deepEqual(input.poll(), ['up']);
});

test('a button already held when polling begins does not fire', () => {
  const { input, pad } = setup();
  pad.buttons[0].pressed = true;
  assert.deepEqual(input.poll(), []);
});

test('dispose removes the key listener', () => {
  const { input, listeners } = setup();
  input.dispose();
  assert.equal(listeners.keydown.size, 0);
});

function twoPadSetup() {
  const windowObject = { addEventListener() {}, removeEventListener() {} };
  const makePad = (index) => ({ index, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) });
  const first = makePad(0);
  const second = makePad(1);
  const navigatorObject = { getGamepads: () => [first, second] };
  return { input: createMenuInput({ windowObject, navigatorObject }), first, second };
}

test('without an extra pad a second pad gives no menu actions; with it, its Options pauses and the same button on two pads is two presses', () => {
  const { input, first, second } = twoPadSetup();
  input.poll();
  second.buttons[9].pressed = true;
  assert.deepEqual(input.poll(), []);
  second.buttons[9].pressed = false;
  input.poll();
  input.setExtraPad(1);
  input.poll();
  second.buttons[9].pressed = true;
  assert.deepEqual(input.poll(), ['pause']);
  second.buttons[9].pressed = false;
  input.poll();
  first.buttons[0].pressed = true;
  second.buttons[0].pressed = true;
  assert.deepEqual(input.poll(), ['confirm', 'confirm']);
});

test('a button held on the extra pad when it is set gives no action until released and pressed again', () => {
  const { input, first, second } = twoPadSetup();
  input.poll();
  first.buttons[1].pressed = true;
  second.buttons[5].pressed = true;
  second.buttons[0].pressed = true;
  assert.deepEqual(input.poll(), ['back', 'altConfirm']);
  input.setExtraPad(1);
  assert.deepEqual(input.poll(), []);
  second.buttons[0].pressed = false;
  input.poll();
  second.buttons[0].pressed = true;
  assert.deepEqual(input.poll(), ['confirm']);
});
