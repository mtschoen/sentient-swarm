// The WebRTC transport: one RTCPeerConnection with two pre-negotiated data channels, behind the endpoint interface of transport.js.
// Signalling is copy and paste, so ICE is not trickled: each description is used once gathering completes (or after the cap).
// The answerer (acceptOffer) starts its ICE checks before the offerer has its answer, and Chrome reports such a connection
// failed after about 15 s of unanswered checks, then connects once the offerer's own checks arrive: so until an answerer's
// connection first opens, failed and disconnected leave it connecting (only the offerer's paste can end the wait).

import { TransportState, TransportChannel, validateChannel } from './transport.js';
import { ICE_SERVERS, ICE_GATHER_CAP_SECONDS } from './ice-configuration.js';

export const STATE_CHANNEL_OPTIONS = Object.freeze({ ordered: false, maxRetransmits: 0, negotiated: true, id: 0 });
export const EVENTS_CHANNEL_OPTIONS = Object.freeze({ ordered: true, negotiated: true, id: 1 });
export const CLOSE_FLUSH_CAP_SECONDS = 1;

export function createRtcConnection({
  PeerConnection,
  iceServers = ICE_SERVERS,
  gatherCapSeconds = ICE_GATHER_CAP_SECONDS,
  setTimer,
  clearTimer,
}) {
  const peer = new PeerConnection({ iceServers: [...iceServers] });
  const channels = {
    [TransportChannel.State]: peer.createDataChannel('state', { ...STATE_CHANNEL_OPTIONS }),
    [TransportChannel.Events]: peer.createDataChannel('events', { ...EVENTS_CHANNEL_OPTIONS }),
  };
  const messageHandlers = [];
  const stateHandlers = [];
  const pendingEvents = [];
  let state = TransportState.Connecting;
  let answered = false;
  let answering = false;
  let everOpened = false;
  let closing = false;

  let released = false;
  const cancellers = new Set();

  // Releases the peer and both channels exactly once, however the connection ended, and settles any pending waits.
  function release() {
    if (released) return;
    released = true;
    for (const cancel of [...cancellers]) cancel();
    for (const channel of Object.values(channels)) channel.close();
    peer.close();
  }

  function setState(next) {
    if (state === next || state === TransportState.Closed) return;
    state = next;
    if (next === TransportState.Closed) release();
    for (const handler of [...stateHandlers]) handler(next);
  }

  function channelsOpen() {
    return Object.values(channels).every((channel) => channel.readyState === 'open');
  }

  function flushEvents() {
    while (pendingEvents.length > 0) channels[TransportChannel.Events].send(pendingEvents.shift());
  }

  function recompute() {
    if (state === TransportState.Closed) return;
    const connection = peer.connectionState;
    if (answering && !everOpened && (connection === 'failed' || connection === 'disconnected')) return;
    if (connection === 'failed' || connection === 'closed') setState(TransportState.Closed);
    else if (connection === 'disconnected') setState(TransportState.Disconnected);
    else if (connection === 'connected' && channelsOpen()) {
      everOpened = true;
      setState(TransportState.Open);
      flushEvents();
    }
  }

  peer.addEventListener('connectionstatechange', recompute);
  for (const [name, channel] of Object.entries(channels)) {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', recompute);
    // A closed channel cannot recover, and a departed page closes its channels promptly, so this ends the connection at once.
    channel.addEventListener('close', () => setState(TransportState.Closed));
    channel.addEventListener('message', (event) => {
      if (state === TransportState.Closed) return;
      const bytes = new Uint8Array(event.data.slice(0));
      for (const handler of [...messageHandlers]) handler(name, bytes);
    });
  }

  function waitForGathering() {
    return new Promise((resolve) => {
      if (peer.iceGatheringState === 'complete') {
        resolve(peer.localDescription.sdp);
        return;
      }
      let timer = null;
      const finish = () => {
        cancellers.delete(finish);
        peer.removeEventListener('icegatheringstatechange', onChange);
        if (timer !== null) clearTimer(timer);
        resolve(peer.localDescription?.sdp);
      };
      cancellers.add(finish);
      const onChange = () => { if (peer.iceGatheringState === 'complete') finish(); };
      peer.addEventListener('icegatheringstatechange', onChange);
      timer = setTimer(finish, gatherCapSeconds);
    });
  }

  async function createOffer() {
    await peer.setLocalDescription(await peer.createOffer());
    return waitForGathering();
  }

  async function acceptOffer(offerSdp) {
    answering = true;
    await peer.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await peer.setLocalDescription(await peer.createAnswer());
    return waitForGathering();
  }

  async function acceptAnswer(answerSdp) {
    if (answered) throw new Error('the invite was already answered');
    answered = true;
    try {
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      answered = false; // a bad paste leaves the invite open for another try
      throw error;
    }
  }

  function shutDown() {
    setState(TransportState.Closed);
    release();
  }

  // Waits for the events channel to drain (so a quit message is delivered) or the cap, then closes.
  function close() {
    if (closing || state === TransportState.Closed) return;
    closing = true;
    const events = channels[TransportChannel.Events];
    if (events.readyState !== 'open' || events.bufferedAmount === 0) {
      shutDown();
      return;
    }
    let timer = null;
    const finish = () => {
      cancellers.delete(finish);
      events.removeEventListener('bufferedamountlow', finish);
      if (timer !== null) clearTimer(timer);
      shutDown();
    };
    events.bufferedAmountLowThreshold = 0;
    cancellers.add(finish);
    events.addEventListener('bufferedamountlow', finish);
    timer = setTimer(finish, CLOSE_FLUSH_CAP_SECONDS);
  }

  const transport = {
    send(channel, bytes) {
      validateChannel(channel);
      if (closing || state === TransportState.Closed) return;
      const copy = Uint8Array.from(bytes);
      if (state !== TransportState.Open) {
        if (channel === TransportChannel.Events) pendingEvents.push(copy);
        return;
      }
      if (channels[channel].readyState === 'open') channels[channel].send(copy);
    },
    onMessage: (handler) => { messageHandlers.push(handler); },
    onStateChange: (handler) => { stateHandlers.push(handler); },
    get state() { return state; },
    close,
  };

  return { transport, createOffer, acceptOffer, acceptAnswer, close };
}
