import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair, seededRandom } from './online-harness.js';
import { OnlineGame } from '../../src/net/online-game.js';
import { SessionClock } from '../../src/net/session-clock.js';
import { createMemoryTransportPair } from '../../src/net/memory-transport.js';
import { decodeEvent, encodeEvent } from '../../src/net/event-codec.js';
import { decodeSnapshot } from '../../src/net/snapshot-codec.js';
import { createGame } from '../game/game-harness.js';

// The 16-bit position code's step over the 32-unit world.
const POSITION_STEP = 32 / 65535;

// Records every message an endpoint sends, decoded.
function recordSends(endpoint) {
  const sent = [];
  const send = endpoint.send;
  endpoint.send = (channel, bytes) => {
    sent.push({ channel, message: channel === 'state' ? decodeSnapshot(bytes) : decodeEvent(bytes) });
    send(channel, bytes);
  };
  return sent;
}

test('on the guest, input.state drives seat index 1 and nothing drives seat index 0', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  const before = guest.game.seats[0].point.x;
  guest.input.seatTwoState.move = { x: 1, y: 0 };
  guest.input.state.move = { x: -1, y: 0 };
  stepBoth(0.5);
  assert.ok(guest.game.seats[1].point.x < 26 - 0.5);
  assert.ok(Math.abs(guest.game.seats[0].point.x - before) <= POSITION_STEP);
});

test('on the host, input.state drives seat index 0 and seatTwoState drives nothing', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  host.input.state.move = { x: 0, y: 1 };
  host.input.seatTwoState.move = { x: -1, y: 0 };
  stepBoth(0.5);
  assert.ok(host.game.seats[0].point.y > 9 + 0.5);
  assert.ok(Math.abs(host.game.seats[1].point.x - 26) <= POSITION_STEP);
  assert.equal(host.game.localSeatIndex, 0);
  assert.equal(host.online.isHost, true);
  assert.equal(host.online.remoteSeatIndex, 1);
});

test('each machine shows the other seat about 100 ms behind', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  const history = [];
  host.input.state.move = { x: 1, y: 0 };
  for (let index = 0; index < 60; index += 1) {
    stepBoth(STEP);
    history.push(host.game.seats[0].point.x);
  }
  const behind = history.at(-1 - Math.round(0.1 / STEP));
  assert.ok(Math.abs(guest.game.seats[0].point.x - behind) < 0.15, `guest ${guest.game.seats[0].point.x}, host 100 ms ago ${behind}`);
});

test('the mirrored ships follow the remote swarm', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(1);
  assert.equal(guest.game.seats[0].swarm.aliveCount, host.game.seats[0].swarm.aliveCount);
  assert.equal(host.game.seats[1].swarm.aliveCount, guest.game.seats[1].swarm.aliveCount);
  const hostCentroid = host.game.seats[0].centroid;
  const mirrored = guest.game.seats[0].centroid;
  assert.ok(Math.hypot(hostCentroid.x - mirrored.x, hostCentroid.y - mirrored.y) < 0.5);
});

test('the remote seat uploads invulnerable and the local seat does not', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  host.simulation.swarmUploads.length = 0;
  guest.simulation.swarmUploads.length = 0;
  stepBoth(0.2);
  for (const [side, remote] of [[host, 1], [guest, 0]]) {
    const uploads = side.simulation.swarmUploads;
    assert.ok(uploads.length >= 24);
    assert.ok(uploads.filter((upload) => upload.seat === remote).every((upload) => upload.invulnerable));
    assert.ok(uploads.filter((upload) => upload.seat !== remote).every((upload) => !upload.invulnerable));
  }
});

test('the remote seat fires nothing locally', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  host.input.state.firing = true;
  host.input.state.aim = { x: 1, y: 0 };
  host.input.seatTwoState.firing = true;
  host.input.seatTwoState.aim = { x: -1, y: 0 };
  stepBoth(0.5);
  assert.ok(host.projectiles.spawnOwners.length > 0);
  assert.ok(host.projectiles.spawnOwners.every((owner) => owner[0] === 0));
  assert.ok(host.projectiles.beamSeats.every((seat) => seat === 0));
});

