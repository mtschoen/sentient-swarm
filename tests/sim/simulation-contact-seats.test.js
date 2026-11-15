import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeSimulation } from './fake-simulation.js';
import { SWARM_UNIFORM_BYTES } from '../../src/sim/kill.js';

const ship = (x) => ({ x, y: 1, alive: true, fresh: false });
const armedSeats = (upload) => new DataView(upload.bytes).getUint32(4, true);

test('contactUpload is one seat with armed bit 0 until a seat 2 table is set', () => {
  const { simulation } = fakeSimulation();
  simulation.setPlayerState({ x: 1, y: 1 });
  simulation.setSwarmShips([ship(1)], 0.06);
  const upload = simulation.contactUpload();
  assert.equal(upload.seatCount, 1);
  assert.equal(armedSeats(upload), 1);
  assert.equal(upload.bytes.byteLength, SWARM_UNIFORM_BYTES);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1 });
  const two = simulation.contactUpload();
  assert.equal(two.seatCount, 2);
  assert.equal(armedSeats(two), 3);
  assert.equal(new DataView(two.bytes).getFloat32(16 + 256 * 16, true), 2);
});

test('a seat invulnerable flag clears only its armed bit; setPlayerState invulnerable clears both', () => {
  const { simulation } = fakeSimulation();
  simulation.setPlayerState({ x: 1, y: 1 });
  simulation.setSwarmShips([ship(1)], 0.06);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1, invulnerable: true });
  assert.equal(armedSeats(simulation.contactUpload()), 0b01);
  simulation.setSwarmShips([ship(1)], 0.06, { seat: 0, invulnerable: true });
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1, invulnerable: false });
  assert.equal(armedSeats(simulation.contactUpload()), 0b10);
  simulation.setSwarmShips([ship(1)], 0.06);
  simulation.setPlayerState({ x: 1, y: 1, invulnerable: true });
  assert.equal(armedSeats(simulation.contactUpload()), 0);
});

test('clearSwarmShips(1) returns to one seat; clearSwarmShips(0) throws RangeError', () => {
  const { simulation } = fakeSimulation();
  simulation.setPlayerState({ x: 1, y: 1 });
  simulation.setSwarmShips([ship(1)], 0.06);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1 });
  simulation.clearSwarmShips(1);
  const upload = simulation.contactUpload();
  assert.equal(upload.seatCount, 1);
  assert.equal(armedSeats(upload), 1);
  assert.throws(() => simulation.clearSwarmShips(0), RangeError);
});

test('carryStateInto keeps both seat tables and their invulnerable flags', () => {
  const { simulation } = fakeSimulation();
  const { simulation: next } = fakeSimulation();
  next.densityReadback.adopt = () => {};
  simulation.setPlayerState({ x: 1, y: 1 });
  simulation.setSwarmShips([ship(1)], 0.06);
  simulation.setSwarmShips([ship(2)], 0.07, { seat: 1, invulnerable: true });
  simulation.carryStateInto(next);
  const upload = next.contactUpload();
  assert.equal(upload.seatCount, 2);
  assert.equal(armedSeats(upload), 0b01);
  const view = new DataView(upload.bytes);
  assert.equal(view.getFloat32(16, true), 1);
  assert.equal(view.getFloat32(16 + 256 * 16, true), 2);
  assert.ok(Math.abs(view.getFloat32(0, true) - 0.06) < 1e-7);
});

const projectileArmedSeats = (upload) => new DataView(upload.bytes).getUint32(8, true);

test('the projectile mask equals armedSeats except for a neutral-immune seat, which keeps only its projectile bit', () => {
  const { simulation } = fakeSimulation();
  simulation.setPlayerState({ x: 1, y: 1 });
  simulation.setSwarmShips([ship(1)], 0.06);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1 });
  const plain = simulation.contactUpload();
  assert.equal(projectileArmedSeats(plain), armedSeats(plain));
  assert.equal(projectileArmedSeats(plain), 0b11);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1, neutralImmune: true });
  const immune = simulation.contactUpload();
  assert.equal(armedSeats(immune), 0b01);
  assert.equal(projectileArmedSeats(immune), 0b11);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1, invulnerable: true, neutralImmune: true });
  const invulnerable = simulation.contactUpload();
  assert.equal(armedSeats(invulnerable), 0b01);
  assert.equal(projectileArmedSeats(invulnerable), 0b01);
  simulation.setSwarmShips([ship(2)], 0.06, { seat: 1, neutralImmune: true });
  simulation.setPlayerState({ x: 1, y: 1, invulnerable: true });
  const everyone = simulation.contactUpload();
  assert.equal(armedSeats(everyone), 0);
  assert.equal(projectileArmedSeats(everyone), 0);
});
