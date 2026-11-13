import test from 'node:test';
import assert from 'node:assert/strict';
import { SWARM_UNIFORM_BYTES, packKillArea, packSwarmShips } from '../../src/sim/kill.js';

test('packKillArea writes a zero (kill everything) area for a kill-all', () => {
  assert.deepEqual(Array.from(new Uint32Array(packKillArea(null))), [0, 0, 0, 0]);
});

test('packKillArea writes center, radius and the radial flag for a radial kill', () => {
  const bytes = packKillArea({ x: 3.5, y: 2.25, radius: 1.5 });
  assert.deepEqual(Array.from(new Float32Array(bytes, 0, 3)), [3.5, 2.25, 1.5]);
  assert.equal(new Uint32Array(bytes)[3], 1);
});

test('packSwarmShips writes the radius, the armed flag and each slot with alive and fresh bits', () => {
  const ships = [{ x: 1.5, y: 2, alive: true, fresh: true }, { x: 3, y: 4, alive: true, fresh: false }, { x: 0, y: 0, alive: false, fresh: false }];
  const bytes = packSwarmShips(ships, { radius: 0.06, armed: true });
  assert.equal(bytes.byteLength, SWARM_UNIFORM_BYTES);
  assert.equal(SWARM_UNIFORM_BYTES, 16 + 256 * 16);
  const floats = new Float32Array(bytes);
  const words = new Uint32Array(bytes);
  assert.ok(Math.abs(floats[0] - 0.06) < 1e-7);
  assert.equal(words[1], 1);
  assert.deepEqual([floats[4], floats[5], words[6]], [1.5, 2, 3]);
  assert.deepEqual([floats[8], floats[9], words[10]], [3, 4, 1]);
  assert.equal(words[14], 0);
  // Reusing the buffer with fewer ships clears the slots past them, and disarmed writes 0.
  packSwarmShips(ships.slice(0, 1), { radius: 0.06, armed: false }, bytes);
  assert.deepEqual([words[1], words[6], words[10]], [0, 3, 0]);
});
