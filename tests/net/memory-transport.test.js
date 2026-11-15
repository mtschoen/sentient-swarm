import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryTransportPair } from '../../src/net/memory-transport.js';
import { TransportState, validateChannel } from '../../src/net/transport.js';
import { sequenceRandom } from './net-fixtures.js';

test('messages arrive after the delay, events in order even with jitter on the state channel', () => {
  const pair = createMemoryTransportPair({ delaySeconds: 0.05, reorderSeconds: 0.04, random: sequenceRandom([0.9, 0.1, 0.5]) });
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push([channel, bytes[0]]));
  pair.host.send('state', Uint8Array.of(1));
  pair.host.send('state', Uint8Array.of(2));
  pair.host.send('events', Uint8Array.of(3));
  pair.host.send('events', Uint8Array.of(4));
  pair.advance(0.049);
  assert.deepEqual(received, []);
  pair.advance(0.1);
  assert.deepEqual(received.filter(([channel]) => channel === 'events'), [['events', 3], ['events', 4]]);
  assert.deepEqual(received.filter(([channel]) => channel === 'state').map(([, value]) => value), [2, 1]);
});

test('both endpoints start open and deliver in both directions', () => {
  const pair = createMemoryTransportPair();
  assert.equal(pair.host.state, TransportState.Open);
  assert.equal(pair.guest.state, TransportState.Open);
  const hostReceived = [];
  pair.host.onMessage((channel, bytes) => hostReceived.push([channel, bytes[0]]));
  pair.guest.send('events', Uint8Array.of(7));
  pair.guest.send('state', Uint8Array.of(8));
  assert.deepEqual(hostReceived, []);
  pair.advance(0);
  assert.deepEqual(hostReceived, [['events', 7], ['state', 8]]);
});

test('full loss drops every state message and no event', () => {
  const pair = createMemoryTransportPair({ lossFraction: 1, random: () => 0 });
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push([channel, bytes[0]]));
  for (let index = 0; index < 10; index += 1) {
    pair.host.send('state', Uint8Array.of(index));
    pair.host.send('events', Uint8Array.of(index));
  }
  pair.advance(1);
  assert.equal(received.filter(([channel]) => channel === 'state').length, 0);
  assert.deepEqual(received.map(([, value]) => value), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(received.every(([channel]) => channel === 'events'));
});

test('a disconnect drops state, holds events until reconnect, and both sides see the states', () => {
  const pair = createMemoryTransportPair();
  const hostStates = [];
  const guestStates = [];
  pair.host.onStateChange((state) => hostStates.push(state));
  pair.guest.onStateChange((state) => guestStates.push(state));
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push([channel, bytes[0]]));
  pair.disconnect();
  assert.deepEqual(hostStates, ['disconnected']);
  assert.deepEqual(guestStates, ['disconnected']);
  assert.equal(pair.host.state, TransportState.Disconnected);
  pair.host.send('state', Uint8Array.of(1));
  pair.host.send('events', Uint8Array.of(2));
  pair.advance(1);
  assert.deepEqual(received, []);
  pair.reconnect();
  assert.deepEqual(hostStates, ['disconnected', 'open']);
  assert.deepEqual(guestStates, ['disconnected', 'open']);
  pair.advance(1);
  assert.deepEqual(received, [['events', 2]]);
  pair.close();
  assert.deepEqual(hostStates, ['disconnected', 'open', 'closed']);
  assert.deepEqual(guestStates, ['disconnected', 'open', 'closed']);
});

test('a closed pair delivers nothing more and cannot reconnect', () => {
  const pair = createMemoryTransportPair();
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push(bytes[0]));
  pair.close();
  pair.host.send('events', Uint8Array.of(1));
  pair.reconnect();
  pair.advance(1);
  assert.deepEqual(received, []);
  assert.equal(pair.host.state, TransportState.Closed);
});

test('mutating the sent array afterwards does not change the delivered bytes', () => {
  const pair = createMemoryTransportPair();
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push(bytes[0]));
  const bytes = Uint8Array.of(1);
  pair.host.send('events', bytes);
  bytes[0] = 9;
  pair.advance(1);
  assert.deepEqual(received, [1]);
});

test('a handler that disconnects mid-delivery stops the delivery and loses no other message', () => {
  const pair = createMemoryTransportPair({ delaySeconds: 0.1 });
  const received = [];
  pair.guest.onMessage((channel, bytes) => {
    received.push(bytes[0]);
    if (bytes[0] === 1) pair.disconnect();
  });
  pair.host.send('events', Uint8Array.of(1));
  pair.host.send('state', Uint8Array.of(2));
  pair.host.send('events', Uint8Array.of(3));
  pair.advance(0.05);
  pair.host.send('events', Uint8Array.of(4));
  pair.advance(0.06);
  assert.deepEqual(received, [1], 'nothing is delivered after the disconnect');
  pair.reconnect();
  pair.advance(0.1);
  assert.deepEqual(received, [1, 3, 4], 'the held events survive and the state message was dropped');
});

test('a handler that closes mid-delivery stops the delivery', () => {
  const pair = createMemoryTransportPair();
  const received = [];
  pair.guest.onMessage((channel, bytes) => {
    received.push(bytes[0]);
    pair.close();
  });
  pair.host.send('events', Uint8Array.of(1));
  pair.host.send('events', Uint8Array.of(2));
  pair.host.send('state', Uint8Array.of(3));
  pair.advance(0);
  assert.deepEqual(received, [1]);
});

test('an unknown channel is rejected', () => {
  assert.equal(validateChannel('state'), 'state');
  assert.equal(validateChannel('events'), 'events');
  assert.throws(() => validateChannel('chat'));
  const pair = createMemoryTransportPair();
  assert.throws(() => pair.host.send('chat', Uint8Array.of(1)));
});

test('setLossFraction changes the state channel loss from the next send on', () => {
  const pair = createMemoryTransportPair({ random: () => 0.5 });
  const received = [];
  pair.guest.onMessage((channel, bytes) => received.push([channel, bytes[0]]));
  pair.host.send('state', Uint8Array.of(1));
  pair.setLossFraction(1);
  pair.host.send('state', Uint8Array.of(2));
  pair.host.send('events', Uint8Array.of(3));
  pair.setLossFraction(0);
  pair.host.send('state', Uint8Array.of(4));
  pair.advance(0);
  assert.deepEqual(received, [['state', 1], ['events', 3], ['state', 4]]);
});
