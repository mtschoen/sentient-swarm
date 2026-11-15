import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeEvent, encodeEvent, EVENT_TYPES } from '../../src/net/event-codec.js';
import { SAMPLE_EVENTS, sampleSpawns } from './net-fixtures.js';

for (const event of SAMPLE_EVENTS) {
  test(`${event.type} round trips`, () => {
    assert.deepEqual(decodeEvent(encodeEvent(event)), event);
  });
}

test('every event type has a sample and codes run from 16', () => {
  assert.deepEqual([...new Set(SAMPLE_EVENTS.map((event) => event.type))].sort(), [...EVENT_TYPES].sort());
  assert.equal(encodeEvent({ type: EVENT_TYPES[0], version: 1 })[0], 16);
});

test('a batch of 300 shots round trips at f32 precision', () => {
  const event = { type: 'shots', owner: 1, matchSeconds: 12.25, spawns: sampleSpawns(300) };
  const decoded = decodeEvent(encodeEvent(event));
  assert.equal(decoded.spawns.length, 300);
  assert.equal(decoded.spawns[299].velocityX, Math.fround(event.spawns[299].velocityX));
});

test('an unknown type code throws RangeError', () => {
  assert.throws(() => decodeEvent(Uint8Array.of(250)), RangeError);
  assert.throws(() => decodeEvent(Uint8Array.of(1)), RangeError);
});

test('a truncated event throws RangeError', () => {
  const bytes = encodeEvent(SAMPLE_EVENTS.find((event) => event.type === 'pickupCollected'));
  assert.throws(() => decodeEvent(bytes.subarray(0, bytes.length - 1)), RangeError);
});

test('encoding an unknown event type or mode throws RangeError', () => {
  assert.throws(() => encodeEvent({ type: 'nonsense' }), RangeError);
  assert.throws(() => encodeEvent({ type: 'titleMode', mode: 'coop' }), RangeError);
});
