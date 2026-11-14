import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIVE_KILLS, REVIVE_OFFSET, SeatRevival, revivePoint } from '../../src/game/seat-revival.js';

test('a downed seat revives on the 100th kill after it went down, not the 99th', () => {
  const revival = new SeatRevival({ seatCount: 2 });
  assert.equal(REVIVE_KILLS, 100);
  revival.down(1);
  assert.equal(revival.isDown(1), true);
  assert.equal(revival.isDown(0), false);
  assert.deepEqual(revival.addKills(60), []);
  assert.deepEqual(revival.addKills(39), []);
  assert.deepEqual(revival.progress(1), { kills: 99, needed: 100 });
  assert.deepEqual(revival.addKills(1), [1]);
  assert.equal(revival.isDown(1), false);
  assert.deepEqual(revival.addKills(500), []);
});

test('kills before the down do not count and reset clears every down seat', () => {
  const revival = new SeatRevival({ seatCount: 2 });
  revival.addKills(400);
  revival.down(0);
  assert.deepEqual(revival.progress(0), { kills: 0, needed: 100 });
  revival.addKills(50);
  revival.down(1);
  assert.deepEqual(revival.progress(1), { kills: 0, needed: 100 });
  revival.reset();
  assert.equal(revival.isDown(0), false);
  assert.equal(revival.isDown(1), false);
  assert.deepEqual(revival.addKills(1000), []);
});

test('revivePoint stays inside the bounds beside a survivor at the right wall', () => {
  const bounds = { minX: 0, minY: 0, maxX: 32, maxY: 18 };
  const radius = 0.12;
  assert.deepEqual(revivePoint({ x: 10, y: 5 }, bounds, radius), { x: 10 + REVIVE_OFFSET, y: 5 });
  const atWall = revivePoint({ x: 31.9, y: 5 }, bounds, radius);
  assert.ok(Math.abs(atWall.x - (31.9 - REVIVE_OFFSET)) < 1e-9);
  assert.ok(atWall.x <= bounds.maxX - radius);
  const inCorner = revivePoint({ x: 0.05, y: 18.5 }, { ...bounds }, radius);
  assert.ok(inCorner.x >= bounds.minX + radius && inCorner.y <= bounds.maxY - radius);
});
