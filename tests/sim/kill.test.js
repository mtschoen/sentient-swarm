import test from 'node:test';
import assert from 'node:assert/strict';
import { SOLO_SWARM_UNIFORM_BYTES, SWARM_UNIFORM_BYTES, packKillArea, packSwarmShips } from '../../src/sim/kill.js';

test('packKillArea writes a zero (kill everything) area for a kill-all', () => {
  assert.deepEqual(Array.from(new Uint32Array(packKillArea(null))), [0, 0, 0, 0]);
});

test('packKillArea writes center, radius and the radial flag for a radial kill', () => {
  const bytes = packKillArea({ x: 3.5, y: 2.25, radius: 1.5 });
  assert.deepEqual(Array.from(new Float32Array(bytes, 0, 3)), [3.5, 2.25, 1.5]);
  assert.equal(new Uint32Array(bytes)[3], 1);
});

test('packSwarmShips writes the armed seat bits and seat k slot s at k * 256 + s', () => {
  assert.equal(SWARM_UNIFORM_BYTES, 16 + 512 * 16);
  assert.equal(SOLO_SWARM_UNIFORM_BYTES, 16 + 256 * 16);
  const bytes = packSwarmShips([[{ x: 1, y: 2, alive: true, fresh: true }], [{ x: 3, y: 4, alive: true, fresh: false }]], { radius: 0.06, armedSeats: 0b10 });
  assert.equal(bytes.byteLength, SWARM_UNIFORM_BYTES);
  const view = new DataView(bytes);
  assert.ok(Math.abs(view.getFloat32(0, true) - 0.06) < 1e-7);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(16 + 8, true), 3);
  assert.equal(view.getFloat32(16 + 256 * 16, true), 3);
  assert.equal(view.getFloat32(16 + 256 * 16 + 4, true), 4);
  assert.equal(view.getUint32(16 + 256 * 16 + 8, true), 1);
});

test('a one-seat table writes every seat 2 slot dead, and reusing the buffer clears old slots', () => {
  const bytes = packSwarmShips([[{ x: 1, y: 2, alive: true, fresh: false }]], { radius: 0.06, armedSeats: 1 });
  const view = new DataView(bytes);
  assert.equal(view.getUint32(4, true), 1);
  for (let slot = 0; slot < 256; slot += 1) assert.equal(view.getUint32(16 + (256 + slot) * 16 + 8, true), 0);
  packSwarmShips([[{ x: 1, y: 2, alive: true, fresh: false }, { x: 1, y: 2, alive: true, fresh: false }], [{ x: 3, y: 4, alive: true, fresh: false }]], { radius: 0.06, armedSeats: 3 }, bytes);
  assert.equal(view.getUint32(16 + 16 + 8, true), 1);
  assert.equal(view.getUint32(16 + 256 * 16 + 8, true), 1);
  packSwarmShips([[{ x: 1, y: 2, alive: true, fresh: false }]], { radius: 0.06, armedSeats: 0 }, bytes);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(view.getUint32(16 + 16 + 8, true), 0);
  assert.equal(view.getUint32(16 + 256 * 16 + 8, true), 0);
});
