import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAM_SLOT, BeamTracker, MAXIMUM_BEAM_SLOTS, PROJECTILE_STRIDE_BYTES, ProjectileSlots, Projectiles, beamReachScale, beamSpawn, contiguousRuns, packProjectile,
  validatedBaseKillBudget, validatedBeamSweepThreshold, withKillBudget,
} from '../../src/game/projectiles.js';
import { BindGroupCache } from '../../src/gpu/bind-group-cache.js';
import {
  BEAM_SWEEP_MINIMUM_REACH_SCALE, MAXIMUM_BASE_KILL_BUDGET, MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES, PROJECTILE_KINDS,
} from '../../src/game/weaponTypes.js';

test('ProjectileSlots assigns round-robin and never hands out the beam slot', () => {
  const slots = new ProjectileSlots(4);
  assert.deepEqual(Array.from({ length: 7 }, () => slots.next()), [1, 2, 3, 1, 2, 3, 1]);
  assert.ok(!Array.from({ length: 10 }, () => slots.next()).includes(BEAM_SLOT));
});

test('ProjectileSlots rejects a capacity with no room beside the beam', () => {
  assert.throws(() => new ProjectileSlots(1), /at least 2 slots/);
});

test('contiguousRuns splits at the wrap so each run is one writeBuffer', () => {
  assert.deepEqual(contiguousRuns([6, 7, 1, 2]), [
    { firstSlot: 6, startIndex: 0, count: 2 },
    { firstSlot: 1, startIndex: 2, count: 2 },
  ]);
  assert.deepEqual(contiguousRuns([]), []);
});

test('packProjectile writes the 48-byte Projectile layout, alive, previousPosition equal to position', () => {
  const bytes = new ArrayBuffer(PROJECTILE_STRIDE_BYTES * 2);
  const view = new DataView(bytes);
  packProjectile(view, PROJECTILE_STRIDE_BYTES, { x: 1, y: 2, velocityX: 3, velocityY: 4, radius: 0.5, lifetime: 0.25, kind: 3, seed: 7, extra: 9 });
  const floats = new Float32Array(bytes, PROJECTILE_STRIDE_BYTES, 12);
  const words = new Uint32Array(bytes, PROJECTILE_STRIDE_BYTES, 12);
  assert.deepEqual(Array.from(floats.slice(0, 8)), [1, 2, 1, 2, 3, 4, 0.5, 0.25]);
  assert.equal(words[8], 3);
  assert.equal(words[9], 1);
  assert.deepEqual([floats[10], floats[11]], [7, 9]);
  assert.ok(new Uint8Array(bytes, 0, PROJECTILE_STRIDE_BYTES).every((byte) => byte === 0));
});

test('beamSpawn normalizes the direction into velocity and treats a zero direction as no beam', () => {
  const beam = beamSpawn({ x: 1, y: 2, directionX: 3, directionY: 4, halfWidth: 0.2 });
  assert.equal(beam.kind, 6);
  assert.equal(beam.radius, 0.2);
  assert.ok(Math.abs(beam.velocityX - 0.6) < 1e-12 && Math.abs(beam.velocityY - 0.8) < 1e-12);
  assert.equal(beamSpawn({ x: 0, y: 0, directionX: 0, directionY: 0, halfWidth: 1 }), null);
  assert.equal(beamSpawn(null), null);
});

const close = (actual, expected) => Math.abs(actual - expected) < 1e-12;

test('beamSpawn carries the previous unit direction in seed and extra, defaulting to the current one', () => {
  const fresh = beamSpawn({ x: 1, y: 2, directionX: 3, directionY: 4, halfWidth: 0.2 });
  assert.ok(close(fresh.seed, 0.6) && close(fresh.extra, 0.8));
  const swept = beamSpawn({ x: 1, y: 2, directionX: 1, directionY: 0, halfWidth: 0.2 }, { x: 0, y: -2 });
  assert.ok(close(swept.seed, 0) && close(swept.extra, -1));
  const zeroPrevious = beamSpawn({ x: 1, y: 2, directionX: 1, directionY: 0, halfWidth: 0.2 }, { x: 0, y: 0 });
  assert.ok(close(zeroPrevious.seed, 1) && close(zeroPrevious.extra, 0));
});

