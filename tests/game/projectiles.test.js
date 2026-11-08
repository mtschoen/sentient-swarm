import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAM_SLOT, BeamTracker, PROJECTILE_STRIDE_BYTES, ProjectileSlots, beamSpawn, contiguousRuns, packProjectile } from '../../src/game/projectiles.js';

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
