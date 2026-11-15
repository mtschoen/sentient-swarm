import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';
import { SWARM_WIPE_MASK, stats } from '../game/game-harness.js';
import { gameOverBanner } from '../../src/ui/hud-seat.js';
import { seatAt } from './net-fixtures.js';
import { endMatch } from '../../src/game/match-end.js';

// A stats frame from the step the next update runs.
function scriptFrame(side, fields) {
  side.simulation.scriptedStats.push(stats({ frameSequence: side.simulation.frameSequence + 1, ...fields }));
}

function runUntilBothOver(stepBoth, host, guest) {
  for (let index = 0; index < 600; index += 1) {
    if (host.game.run.phase === 'gameOver' && guest.game.run.phase === 'gameOver') return;
    stepBoth(STEP);
  }
  assert.fail(`phases ${host.game.run.phase} and ${guest.game.run.phase}`);
}

// Records every event an endpoint sends.
function sentEvents(side) {
  const sent = [];
  const queueEvent = side.online.queueEvent.bind(side.online);
  side.online.queueEvent = (event) => {
    sent.push(event);
    queueEvent(event);
  };
  return sent;
}

test('a guest wipe ends the match on both with the same banner', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  const guestSent = sentEvents(guest);
  stepBoth(1.5);
  scriptFrame(guest, { secondSwarmHitMask: SWARM_WIPE_MASK });
  stepBoth(STEP);
  assert.equal(guest.game.seats[1].aliveCount, 0);
  assert.deepEqual(guestSent.filter((event) => event.type === 'wiped').map((event) => event.seat), [1]);
  assert.equal(guest.game.run.phase, 'playing', 'the guest waits for the host\'s result');
  stepBoth(0.2);
  assert.equal(host.game.run.phase, 'playing', 'the host waits out the draw window');
  runUntilBothOver(stepBoth, host, guest);
  for (const side of [host, guest]) {
    assert.deepEqual(side.game.state.matchResult, { winner: 0, draw: false, hives: false });
    assert.equal(gameOverBanner(side.game.state.matchResult).title, 'PLAYER 1 WINS');
  }
});

test('a host wipe ends the match on both for player 2', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  const hostSent = sentEvents(host);
  stepBoth(1.5);
  scriptFrame(host, { swarmHitMask: SWARM_WIPE_MASK });
  stepBoth(STEP);
  assert.equal(hostSent.filter((event) => event.type === 'wiped').length, 0, 'the host reports to its own referee');
  runUntilBothOver(stepBoth, host, guest);
  assert.deepEqual(hostSent.filter((event) => event.type === 'result'), [{ type: 'result', winner: 1, draw: false, hives: false }]);
  for (const side of [host, guest]) {
    assert.deepEqual(side.game.state.matchResult, { winner: 1, draw: false, hives: false });
    assert.equal(gameOverBanner(side.game.state.matchResult).title, 'PLAYER 2 WINS');
  }
});

test('both seats wiped in the same moment is a draw on both', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(1.5);
  scriptFrame(host, { swarmHitMask: SWARM_WIPE_MASK });
  scriptFrame(guest, { secondSwarmHitMask: SWARM_WIPE_MASK });
  stepBoth(STEP);
  runUntilBothOver(stepBoth, host, guest);
  for (const side of [host, guest]) {
    assert.deepEqual(side.game.state.matchResult, { winner: null, draw: true, hives: false });
    assert.equal(gameOverBanner(side.game.state.matchResult).title, 'DRAW');
  }
});

test('a remote snapshot showing no ships ends nothing by itself', async () => {
  const { host, startMatch } = await createOnlinePair();
  await startMatch('versus');
  host.online.driver.receive(seatAt({ sequence: 1, matchSeconds: 0, x: 26, seat: 1, shipCount: 0 }));
  host.game.update(STEP);
  assert.equal(host.game.seats[1].aliveCount, 0);
  for (let index = 0; index < 30; index += 1) host.game.update(STEP);
  assert.equal(host.game.run.phase, 'playing');
  assert.equal(host.game.state.matchResult, null);
});

test('a hives hold on the host ends the match on both', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('hives');
  const hostSent = sentEvents(host);
  stepBoth(0.5);
  // As updateHives ends a match held for the hold time (hive-seats.js).
  const result = host.game.versusMatch.awardHold(0);
  assert.ok(endMatch(host.game, result, host.simulation.frameSequence, host.game.seats[1].point));
  runUntilBothOver(stepBoth, host, guest);
  assert.deepEqual(hostSent.filter((event) => event.type === 'result'), [{ type: 'result', ...result }]);
  assert.deepEqual(guest.game.state.matchResult, { winner: 0, draw: false, hives: true });
});

test('the guest\'s wipe time is converted to host match time', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  // The guest's match clock runs 5 s ahead of the host's; the pings measure it.
  guest.clock.advanceMatch(5);
  stepBoth(2.5);
  assert.ok(Math.abs(host.clock.matchOffsetSeconds - 5) < 2 * STEP, `${host.clock.matchOffsetSeconds}`);
  scriptFrame(guest, { secondSwarmHitMask: SWARM_WIPE_MASK });
  stepBoth(0.5);
  assert.notEqual(host.game.run.phase, 'playing', 'decided 0.2 s plus the latency after the wipe, not 5 s later');
  assert.deepEqual(host.game.state.matchResult, { winner: 0, draw: false, hives: false });
});
