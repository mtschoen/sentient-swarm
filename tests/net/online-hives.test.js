import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair, seededRandom } from './online-harness.js';
import { HOST_STATE_UPDATE_INTERVAL } from '../../src/net/protocol.js';
import { decodeSnapshot, encodeSnapshot } from '../../src/net/snapshot-codec.js';
import { seatAt } from './net-fixtures.js';

const CAPTURE_STRENGTH = 0.4;

// Every live ship of the seat (and its point) at x, y, before the next update.
function holdAt(seat, x, y) {
  seat.player.positionX = x;
  seat.player.positionY = y;
  for (const slot of seat.swarm.slots) {
    if (slot.alive) Object.assign(slot, { x, y, previousX: x, previousY: y });
  }
}

function stepHolding(stepBoth, seat, site, seconds) {
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) {
    holdAt(seat, site.x, site.y);
    stepBoth(STEP);
  }
}

const captureShockwaves = (side) => side.game.pendingImpulses.filter((impulse) => impulse.strength === CAPTURE_STRENGTH);
const hivesOn = (side) => side.game.versusMatch.hives;

// Records every event an adapter queues.
function queuedEvents(side) {
  const queued = [];
  const queueEvent = side.online.queueEvent.bind(side.online);
  side.online.queueEvent = (event) => {
    queued.push(event);
    queueEvent(event);
  };
  return queued;
}

test('the host captures the center hive and the guest shows the same owner', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  const hostQueued = queuedEvents(host);
  const center = hivesOn(host).hives[2];
  stepHolding(stepBoth, host.game.seats[0], center, 5.5);
  assert.equal(hivesOn(host).hives[2].owner, 0);
  assert.deepEqual(hostQueued.filter((event) => event.type === 'hiveCaptured'), [{ type: 'hiveCaptured', hive: 2, seat: 0 }]);
  stepHolding(stepBoth, host.game.seats[0], center, 0.2);
  assert.equal(guest.game.state.hives.hives[2].owner, 0);
  for (const side of [host, guest]) {
    const shockwaves = captureShockwaves(side);
    assert.equal(shockwaves.length, 1, side.online.role);
    assert.equal(shockwaves[0].x, center.x);
    assert.equal(shockwaves[0].y, center.y);
  }
});

test('the guest capturing its own hive is computed on the host from the guest ships', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  const own = hivesOn(guest).hives[1];
  stepHolding(stepBoth, guest.game.seats[1], own, 5.5);
  assert.equal(hivesOn(host).hives[1].owner, 1);
  stepHolding(stepBoth, guest.game.seats[1], own, 0.2);
  assert.equal(guest.game.state.hives.hives[1].owner, 1);
  assert.equal(captureShockwaves(guest).length, 1);
});

// The host-state sequences the host sends and the guest's transport delivers, in delivery order.
function traceHostStates(pair) {
  const sent = [];
  const delivered = [];
  const sequenceOf = (channel, bytes) => (channel === 'state' ? decodeSnapshot(bytes).hostState?.sequence ?? null : null);
  const send = pair.host.send.bind(pair.host);
  pair.host.send = (channel, bytes) => {
    const sequence = sequenceOf(channel, bytes);
    if (sequence !== null) sent.push(sequence);
    send(channel, bytes);
  };
  pair.guest.onMessage((channel, bytes) => {
    const sequence = sequenceOf(channel, bytes);
    if (sequence !== null) delivered.push(sequence);
  });
  const outOfOrder = () => delivered.filter((sequence, index) => delivered.slice(0, index).some((earlier) => earlier > sequence)).length;
  return { sent, delivered, outOfOrder };
}

// Reorder above the 0.1 s between host states, so a newer state often lands before an older one.
const REORDER_SECONDS = 0.25;

