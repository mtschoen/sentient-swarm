import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLifecycle, LifecyclePhase } from '../../src/net/lifecycle.js';
import { PROTOCOL_VERSION } from '../../src/net/protocol.js';

const identity = (seconds) => seconds;
const nothing = { send: [], actions: [] };

function readyHost() {
  const host = new SessionLifecycle({ role: 'host' });
  host.setLocalReady();
  host.setRemoteReady();
  return host;
}

function playingHost() {
  const host = readyHost();
  host.requestStart('hives', 0);
  host.tick(0.5);
  return host;
}

function pausedHost() {
  const host = playingHost();
  host.pause(0);
  return host;
}

function playingGuest() {
  const guest = new SessionLifecycle({ role: 'guest' });
  guest.receive({ type: 'start', mode: 'hives', startSessionSeconds: 0.5 }, 0, identity);
  guest.tick(0.5);
  return guest;
}

test('the host start waits for both ready flags and lands half a second ahead', () => {
  const host = new SessionLifecycle({ role: 'host' });
  host.setLocalReady();
  assert.equal(host.waitingFor, 'remote');
  assert.deepEqual(host.requestStart('hives', 20).send, []);
  host.setRemoteReady();
  assert.equal(host.waitingFor, null);
  const { send } = host.requestStart('hives', 20);
  assert.deepEqual(send, [{ type: 'start', mode: 'hives', startSessionSeconds: 20.5 }]);
  assert.deepEqual(host.tick(20.49).actions, []);
  assert.deepEqual(host.tick(20.5).actions, [{ type: 'start', mode: 'hives' }]);
  assert.equal(host.phase, LifecyclePhase.Playing);
  assert.throws(() => new SessionLifecycle({ role: 'guest' }).requestStart('hives', 0));
});

test('the guest enters Starting from the start event and acts at the converted moment', () => {
  const guest = new SessionLifecycle({ role: 'guest' });
  guest.receive({ type: 'start', mode: 'versus', startSessionSeconds: 70.5 }, 70, (seconds) => seconds - 50);
  assert.equal(guest.phase, LifecyclePhase.Starting);
  assert.deepEqual(guest.tick(20.4).actions, []);
  assert.deepEqual(guest.tick(20.5).actions, [{ type: 'start', mode: 'versus' }]);
});

test('the countdown reads 3, 2, 1 and resumes at zero', () => {
  const host = pausedHost();
  assert.deepEqual(host.requestResume(30).send, [{ type: 'resumeCountdown', endSessionSeconds: 33 }]);
  host.tick(30);
  assert.equal(host.countdownNumber, 3);
  host.tick(31.2);
  assert.equal(host.countdownNumber, 2);
  host.tick(32.5);
  assert.equal(host.countdownNumber, 1);
  assert.deepEqual(host.tick(33).actions, [{ type: 'resume' }]);
  assert.equal(host.countdownNumber, null);
  assert.equal(host.phase, LifecyclePhase.Playing);
});

test('a guest resume request makes the host count down and the guest follow', () => {
  const host = pausedHost();
  const guest = playingGuest();
  guest.pause(1);
  const request = guest.requestResume(40).send;
  assert.deepEqual(request, [{ type: 'resumeRequest' }]);
  const reply = host.receive(request[0], 40, identity);
  assert.deepEqual(reply.send, [{ type: 'resumeCountdown', endSessionSeconds: 43 }]);
  assert.equal(host.phase, LifecyclePhase.Countdown);
  guest.receive(reply.send[0], 40.05, identity);
  assert.equal(guest.phase, LifecyclePhase.Countdown);
  assert.equal(guest.countdownNumber, 3);
  assert.deepEqual(guest.tick(43).actions, [{ type: 'resume' }]);
});

test('a pause during the countdown means it never resumes', () => {
  const host = pausedHost();
  host.requestResume(30);
  assert.deepEqual(host.receivePause(1).actions, [{ type: 'pause', by: 1 }]);
  assert.deepEqual(host.tick(33.5).actions, []);
  assert.deepEqual(host.tick(40).actions, []);
  assert.equal(host.phase, LifecyclePhase.Paused);
  assert.equal(host.pausedBy, 1);
});

test('a pause while paused keeps the first seat', () => {
  const host = playingHost();
  assert.deepEqual(host.pause(0).send, [{ type: 'pause', seat: 0 }]);
  assert.deepEqual(host.receivePause(1), nothing);
  assert.equal(host.pausedBy, 0);
});

test('a pause during Starting is held and delivered right after the start', () => {
  const host = readyHost();
  host.requestStart('hives', 5);
  const paused = host.pause(0);
  assert.deepEqual(paused.send, [{ type: 'pause', seat: 0 }]);
  assert.deepEqual(paused.actions, []);
  assert.equal(host.phase, LifecyclePhase.Starting);
  assert.deepEqual(host.tick(5.5).actions, [{ type: 'start', mode: 'hives' }, { type: 'pause', by: 0 }]);
  assert.equal(host.phase, LifecyclePhase.Paused);
  assert.equal(host.pausedBy, 0);
});

