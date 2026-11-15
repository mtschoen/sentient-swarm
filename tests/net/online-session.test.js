import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';
import { SWARM_WIPE_MASK, stats } from '../game/game-harness.js';
import { RESTART_GUARD_SECONDS } from '../../src/game/game.js';
import { decodeEvent } from '../../src/net/event-codec.js';

// A stats frame from the step the next update runs.
function scriptFrame(side, fields) {
  side.simulation.scriptedStats.push(stats({ frameSequence: side.simulation.frameSequence + 1, ...fields }));
}

// Every event an endpoint sends, decoded.
function sentEvents(endpoint) {
  const sent = [];
  const send = endpoint.send;
  endpoint.send = (channel, bytes) => {
    if (channel === 'events') sent.push(decodeEvent(bytes));
    send(channel, bytes);
  };
  return sent;
}

function bothPhases(host, guest) {
  return [host.game.run.phase, guest.game.run.phase];
}

// A guest wipe, then the steps until both machines show game over.
function endWithGuestWipe({ host, guest, stepBoth, stepUntil }) {
  scriptFrame(guest, { secondSwarmHitMask: SWARM_WIPE_MASK });
  stepBoth(STEP);
  stepUntil(() => host.game.run.phase === 'gameOver' && guest.game.run.phase === 'gameOver', 'both over');
}

test('the host start begins both matches at the same moment', async () => {
  const { host, guest, stepBoth, stepUntil } = await createOnlinePair({ delaySeconds: 0.05 });
  host.session.markReady();
  guest.session.markReady();
  stepUntil(() => host.session.waitingFor === null, 'both ready');
  const startSeconds = host.clock.sessionSeconds;
  assert.equal(host.session.start('hives'), true);
  while (host.clock.sessionSeconds + STEP < startSeconds + 0.5) {
    stepBoth(STEP);
    assert.deepEqual(bothPhases(host, guest), ['ready', 'ready'], `at ${host.clock.sessionSeconds}`);
  }
  stepBoth(2 * STEP);
  assert.deepEqual(bothPhases(host, guest), ['playing', 'playing']);
  for (const side of [host, guest]) {
    assert.equal(side.game.mode, 'hives');
    assert.equal(side.game.online, side.online);
    assert.equal(side.game.fullRateLocked, true);
  }
  assert.equal(host.game.localSeatIndex, 0);
  assert.equal(guest.game.localSeatIndex, 1);
  assert.deepEqual(host.actions.filter((action) => action.type === 'start'), [{ type: 'start', mode: 'hives' }]);
  assert.deepEqual(guest.actions.filter((action) => action.type === 'start'), [{ type: 'start', mode: 'hives' }]);
});

test('the round trip is known at the title, before any match', async () => {
  const { host, guest, stepBoth } = await createOnlinePair({ delaySeconds: 0.05 });
  assert.equal(host.session.roundTripMilliseconds, null);
  stepBoth(0.3);
  for (const side of [host, guest]) {
    assert.ok(side.session.roundTripMilliseconds >= 100 && side.session.roundTripMilliseconds <= 134, `${side.session.roundTripMilliseconds}`);
    assert.equal(Number.isInteger(side.session.roundTripMilliseconds), true);
  }
});

test('the host title mode reaches the guest', async () => {
  const { host, guest, stepBoth } = await createOnlinePair();
  host.session.setTitleMode('versus');
  stepBoth(STEP);
  assert.equal(guest.session.remoteTitleMode, 'versus');
  assert.deepEqual(guest.actions.filter((action) => action.type === 'titleMode'), [{ type: 'titleMode', mode: 'versus' }]);
});

test('a pause on the guest pauses the host with the guest named', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth } = pair;
  await pair.startMatch('versus');
  stepBoth(0.5);
  guest.session.pause();
  assert.equal(guest.game.paused, true);
  stepBoth(0.1);
  assert.equal(host.game.paused, true);
  assert.equal(host.session.pausedBy, 1);
  assert.equal(guest.session.pausedBy, 1);
  assert.deepEqual(host.actions.filter((action) => action.type === 'pause'), [{ type: 'pause', by: 1 }]);
});

test('the countdown runs on both and a pause from a hidden guest tab cancels it', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, step, stepBoth } = pair;
  await pair.startMatch('versus');
  stepBoth(0.5);
  host.session.pause();
  stepBoth(0.1);
  assert.deepEqual([host.game.paused, guest.game.paused], [true, true]);
  host.session.resume();
  assert.equal(host.session.countdownNumber, 3);
  // The guest's tab is hidden from here on: it draws no frames, so its game never updates.
  step(0.1, { guestUpdates: false });
  assert.equal(guest.session.countdownNumber, 3);
  step(1.9, { guestUpdates: false });
  // Its visibilitychange handler pauses.
  guest.session.pause();
  step(3, { guestUpdates: false });
  assert.deepEqual([host.game.paused, guest.game.paused], [true, true]);
  assert.equal(host.session.phase, 'paused');
  assert.equal(host.session.pausedBy, 1);
  assert.equal(host.actions.filter((action) => action.type === 'resume').length, 0);
  assert.equal(guest.actions.filter((action) => action.type === 'resume').length, 0);
});

test('a countdown with no pause resumes both games', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth } = pair;
  await pair.startMatch('versus');
  stepBoth(0.5);
  guest.session.pause();
  stepBoth(0.1);
  guest.session.resume();
  stepBoth(0.2);
  assert.equal(host.session.countdownNumber, 3);
  assert.equal(guest.session.countdownNumber, 3);
  stepBoth(1.2);
  assert.equal(host.session.countdownNumber, 2);
  assert.ok(guest.actions.some((action) => action.type === 'countdown' && action.number === 2));
  stepBoth(2);
  assert.deepEqual([host.game.paused, guest.game.paused], [false, false]);
  assert.deepEqual(bothPhases(host, guest), ['playing', 'playing']);
});

