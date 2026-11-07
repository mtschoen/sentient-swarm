import test from 'node:test';
import assert from 'node:assert/strict';
import { STATS_BYTES, STATS_INDICES, STATS_PERSISTENT_OFFSET_BYTES, decodeStats } from '../../src/sim/stats.js';

test('the per-frame prefix comes before the persistent tail, both 4-byte aligned', () => {
  assert.equal(STATS_PERSISTENT_OFFSET_BYTES % 4, 0);
  assert.ok(STATS_PERSISTENT_OFFSET_BYTES < STATS_BYTES);
  const perFrame = ['aliveTotal', 'frameSequence', 'killsUnscored'];
  for (const name of perFrame) assert.ok(STATS_INDICES[name] * 4 < STATS_PERSISTENT_OFFSET_BYTES, name);
  for (const name of ['playerHitSequence', 'hitLatch', 'kills']) {
    assert.ok(STATS_INDICES[name] * 4 >= STATS_PERSISTENT_OFFSET_BYTES, name);
    assert.ok(STATS_INDICES[name] * 4 < STATS_BYTES, name);
  }
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
  assert.deepEqual(decodeStats(words.buffer), {
    aliveTotal: 15,
    alivePerSpecies: new Uint32Array([1, 2, 3, 4, 5]),
    killsTotal: 7,
    frameSequence: 42,
    killsUnscored: 900,
    playerHitSequence: 40,
    hitLatch: 1,
  });
});
