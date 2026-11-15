import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerSeat } from '../../src/game/player-seat.js';
import { buildSeatSnapshot } from '../../src/net/seat-snapshot.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot-codec.js';

const OPTIONS = Object.freeze({ sequence: 7, matchSeconds: 3.5, firing: true, beam: null, invulnerable: false });

function seatAt(index, x) {
  const seat = new PlayerSeat({ index, random: () => 0.5 });
  seat.reset(12, { x, y: 9 });
  return seat;
}

test('buildSeatSnapshot carries the seat, its ships with generations and gunners, and encodes', () => {
  const seat = seatAt(1, 26);
  const snapshot = buildSeatSnapshot(seat, OPTIONS);
  assert.equal(snapshot.type, 'snapshot');
  assert.equal(snapshot.seat, 1);
  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.matchSeconds, 3.5);
  assert.equal(snapshot.firing, true);
  assert.equal(snapshot.host, null);
  assert.equal(snapshot.hostState, null);
  assert.equal(snapshot.aliveCount, 12);
  assert.equal(snapshot.ships.length, 12);
  assert.deepEqual(snapshot.point, { x: 26, y: 9, velocityX: 0, velocityY: 0 });
  assert.equal(snapshot.ships[0].generation, seat.swarm.generationOf(snapshot.ships[0].slot));
  assert.ok(encodeSnapshot(snapshot).length > 0);
});

test('a seat with no turrets decodes with no gunners, and a gunner keeps its station', () => {
  const seat = seatAt(0, 6);
  assert.ok(buildSeatSnapshot(seat, OPTIONS).ships.every((entry) => entry.gunnerIndex === null));
  const decoded = decodeSnapshot(encodeSnapshot(buildSeatSnapshot(seat, OPTIONS)));
  assert.ok(decoded.ships.every((entry) => entry.gunnerIndex === null));
  seat.swarm.slots[3].gunnerIndex = 2;
  const withGunner = decodeSnapshot(encodeSnapshot(buildSeatSnapshot(seat, OPTIONS)));
  assert.deepEqual(withGunner.ships.filter((entry) => entry.gunnerIndex !== null).map((entry) => [entry.slot, entry.gunnerIndex]), [[3, 2]]);
});

test('headings are wrapped into [-PI, PI] so a heading of 5 survives the codec', () => {
  const seat = seatAt(0, 6);
  seat.swarm.slots[0].heading = 5;
  const snapshot = buildSeatSnapshot(seat, OPTIONS);
  assert.ok(Math.abs(snapshot.ships[0].heading - (5 - 2 * Math.PI)) < 1e-12);
  const decoded = decodeSnapshot(encodeSnapshot(snapshot));
  assert.ok(Math.abs(decoded.ships[0].heading - (5 - 2 * Math.PI)) < (2 * Math.PI) / 255);
});

test('the weapons, aim and beam come from the seat and the options', () => {
  const seat = seatAt(0, 6);
  seat.weapons.armed = 'rail';
  seat.weapons.tier = 2;
  seat.weapons.charge = 0.5;
  const beam = { x: 6, y: 9, directionX: 1, directionY: 0, halfWidth: 0.1, extra: 'dropped' };
  const snapshot = buildSeatSnapshot(seat, { ...OPTIONS, beam, invulnerable: true });
  assert.deepEqual(snapshot.weapons, { armed: 'rail', tier: 2, charge: 0.5, railTurrets: 0, railTier: seat.weapons.railTier });
  assert.deepEqual(snapshot.aim, { x: seat.player.aimX, y: seat.player.aimY });
  assert.deepEqual(snapshot.beam, { x: 6, y: 9, directionX: 1, directionY: 0, halfWidth: 0.1 });
  assert.equal(snapshot.invulnerable, true);
});

test('a new seat declares its remote fields', () => {
  const seat = new PlayerSeat();
  assert.equal(seat.remote, false);
  assert.equal(seat.remoteFiring, false);
  assert.equal(seat.remoteInvulnerable, false);
  assert.equal(seat.remoteBeam, null);
});
