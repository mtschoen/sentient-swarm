// The transport interface, in prose.
//
// A transport endpoint is { send(channel, bytes), onMessage(handler), onStateChange(handler), state, close() }.
//   send(channel, bytes): queues a Uint8Array for the other side; the bytes are copied.
//   onMessage(handler): handler(channel, bytes) runs for every message that arrives.
//   onStateChange(handler): handler(state) runs when the state changes.
//   state: one of TransportState.
//   close(): ends the connection for good.
// Channels: 'state' is unordered with no retransmits (a message may be lost or arrive late);
// 'events' is reliable and ordered.

export const TransportState = Object.freeze({
  Connecting: 'connecting',
  Open: 'open',
  Disconnected: 'disconnected',
  Closed: 'closed',
});

export const TransportChannel = Object.freeze({
  State: 'state',
  Events: 'events',
});

export function validateChannel(name) {
  if (name !== TransportChannel.State && name !== TransportChannel.Events) {
    throw new Error(`Unknown transport channel: ${String(name)}`);
  }
  return name;
}
