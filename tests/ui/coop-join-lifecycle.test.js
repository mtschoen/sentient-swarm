import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoopJoin } from '../../src/ui/coop-join.js';
import { createMenuInput } from '../../src/input/menuInput.js';

function pad(index, pressedButtons = []) {
  const buttons = Array.from({ length: 17 }, (unused, button) => ({ pressed: pressedButtons.includes(button) }));
  return { index, buttons, axes: [0, 0, 0, 0] };
}

function setup() {
  const state = { gamepads: [pad(0), pad(1)], seatTwoPad: null, extraPad: 'unset', toasts: [] };
  const input = {
    setSeatTwoPad: (padIndex) => { state.seatTwoPad = padIndex; },
    seatOnePadIndex: () => 0,
  };
  const menuInput = { setExtraPad: (padIndex) => { state.extraPad = padIndex; } };
  const hud = { showToast: (text) => state.toasts.push(text) };
  const documentObject = { createElement: () => ({ style: {}, hidden: false, textContent: '' }) };
  const navigatorObject = { getGamepads: () => state.gamepads };
  const join = createCoopJoin({ input, menuInput, hud, menuElement: { append() {} }, navigatorObject, documentObject });
  join.update({ titleOpen: true });
  return { join, state };
}

test('a pad returning under the same index with a button held gives no menu confirm until it is pressed again', () => {
  const state = { gamepads: [pad(0), pad(1, [0])] };
  const navigatorObject = { getGamepads: () => state.gamepads };
  const menuInput = createMenuInput({ windowObject: { addEventListener() {} }, navigatorObject });
  const input = { setSeatTwoPad() {}, seatOnePadIndex: () => 0 };
  const documentObject = { createElement: () => ({ style: {}, hidden: false, textContent: '' }) };
  const join = createCoopJoin({ input, menuInput, hud: { showToast() {} }, menuElement: { append() {} }, navigatorObject, documentObject });
  state.gamepads = [pad(0), pad(1)];
  join.update({ titleOpen: true });
  state.gamepads = [pad(0), pad(1, [5])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 2);
  menuInput.poll();
  state.gamepads = [pad(0), pad(1)];
  menuInput.poll();
  // The pad wakes under the same index with the south button already down.
  state.gamepads = [pad(0), pad(1, [0])];
  assert.equal(join.handleConnect(1), true);
  assert.deepEqual(menuInput.poll(), []);
  state.gamepads = [pad(0), pad(1)];
  assert.deepEqual(menuInput.poll(), []);
  state.gamepads = [pad(0), pad(1, [0])];
  assert.deepEqual(menuInput.poll(), ['confirm']);
});

test('seat 2 pad disconnecting at the title unseats seat 2 quietly; mid-run it is reported', () => {
  const { join, state } = setup();
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 2);
  state.gamepads = [pad(0)];
  assert.equal(join.handleDisconnect(1), false, 'no pause and no toast at the title');
  assert.equal(join.playerCount, 1);
  assert.equal(state.seatTwoPad, null);
  assert.equal(state.extraPad, null);
  assert.deepEqual(state.toasts, ['Player 2 joined']);

  state.gamepads = [pad(0), pad(1)];
  join.update({ titleOpen: true });
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 2);
  join.update({ titleOpen: false });
  state.gamepads = [pad(0)];
  assert.equal(join.handleDisconnect(1), true, 'mid-run keeps the pause and the toast');
  assert.equal(join.playerCount, 2);
});
