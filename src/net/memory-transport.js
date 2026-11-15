// An in-memory transport pair for tests and the two-game harness: virtual time, delay, loss and reorder on the state channel.

import { TransportState, TransportChannel, validateChannel } from './transport.js';

export function createMemoryTransportPair({ delaySeconds = 0, lossFraction = 0, reorderSeconds = 0, random = Math.random } = {}) {
  let time = 0;
  let sequence = 0;
  let connection = TransportState.Open;
  const queue = [];

  function createEndpoint() {
    return { state: TransportState.Open, messageHandlers: [], stateHandlers: [] };
  }

  const endpoints = { host: createEndpoint(), guest: createEndpoint() };

  function setConnection(state) {
    connection = state;
    for (const endpoint of [endpoints.host, endpoints.guest]) {
      endpoint.state = state;
      for (const handler of [...endpoint.stateHandlers]) handler(state);
    }
  }

  function send(from, channel, bytes) {
    validateChannel(channel);
    if (connection === TransportState.Closed) return;
    const copy = Uint8Array.from(bytes);
    let deliverAt = time + delaySeconds;
    if (channel === TransportChannel.State) {
      if (connection !== TransportState.Open) return;
      if (lossFraction > 0 && random() < lossFraction) return;
      if (reorderSeconds > 0) deliverAt += random() * reorderSeconds;
    }
    queue.push({ to: from === endpoints.host ? endpoints.guest : endpoints.host, channel, bytes: copy, deliverAt, sequence });
    sequence += 1;
  }

  function buildApi(endpoint) {
    return {
      send: (channel, bytes) => send(endpoint, channel, bytes),
      onMessage: (handler) => { endpoint.messageHandlers.push(handler); },
      onStateChange: (handler) => { endpoint.stateHandlers.push(handler); },
      get state() { return endpoint.state; },
      close: () => close(),
    };
  }

  function advance(seconds) {
    time += seconds;
    if (connection !== TransportState.Open) return;
    const due = queue.filter((message) => message.deliverAt <= time);
    due.sort((first, second) => first.deliverAt - second.deliverAt || first.sequence - second.sequence);
    for (const message of due) {
      // A handler may disconnect or close the pair (which drops queued messages): stop there.
      if (connection !== TransportState.Open) return;
      const index = queue.indexOf(message);
      if (index < 0) continue;
      queue.splice(index, 1);
      for (const handler of [...message.to.messageHandlers]) handler(message.channel, message.bytes);
    }
  }

  function disconnect() {
    if (connection !== TransportState.Open) return;
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index].channel === TransportChannel.State) queue.splice(index, 1);
    }
    setConnection(TransportState.Disconnected);
  }

  function reconnect() {
    if (connection !== TransportState.Disconnected) return;
    setConnection(TransportState.Open);
  }

  function close() {
    if (connection === TransportState.Closed) return;
    queue.length = 0;
    setConnection(TransportState.Closed);
  }

  return {
    host: buildApi(endpoints.host),
    guest: buildApi(endpoints.guest),
    advance,
    disconnect,
    reconnect,
    close,
    // The state channel's loss from the next send on (messages already in flight still arrive).
    setLossFraction: (fraction) => { lossFraction = fraction; },
  };
}
