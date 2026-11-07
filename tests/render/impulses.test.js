import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOOM_BOOST_SECONDS, ImpulseSet, bloomBoostFactor } from '../../src/render/impulses.js';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} close to ${expected}`);

test('toUniformArray packs [x, y, age, strength] per impulse and zeroes unused slots', () => {
  const impulses = new ImpulseSet({ capacity: 8, durationSeconds: 1.2 });
  impulses.add({ x: 3, y: 4, strength: 1 }, 10);
  impulses.add({ x: 5, y: 6, strength: 0.3 }, 10.5);
  const packed = impulses.toUniformArray(11);
  assert.ok(packed instanceof Float32Array);
  assert.equal(packed.length, 8 * 4);
  [3, 4, 1, 1].forEach((value, index) => close(packed[index], value));
  [5, 6, 0.5, 0.3].forEach((value, index) => close(packed[4 + index], value));
  assert.deepEqual(Array.from(packed.slice(8)), new Array(24).fill(0));
});

test('an impulse has strength 0 once durationSeconds have passed', () => {
  const impulses = new ImpulseSet({ capacity: 8, durationSeconds: 1.2 });
  impulses.add({ x: 1, y: 1, strength: 1 }, 2);
  assert.ok(impulses.toUniformArray(3.1)[3] > 0);
  assert.equal(impulses.toUniformArray(3.2)[3], 0);
  assert.equal(impulses.toUniformArray(5)[3], 0);
  impulses.prune(5);
  assert.equal(impulses.count, 0);
});

test('a ninth impulse replaces the oldest', () => {
  const impulses = new ImpulseSet({ capacity: 8, durationSeconds: 1.2 });
  for (let index = 0; index < 8; index += 1) impulses.add({ x: index, y: 0, strength: 1 }, index * 0.01);
  impulses.add({ x: 99, y: 0, strength: 0.15 }, 0.1);
  assert.equal(impulses.count, 8);
  const packed = impulses.toUniformArray(0.1);
  const xs = [];
  for (let slot = 0; slot < 8; slot += 1) xs.push(packed[slot * 4]);
  assert.ok(!xs.includes(0), 'the oldest (x 0) is gone');
  assert.ok(xs.includes(99) && xs.includes(1) && xs.includes(7));
});

test('a dead impulse frees its slot before the oldest live one is replaced', () => {
  const impulses = new ImpulseSet({ capacity: 2, durationSeconds: 1 });
  impulses.add({ x: 1, y: 0, strength: 1 }, 0);
  impulses.add({ x: 2, y: 0, strength: 1 }, 0.5);
  impulses.add({ x: 3, y: 0, strength: 1 }, 1.2);
  const packed = impulses.toUniformArray(1.2);
  assert.deepEqual([packed[0], packed[4]].sort(), [2, 3]);
});

test('bloomBoostFactor doubles at the boost and decays back to 1 over 0.3 s', () => {
  assert.equal(BLOOM_BOOST_SECONDS, 0.3);
  close(bloomBoostFactor(0), 2);
  close(bloomBoostFactor(0.15), 1.5);
  close(bloomBoostFactor(0.3), 1);
  close(bloomBoostFactor(1), 1);
  close(bloomBoostFactor(-Infinity), 1);
  close(bloomBoostFactor(Infinity), 1);
});

test('adding an impulse stamped earlier than a live one keeps the later one', () => {
  const impulses = new ImpulseSet({ capacity: 8, durationSeconds: 1.2 });
  impulses.add({ x: 1, y: 0, strength: 1 }, 5);
  impulses.add({ x: 2, y: 0, strength: 0.15 }, 4.9);
  assert.equal(impulses.count, 2);
  const packed = impulses.toUniformArray(5);
  assert.equal(packed[3], 1);
  close(packed[7], 0.15);
});
