import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROJECTILE_FLAG_ALIVE, PROJECTILE_OWNER_MASK, PROJECTILE_OWNER_SHIFT, STATS_INDICES, STATS_WORD_COUNT, projectileOwnerFlags } from '../../src/sim/layout.js';
import { BeamTracker, PROJECTILE_STRIDE_BYTES, Projectiles, packProjectile } from '../../src/game/projectiles.js';
import { VersusHitPass, versusHitWorkgroups } from '../../src/sim/versus-hits.js';
import { decodeOwnerKills } from '../../src/sim/stats.js';
import { fakeSimulation } from './fake-simulation.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

const BULLET = { x: 1, y: 2, velocityX: 3, velocityY: 4, radius: 0.5, lifetime: 0.25, kind: 0 };
const flagsAt = (bytes, byteOffset = 0) => new DataView(bytes).getUint32(byteOffset + 36, true);

test('projectileOwnerFlags puts the seat plus 1 in bits 2 and 3, 0 for no owner, and rejects other seats', () => {
  assert.equal(projectileOwnerFlags(null), 0);
  assert.equal(projectileOwnerFlags(undefined), 0);
  assert.equal(projectileOwnerFlags(0), 1 << PROJECTILE_OWNER_SHIFT);
  assert.equal(projectileOwnerFlags(1), 2 << PROJECTILE_OWNER_SHIFT);
  assert.equal(projectileOwnerFlags(1) & ~PROJECTILE_OWNER_MASK, 0);
  assert.throws(() => projectileOwnerFlags(2), RangeError);
});

test('the owner kill words sit in the spare persistent tail', () => {
  assert.equal(STATS_INDICES.ownerKills, 40);
  assert.ok(STATS_INDICES.ownerKills + 2 <= STATS_WORD_COUNT);
});

test('packProjectile writes only the alive flag without an owner, and the owner bits with one', () => {
  const bytes = new ArrayBuffer(PROJECTILE_STRIDE_BYTES);
  packProjectile(new DataView(bytes), 0, BULLET);
  assert.equal(flagsAt(bytes), PROJECTILE_FLAG_ALIVE);
  packProjectile(new DataView(bytes), 0, { ...BULLET, owner: 1 });
  assert.equal(flagsAt(bytes), PROJECTILE_FLAG_ALIVE | projectileOwnerFlags(1));
});

test('BeamTracker carries the owner into the beam spawn and forgets it on clear', () => {
  const tracker = new BeamTracker();
  tracker.set({ x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 }, 1);
  assert.equal(tracker.next().owner, 1);
  tracker.clear();
  tracker.set({ x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 });
  assert.equal(tracker.next().owner, null);
});

function fakeProjectiles() {
  const writes = [];
  const device = {
    createBuffer: ({ size }) => ({ size, destroy() {} }),
    queue: { writeBuffer: (target, offset, data) => writes.push({ offset, data }) },
  };
  return { projectiles: new Projectiles({ device }, { capacity: 8, common: '' }), writes };
}

test('queueSpawn tags an owned spawn and leaves an unowned one as it was', () => {
  const { projectiles, writes } = fakeProjectiles();
  projectiles.queueSpawn(BULLET);
  projectiles.queueSpawn(BULLET, 0);
  assert.equal(projectiles.pending[0].spawn, BULLET);
  assert.equal(projectiles.pending[1].spawn.owner, 0);
  projectiles.setBeam({ x: 0, y: 0, directionX: 1, directionY: 0, halfWidth: 0.1 }, 0, 0);
  projectiles.writePending();
  const beamWrite = writes.find(({ offset }) => offset === 0);
  assert.equal(flagsAt(beamWrite.data), PROJECTILE_FLAG_ALIVE | projectileOwnerFlags(0));
  const run = writes.find(({ offset }) => offset === PROJECTILE_STRIDE_BYTES);
  assert.equal(flagsAt(run.data, 0), PROJECTILE_FLAG_ALIVE);
  assert.equal(flagsAt(run.data, PROJECTILE_STRIDE_BYTES), PROJECTILE_FLAG_ALIVE | projectileOwnerFlags(0));
});

