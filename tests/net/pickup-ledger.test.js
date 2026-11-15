import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestPickups, PickupLedger, findReachedPickup } from '../../src/net/pickup-ledger.js';
import { SWARM_PICKUP_RADIUS } from '../../src/game/player-seat.js';

const pickup = (x, y, type = 'scatter') => ({ x, y, type, age: 0, fade: 1 });

test('the ledger gives ids by identity and announces expiry once', () => {
  const ledger = new PickupLedger();
  const a = pickup(1, 2);
  const b = pickup(3, 4, 'rail');
  assert.deepEqual(ledger.observe([a, b]), {
    announced: [{ id: 1, pickupType: 'scatter', x: 1, y: 2 }, { id: 2, pickupType: 'rail', x: 3, y: 4 }],
    expired: [],
  });
  assert.deepEqual(ledger.observe([a, b]), { announced: [], expired: [] });
  assert.deepEqual(ledger.observe([b]), { announced: [], expired: [1] });
  assert.deepEqual(ledger.observe([b]), { announced: [], expired: [] });
  const list = [b];
  assert.equal(ledger.take(2, list), b);
  assert.deepEqual(list, []);
  assert.equal(ledger.take(2, list), null);
  assert.deepEqual(ledger.observe(list), { announced: [], expired: [] }, 'a taken pickup is not reported expired');
});

test('ids are never reused, also after a reset', () => {
  const ledger = new PickupLedger();
  ledger.observe([pickup(1, 1)]);
  ledger.reset();
  const later = pickup(2, 2);
  assert.deepEqual(ledger.observe([later]).announced.map((entry) => entry.id), [2]);
  assert.equal(ledger.idOf(later), 2);
  assert.equal(ledger.idOf(pickup(2, 2)), null);
});

test('a pickup the director already removed is not taken and still expires', () => {
  const ledger = new PickupLedger();
  const a = pickup(1, 1);
  ledger.observe([a]);
  assert.equal(ledger.take(1, []), null);
  assert.deepEqual(ledger.observe([]).expired, [1]);
});

function seatAtPoint(x, y, ships = []) {
  return { player: { position: { x, y } }, swarm: { ships } };
}

test('findReachedPickup takes the nearest at the point, else one a ship reaches, and removes nothing', () => {
  const near = pickup(10.1, 10);
  const nearer = pickup(10.05, 10);
  const list = [near, nearer];
  assert.equal(findReachedPickup(seatAtPoint(10, 10), list), nearer);
  assert.equal(list.length, 2);
  assert.equal(findReachedPickup(seatAtPoint(10.36, 10), [pickup(10, 10)]), null);
  const byShip = pickup(5, 5);
  assert.equal(findReachedPickup(seatAtPoint(0, 0, [{ x: 5 + SWARM_PICKUP_RADIUS * 0.9, y: 5 }]), [byShip]), byShip);
  assert.equal(findReachedPickup(seatAtPoint(0, 0, [{ x: 5 + SWARM_PICKUP_RADIUS * 1.1, y: 5 }]), [byShip]), null);
});

test('guest pickups are announced, aged without removal, claimed once and removed', () => {
  const director = { pickups: [] };
  const guest = new GuestPickups(director);
  guest.announce({ id: 7, pickupType: 'pulse', x: 3, y: 4 });
  assert.deepEqual(director.pickups, [{ id: 7, type: 'pulse', x: 3, y: 4, age: 0, fade: 1 }]);
  guest.age(12, 10);
  assert.equal(director.pickups.length, 1, 'the host says when it expires');
  assert.equal(director.pickups[0].fade, 0);
  assert.equal(director.pickups[0].age, 12);
  assert.equal(guest.claim(7), true);
  assert.equal(guest.claim(7), false);
  assert.deepEqual([...guest.pending], [7]);
  guest.remove(7);
  assert.deepEqual(director.pickups, []);
  assert.deepEqual([...guest.pending], []);
  guest.remove(7);
  guest.announce({ id: 8, pickupType: 'rail', x: 1, y: 1 });
  guest.claim(8);
  guest.reset();
  assert.deepEqual([...guest.pending], []);
  assert.equal(guest.claim(8), true, 'a reset forgets the claims');
});
