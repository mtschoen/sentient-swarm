import test from 'node:test';
import assert from 'node:assert/strict';
import { assignGunners, gunnerStations } from '../../src/game/swarm-gunners.js';

const DEGREE = Math.PI / 180;

function slotAt(x, y = 0) {
  return { alive: true, x, y, gunnerIndex: -1, stationX: 0, stationY: 0, stationAngle: 0 };
}

function row(count) {
  return Array.from({ length: count }, (_, index) => slotAt(index));
}

function stationList(positions) {
  return positions.map(([x, y]) => ({ x, y, angle: 0 }));
}

test('gunnerStations puts three stations 30 degrees apart around the rear of the aim at the radius', () => {
  const out = [];
  const result = gunnerStations(3, 0, 5, 5, 1, out);
  assert.equal(result, out);
  [150, 180, 210].forEach((degrees, index) => {
    const angle = degrees * DEGREE;
    assert.ok(Math.abs(out[index].angle - angle) < 1e-9);
    assert.ok(Math.abs(out[index].x - (5 + Math.cos(angle))) < 1e-9);
    assert.ok(Math.abs(out[index].y - (5 + Math.sin(angle))) < 1e-9);
  });
  const first = out.slice();
  gunnerStations(3, 1, 5, 5, 1, out);
  first.forEach((entry, index) => assert.equal(out[index], entry));
});

test('assignGunners picks the nearest live ship to each station', () => {
  const slots = row(4);
  assignGunners(slots, 2, stationList([[2.9, 0], [0.2, 0]]));
  assert.deepEqual(slots.map((slot) => slot.gunnerIndex), [1, -1, -1, 0]);
  assert.equal(slots[3].stationX, 2.9);
  assert.equal(slots[0].stationX, 0.2);
});

test('assignGunners keeps a gunner on its station index while it lives', () => {
  const slots = row(4);
  const stations = stationList([[0, 0], [3, 0]]);
  assignGunners(slots, 2, stations);
  assert.equal(slots[0].gunnerIndex, 0);
  slots[1].x = 0;
  slots[0].x = 0.4;
  assignGunners(slots, 2, stations);
  assert.equal(slots[0].gunnerIndex, 0);
  assert.equal(slots[1].gunnerIndex, -1);
});

test("a dead gunner's station passes to the nearest non-gunner", () => {
  const slots = row(5);
  const stations = stationList([[0, 0], [4, 0]]);
  assignGunners(slots, 2, stations);
  assert.equal(slots[4].gunnerIndex, 1);
  slots[4].alive = false;
  assignGunners(slots, 2, stations);
  assert.equal(slots[4].gunnerIndex, -1);
  assert.equal(slots[3].gunnerIndex, 1);
  const indices = slots.filter((slot) => slot.gunnerIndex >= 0).map((slot) => slot.gunnerIndex).sort();
  assert.deepEqual(indices, [0, 1]);
});

test('fewer ships than turrets makes every ship a gunner', () => {
  const slots = row(3);
  assignGunners(slots, 3, stationList([[0, 0], [1, 0], [2, 0]]));
  assert.deepEqual(slots.map((slot) => slot.gunnerIndex).sort(), [0, 1, 2]);
});

test('a lowered effective count demotes the highest indices', () => {
  const slots = row(6);
  const stations = stationList([[0, 0], [1, 0], [2, 0], [3, 0]]);
  assignGunners(slots, 4, stations);
  assignGunners(slots, 2, stations);
  const indices = slots.filter((slot) => slot.gunnerIndex >= 0).map((slot) => slot.gunnerIndex).sort();
  assert.deepEqual(indices, [0, 1]);
});

test('assignGunners does not allocate', () => {
  const slots = row(256);
  const stations = stationList(Array.from({ length: 12 }, (_, index) => [index * 20, 0]));
  assignGunners(slots, 12, stations);
  const keys = Object.keys(slots[0]).join();
  const before = slots.slice();
  for (let run = 0; run < 1000; run += 1) assignGunners(slots, 12, stations);
  slots.forEach((slot, index) => assert.equal(slot, before[index]));
  assert.equal(Object.keys(slots[0]).join(), keys);
  assert.equal(slots.filter((slot) => slot.gunnerIndex >= 0).length, 12);
});

test('equidistant ships tie to the lowest slot', () => {
  const slots = [slotAt(3, 5), slotAt(3, 1), slotAt(1, 3), slotAt(5, 3)];
  assignGunners(slots, 1, stationList([[3, 3]]));
  assert.deepEqual(slots.map((slot) => slot.gunnerIndex), [0, -1, -1, -1]);
});
