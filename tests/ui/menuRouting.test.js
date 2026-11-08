import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuInput } from '../../src/input/menuInput.js';
import { routeMenuActions } from '../../src/ui/menuRouting.js';

// The render loop's wiring (main.js): the real menu input, a settings panel that closes, and the
// menu dispatch that would pause or resume the run on 'pause'.
function setup({ open = true } = {}) {
  const listeners = {};
  const windowObject = {
    addEventListener: (type, listener) => { (listeners[type] ??= new Set()).add(listener); },
    removeEventListener: (type, listener) => listeners[type]?.delete(listener),
  };
  const pad = { axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false })) };
  const input = createMenuInput({ windowObject, navigatorObject: { getGamepads: () => [pad] } });
  const press = (key) => [...(listeners.keydown ?? [])].forEach((listener) => listener({ key, target: {}, repeat: false }));
  const panel = { isOpen: open, closes: 0 };
  const dispatched = [];
  const frame = () => routeMenuActions(input.poll(), {
    settingsOpen: () => panel.isOpen,
    closeSettings: () => { panel.closes += 1; panel.isOpen = false; },
    dispatch: (action) => dispatched.push(action),
  });
  frame();
  return { press, pad, panel, dispatched, frame };
}

test('Escape with Settings open closes the panel and never also pauses or resumes', () => {
  const { press, panel, dispatched, frame } = setup();
  press('Escape');
  frame();
  assert.equal(panel.closes, 1);
  assert.equal(panel.isOpen, false);
  frame();
  frame();
  assert.deepEqual(dispatched, [], 'the closing press is not dispatched as pause on a later frame');
});

test('the gamepad back and Options buttons close the panel; other actions are dropped while it is open', () => {
  const { pad, panel, dispatched, frame } = setup();
  pad.buttons[13].pressed = true;
  frame();
  assert.equal(panel.closes, 0, 'navigation does not close');
  pad.buttons[13].pressed = false;
  pad.buttons[1].pressed = true;
  frame();
  assert.equal(panel.closes, 1, 'back closes');
  pad.buttons[1].pressed = false;
  frame();
  panel.isOpen = true;
  pad.buttons[9].pressed = true;
  frame();
  assert.equal(panel.closes, 2, 'Options closes');
  assert.deepEqual(dispatched, []);
});

test('with the panel closed every action is dispatched in order', () => {
  const { press, dispatched, frame, panel } = setup({ open: false });
  press('ArrowDown');
  press('Escape');
  frame();
  assert.deepEqual(dispatched, ['down', 'pause']);
  assert.equal(panel.closes, 0);
});