test('state channel loss during a capture still converges and never steps back', async () => {
  const { host, guest, pair, stepBoth, startMatch } = await createOnlinePair({ lossFraction: 0.5, reorderSeconds: REORDER_SECONDS, random: seededRandom(7) });
  const trace = traceHostStates(pair);
  await startMatch('hives');
  const hostCenter = hivesOn(host).hives[2];
  const guestCenter = hivesOn(guest).hives[2];
  let previousHost = 0;
  let previousGuest = 0;
  let guestRises = 0;
  let updates = 0;
  while (hostCenter.owner === null) {
    assert.ok(updates < 600, 'the host captures within 10 s');
    holdAt(host.game.seats[0], hostCenter.x, hostCenter.y);
    stepBoth(STEP);
    updates += 1;
    if (hostCenter.owner !== null) break;
    assert.ok(hostCenter.progress >= previousHost, 'the host\'s progress only rises');
    assert.ok(guestCenter.progress >= previousGuest, `the guest stepped back from ${previousGuest} to ${guestCenter.progress}`);
    if (guestCenter.progress > previousGuest) guestRises += 1;
    previousHost = hostCenter.progress;
    previousGuest = guestCenter.progress;
  }
  assert.ok(guestRises > 10, `the guest followed the capture (${guestRises} rises)`);
  assert.ok(trace.delivered.length < trace.sent.length, `some host states were dropped (${trace.delivered.length} of ${trace.sent.length})`);
  assert.ok(trace.outOfOrder() > 0, 'some host states arrived after a newer one');
  // Once the guest shows the owner it never shows the hive neutral again.
  let guestOwned = false;
  for (let update = 0; update < Math.round(0.5 / STEP); update += 1) {
    holdAt(host.game.seats[0], hostCenter.x, hostCenter.y);
    stepBoth(STEP);
    if (guestCenter.owner === 0) guestOwned = true;
    else assert.equal(guestOwned, false, 'the guest stepped back to an older owner');
  }
  assert.equal(guestCenter.owner, hostCenter.owner);
  // Loss stops: within one host-state interval (plus the reorder) the guest matches the host.
  pair.setLossFraction(0);
  stepHolding(stepBoth, host.game.seats[0], hostCenter, (HOST_STATE_UPDATE_INTERVAL + 1) * STEP + REORDER_SECONDS);
  holdAt(host.game.seats[0], hostCenter.x, hostCenter.y);
  stepHolding(stepBoth, host.game.seats[0], hostCenter, HOST_STATE_UPDATE_INTERVAL * STEP);
  hivesOn(host).hives.forEach((hive, index) => {
    const mirrored = hivesOn(guest).hives[index];
    assert.equal(mirrored.owner, hive.owner);
    assert.equal(mirrored.capturer, hive.capturer);
    assert.ok(Math.abs(mirrored.progress - hive.progress) < 0.2 * HOST_STATE_UPDATE_INTERVAL * STEP + 1e-4);
  });
  assert.equal(captureShockwaves(guest).length, 1, 'the capture shockwave plays once');
});

test('a hold win reads PLAYER 1 WINS on both with hives true', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('hives');
  stepBoth(0.2);
  hivesOn(host).hives.forEach((hive) => { hive.owner = 0; });
  Object.assign(hivesOn(host).hold, { holder: 0, seconds: 19.9 });
  stepBoth(0.5);
  for (let index = 0; index < 600 && !(host.game.run.phase === 'gameOver' && guest.game.run.phase === 'gameOver'); index += 1) stepBoth(STEP);
  for (const side of [host, guest]) {
    assert.equal(side.game.run.phase, 'gameOver', side.online.role);
    assert.deepEqual(side.game.state.matchResult, { winner: 0, draw: false, hives: true });
  }
});

test('the guest never calls captureStep', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  let calls = 0;
  hivesOn(guest).update = () => {
    calls += 1;
    return { captured: [], winner: null };
  };
  holdAt(guest.game.seats[1], 16, 9);
  stepBoth(3);
  assert.equal(calls, 0);
});

test('the guest keeps the newest host state for the shared numbers', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  assert.equal(guest.online.hostState, null);
  stepBoth(0.2);
  assert.equal(host.online.hostState, null, 'the host applies none');
  const state = guest.online.hostState;
  assert.ok(state !== null);
  assert.equal(state.bombs, host.game.run.bombs);
  assert.equal(state.hives.length, 3);
});

test('resetHostState forgets the shared numbers but never takes an older state again', async () => {
  const { guest, pair, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('hives');
  stepBoth(0.2);
  // The guest drains what the host's last update sent, so only the stale state below is in flight.
  guest.game.update(STEP);
  const applied = guest.online.hostState;
  guest.online.resetHostState();
  assert.equal(guest.online.hostState, null);
  hivesOn(guest).hives[2].progress = 0.75;
  // A state from before the reset (its sequence not above the last applied) still changes nothing.
  const stale = { ...seatAt({ sequence: 999, matchSeconds: 0, x: 6, seat: 0 }), hostState: { ...applied, hives: applied.hives.map((hive) => ({ ...hive, progress: 0 })) } };
  pair.host.send('state', encodeSnapshot(stale));
  pair.advance(0);
  guest.game.update(STEP);
  assert.equal(hivesOn(guest).hives[2].progress, 0.75);
  assert.equal(guest.online.hostState, null);
});
