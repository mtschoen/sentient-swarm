import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSeatDriver } from '../../src/net/remote-seat.js';
import { MAXIMUM_EXTRAPOLATION_SECONDS } from '../../src/net/protocol.js';
import { PlayerSeat } from '../../src/game/player-seat.js';
import { seatAt } from './net-fixtures.js';

const SNAPSHOT_SECONDS = 1 / 30;
const TOLERANCE = 1e-9;

function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${message ?? ''} expected ${expected}, got ${actual}`);
}

function remoteSeat() {
  const seat = new PlayerSeat({ index: 0, random: () => 0.5 });
  seat.reset(12, { x: 26, y: 9 });
  return seat;
}

test('two snapshots bracket the render time', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10 }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 1 + SNAPSHOT_SECONDS, x: 11 }));
  const sample = driver.sample(1 + SNAPSHOT_SECONDS / 2);
  near(sample.point.x, 10.5);
  near(sample.ships[0].x, 10.5);
  assert.equal(sample.ships.length, 12);
});

test('past the newest snapshot it extrapolates at most 0.1 s, then holds', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 2, x: 10 }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 2 + SNAPSHOT_SECONDS, x: 10.1 }));
  const newest = 2 + SNAPSHOT_SECONDS;
  near(driver.sample(newest + 0.05).point.x, 10.25);
  near(driver.sample(newest + 0.05).ships[0].x, 10.25);
  assert.equal(MAXIMUM_EXTRAPOLATION_SECONDS, 0.1);
  near(driver.sample(newest + 0.3).point.x, 10.4);
  near(driver.sample(newest + 0.3).ships[5].x, 10.4);
});

test('before the oldest snapshot it holds the oldest', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 2, x: 10, weapons: { armed: 'rail', tier: 1 } }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 2 + SNAPSHOT_SECONDS, x: 11 }));
  const sample = driver.sample(1);
  near(sample.point.x, 10);
  assert.equal(sample.weapons.armed, 'rail');
});

test('a snapshot arriving out of order still brackets correctly, and a duplicate is ignored', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10 }));
  driver.receive(seatAt({ sequence: 3, matchSeconds: 1 + 2 / 30, x: 12 }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 1 + 1 / 30, x: 11 }));
  driver.receive(seatAt({ sequence: 3, matchSeconds: 1 + 2 / 30, x: 99 }));
  assert.equal(driver.count, 3);
  near(driver.sample(1 + 1.5 / 30).point.x, 11.5);
  assert.equal(driver.newest.sequence, 3);
  assert.equal(driver.newest.point.x, 12, 'the duplicate did not replace the held snapshot');
});

test('another seat is ignored, at most 32 are kept and an older one than the oldest kept is dropped', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 1 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10, seat: 0 }));
  assert.equal(driver.newest, null);
  assert.equal(driver.sample(1), null);
  for (let sequence = 10; sequence < 50; sequence += 1) driver.receive(seatAt({ sequence, matchSeconds: sequence / 30, x: 10, seat: 1 }));
  assert.equal(driver.count, 32);
  assert.equal(driver.oldest.sequence, 18);
  driver.receive(seatAt({ sequence: 12, matchSeconds: 12 / 30, x: 10, seat: 1 }));
  assert.equal(driver.count, 32);
  assert.equal(driver.oldest.sequence, 18);
});

test('a regrown slot jumps to the new ship once the render time reaches it', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const older = seatAt({ sequence: 1, matchSeconds: 1, x: 10, generations: { 2: 1 } });
  const newer = seatAt({ sequence: 2, matchSeconds: 1 + 1 / 30, x: 10, generations: { 2: 2 } });
  newer.ships[2].x = 14;
  driver.receive(older);
  driver.receive(newer);
  const middle = driver.sample(1 + 0.5 / 30).ships.find((ship) => ship.slot === 2);
  assert.equal(middle.generation, 1);
  near(middle.x, 10, 'no blend toward the new ship');
  const reached = driver.sample(1 + 1 / 30).ships.find((ship) => ship.slot === 2);
  assert.equal(reached.generation, 2);
  near(reached.x, 14);
});

test('a ship present only in the newer snapshot appears once the render time reaches it', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10, shipCount: 11 }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 1 + 1 / 30, x: 10, shipCount: 12 }));
  assert.equal(driver.sample(1 + 0.5 / 30).ships.length, 11);
  assert.equal(driver.sample(1 + 1 / 30).ships.length, 12);
});

test('weapons, firing, invulnerable and beam come from the newest snapshot at or before the render time', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const newer = { ...seatAt({ sequence: 2, matchSeconds: 2, x: 10, firing: true, weapons: { armed: 'pulse', tier: 2 } }), invulnerable: true };
  newer.beam = { x: 10, y: 9, directionX: 1, directionY: 0, halfWidth: 0.1 };
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10 }));
  driver.receive(newer);
  const before = driver.sample(1.5);
  assert.equal(before.weapons.armed, 'base');
  assert.equal(before.firing, false);
  assert.equal(before.invulnerable, false);
  assert.equal(before.beam, null);
  const after = driver.sample(2.01);
  assert.equal(after.weapons.armed, 'pulse');
  assert.equal(after.weapons.tier, 2);
  assert.equal(after.firing, true);
  assert.equal(after.invulnerable, true);
  assert.deepEqual(after.beam, newer.beam);
});

test('headings take the shortest arc', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const older = seatAt({ sequence: 1, matchSeconds: 1, x: 10 });
  const newer = seatAt({ sequence: 2, matchSeconds: 2, x: 10 });
  older.ships[0].heading = Math.PI - 0.1;
  newer.ships[0].heading = -Math.PI + 0.1;
  driver.receive(older);
  driver.receive(newer);
  const heading = driver.sample(1.5).ships[0].heading;
  near(Math.abs(heading), Math.PI, 'the midpoint is at PI, not 0');
});

test('apply writes the point, weapons and remote fields and mirrors the ships', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const seat = remoteSeat();
  // The reset seat spawned slots 0 to 11 once each, so their generation is 1 like the snapshots'.
  const generations = Object.fromEntries(Array.from({ length: 12 }, (unused, slot) => [slot, 1]));
  const weapons = { armed: 'rail', tier: 1, charge: 0.5, railTurrets: 2, railTier: 1 };
  const newer = { ...seatAt({ sequence: 2, matchSeconds: 1 + 1 / 30, x: 11, firing: true, generations, weapons }), invulnerable: true };
  newer.point = { x: 11, y: 9, velocityX: 30, velocityY: 0 };
  newer.ships[0].gunnerIndex = 1;
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10, generations }));
  driver.receive(newer);
  const { lost } = driver.apply(seat, 1 + 1 / 30, 1 / 60);
  assert.equal(lost.length, 0, 'the same slots and generations are the same ships');
  assert.equal(driver.apply(seat, 1 + 1 / 30, 1 / 60).lost.length, 0);
  const regrown = seatAt({ sequence: 3, matchSeconds: 2, x: 11, generations: { ...generations, 4: 2 } });
  regrown.ships.splice(11, 1);
  driver.receive(regrown);
  assert.deepEqual(driver.apply(seat, 2, 1 / 60).lost.map((ship) => ship.slot), [4, 11]);
  const full = seatAt({ sequence: 4, matchSeconds: 3, x: 11, generations }).ships;
  full[0].gunnerIndex = 1;
  driver.receive({ ...newer, sequence: 4, matchSeconds: 3, ships: full, aliveCount: 12 });
  driver.apply(seat, 3, 1 / 60);
  near(seat.player.positionX, 11);
  assert.equal(seat.player.positionY, 9);
  assert.equal(seat.player.velocityX, 30);
  assert.deepEqual([seat.player.aimX, seat.player.aimY], [1, 0]);
  assert.deepEqual(
    [seat.weapons.armed, seat.weapons.tier, seat.weapons.charge, seat.weapons.railTurrets, seat.weapons.railTier],
    ['rail', 1, 0.5, 2, 1],
  );
  assert.equal(seat.remoteFiring, true);
  assert.equal(seat.remoteInvulnerable, true);
  assert.equal(seat.remoteBeam, null);
  assert.equal(seat.swarm.aliveCount, 12);
  assert.equal(seat.swarm.slots[0].gunnerIndex, 1);
  assert.equal(seat.swarm.slots[1].gunnerIndex, -1);
  near(seat.swarm.slots[3].x, 11);
});

test('a suppressed ship stays out until the slot dies or changes generation', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const seat = remoteSeat();
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10, generations: { 3: 2 } }));
  driver.receive(seatAt({ sequence: 2, matchSeconds: 1 + 1 / 30, x: 10, generations: { 3: 2 } }));
  driver.apply(seat, 1, 1 / 60);
  assert.equal(seat.swarm.aliveCount, 12);
  driver.suppress(3, 2);
  driver.apply(seat, 1 + 0.5 / 30, 1 / 60);
  assert.equal(seat.swarm.slots[3].alive, false);
  assert.equal(seat.swarm.aliveCount, 11);
  driver.apply(seat, 1 + 1 / 30, 1 / 60);
  assert.equal(seat.swarm.aliveCount, 11);
  driver.receive(seatAt({ sequence: 3, matchSeconds: 1 + 2 / 30, x: 10, generations: { 3: 3 } }));
  driver.apply(seat, 1 + 2 / 30, 1 / 60);
  assert.equal(seat.swarm.slots[3].alive, true);
  assert.equal(seat.swarm.generationOf(3), 3);
  assert.equal(seat.swarm.aliveCount, 12);
  driver.receive(seatAt({ sequence: 4, matchSeconds: 1 + 3 / 30, x: 10, generations: { 3: 2 } }));
  driver.apply(seat, 1 + 3 / 30, 1 / 60);
  assert.equal(seat.swarm.slots[3].alive, true, 'the suppression ended with the new generation');
});

test('a suppression ends when a sample shows the slot dead', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const seat = remoteSeat();
  driver.receive(seatAt({ sequence: 1, matchSeconds: 1, x: 10, generations: { 11: 2 } }));
  driver.suppress(11, 2);
  driver.apply(seat, 1, 1 / 60);
  assert.equal(seat.swarm.aliveCount, 11);
  driver.receive(seatAt({ sequence: 2, matchSeconds: 2, x: 10, shipCount: 11 }));
  driver.apply(seat, 2, 1 / 60);
  driver.receive(seatAt({ sequence: 3, matchSeconds: 3, x: 10, generations: { 11: 2 } }));
  driver.apply(seat, 3, 1 / 60);
  assert.equal(seat.swarm.aliveCount, 12, 'the same generation after a death is a new ship to the driver');
});

test('before any snapshot apply leaves the seat as it was', () => {
  const driver = new RemoteSeatDriver({ seatIndex: 0 });
  const seat = remoteSeat();
  const ships = seat.swarm.ships.map((ship) => [ship.slot, ship.x, ship.y]);
  assert.equal(driver.sample(5), null);
  assert.deepEqual(driver.apply(seat, 5, 1 / 60), { lost: [] });
  assert.deepEqual(seat.point, { x: 26, y: 9 });
  assert.deepEqual(seat.swarm.ships.map((ship) => [ship.slot, ship.x, ship.y]), ships);
});