test('versusHitWorkgroups covers every projectile slot', () => {
  assert.equal(versusHitWorkgroups({ size: 8192 * PROJECTILE_STRIDE_BYTES }), 32);
  assert.equal(versusHitWorkgroups({ size: 257 * PROJECTILE_STRIDE_BYTES }), 2);
});

test('VersusHitPass refuses to encode before initialize, then binds params, swarm, projectiles and stats', () => {
  const groups = [];
  const device = { createBindGroup: (descriptor) => { groups.push(descriptor); return descriptor; } };
  const pass = new VersusHitPass({ device }, { common: '' });
  const buffers = { paramsBuffer: { name: 'params' }, swarmBuffer: { name: 'swarm' }, projectileBuffer: { name: 'projectiles', size: 256 * PROJECTILE_STRIDE_BYTES }, statsBuffer: { name: 'stats' } };
  const dispatched = [];
  const computePass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups: (count) => dispatched.push(count), end() {} };
  const encoder = { beginComputePass: () => computePass };
  assert.throws(() => pass.encode(encoder, buffers), /initialize/);
  pass.pipeline = { getBindGroupLayout: () => 'layout' };
  pass.encode(encoder, buffers);
  assert.deepEqual(groups[0].entries.map(({ resource }) => resource.buffer.name), ['params', 'swarm', 'projectiles', 'stats']);
  assert.deepEqual(dispatched, [1]);
});

test('decodeOwnerKills reads the two owner words', () => {
  const words = new Uint32Array(STATS_WORD_COUNT);
  words[STATS_INDICES.ownerKills] = 5;
  words[STATS_INDICES.ownerKills + 1] = 9;
  assert.deepEqual(Array.from(decodeOwnerKills(words.buffer)), [5, 9]);
});

test('setVersusProjectiles defaults to null and carries across a capacity swap', () => {
  const { simulation } = fakeSimulation();
  const { simulation: next } = fakeSimulation();
  next.densityReadback.adopt = () => {};
  assert.equal(simulation.versusProjectiles, null);
  const buffer = { size: 48 };
  simulation.setVersusProjectiles(buffer);
  simulation.lastOwnerKills = [3, 4];
  simulation.carryStateInto(next);
  assert.equal(next.versusProjectiles, buffer);
  assert.deepEqual(next.lastOwnerKills, [3, 4]);
  simulation.setVersusProjectiles(null);
  assert.equal(simulation.versusProjectiles, null);
});

test('readAllStats reports each seat\'s owner kills since the last read, wrapping like the kill counter', () => {
  const { simulation } = fakeSimulation();
  const frame = (first, second) => {
    const words = new Uint32Array(STATS_WORD_COUNT);
    words[STATS_INDICES.ownerKills] = first;
    words[STATS_INDICES.ownerKills + 1] = second;
    return words.buffer;
  };
  simulation.lastOwnerKills = [0xfffffffe, 0];
  simulation.stagingRing = { readAll: () => [frame(1, 4), frame(2, 4)] };
  const [first, second] = simulation.readAllStats();
  assert.deepEqual(first.ownerKillsSinceLastRead, [3, 4]);
  assert.deepEqual(second.ownerKillsSinceLastRead, [1, 0]);
});

// Only versus play sets the versus projectiles: solo and co-op never dispatch the versus hit pass.
test('the step dispatches the versus hit pass only with versus projectiles set and two seats', () => {
  const source = readFileSync(new URL('../../src/sim/simulation.js', import.meta.url), 'utf8');
  assert.match(source, /if \(this\.versusProjectiles !== null && seatCount === MAXIMUM_PLAYER_SEATS\) \{\n\s+this\.versusHitPass\.encode/);
});