const beamToward = (directionX, directionY) => ({ x: 8, y: 4.5, directionX, directionY, halfWidth: 0.1 });

test('BeamTracker: the first written beam is a line, later ones sweep from the last written direction', () => {
  const tracker = new BeamTracker();
  assert.equal(tracker.next(), null);
  tracker.set(beamToward(1, 0));
  const first = tracker.next();
  assert.ok(close(first.seed, 1) && close(first.extra, 0));
  tracker.set(beamToward(0, 2));
  const second = tracker.next();
  assert.ok(close(second.velocityX, 0) && close(second.velocityY, 1));
  assert.ok(close(second.seed, 1) && close(second.extra, 0));
  const held = tracker.next();
  assert.ok(close(held.seed, 0) && close(held.extra, 1));
});

test('BeamTracker: several sets between writes sweep from the last written direction, not the last set', () => {
  const tracker = new BeamTracker();
  tracker.set(beamToward(1, 0));
  tracker.next();
  tracker.set(beamToward(1, 1));
  tracker.set(beamToward(0, 1));
  const spawn = tracker.next();
  assert.ok(close(spawn.seed, 1) && close(spawn.extra, 0));
  assert.ok(close(spawn.velocityX, 0) && close(spawn.velocityY, 1));
});

test('BeamTracker: stopping (null, as on the expiry frame) resets, so the next beam starts as a line', () => {
  const tracker = new BeamTracker();
  tracker.set(beamToward(1, 0));
  tracker.next();
  tracker.set(null);
  assert.equal(tracker.next(), null);
  tracker.set(beamToward(0, 1));
  const restarted = tracker.next();
  assert.ok(close(restarted.seed, 0) && close(restarted.extra, 1));
});

test('BeamTracker: a stop and restart between two writes still resets', () => {
  const tracker = new BeamTracker();
  tracker.set(beamToward(1, 0));
  tracker.next();
  tracker.set(null);
  tracker.set(beamToward(-1, 0));
  const restarted = tracker.next();
  assert.ok(close(restarted.seed, -1) && close(restarted.extra, 0));
});

test('BeamTracker: clear drops the beam and the previous direction', () => {
  const tracker = new BeamTracker();
  tracker.set(beamToward(1, 0));
  tracker.next();
  tracker.clear();
  assert.equal(tracker.next(), null);
  tracker.set(beamToward(0, -1));
  const spawn = tracker.next();
  assert.ok(close(spawn.seed, 0) && close(spawn.extra, -1));
});

test('beamReachScale is 1 with the sweep budget off, for a line, and under the threshold', () => {
  const right = { x: 1, y: 0 };
  const turned = { x: Math.cos(Math.PI / 4), y: Math.sin(Math.PI / 4) };
  assert.equal(beamReachScale(right, turned, 0), 1);
  assert.equal(beamReachScale(null, turned, 10), 1);
  assert.equal(beamReachScale(right, right, 10), 1);
  assert.equal(beamReachScale(right, turned, 60), 1);
});

test('beamReachScale shrinks as threshold over swept angle, floored at the minimum scale', () => {
  const right = { x: 1, y: 0 };
  const turned = { x: Math.cos(Math.PI / 4), y: Math.sin(Math.PI / 4) };
  assert.ok(Math.abs(beamReachScale(right, turned, 15) - 15 / 45) < 1e-9);
  assert.equal(beamReachScale(right, { x: -1, y: 0 }, 1), BEAM_SWEEP_MINIMUM_REACH_SCALE);
});