test('each machine sends 30 snapshots a second, stamped with the match time after the update', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  const hostSent = recordSends(host.online.transport);
  const guestSent = recordSends(guest.online.transport);
  await startMatch('versus');
  stepBoth(1);
  const hostSnapshots = hostSent.filter((entry) => entry.channel === 'state').map((entry) => entry.message);
  assert.equal(hostSnapshots.length, 30);
  assert.equal(guestSent.filter((entry) => entry.channel === 'state').length, 30);
  assert.ok(hostSnapshots.every((snapshot) => snapshot.seat === 0));
  assert.deepEqual(hostSnapshots.slice(0, 3).map((snapshot) => snapshot.sequence), [1, 2, 3]);
  assert.ok(Math.abs(hostSnapshots[0].matchSeconds - 2 * STEP) < 1e-12);
  assert.ok(Math.abs(host.clock.matchSeconds - 1) < 1e-9);
});

test('pings go out once a second and are answered, so both clocks learn the round trip', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  const hostSent = recordSends(host.online.transport);
  await startMatch('versus');
  stepBoth(2.5);
  const pings = hostSent.filter((entry) => entry.message.type === 'ping');
  const pongs = hostSent.filter((entry) => entry.message.type === 'pong');
  assert.equal(pings.length, 3);
  assert.equal(pongs.length, 3);
  for (const side of [host, guest]) {
    assert.ok(side.clock.roundTripSeconds >= 0.1 - 1e-9 && side.clock.roundTripSeconds < 0.1 + 2 * STEP, `${side.clock.roundTripSeconds}`);
  }
});

test('the match clock runs while Playing and freezes otherwise', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  stepBoth(0.5);
  assert.equal(host.clock.matchSeconds, 0, 'Ready does not advance the match');
  await startMatch('versus');
  stepBoth(0.5);
  assert.ok(Math.abs(host.clock.matchSeconds - 0.5) < 1e-9);
  host.game.pause();
  stepBoth(0.5);
  assert.ok(Math.abs(host.clock.matchSeconds - 0.5) < 1e-9);
});

test('queued events go out on the events channel at the end of the update', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  const hostSent = recordSends(host.online.transport);
  await startMatch('versus');
  // The session's ready, start and pings went out during startMatch; a pause would pause the
  // guest's session (online-session.js), so the queued event is a capture.
  const sentBefore = hostSent.length;
  host.online.queueEvent({ type: 'hiveCaptured', hive: 0, seat: 0 });
  assert.equal(hostSent.length, sentBefore);
  stepBoth(STEP);
  assert.deepEqual(hostSent.filter((entry) => entry.message.type === 'hiveCaptured').map((entry) => entry.channel), ['events']);
  // Delivered after the guest's update, it is drained in the guest's next one.
  stepBoth(STEP);
  assert.deepEqual(guest.online.receivedEvents.filter((event) => event.type === 'hiveCaptured'), [{ type: 'hiveCaptured', hive: 0, seat: 0 }]);
  stepBoth(STEP);
  assert.equal(guest.online.receivedEvents.length, 0, 'the list holds this update\'s events only');
});

test('a lost remote ship ripples the warp grid once', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  guest.game.takeImpulses();
  host.game.seats[0].swarm.killShip(3);
  stepBoth(0.5);
  const losses = guest.game.takeImpulses().filter((impulse) => impulse.strength === 0.12);
  assert.equal(losses.length, 1);
  assert.equal(guest.game.seats[0].swarm.aliveCount, 11);
});

test('the first mirror of a run replaces the reset swarm without shockwaves', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  // The host's seat 0 swarm regrew slot 0 before the match, so its generation differs from the guest's copy.
  host.game.seats[0].swarm.killShip(0);
  host.game.seats[0].swarm.spawnShip(6, 9);
  await startMatch('versus');
  guest.game.takeImpulses();
  stepBoth(0.5);
  assert.equal(guest.game.takeImpulses().filter((impulse) => impulse.strength === 0.12).length, 0);
});

test('both cameras frame both swarms as the couch camera does', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(1);
  assert.ok(Math.abs(guest.game.camera.centerX - host.game.camera.centerX) < 0.3);
  assert.ok(Math.abs(host.game.camera.centerX - 16) < 0.3);
  assert.ok(Math.abs(guest.game.camera.centerX - 16) < 0.3);
  assert.ok(Math.abs(guest.game.camera.zoom - host.game.camera.zoom) < 0.02);
});

test('attach needs two seats and detach returns the local seat to 0 and clears the remote flag', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  assert.throws(() => guest.online.attach(guest.game), RangeError);
  await startMatch('versus');
  assert.equal(guest.game.localSeatIndex, 1);
  assert.equal(guest.game.online, guest.online);
  assert.equal(guest.game.seats[0].remote, true);
  assert.equal(guest.game.seats[1].remote, false);
  stepBoth(0.5);
  const remoteSeat = guest.game.seats[0];
  guest.game.quitToTitle();
  guest.online.detach(guest.game);
  assert.equal(guest.game.localSeatIndex, 0);
  assert.equal(guest.game.online, null);
  assert.ok(guest.game.seats.every((seat) => !seat.remote));
  assert.equal(remoteSeat.remote, false);
  stepBoth(0.2);
});

