import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SEAT_START_OFFSET, isSeatLive, liveSeats, partnerFor, pickupAnchor, seatStarts, seekTargets,
} from '../../src/game/seats.js';

function fakeSeat(x, y, { down = false, aliveCount = 12 } = {}) {
  return { point: { x, y }, down, aliveCount, player: { aim: { x: 1, y: 0 } }, cameraFocus: { x, y } };
}

test('isSeatLive needs a seat that is not down and still has ships', () => {
  assert.equal(isSeatLive(fakeSeat(0, 0)), true);
  assert.equal(isSeatLive(fakeSeat(0, 0, { down: true })), false);
  assert.equal(isSeatLive(fakeSeat(0, 0, { aliveCount: 0 })), false);
  assert.equal(liveSeats([fakeSeat(0, 0), fakeSeat(1, 1, { down: true })]).length, 1);
});

test('seekTargets primary falls to seat 2 when seat 1 is down, and secondary is null', () => {
  const seats = [fakeSeat(1, 2, { down: true }), fakeSeat(5, 6)];
  assert.deepEqual(seekTargets(seats), { primary: { x: 5, y: 6 }, secondary: null });
  assert.deepEqual(seekTargets([fakeSeat(1, 2), fakeSeat(5, 6)]), { primary: { x: 1, y: 2 }, secondary: { x: 5, y: 6 } });
  assert.deepEqual(seekTargets([fakeSeat(1, 2, { down: true })]), { primary: { x: 1, y: 2 }, secondary: null });
});

test('pickupAnchor is the midpoint of the live seats and ignores a down seat', () => {
  assert.deepEqual(pickupAnchor([fakeSeat(2, 4), fakeSeat(6, 8)]), { x: 4, y: 6 });
  assert.deepEqual(pickupAnchor([fakeSeat(2, 4), fakeSeat(6, 8, { down: true })]), { x: 2, y: 4 });
  assert.deepEqual(pickupAnchor([fakeSeat(2, 4, { aliveCount: 0 })]), { x: 2, y: 4 });
});

test('partnerFor is the second live seat with its aim, else null', () => {
  assert.deepEqual(partnerFor([fakeSeat(2, 4), fakeSeat(6, 8)]), { x: 6, y: 8, aimX: 1, aimY: 0 });
  assert.equal(partnerFor([fakeSeat(2, 4), fakeSeat(6, 8, { down: true })]), null);
  assert.equal(partnerFor([fakeSeat(2, 4)]), null);
});

test('seatStarts gives the center for one seat and the center either side for two', () => {
  const bounds = { minX: 0, maxX: 32, minY: 0, maxY: 18 };
  assert.deepEqual(seatStarts(1, bounds), [{ x: 16, y: 9 }]);
  assert.deepEqual(seatStarts(2, bounds), [{ x: 16 - SEAT_START_OFFSET, y: 9 }, { x: 16 + SEAT_START_OFFSET, y: 9 }]);
});