test('beamSpawn writes the reach scale as the beam lifetime (1 by default, so nothing changes)', () => {
  const beam = { x: 1, y: 1, directionX: 0, directionY: 1, halfWidth: 0.1 };
  assert.equal(beamSpawn(beam, { x: 1, y: 0 }).lifetime, 1);
  assert.ok(Math.abs(beamSpawn(beam, { x: 1, y: 0 }, 30).lifetime - 30 / 90) < 1e-9);
});

test('BeamTracker applies its sweep threshold to the written beam', () => {
  const tracker = new BeamTracker();
  tracker.sweepThresholdDegrees = 9;
  tracker.set({ x: 1, y: 1, directionX: 1, directionY: 0, halfWidth: 0.1 });
  assert.equal(tracker.next().lifetime, 1);
  tracker.set({ x: 1, y: 1, directionX: 0, directionY: 1, halfWidth: 0.1 });
  assert.ok(Math.abs(tracker.next().lifetime - 0.25) < 1e-9);
});

test('withKillBudget writes the base gun budget into extra and leaves other kinds and unlimited alone', () => {
  const bullet = { kind: PROJECTILE_KINDS.bullet, extra: 0 };
  const sidewinder = { kind: PROJECTILE_KINDS.sidewinder, extra: 5 };
  assert.equal(withKillBudget(bullet, 0), bullet);
  assert.equal(withKillBudget(bullet, 3).extra, 3);
  assert.equal(bullet.extra, 0);
  assert.equal(withKillBudget(sidewinder, 3), sidewinder);
});

test('kill budget and sweep threshold validators reject out-of-range values', () => {
  assert.equal(validatedBaseKillBudget(0), 0);
  assert.equal(validatedBaseKillBudget(MAXIMUM_BASE_KILL_BUDGET), MAXIMUM_BASE_KILL_BUDGET);
  assert.throws(() => validatedBaseKillBudget(1.5), RangeError);
  assert.throws(() => validatedBaseKillBudget(-1), RangeError);
  assert.equal(validatedBeamSweepThreshold(MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES), MAXIMUM_BEAM_SWEEP_THRESHOLD_DEGREES);
  assert.throws(() => validatedBeamSweepThreshold(91), RangeError);
  assert.throws(() => validatedBeamSweepThreshold(Number.NaN), RangeError);
});

test('clearBindGroupCaches empties both bind group caches so a replaced simulation leaves no stale entries', () => {
  // The constructor allocates GPU buffers, so build the instance without it and give it the two caches.
  const projectiles = Object.create(Projectiles.prototype);
  projectiles.stepBindGroupCache = new BindGroupCache(() => ({}));
  projectiles.collideBindGroupCache = new BindGroupCache(() => ({}));
  const buffer = {};
  projectiles.stepBindGroupCache.get([buffer]);
  projectiles.collideBindGroupCache.get([buffer]);
  projectiles.clearBindGroupCaches();
  assert.equal(projectiles.stepBindGroupCache.entries.size, 0);
  assert.equal(projectiles.collideBindGroupCache.entries.size, 0);
  projectiles.stepBindGroupCache.get([buffer]);
  assert.equal(projectiles.stepBindGroupCache.creationCount, 2);
});

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

// A Projectiles over a fake device that records every writeBuffer and every dispatch.
function fakeProjectiles(capacity = 16) {
  const writes = [];
  const dispatches = [];
  let current = null;
  const buffer = (size) => ({ size, destroy() {} });
  const device = {
    createBuffer: ({ size }) => buffer(size),
    queue: { writeBuffer: (target, offset, data) => writes.push({ offset, bytes: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength) }) },
  };
  const projectiles = new Projectiles({ device }, { capacity, common: '' });
  projectiles.pipelines = { step: 'step', collide: 'collide', rings: 'rings', beam: 'beam' };
  projectiles.stepBindGroupCache = { get: () => ({}), clear() {} };
  projectiles.collideBindGroupCache = { get: () => ({}), clear() {} };
  const pass = {
    setPipeline: (pipeline) => { current = pipeline; },
    setBindGroup() {},
    dispatchWorkgroups: (count) => dispatches.push({ pipeline: current, count }),
    end() {},
  };
  const encoder = { copyBufferToBuffer() {}, beginComputePass: () => pass };
  const context = {
    agentsBuffer: {}, gridBuffers: {}, fieldBuffers: { blurred: {}, threatAccumulator: {} },
    particlePool: { registerBindGroupCache() {}, buffers: { particles: {} } }, statsBuffer: {}, paramsBuffer: {}, speciesTableBuffer: {},
  };
  return { projectiles, writes, dispatches, encode: () => projectiles.encode(encoder, context) };
}

