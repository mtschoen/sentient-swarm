import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtcConnection } from '../../src/net/rtc-transport.js';
import { ICE_SERVERS, ICE_GATHER_CAP_SECONDS } from '../../src/net/ice-configuration.js';

class FakeTarget {
  #listeners = new Map();
  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(listener);
  }
  removeEventListener(type, listener) {
    const list = this.#listeners.get(type) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  }
  emit(type, event = {}) { for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event); }
}

class FakeChannel extends FakeTarget {
  readyState = 'connecting';
  bufferedAmount = 0;
  sent = [];
  closed = false;
  send(data) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 'closed'; }
  open() { this.readyState = 'open'; this.emit('open'); }
}

class FakePeerConnection extends FakeTarget {
  static last = null;
  connectionState = 'new';
  iceGatheringState = 'new';
  localDescription = { sdp: 'local-sdp' };
  channels = [];
  channelOptions = {};
  descriptions = [];
  peerClosed = false;
  constructor(configuration) {
    super();
    this.configuration = configuration;
    FakePeerConnection.last = this;
  }
  createDataChannel(label, options) {
    const channel = new FakeChannel();
    this.channels.push(channel);
    this.channelOptions[label] = options;
    return channel;
  }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'answer-sdp' }; }
  async setLocalDescription(description) { this.descriptions.push(['local', description.type]); }
  async setRemoteDescription(description) { this.descriptions.push(['remote', description.type, description.sdp]); }
  close() { this.peerClosed = true; }
  setConnection(value) { this.connectionState = value; this.emit('connectionstatechange'); }
  completeGathering() { this.iceGatheringState = 'complete'; this.emit('icegatheringstatechange'); }
}

function createFakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    set: (callback, seconds) => { timers.set(next, { callback, seconds }); return next++; },
    clear: (handle) => { timers.delete(handle); },
    pending: () => [...timers.values()],
    fireAll: () => { for (const [handle, timer] of [...timers]) { timers.delete(handle); timer.callback(); } },
  };
}

function build(timers = createFakeTimers()) {
  const connection = createRtcConnection({ PeerConnection: FakePeerConnection, setTimer: timers.set, clearTimer: timers.clear });
  return { connection, timers, peer: FakePeerConnection.last };
}

function openAll(peer) {
  peer.setConnection('connected');
  for (const channel of peer.channels) channel.open();
}

async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

test('the two channels are negotiated with the pinned options', () => {
  const { peer } = build();
  assert.deepEqual(peer.channelOptions, {
    state: { ordered: false, maxRetransmits: 0, negotiated: true, id: 0 },
    events: { ordered: true, negotiated: true, id: 1 },
  });
  assert.deepEqual(peer.configuration.iceServers, ICE_SERVERS);
  assert.ok(peer.channels.every((channel) => channel.binaryType === 'arraybuffer'));
  assert.equal(ICE_GATHER_CAP_SECONDS, 3);
});

test('the offer waits for gathering to complete, or for the 3 s cap', async () => {
  const first = build();
  let offer = null;
  const pending = first.connection.createOffer().then((sdp) => { offer = sdp; });
  await settle();
  assert.equal(offer, null);
  first.peer.completeGathering();
  await pending;
  assert.equal(offer, 'local-sdp');
  assert.equal(first.timers.pending().length, 0);

  const second = build();
  let capped = null;
  const waiting = second.connection.createOffer().then((sdp) => { capped = sdp; });
  await settle();
  assert.equal(capped, null);
  assert.deepEqual(second.timers.pending().map((timer) => timer.seconds), [3]);
  second.timers.fireAll();
  await waiting;
  assert.equal(capped, 'local-sdp');
});

test('acceptOffer answers once gathering completes', async () => {
  const { connection, peer } = build();
  peer.iceGatheringState = 'complete';
  assert.equal(await connection.acceptOffer('their-offer'), 'local-sdp');
  assert.deepEqual(peer.descriptions, [['remote', 'offer', 'their-offer'], ['local', 'answer']]);
});

test('a second answer is refused', async () => {
  const { connection, peer } = build();
  await connection.acceptAnswer('sdp');
  assert.deepEqual(peer.descriptions, [['remote', 'answer', 'sdp']]);
  await assert.rejects(() => connection.acceptAnswer('sdp'), /already answered/);
});

test('the connection states map onto the transport states', () => {
  const { connection, peer } = build();
  const seen = [];
  connection.transport.onStateChange((value) => seen.push(value));
  assert.equal(connection.transport.state, 'connecting');
  peer.setConnection('connected');
  assert.equal(connection.transport.state, 'connecting');
  peer.channels[0].open();
  assert.equal(connection.transport.state, 'connecting');
  peer.channels[1].open();
  assert.equal(connection.transport.state, 'open');
  peer.setConnection('disconnected');
  assert.equal(connection.transport.state, 'disconnected');
  peer.setConnection('failed');
  assert.equal(connection.transport.state, 'closed');
  peer.setConnection('connected');
  assert.equal(connection.transport.state, 'closed');
  assert.deepEqual(seen, ['open', 'disconnected', 'closed']);
});

test('either data channel closing maps to closed', () => {
  for (const index of [0, 1]) {
    const { connection, peer } = build();
    openAll(peer);
    peer.channels[index].readyState = 'closed';
    peer.channels[index].emit('close');
    assert.equal(connection.transport.state, 'closed');
  }
});

