import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoopJoin } from '../../src/ui/coop-join.js';

function pad(index, pressedButtons = []) {
  const buttons = Array.from({ length: 17 }, (unused, button) => ({ pressed: pressedButtons.includes(button) }));
  return { index, buttons, axes: [0, 0, 0, 0] };
}

function setup() {
  const state = { gamepads: [pad(0), pad(1)], seatTwoPad: null, extraPad: 'unset', toasts: [], seatOne: 0 };
  const input = {
    setSeatTwoPad: (padIndex) => { state.seatTwoPad = padIndex; },
    seatOnePadIndex: () => state.seatOne,
  };
  const menuInput = { setExtraPad: (padIndex) => { state.extraPad = padIndex; } };
  const hud = { showToast: (text) => state.toasts.push(text) };
  const menuElement = { append() {} };
  const documentObject = { createElement: () => ({ style: {}, hidden: false, textContent: '' }) };
  const navigatorObject = { getGamepads: () => state.gamepads };
  const join = createCoopJoin({ input, menuInput, hud, menuElement, navigatorObject, documentObject });
  join.update({ titleOpen: true });
  return { join, state };
}

test('coop-join seats the pad in the input, toasts, and reports playerCount 2 until reset', () => {
  const { join, state } = setup();
  assert.equal(join.playerCount, 1);
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 2);
  assert.equal(state.seatTwoPad, 1);
  assert.equal(state.extraPad, 1);
  assert.deepEqual(state.toasts, ['Player 2 joined']);
  state.gamepads = [pad(0), pad(1)];
  join.update({ titleOpen: true });
  state.gamepads = [pad(0), pad(1, [5])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 1);
  assert.equal(state.seatTwoPad, null);
  assert.equal(state.extraPad, null);
  assert.deepEqual(state.toasts, ['Player 2 joined', 'Player 2 left']);
  state.gamepads = [pad(0), pad(1)];
  join.update({ titleOpen: true });
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  assert.equal(join.playerCount, 2);
  join.reset();
  assert.equal(join.playerCount, 1);
  assert.equal(state.seatTwoPad, null);
  assert.equal(state.extraPad, null);
});

test('a press while the title is closed never joins', () => {
  const { join, state } = setup();
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: false });
  assert.equal(join.playerCount, 1);
  assert.deepEqual(state.toasts, []);
});

test('padForSeat is undefined for seat 0 in solo and the seat pads in co-op', () => {
  const { join, state } = setup();
  assert.equal(join.padForSeat(0), undefined);
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  state.seatOne = 0;
  assert.equal(join.padForSeat(0), 0);
  assert.equal(join.padForSeat(1), 1);
});

test('a disconnect of seat 2 pad is reported and the returning pad reclaims the seat', () => {
  const { join, state } = setup();
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  assert.equal(join.handleDisconnect(0), false);
  join.update({ titleOpen: false });
  state.gamepads = [pad(0), null];
  assert.equal(join.handleDisconnect(1), true);
  state.gamepads = [pad(0), null, pad(2)];
  assert.equal(join.handleConnect(2), true);
  assert.equal(state.seatTwoPad, 2);
  assert.equal(join.padForSeat(1), 2);
  assert.equal(join.handleConnect(3), false, 'seat 2 pad is connected again');
});

test('handleConnect is true for seat 2 pad under a new or the same index, false for any other pad', () => {
  const { join, state } = setup();
  assert.equal(join.handleConnect(1), false, 'nobody joined');
  state.gamepads = [pad(0), pad(1, [0])];
  join.update({ titleOpen: true });
  state.gamepads = [pad(0), pad(1)];
  assert.equal(join.handleConnect(1), true, 'the same index returns');
  assert.equal(join.handleConnect(0), false);
  state.gamepads = [pad(0), null, pad(2)];
  assert.equal(join.handleConnect(2), true, 'a new index takes the seat');
  assert.equal(join.handleConnect(0), false);
});
