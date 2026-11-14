import test from 'node:test';
import assert from 'node:assert/strict';
import { SeatJoin, JOIN_BUTTON_INDICES, SECOND_PAD_JOIN_BUTTON_INDICES } from '../../src/input/seat-join.js';

function pad(index, pressedButtons = []) {
  const buttons = Array.from({ length: 17 }, (unused, button) => ({ pressed: pressedButtons.includes(button) }));
  return { index, buttons, axes: [0, 0, 0, 0] };
}

// Primes the join on an open title with nothing held, then returns it.
function primed(gamepads) {
  const join = new SeatJoin();
  join.poll(gamepads, { open: true });
  return join;
}

test('a fresh R1 on any pad claims seat 2 and the same press on that pad leaves', () => {
  const join = primed([pad(0), pad(1)]);
  assert.equal(join.poll([pad(0, [5]), pad(1)], { open: true }), 'joined');
  assert.equal(join.seatTwoPad, 0);
  assert.equal(join.joined, true);
  assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  assert.equal(join.poll([pad(0, [5]), pad(1)], { open: true }), 'left');
  assert.equal(join.seatTwoPad, null);
  assert.deepEqual([...JOIN_BUTTON_INDICES], [4, 5, 6, 7]);
  assert.deepEqual([...SECOND_PAD_JOIN_BUTTON_INDICES], [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('a fresh A on a pad that is not the first claims seat 2; A on the first pad does not; A on seat 2 pad does not leave', () => {
  const join = primed([pad(0), pad(1)]);
  assert.equal(join.poll([pad(0, [0]), pad(1)], { open: true }), null);
  assert.equal(join.joined, false);
  assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  assert.equal(join.poll([pad(0), pad(1, [0])], { open: true }), 'joined');
  assert.equal(join.seatTwoPad, 1);
  assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  assert.equal(join.poll([pad(0), pad(1, [0])], { open: true }), null);
  assert.equal(join.seatTwoPad, 1);
});

test('the first non-null pad is matched by index, not array position, across null holes', () => {
  const join = primed([null, pad(1), pad(2)]);
  assert.equal(join.poll([null, pad(1, [0]), pad(2)], { open: true }), null);
  assert.equal(join.poll([null, pad(1), pad(2)], { open: true }), null);
  assert.equal(join.poll([null, pad(1), pad(2, [3])], { open: true }), 'joined');
  assert.equal(join.seatTwoPad, 2);
  assert.equal(join.poll([null, pad(1), pad(2)], { open: true }), null);
  assert.equal(join.poll([null, pad(1), pad(2, [4])], { open: true }), 'left');
});

test('a join button held when the title opens does not join', () => {
  const join = new SeatJoin();
  assert.equal(join.poll([pad(0, [5])], { open: true }), null, 'held at the first call');
  assert.equal(join.poll([pad(0, [5])], { open: true }), null, 'still held');
  assert.equal(join.joined, false);
  assert.equal(join.poll([pad(0, [5])], { open: false }), null);
  assert.equal(join.poll([pad(0, [5])], { open: true }), null, 'held while the title reopens');
  assert.equal(join.joined, false);
  assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  assert.equal(join.poll([pad(0, [5]), pad(1)], { open: true }), 'joined');
});

test('a press while the title is closed does not join', () => {
  const join = primed([pad(0), pad(1)]);
  assert.equal(join.poll([pad(0), pad(1, [0])], { open: false }), null);
  assert.equal(join.joined, false);
});

test('the d-pad, Options and the sticks never join on any pad', () => {
  const join = primed([pad(0), pad(1)]);
  for (const button of [8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    assert.equal(join.poll([pad(0, [button]), pad(1, [button])], { open: true }), null);
    assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  }
  const stick = pad(1);
  stick.axes = [1, 1, 1, 1];
  assert.equal(join.poll([pad(0), stick], { open: true }), null);
  assert.equal(join.joined, false);
});

test('a second pad cannot take a taken seat 2', () => {
  const join = primed([pad(0), pad(1), pad(2)]);
  assert.equal(join.poll([pad(0), pad(1, [5]), pad(2)], { open: true }), 'joined');
  assert.equal(join.poll([pad(0), pad(1), pad(2)], { open: true }), null);
  assert.equal(join.poll([pad(0), pad(1), pad(2, [0, 5])], { open: true }), null);
  assert.equal(join.poll([pad(0, [5]), pad(1), pad(2)], { open: true }), null);
  assert.equal(join.seatTwoPad, 1);
});

test('reconnect hands seat 2 to a new pad index only while the old pad is missing', () => {
  const join = primed([pad(0), pad(1)]);
  assert.equal(join.reconnect(3, [pad(0), pad(1)]), false, 'nobody joined yet');
  join.poll([pad(0), pad(1, [0])], { open: true });
  assert.equal(join.seatTwoPad, 1);
  assert.equal(join.seatTwoConnected([pad(0), pad(1)]), true);
  assert.equal(join.reconnect(3, [pad(0), pad(1), pad(3)]), false, 'the old pad is still there');
  assert.equal(join.seatTwoPad, 1);
  assert.equal(join.seatTwoConnected([pad(0), null, pad(3)]), false);
  assert.equal(join.reconnect(3, [pad(0), null, pad(3)]), true);
  assert.equal(join.seatTwoPad, 3);
  assert.equal(join.seatTwoConnected([pad(0), null, pad(3)]), true);
});

test('reset empties the seat and primes again', () => {
  const join = primed([pad(0), pad(1)]);
  join.poll([pad(0), pad(1, [0])], { open: true });
  join.reset();
  assert.equal(join.joined, false);
  assert.equal(join.poll([pad(0), pad(1, [0])], { open: true }), null, 'primes on the first call after a reset');
});

test('a pad that first appears with A down joins on that poll', () => {
  const join = primed([pad(0)]);
  assert.equal(join.poll([pad(0), pad(1, [0])], { open: true }), 'joined');
  assert.equal(join.seatTwoPad, 1);
});

test("seat 2's pad returning with R1 held does not leave", () => {
  const join = primed([pad(0), pad(1)]);
  join.poll([pad(0), pad(1, [0])], { open: true });
  assert.equal(join.poll([pad(0), null], { open: true }), null);
  assert.equal(join.poll([pad(0), pad(1, [5])], { open: true }), null);
  assert.equal(join.joined, true);
  assert.equal(join.poll([pad(0), pad(1)], { open: true }), null);
  assert.equal(join.poll([pad(0), pad(1, [5])], { open: true }), 'left');
});

test('a pad seated by reconnect with R1 held does not leave on the next poll', () => {
  const join = primed([pad(0), pad(1)]);
  join.poll([pad(0), pad(1, [0])], { open: true });
  join.poll([pad(0), null], { open: true });
  const returned = [pad(0), null, pad(2, [5])];
  assert.equal(join.reconnect(2, returned), true);
  assert.equal(join.poll(returned, { open: true }), null);
  assert.equal(join.seatTwoPad, 2);
  assert.equal(join.poll(returned, { open: true }), null);
});

test('a pad that appears while the title is closed is primed when it reopens', () => {
  const join = primed([pad(0)]);
  assert.equal(join.poll([pad(0), pad(1, [5])], { open: false }), null);
  assert.equal(join.poll([pad(0), pad(1, [5])], { open: true }), null);
  assert.equal(join.joined, false);
});
