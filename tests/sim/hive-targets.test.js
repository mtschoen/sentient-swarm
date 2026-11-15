import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packGateOwnership, packSimParams } from '../../src/sim/params.js';
import { AGENT_FLAG_ALIVE, AGENT_SPAWN_FRAMES_MASK, AGENT_TARGET_MASK, AGENT_TARGET_SHIFT, SHADER_CONSTANTS, STATS_INDICES, STATS_WORD_COUNT } from '../../src/sim/layout.js';
import { HIVE_FEEDING_REACH_SCALE } from '../../src/game/hive-tuning.js';
import { decodeFeedingKills } from '../../src/sim/stats.js';

const read = (name) => readFileSync(new URL(`../../src/sim/shaders/${name}.wgsl`, import.meta.url), 'utf8');
const occurrences = (text, needle) => text.split(needle).length - 1;

test('the target flag bits are clear of the alive bit and the spawn-in frames', () => {
  assert.equal(AGENT_TARGET_MASK, 3 << AGENT_TARGET_SHIFT);
  assert.equal(AGENT_TARGET_MASK & (AGENT_FLAG_ALIVE | AGENT_SPAWN_FRAMES_MASK), 0);
  assert.equal(SHADER_CONSTANTS.AGENT_TARGET_SHIFT, AGENT_TARGET_SHIFT);
  assert.ok(read('common').includes('const AGENT_TARGET_SHIFT: u32 = __AGENT_TARGET_SHIFT__u;'));
});

test('the gate ownership word packs four bits per row: the seek target then the owner, each seat plus 1', () => {
  assert.equal(packGateOwnership([]), 0);
  assert.equal(packGateOwnership([{}, { target: null, owner: null }]), 0);
  assert.equal(packGateOwnership([{ owner: 0, target: 1 }]), 2 | (1 << 2));
  assert.equal(packGateOwnership([{}, { owner: 1, target: 0 }, {}, { owner: 0, target: 1 }]), ((1 | (2 << 2)) << 4) | ((2 | (1 << 2)) << 12));
  assert.throws(() => packGateOwnership([{ owner: 2 }]), RangeError);
  assert.throws(() => packGateOwnership([{ target: -1 }]), RangeError);
});

test('packSimParams writes the ownership at byte 260 and leaves it zero for plain gates', () => {
  const plain = new DataView(packSimParams({ spawnGates: { gates: [{ x: 1, y: 2, radius: 1, emit: 1, species: 0 }], speciesBias: 0 } }));
  assert.equal(plain.getUint32(260, true), 0);
  const owned = new DataView(packSimParams({ spawnGates: { gates: [{ x: 1, y: 2, radius: 1, emit: 1, species: 0, owner: 1, target: 0 }], speciesBias: 0 } }));
  assert.equal(owned.getUint32(260, true), 1 | (2 << 2));
  assert.ok(read('common').includes('  seekRange: f32,\n  spawnGateOwnership: u32,\n}'));
});

test('steer seeks seekPointFor, which is exactly the nearest point for target 0', () => {
  const common = read('common');
  const steer = read('steer');
  assert.equal(occurrences(steer, 'seekPointFor(agent.position, agent.flags, params)'), 1);
  assert.equal(occurrences(steer, 'nearestPlayerPosition('), 0);
  const start = common.indexOf('fn seekPointFor(');
  const body = common.slice(start, common.indexOf('\n}\n', start) + 2);
  assert.ok(body.includes('if (seekTarget == 1u) {\n    return params.playerPosition;'));
  assert.ok(body.includes('if (seekTarget == 2u && params.secondPlayerActive != 0u) {\n    return params.secondPlayerPosition;'));
  assert.ok(body.trimEnd().endsWith('return nearestPlayerPosition(position, params);\n}'));
});

test('spawn writes the gate row target only for a gate placement and the whole flags word', () => {
  const spawn = read('spawn');
  assert.equal(occurrences(spawn, 'seekTarget = gateSeekTarget(draw.gate, params);'), 1);
  assert.equal(occurrences(spawn, 'agent.flags = FLAG_ALIVE | (SPAWN_IN_FRAMES << SPAWN_FRAMES_SHIFT) | (seekTarget << AGENT_TARGET_SHIFT);'), 1);
});

test('steer, spawn and the projectile collide pass keep their storage bindings', () => {
  assert.equal(occurrences(read('steer'), 'var<storage'), 7);
  assert.equal(occurrences(read('spawn'), 'var<storage'), 3);
  assert.equal(occurrences(read('projectiles_collide'), 'var<storage'), 8);
});

test('the feeding ground counters sit in the spare persistent stats words and decode per seat', () => {
  assert.equal(STATS_INDICES.ownerFeedingKills, 42);
  assert.equal(SHADER_CONSTANTS.STAT_OWNER_FEEDING_KILLS, 42);
  assert.equal(SHADER_CONSTANTS.HIVE_FEEDING_REACH_SCALE, HIVE_FEEDING_REACH_SCALE);
  const words = new Uint32Array(STATS_WORD_COUNT);
  words[42] = 5;
  words[43] = 9;
  assert.deepEqual(Array.from(decodeFeedingKills(words.buffer)), [5, 9]);
});