test('events sent before open are delivered on open and state messages are dropped', () => {
  const { connection, peer } = build();
  connection.transport.send('events', Uint8Array.of(1));
  connection.transport.send('state', Uint8Array.of(2));
  openAll(peer);
  assert.deepEqual(peer.channels[1].sent.map((bytes) => [...bytes]), [[1]]);
  assert.deepEqual(peer.channels[0].sent, []);
  connection.transport.send('state', Uint8Array.of(3));
  assert.deepEqual(peer.channels[0].sent.map((bytes) => [...bytes]), [[3]]);
  assert.throws(() => connection.transport.send('bogus', Uint8Array.of(1)), /Unknown transport channel/);
});

test('messages arrive as copied byte arrays on every subscribed handler', () => {
  const { connection, peer } = build();
  const first = [];
  const second = [];
  connection.transport.onMessage((channel, bytes) => first.push([channel, bytes]));
  connection.transport.onMessage((channel) => second.push(channel));
  peer.channels[1].emit('message', { data: Uint8Array.of(7, 8).buffer });
  peer.channels[0].emit('message', { data: Uint8Array.of(9).buffer });
  assert.deepEqual(second, ['events', 'state']);
  assert.ok(first[0][1] instanceof Uint8Array);
  assert.deepEqual([...first[0][1]], [7, 8]);
});

test('close with nothing buffered closes at once', () => {
  const { connection, peer } = build();
  openAll(peer);
  connection.close();
  assert.equal(connection.transport.state, 'closed');
  assert.ok(peer.peerClosed);
  assert.ok(peer.channels.every((channel) => channel.closed));
});

test('close waits for the events channel to drain, or for the 1 s cap', () => {
  const drained = build();
  openAll(drained.peer);
  drained.peer.channels[1].bufferedAmount = 12;
  drained.connection.close();
  assert.equal(drained.peer.peerClosed, false);
  assert.deepEqual(drained.timers.pending().map((timer) => timer.seconds), [1]);
  drained.peer.channels[1].emit('bufferedamountlow');
  assert.ok(drained.peer.peerClosed);
  assert.equal(drained.timers.pending().length, 0);

  const stuck = build();
  openAll(stuck.peer);
  stuck.peer.channels[1].bufferedAmount = 12;
  stuck.connection.close();
  stuck.timers.fireAll();
  assert.ok(stuck.peer.peerClosed);
  assert.equal(stuck.connection.transport.state, 'closed');
});

test('a channel closing from the remote side releases the peer and both channels once, and stops delivery', () => {
  const { connection, peer } = build();
  openAll(peer);
  const received = [];
  connection.transport.onMessage((channel) => received.push(channel));
  let peerCloses = 0;
  peer.close = () => { peerCloses += 1; };
  peer.channels[0].readyState = 'closed';
  peer.channels[0].emit('close');
  assert.equal(connection.transport.state, 'closed');
  assert.equal(peerCloses, 1);
  assert.ok(peer.channels.every((channel) => channel.closed));
  peer.channels[1].emit('message', { data: Uint8Array.of(1).buffer });
  assert.deepEqual(received, []);
  connection.close();
  assert.equal(peerCloses, 1);
});

test('a failed connection releases the peer and channels', () => {
  const { peer } = build();
  openAll(peer);
  peer.setConnection('failed');
  assert.ok(peer.peerClosed);
  assert.ok(peer.channels.every((channel) => channel.closed));
});

test('an answerer that has not opened yet keeps connecting through failed, and closes on failed once it has opened', async () => {
  const { connection, peer } = build();
  peer.iceGatheringState = 'complete';
  await connection.acceptOffer('their-offer');
  const seen = [];
  connection.transport.onStateChange((value) => seen.push(value));
  peer.setConnection('connecting');
  peer.setConnection('disconnected');
  peer.setConnection('failed');
  assert.equal(connection.transport.state, 'connecting', 'the offerer may still paste the reply');
  assert.equal(peer.peerClosed, false);
  openAll(peer);
  assert.equal(connection.transport.state, 'open');
  peer.setConnection('failed');
  assert.equal(connection.transport.state, 'closed');
  assert.deepEqual(seen, ['open', 'closed']);

  const offerer = build();
  await offerer.connection.acceptAnswer('sdp');
  offerer.peer.setConnection('failed');
  assert.equal(offerer.connection.transport.state, 'closed', 'the offerer\'s failure before open is final');
});

test('a bad answer paste does not block a retry, but an accepted answer does', async () => {
  const { connection, peer } = build();
  const original = peer.setRemoteDescription.bind(peer);
  peer.setRemoteDescription = async () => { throw new Error('bad sdp'); };
  await assert.rejects(() => connection.acceptAnswer('junk'), /bad sdp/);
  peer.setRemoteDescription = original;
  await connection.acceptAnswer('good');
  await assert.rejects(() => connection.acceptAnswer('good'), /already answered/);
});

test('send on a channel that is not open is dropped without throwing', () => {
  const { connection, peer } = build();
  openAll(peer);
  peer.channels[0].readyState = 'closing';
  peer.channels[1].send = () => { throw new Error('should not be called'); };
  peer.channels[1].readyState = 'closing';
  connection.transport.send('state', Uint8Array.of(1));
  connection.transport.send('events', Uint8Array.of(2));
  assert.deepEqual(peer.channels[0].sent, []);
});

test('close cancels a pending gather timer', async () => {
  const { connection, peer, timers } = build();
  let offer = null;
  const pending = connection.createOffer().then((sdp) => { offer = sdp; });
  await settle();
  assert.equal(timers.pending().length, 1);
  connection.close();
  assert.equal(timers.pending().length, 0);
  await pending;
  assert.equal(offer, 'local-sdp');
  assert.ok(peer.peerClosed);
});
