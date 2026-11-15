import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionClock, CLOCK_SAMPLE_COUNT } from '../../src/net/session-clock.js';

const EPSILON = 1e-9;

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < EPSILON, `expected ${actual} to be within ${EPSILON} of ${expected}`);
}

function pair() {
  const state = { seconds: 100 };
  const host = new SessionClock({ now: () => state.seconds });
  const guest = new SessionClock({ now: () => state.seconds + 5 });
  host.connect();
  guest.connect();
  return { state, host, guest };
}

test('a symmetric ping measures the round trip and the session offset', () => {
  const { state, host, guest } = pair();
  state.seconds += 1;
  const ping = host.ping();
  state.seconds += 0.04;
  const pong = guest.pong(ping);
  state.seconds += 0.04;
  host.receivePong(pong);
  near(host.roundTripSeconds, 0.08);
  near(host.toLocalSession(pong.sessionSeconds), host.sessionSeconds - 0.04);
});

test('the round trip is null and the offsets are 0 before the first pong', () => {
  const { host } = pair();
  assert.equal(host.roundTripSeconds, null);
  assert.equal(host.sessionOffsetSeconds, 0);
  assert.equal(host.matchOffsetSeconds, 0);
});

test('the smallest round trip of the last 8 samples wins', () => {
  const { state, host, guest } = pair();
  // A slow sample: 0.3 s out, 0.3 s back is symmetric; make it lopsided so its offset differs.
  state.seconds += 1;
  const slowPing = host.ping();
  state.seconds += 0.25;
  const slowPong = guest.pong(slowPing);
  state.seconds += 0.05;
  host.receivePong(slowPong);
  near(host.roundTripSeconds, 0.3);
  const slowOffset = host.sessionOffsetSeconds;
  state.seconds += 1;
  const fastPing = host.ping();
  state.seconds += 0.025;
  const fastPong = guest.pong(fastPing);
  state.seconds += 0.025;
  host.receivePong(fastPong);
  near(host.roundTripSeconds, 0.05);
  near(host.sessionOffsetSeconds, 0);
  assert.ok(Math.abs(slowOffset) > 0.05);
  // Later slower samples do not displace it.
  state.seconds += 1;
  const laterPing = host.ping();
  state.seconds += 0.2;
  host.receivePong(guest.pong(laterPing));
  near(host.roundTripSeconds, 0.05);
});

test('a best sample ages out after 8 later samples', () => {
  const { state, host, guest } = pair();
  state.seconds += 1;
  const fastPing = host.ping();
  state.seconds += 0.01;
  const fastPong = guest.pong(fastPing);
  state.seconds += 0.01;
  host.receivePong(fastPong);
  near(host.roundTripSeconds, 0.02);
  for (let index = 0; index < CLOCK_SAMPLE_COUNT; index += 1) {
    state.seconds += 1;
    const ping = host.ping();
    state.seconds += 0.1;
    const pong = guest.pong(ping);
    state.seconds += 0.1;
    host.receivePong(pong);
  }
  near(host.roundTripSeconds, 0.2);
});

test('the match offset compares match times at the moment of receipt', () => {
  const { state, host, guest } = pair();
  host.setMatchRunning(true);
  host.advanceMatch(10);
  guest.advanceMatch(10.02);
  const ping = host.ping();
  assert.equal(ping.type, 'ping');
  near(ping.matchSeconds, 10);
  state.seconds += 0.04;
  const pong = guest.pong(ping);
  assert.equal(pong.type, 'pong');
  near(pong.matchSeconds, 10.02);
  state.seconds += 0.04;
  host.advanceMatch(0.08);
  host.receivePong(pong);
  near(host.matchOffsetSeconds, -0.02);
  near(host.remoteMatchNow(), host.matchSeconds - 0.02);
});

test('a pong received while the local match is stopped keeps the old match offset', () => {
  const { state, host, guest } = pair();
  host.setMatchRunning(true);
  host.advanceMatch(10);
  guest.advanceMatch(10.02);
  const ping = host.ping();
  state.seconds += 0.04;
  const pong = guest.pong(ping);
  state.seconds += 0.04;
  host.advanceMatch(0.08);
  host.receivePong(pong);
  near(host.matchOffsetSeconds, -0.02);
  host.setMatchRunning(false);
  guest.advanceMatch(0.5);
  state.seconds += 1;
  const laterPing = host.ping();
  state.seconds += 0.04;
  const laterPong = guest.pong(laterPing);
  state.seconds += 0.04;
  host.receivePong(laterPong);
  near(host.matchOffsetSeconds, -0.02);
  near(host.sessionOffsetSeconds, 0);
});

test('resetMatch returns the match time to 0', () => {
  const { host } = pair();
  host.advanceMatch(3);
  host.resetMatch();
  assert.equal(host.matchSeconds, 0);
});

test('resetMatch clears the match samples so a stale offset does not outlive a match', () => {
  const { state, host, guest } = pair();
  host.setMatchRunning(true);
  guest.advanceMatch(2);
  state.seconds += 1;
  const ping = host.ping();
  state.seconds += 0.04;
  const pong = guest.pong(ping);
  state.seconds += 0.04;
  host.receivePong(pong);
  assert.notEqual(host.matchOffsetSeconds, 0);
  host.resetMatch();
  assert.equal(host.matchOffsetSeconds, 0);
});
