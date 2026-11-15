import test from 'node:test';
import assert from 'node:assert/strict';
import { SEAT_START_OFFSET, seatStarts } from '../../src/game/seats.js';
import { VERSUS_START_OFFSET, startsFor } from '../../src/game/versus-seats.js';

const bounds = { minX: 0, maxX: 32, minY: 0, maxY: 18 };

test('seatStarts takes the offset either side of the center for two seats', () => {
  assert.deepEqual(seatStarts(2, bounds, 10), [{ x: 6, y: 9 }, { x: 26, y: 9 }]);
  assert.deepEqual(seatStarts(1, bounds, 10), [{ x: 16, y: 9 }]);
});

test('versus seats start far apart and inside the world; co-op keeps its close start', () => {
  const versus = startsFor({ seats: [{}, {}], worldBounds: bounds, versus: true });
  assert.equal(versus[1].x - versus[0].x, 2 * VERSUS_START_OFFSET);
  assert.ok(versus[0].x > bounds.minX && versus[1].x < bounds.maxX);
  assert.ok(VERSUS_START_OFFSET >= 4 * SEAT_START_OFFSET);
  const coop = startsFor({ seats: [{}, {}], worldBounds: bounds, versus: false });
  assert.equal(coop[1].x - coop[0].x, 2 * SEAT_START_OFFSET);
});
