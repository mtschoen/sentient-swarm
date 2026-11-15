import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignal, decodeSignal, inviteUrl, inviteFromHash } from '../../src/net/signal-codec.js';
import { SAMPLE_SDP, encodeWithVersion } from './net-fixtures.js';

test('an offer round trips through base64url', async () => {
  const encoded = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeSignal(`  ${encoded}\n`, 'offer'), { kind: 'offer', sdp: SAMPLE_SDP });
  assert.ok(encoded.length < SAMPLE_SDP.length);
});

test('a whole invite url decodes to the same offer', async () => {
  const encoded = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  const decoded = await decodeSignal(inviteUrl('https://example.test/game/', encoded), 'offer');
  assert.deepEqual(decoded, { kind: 'offer', sdp: SAMPLE_SDP });
});

test('a pasted reply that is not a reply says why', async () => {
  const offer = await encodeSignal({ kind: 'offer', sdp: SAMPLE_SDP });
  await assert.rejects(decodeSignal(offer, 'answer'), { name: 'SignalError', reason: 'wrongKind' });
  await assert.rejects(decodeSignal(inviteUrl('https://example.test/game/', offer), 'answer'), { reason: 'wrongKind' });
  await assert.rejects(decodeSignal('not a reply at all', 'answer'), { reason: 'malformed' });
  await assert.rejects(decodeSignal('', 'answer'), { reason: 'malformed' });
  await assert.rejects(decodeSignal(await encodeWithVersion(2, 'answer'), 'answer'), { reason: 'version' });
});

test('valid base64url that is not a deflated signal is malformed', async () => {
  await assert.rejects(decodeSignal('QUJDREVGRw', 'offer'), { name: 'SignalError', reason: 'malformed' });
});

test('the invite link keeps the page address and replaces any fragment', () => {
  assert.equal(inviteUrl('https://example.test/game/#mix=abc', 'QQ'), 'https://example.test/game/#join=QQ');
  assert.equal(inviteFromHash('#join=QQ'), 'QQ');
  assert.equal(inviteFromHash('#mix=abc'), null);
  assert.equal(inviteFromHash(''), null);
});
