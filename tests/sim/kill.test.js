import test from 'node:test';
import assert from 'node:assert/strict';
import { packKillArea } from '../../src/sim/kill.js';

test('packKillArea writes a zero (kill everything) area for a kill-all', () => {
  assert.deepEqual(Array.from(new Uint32Array(packKillArea(null))), [0, 0, 0, 0]);
});

test('packKillArea writes center, radius and the radial flag for a radial kill', () => {
  const bytes = packKillArea({ x: 3.5, y: 2.25, radius: 1.5 });
  assert.deepEqual(Array.from(new Float32Array(bytes, 0, 3)), [3.5, 2.25, 1.5]);
  assert.equal(new Uint32Array(bytes)[3], 1);
});