test('detach in Ready with two seats puts the local seat back on 0', async () => {
  const { guest } = await createOnlinePair();
  guest.game.setPlayerCount(2);
  guest.online.attach(guest.game);
  assert.equal(guest.game.localSeatIndex, 1);
  guest.online.detach(guest.game);
  assert.equal(guest.game.localSeatIndex, 0);
  assert.ok(guest.game.seats.every((seat) => !seat.remote));
});

test('a guest adapter plays seat index 1', async () => {
  const { game } = await createGame();
  const pair = createMemoryTransportPair();
  const online = new OnlineGame({ role: 'guest', transport: pair.guest, clock: new SessionClock({ now: () => 0 }) });
  game.setPlayerCount(2);
  online.attach(game);
  assert.equal(online.isGuest, true);
  assert.equal(online.isHost, false);
  assert.equal(game.localSeatIndex, 1);
  assert.equal(online.localSeatIndex, 1);
});

test('the role must be host or guest', () => {
  const pair = createMemoryTransportPair();
  assert.throws(() => new OnlineGame({ role: 'spectator', transport: pair.host, clock: new SessionClock({ now: () => 0 }) }), RangeError);
});

test('a lossy, jittery link still mirrors the remote seat', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.04, lossFraction: 0.2, reorderSeconds: 0.03, random: seededRandom(7) });
  await startMatch('versus');
  host.input.state.move = { x: 0.5, y: 0 };
  stepBoth(2);
  const shown = guest.game.seats[0].point.x;
  assert.ok(Math.abs(shown - host.game.seats[0].point.x) < 0.6, `guest ${shown}, host ${host.game.seats[0].point.x}`);
  assert.ok(shown > 6.5);
  assert.ok(Number.isFinite(guest.game.camera.centerX));
});

test('an event that does not decode is dropped and the next one still arrives', async () => {
  const { guest, pair, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  pair.host.send('events', Uint8Array.of(250));
  // A quit would end the session (online-session.js), so the event that follows is a capture.
  pair.host.send('events', encodeEvent({ type: 'hiveCaptured', hive: 0, seat: 0 }));
  pair.host.send('state', Uint8Array.of(9, 9));
  stepBoth(2 * STEP);
  assert.ok(guest.online.receivedEvents.some((event) => event.type === 'hiveCaptured'));
});

// The spawns queued with owner seat, in queue order.
function ownedSpawns(projectiles, seat) {
  return projectiles.spawns.filter((spawn, index) => projectiles.spawnOwners[index][0] === seat);
}

test('every host shot reaches the guest with its owner, aged by the delay', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  host.game.debugArm('scatter', 2);
  host.input.state.firing = true;
  host.input.state.aim = { x: 1, y: 0 };
  stepBoth(1);
  host.input.state.firing = false;
  stepBoth(0.2);
  const fired = ownedSpawns(host.projectiles, 0);
  const replayed = ownedSpawns(guest.projectiles, 0);
  assert.ok(fired.length > 20);
  assert.equal(replayed.length, fired.length);
  replayed.forEach((copy, index) => {
    const original = fired[index];
    const age = original.lifetime - copy.lifetime;
    assert.ok(Math.abs(age - 0.05) <= STEP + 1e-4, `age ${age}`);
    assert.ok(Math.abs(copy.x - (original.x + original.velocityX * age)) < 1e-4);
    assert.ok(Math.abs(copy.y - (original.y + original.velocityY * age)) < 1e-4);
    assert.equal(copy.kind, original.kind);
  });
  assert.equal(ownedSpawns(host.projectiles, 1).length, 0, 'the guest fired nothing');
});

test('the remote beam follows the remote seat and stops with it', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  host.game.debugArm('beam');
  host.input.state.firing = true;
  host.input.state.aim = { x: 1, y: 0 };
  stepBoth(0.5);
  const seatZeroBeams = () => guest.projectiles.beams.filter((beam, index) => guest.projectiles.beamSeats[index] === 0);
  const firing = seatZeroBeams();
  assert.ok(firing.some((beam) => beam !== null));
  assert.ok(firing.at(-1) !== null);
  assert.ok(guest.projectiles.beamOwners.filter((owner, index) => guest.projectiles.beamSeats[index] === 0).every((owner) => owner[0] === 0));
  host.input.state.firing = false;
  stepBoth(0.3);
  assert.equal(seatZeroBeams().at(-1), null);
});