const BEAM_REQUEST = { x: 1, y: 2, directionX: 1, directionY: 0, halfWidth: 0.1 };

test('with two beam slots the cursor never hands out slots 0 or 1', () => {
  const slots = new ProjectileSlots(6, MAXIMUM_BEAM_SLOTS);
  const handed = Array.from({ length: 20 }, () => slots.next());
  assert.ok(handed.every((slot) => slot >= 2));
  assert.deepEqual(handed.slice(0, 5), [2, 3, 4, 5, 2]);
  slots.setReservedSlots(1);
  assert.ok(Array.from({ length: 12 }, () => slots.next()).includes(1));
});

test('setBeam(beam, 1) writes slot 1 and setBeamSlotCount(1) writes it dead once', () => {
  const { projectiles, writes, encode } = fakeProjectiles();
  projectiles.setBeamSlotCount(2);
  projectiles.setBeam(BEAM_REQUEST, 1);
  encode();
  assert.deepEqual(writes.map((write) => write.offset), [PROJECTILE_STRIDE_BYTES]);
  assert.ok(writes[0].bytes.some((byte) => byte !== 0));
  projectiles.setBeamSlotCount(1);
  encode();
  assert.deepEqual(writes.map((write) => write.offset), [PROJECTILE_STRIDE_BYTES, PROJECTILE_STRIDE_BYTES]);
  assert.ok(writes[1].bytes.every((byte) => byte === 0));
  encode();
  assert.equal(writes.length, 2);
});

test('setBeam for a seat past the slot count and setBeamSlotCount(3) throw RangeError', () => {
  const { projectiles } = fakeProjectiles();
  assert.throws(() => projectiles.setBeam(BEAM_REQUEST, 1), RangeError);
  assert.throws(() => projectiles.setBeamSlotCount(3), RangeError);
  assert.throws(() => projectiles.setBeamSlotCount(0), RangeError);
  projectiles.setBeamSlotCount(2);
  projectiles.setBeam(BEAM_REQUEST, 1);
  assert.throws(() => projectiles.setBeam(BEAM_REQUEST, 2), RangeError);
});

test('encode dispatches one beam workgroup per beam slot', () => {
  const { projectiles, dispatches, encode } = fakeProjectiles();
  encode();
  projectiles.setBeamSlotCount(2);
  encode();
  const beamCounts = dispatches.filter((dispatch) => dispatch.pipeline === 'beam').map((dispatch) => dispatch.count);
  assert.deepEqual(beamCounts, [1, 2]);
});

test('setBeamSweepThreshold sets both trackers and clear clears both', () => {
  const { projectiles } = fakeProjectiles();
  projectiles.setBeamSlotCount(2);
  projectiles.setBeamSweepThreshold(30);
  assert.deepEqual(projectiles.beamTrackers.map((tracker) => tracker.sweepThresholdDegrees), [30, 30]);
  assert.equal(projectiles.beamTracker, projectiles.beamTrackers[0]);
  projectiles.setBeam(BEAM_REQUEST, 0);
  projectiles.setBeam(BEAM_REQUEST, 1);
  projectiles.clear();
  assert.deepEqual(projectiles.beamTrackers.map((tracker) => tracker.beam), [null, null]);
});