test('pauses are ignored at the title and when the match is over, and restart is still accepted', () => {
  assert.deepEqual(new SessionLifecycle({ role: 'host' }).pause(0), nothing);
  const host = playingHost();
  host.setMatchOver(true);
  assert.deepEqual(host.pause(0), nothing);
  assert.deepEqual(host.receivePause(1), nothing);
  assert.equal(host.phase, LifecyclePhase.Playing);
  assert.equal(host.requestRestart(9).send.length, 1);
});

test('a lost connection ends the session after 10 s unless it comes back', () => {
  const host = playingHost();
  assert.deepEqual(host.connectionChanged('disconnected', 50).actions, [{ type: 'pause', by: null, lost: true }]);
  assert.equal(host.phase, LifecyclePhase.Lost);
  assert.deepEqual(host.tick(59.99).actions, []);
  assert.deepEqual(host.tick(60).actions, [{ type: 'end', reason: 'lost' }]);

  const other = playingHost();
  other.connectionChanged('disconnected', 50);
  assert.deepEqual(other.connectionChanged('open', 54).actions, []);
  assert.equal(other.phase, LifecyclePhase.Paused);
  assert.equal(other.pausedBy, null);
  assert.deepEqual(other.tick(61).actions, []);
});

test('a closed connection ends the session and a disconnect at the title waits', () => {
  assert.deepEqual(playingHost().connectionChanged('closed', 12).actions, [{ type: 'end', reason: 'lost' }]);
  const title = new SessionLifecycle({ role: 'host' });
  assert.deepEqual(title.connectionChanged('disconnected', 1).actions, []);
  assert.equal(title.phase, LifecyclePhase.Title);
});

test('a disconnect during Starting holds the pause until the start', () => {
  const host = readyHost();
  host.requestStart('hives', 5);
  assert.deepEqual(host.connectionChanged('disconnected', 5.1).actions, []);
  host.connectionChanged('open', 6);
  assert.deepEqual(host.tick(6).actions, [{ type: 'start', mode: 'hives' }, { type: 'pause', by: null, lost: true }]);
  assert.equal(host.phase, LifecyclePhase.Paused);
});

test('restart and quit work from either side', () => {
  const guest = playingGuest();
  const host = playingHost();
  const request = guest.requestRestart(40);
  assert.deepEqual(request.send, [{ type: 'restartRequest' }]);
  const reply = host.receive(request.send[0], 40, identity);
  assert.deepEqual(reply.send, [{ type: 'restart', startSessionSeconds: 40.5 }]);
  assert.deepEqual(host.tick(40.5).actions, [{ type: 'restart' }]);
  guest.receive(reply.send[0], 40.02, identity);
  assert.equal(guest.phase, LifecyclePhase.Starting);
  assert.deepEqual(guest.tick(40.5).actions, [{ type: 'restart' }]);

  assert.deepEqual(guest.quit(), { send: [{ type: 'quit' }], actions: [{ type: 'end', reason: 'quit' }] });
  assert.deepEqual(host.receive({ type: 'quit' }, 41, identity).actions, [{ type: 'end', reason: 'remoteQuit' }]);
  assert.deepEqual(host.tick(100).actions, []);
});

test('the host restarts on its own request from Paused', () => {
  const host = pausedHost();
  assert.deepEqual(host.requestRestart(8).send, [{ type: 'restart', startSessionSeconds: 8.5 }]);
  assert.deepEqual(host.tick(8.5).actions, [{ type: 'restart' }]);
  assert.equal(host.phase, LifecyclePhase.Playing);
});

test('a hello with another version ends the session and unrelated events do nothing', () => {
  const host = playingHost();
  assert.deepEqual(host.receive({ type: 'hello', version: PROTOCOL_VERSION }, 1, identity), nothing);
  assert.deepEqual(host.receive({ type: 'ping' }, 1, identity), nothing);
  assert.deepEqual(host.receive({ type: 'hello', version: PROTOCOL_VERSION + 1 }, 1, identity).actions, [
    { type: 'end', reason: 'version' },
  ]);
});

test('the ready flag is announced once and the remote one arrives through receive', () => {
  const host = new SessionLifecycle({ role: 'host' });
  assert.deepEqual(host.setLocalReady().send, [{ type: 'ready' }]);
  assert.deepEqual(host.setLocalReady().send, []);
  assert.equal(host.waitingFor, 'remote');
  host.receive({ type: 'ready' }, 0, identity);
  assert.equal(host.bothReady, true);
});