test('either player restarts from game over and both restart', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth, stepUntil } = pair;
  await pair.startMatch('hives');
  stepBoth(1);
  endWithGuestWipe(pair);
  guest.session.restart();
  stepUntil(() => host.game.run.phase === 'playing' && guest.game.run.phase === 'playing', 'both restarted');
  for (const side of [host, guest]) {
    assert.equal(side.game.state.score, 0);
    assert.equal(side.game.state.matchResult, null);
    assert.ok(side.game.state.hives.hives.every((hive) => hive.owner === null && hive.progress === 0), JSON.stringify(side.game.state.hives));
  }
  assert.equal(host.actions.filter((action) => action.type === 'restart').length, 1);
  assert.equal(guest.actions.filter((action) => action.type === 'restart').length, 1);
});

test('after a restart a guest wipe still ends the match on both', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth, stepUntil } = pair;
  await pair.startMatch('versus');
  stepBoth(1);
  endWithGuestWipe(pair);
  host.session.restart();
  stepUntil(() => host.game.run.phase === 'playing' && guest.game.run.phase === 'playing', 'both restarted');
  stepBoth(1.5);
  assert.deepEqual(bothPhases(host, guest), ['playing', 'playing']);
  endWithGuestWipe(pair);
  for (const side of [host, guest]) assert.deepEqual(side.game.state.matchResult, { winner: 0, draw: false, hives: false });
});

test('a restart while paused restarts both unpaused', async () => {
  const pair = await createOnlinePair();
  const { host, guest, stepBoth, stepUntil } = pair;
  await pair.startMatch('versus');
  stepBoth(0.5);
  guest.session.pause();
  stepBoth(STEP);
  guest.session.restart();
  stepUntil(() => host.session.phase === 'playing' && guest.session.phase === 'playing', 'both restarted');
  assert.deepEqual([host.game.paused, guest.game.paused], [false, false]);
  assert.deepEqual(bothPhases(host, guest), ['playing', 'playing']);
});

test('a quit by either returns both to a co-op title with one seat', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth } = pair;
  await pair.startMatch('hives');
  stepBoth(0.5);
  guest.session.quit();
  stepBoth(0.2);
  for (const side of [host, guest]) {
    assert.equal(side.game.run.phase, 'ready');
    assert.equal(side.game.mode, 'coop');
    assert.equal(side.game.playerCount, 1);
    assert.equal(side.game.online, null);
    assert.equal(side.game.fullRateLocked, false);
    assert.equal(side.session.phase, 'ended');
  }
  assert.equal(pair.pair.host.state, 'closed');
  assert.equal(pair.pair.guest.state, 'closed');
  assert.deepEqual(guest.actions.filter((action) => action.type === 'end'), [{ type: 'end', reason: 'quit' }]);
  assert.deepEqual(host.actions.filter((action) => action.type === 'end'), [{ type: 'end', reason: 'remoteQuit' }]);
  assert.equal(pair.timers.count, 0, 'no timer outlives the session');
});

test('a dropped connection pauses both, and 10 s later both are at the title', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth } = pair;
  await pair.startMatch('versus');
  stepBoth(0.5);
  pair.pair.disconnect();
  for (const side of [host, guest]) {
    assert.equal(side.game.paused, true);
    assert.deepEqual(side.actions.filter((action) => action.type === 'pause'), [{ type: 'pause', by: null, lost: true }]);
  }
  stepBoth(9.9);
  assert.deepEqual([host.game.paused, guest.game.paused], [true, true]);
  stepBoth(0.2);
  for (const side of [host, guest]) {
    assert.equal(side.game.run.phase, 'ready');
    assert.equal(side.game.online, null);
    assert.deepEqual(side.actions.filter((action) => action.type === 'end'), [{ type: 'end', reason: 'lost' }]);
  }
});

test('a protocol version mismatch ends the session on both', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05, guestProtocolVersion: 2 });
  const { host, guest, stepBoth } = pair;
  stepBoth(0.2);
  for (const side of [host, guest]) {
    assert.deepEqual(side.actions.filter((action) => action.type === 'end'), [{ type: 'end', reason: 'version' }]);
    assert.equal(side.game.run.phase, 'ready');
    assert.equal(side.session.phase, 'ended');
  }
});

test('a guest game-over press asks for a restart instead of restarting alone', async () => {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth } = pair;
  await pair.startMatch('versus');
  stepBoth(1);
  endWithGuestWipe(pair);
  stepBoth(RESTART_GUARD_SECONDS + 0.1);
  const guestSent = sentEvents(guest.online.transport);
  let localRestarts = 0;
  const restart = guest.game.restart.bind(guest.game);
  guest.game.restart = () => { localRestarts += 1; restart(); };
  guest.input.state.firing = true;
  guest.game.update(STEP);
  assert.equal(localRestarts, 0);
  assert.equal(guest.game.run.phase, 'gameOver');
  assert.equal(guestSent.filter((event) => event.type === 'restartRequest').length, 1);
  guest.input.state.firing = false;
  host.game.update(STEP);
  stepBoth(1);
  assert.equal(localRestarts, 1, 'the host\'s restart restarts the guest once');
  assert.deepEqual(bothPhases(host, guest), ['playing', 'playing']);
});
