import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_BYTES, STATS_INDICES, STATS_PERSISTENT_OFFSET_BYTES, decodeStats } from '../../src/sim/stats.js';
import { SWARM_HIT_MASK_WORDS } from '../../src/sim/layout.js';

test('the per-frame prefix comes before the persistent tail, both 4-byte aligned', () => {
  assert.equal(STATS_PERSISTENT_OFFSET_BYTES % 4, 0);
  assert.ok(STATS_PERSISTENT_OFFSET_BYTES < STATS_BYTES);
  const perFrame = ['aliveTotal', 'frameSequence', 'killsUnscored', 'ringsThisFrame', 'lastRingX', 'lastRingY'];
  for (const name of perFrame) assert.ok(STATS_INDICES[name] * 4 < STATS_PERSISTENT_OFFSET_BYTES, name);
  for (const name of ['playerHitSequence', 'hitLatch', 'kills', 'swarmHitMask']) {
    assert.ok(STATS_INDICES[name] * 4 >= STATS_PERSISTENT_OFFSET_BYTES, name);
    assert.ok(STATS_INDICES[name] * 4 < STATS_BYTES, name);
  }
  // The swarm hit mask's last word still fits.
  assert.ok((STATS_INDICES.swarmHitMask + SWARM_HIT_MASK_WORDS) * 4 <= STATS_BYTES);
});

test('decodeStats reads every field by index', () => {
  const words = new Uint32Array(STATS_BYTES / 4);
  words[STATS_INDICES.aliveTotal] = 15;
  [1, 2, 3, 4, 5].forEach((count, species) => { words[STATS_INDICES.firstSpecies + species] = count; });
  words[STATS_INDICES.kills] = 7;
  words[STATS_INDICES.frameSequence] = 42;
  words[STATS_INDICES.killsUnscored] = 900;
  words[STATS_INDICES.playerHitSequence] = 40;
  words[STATS_INDICES.hitLatch] = 1;
  words[STATS_INDICES.ringsThisFrame] = 3;
  words[STATS_INDICES.swarmHitMask] = 5;
  words[STATS_INDICES.swarmHitMask + SWARM_HIT_MASK_WORDS - 1] = 0x80000000;
  const floats = new Float32Array(words.buffer);
  floats[STATS_INDICES.lastRingX] = 4.5;
  floats[STATS_INDICES.lastRingY] = 2.25;
  assert.deepEqual(decodeStats(words.buffer), {
    aliveTotal: 15,
    alivePerSpecies: new Uint32Array([1, 2, 3, 4, 5]),
    killsTotal: 7,
    frameSequence: 42,
    killsUnscored: 900,
    playerHitSequence: 40,
    hitLatch: 1,
    ringsThisFrame: 3,
    lastRingX: 4.5,
    lastRingY: 2.25,
    swarmHitMask: new Uint32Array([5, 0, 0, 0, 0, 0, 0, 0x80000000]),
    secondSwarmHitMask: new Uint32Array(SWARM_HIT_MASK_WORDS),
  });
});

test('the second swarm hit mask follows the first in the persistent tail', () => {
  assert.equal(STATS_INDICES.secondSwarmHitMask, STATS_INDICES.swarmHitMask + SWARM_HIT_MASK_WORDS);
  assert.equal(STATS_BYTES, 48 * 4);
  assert.ok((STATS_INDICES.secondSwarmHitMask + SWARM_HIT_MASK_WORDS) * 4 <= STATS_BYTES);
  assert.ok(STATS_INDICES.secondSwarmHitMask * 4 >= STATS_PERSISTENT_OFFSET_BYTES);
  const words = new Uint32Array(STATS_BYTES / 4);
  words[STATS_INDICES.secondSwarmHitMask] = 9;
  words[STATS_INDICES.secondSwarmHitMask + SWARM_HIT_MASK_WORDS - 1] = 0x80000000;
  const decoded = decodeStats(words.buffer);
  assert.deepEqual(decoded.secondSwarmHitMask, new Uint32Array([9, 0, 0, 0, 0, 0, 0, 0x80000000]));
  assert.deepEqual(decoded.swarmHitMask, new Uint32Array(SWARM_HIT_MASK_WORDS));
});
