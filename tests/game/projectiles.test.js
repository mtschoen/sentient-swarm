import test from 'node:test';
import assert from 'node:assert/strict';
import { BEAM_SLOT, PROJECTILE_STRIDE_BYTES, ProjectileSlots, beamSpawn, contiguousRuns, packProjectile } from '../../src/game/projectiles.js';

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
