import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuInput } from '../../src/input/menuInput.js';
import { createSettingsOpener, routeMenuActions, routeSettingsKey } from '../../src/ui/menuRouting.js';

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

function keyRoute({ settingsIsOpen = true, rotateShowing = false } = {}) {
  const state = { open: settingsIsOpen, closes: 0, opens: 0, pauses: 0, dispatched: [] };
  const route = (event) => routeSettingsKey(event, {
    settingsOpen: () => state.open,
    closeSettings: () => { state.closes += 1; state.open = false; },
    openSettings: () => { state.opens += 1; state.open = true; },
    dispatch: (action) => state.dispatched.push(action),
  });
  return { state, route };
}

test('Escape and O still close the panel from a focused slider, through the one close path', () => {
  const slider = { tagName: 'INPUT', type: 'range' };
  const escape = keyRoute();
  escape.route({ key: 'Escape', code: 'Escape', target: slider, repeat: false });
  assert.equal(escape.state.closes, 1);
  assert.deepEqual(escape.state.dispatched, []);
  const letter = keyRoute();
  letter.route({ key: 'o', code: 'KeyO', target: slider, repeat: false });
  assert.equal(letter.state.closes, 1);
  const checkbox = keyRoute({ settingsIsOpen: false });
  checkbox.route({ key: 'o', code: 'KeyO', target: { tagName: 'INPUT', type: 'checkbox' }, repeat: false });
  assert.equal(checkbox.state.opens, 1);
});

test('typing in a text field never opens or closes the panel (Escape aside is the menu path)', () => {
  const text = keyRoute({ settingsIsOpen: false });
  text.route({ key: 'o', code: 'KeyO', target: { tagName: 'INPUT', type: 'text' }, repeat: false });
  text.route({ key: 'o', code: 'KeyO', target: { tagName: 'INPUT', type: 'number' }, repeat: false });
  text.route({ key: 'o', code: 'KeyO', target: { tagName: 'SELECT' }, repeat: false });
  assert.equal(text.state.opens, 0);
  const held = keyRoute();
  held.route({ key: 'o', code: 'KeyO', target: { tagName: 'INPUT', type: 'range' }, repeat: true });
  assert.equal(held.state.closes, 0);
});

test('settings opened while the rotate overlay pauses shows no pause menu under it', () => {
  const steps = [];
  let rotating = true;
  const open = createSettingsOpener({
    isRotateShowing: () => rotating,
    pauseForMenu: () => steps.push('pause menu'),
    openPanel: () => steps.push('panel'),
  });
  open();
  assert.deepEqual(steps, ['panel']);
  rotating = false;
  open();
  assert.deepEqual(steps, ['panel', 'pause menu', 'panel']);
});
