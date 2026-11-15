import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';
import { encodeEvent } from '../../src/net/event-codec.js';
import { SHIP_CONTACT_DISTANCE } from '../../src/game/versus-seats.js';

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

function place(swarm, slot, x, y) {
  Object.assign(swarm.slots[slot], { x, y, previousX: x, previousY: y });
}

const contactKills = (events) => events.filter((event) => event.type === 'contactKills');

test('one touch kills one ship on each side', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const hostQueued = queuedEvents(host);
  const generation = host.game.seats[1].swarm.generationOf(0);
  assert.equal(generation, guest.game.seats[1].swarm.generationOf(0));
  // The host's ship and its mirror copy of the guest's ship together (the couch tests' way).
  place(host.game.seats[0].swarm, 0, 16, 9);
  place(host.game.seats[1].swarm, 0, 16, 9);
  host.game.online.stepVersus(host.game, STEP);
  assert.equal(host.game.seats[0].aliveCount, 11);
  assert.equal(host.game.seats[1].aliveCount, 11, 'the mirror loses the guest ship at once');
  assert.deepEqual(contactKills(hostQueued), [{ type: 'contactKills', kills: [{ slot: 0, generation }] }]);
  stepBoth(0.3);
  assert.equal(host.game.seats[0].aliveCount, 11);
  assert.equal(guest.game.seats[1].aliveCount, 11);
  assert.equal(guest.game.seats[1].swarm.slots[0].alive, false);
  assert.equal(host.game.seats[1].aliveCount, 11);
  assert.equal(guest.game.seats[0].aliveCount, 11);
  assert.equal(contactKills(hostQueued).length, 1);
});

test('a contact against a ship whose death the host has not seen yet kills only once', async () => {
  const { host, guest, pair, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.5);
  const hostQueued = queuedEvents(host);
  // Where the host's mirror would show the guest's slot 0 each update, suppressed or not.
  const { driver } = host.online;
  const sample = driver.sample.bind(driver);
  let latest = null;
  driver.sample = (renderMatchSeconds) => {
    latest = sample(renderMatchSeconds);
    return latest;
  };
  // The guest holds its slot 0 ship away from its swarm (its flock pulls it back a little each
  // update), so only that ship can touch the host's ship.
  const guestSwarm = guest.game.seats[1].swarm;
  const isolate = () => { if (guestSwarm.slots[0].alive) place(guestSwarm, 0, 20, 15); };
  for (let update = 0; update < 20; update += 1) {
    stepBoth(STEP);
    isolate();
  }
  const clearance = (ship) => Math.min(...latest.ships.filter((other) => other.slot !== ship.slot).map((other) => Math.hypot(other.x - ship.x, other.y - ship.y)));
  const target = 0;
  const heldShip = () => latest.ships.find((ship) => ship.slot === target);
  const hostSwarm = host.game.seats[0].swarm;
  place(hostSwarm, 0, heldShip().x, heldShip().y);
  pair.setLossFraction(1);
  host.game.online.stepVersus(host.game, STEP);
  assert.equal(hostSwarm.aliveCount, 11);
  // The snapshots still in flight (100 ms behind), then none: the guest ship's death never shows.
  for (let update = 0; update < 10; update += 1) {
    stepBoth(STEP);
    isolate();
    assert.ok(heldShip() !== undefined, 'the host still holds the guest ship alive');
    assert.ok(clearance(heldShip()) > 2 * SHIP_CONTACT_DISTANCE, 'no other guest ship is in reach');
    place(hostSwarm, 1, heldShip().x, heldShip().y);
    host.game.online.stepVersus(host.game, STEP);
  }
  assert.equal(hostSwarm.aliveCount, 11);
  assert.equal(host.game.seats[1].swarm.slots[target].alive, false);
  assert.deepEqual(contactKills(hostQueued).flatMap((event) => event.kills).map((kill) => kill.slot), [target]);
  assert.equal(guest.game.seats[1].aliveCount, 11, 'the events channel still delivers the kill');
  assert.equal(guest.game.seats[1].swarm.slots[target].alive, false);
});

test('a contact kill naming an older generation is ignored', async () => {
  const { guest, pair, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const swarm = guest.game.seats[1].swarm;
  const generation = swarm.generationOf(4);
  pair.host.send('events', encodeEvent({ type: 'contactKills', kills: [{ slot: 4, generation: (generation + 15) % 16 }] }));
  stepBoth(2 * STEP);
  assert.equal(swarm.aliveCount, 12);
  assert.equal(swarm.slots[4].alive, true);
  guest.game.takeImpulses();
  pair.host.send('events', encodeEvent({ type: 'contactKills', kills: [{ slot: 4, generation }, { slot: 5, generation: swarm.generationOf(5) }] }));
  stepBoth(2 * STEP);
  assert.equal(swarm.aliveCount, 10);
  assert.equal(guest.game.takeImpulses().filter((impulse) => impulse.strength === 0.12).length, 2);
});

test('the guest never pairs ships', async () => {
  const { guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const guestQueued = queuedEvents(guest);
  const own = guest.game.seats[1].swarm;
  const mirror = guest.game.seats[0].swarm;
  for (const ship of own.ships) place(mirror, ship.slot, ship.x, ship.y);
  guest.game.online.stepVersus(guest.game, STEP);
  assert.equal(own.aliveCount, 12);
  assert.equal(mirror.aliveCount, 12);
  assert.deepEqual(contactKills(guestQueued), []);
});

test('a guest wiped by contact kills reports its wipe', async () => {
  const { host, guest, pair, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const guestQueued = queuedEvents(guest);
  const swarm = guest.game.seats[1].swarm;
  const kills = swarm.ships.map((ship) => ({ slot: ship.slot, generation: swarm.generationOf(ship.slot) }));
  pair.host.send('events', encodeEvent({ type: 'contactKills', kills }));
  stepBoth(2 * STEP);
  assert.equal(swarm.aliveCount, 0);
  assert.deepEqual(guestQueued.filter((event) => event.type === 'wiped').map((event) => event.seat), [1]);
  stepBoth(1);
  assert.deepEqual(host.game.state.matchResult, { winner: 0, draw: false, hives: false });
});

test('a contact that wipes both last ships at once is a draw on both games', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.5);
  // Each machine kills its own ships down to slot 0; the snapshots carry it to the other's mirror.
  for (const swarm of [host.game.seats[0].swarm, guest.game.seats[1].swarm]) {
    for (const ship of swarm.ships) if (ship.slot !== 0) swarm.killShip(ship.slot);
  }
  stepBoth(0.5);
  assert.equal(host.game.seats[1].aliveCount, 1, 'the host mirror shows the guest\'s last ship');
  assert.equal(guest.game.seats[0].aliveCount, 1, 'the guest mirror shows the host\'s last ship');
  // The host's last ship touches its mirror of the guest's last ship.
  place(host.game.seats[0].swarm, 0, 16, 9);
  place(host.game.seats[1].swarm, 0, 16, 9);
  host.game.online.stepVersus(host.game, STEP);
  assert.equal(host.game.seats[0].aliveCount, 0);
  runUntilBothOver(stepBoth, host, guest);
  assert.equal(guest.game.seats[1].aliveCount, 0, 'the contact kill reached the guest');
  for (const side of [host, guest]) assert.deepEqual(side.game.state.matchResult, { winner: null, draw: true, hives: false });
});

function runUntilBothOver(stepBoth, host, guest) {
  for (let index = 0; index < 600; index += 1) {
    if (host.game.run.phase === 'gameOver' && guest.game.run.phase === 'gameOver') return;
    stepBoth(STEP);
  }
  assert.fail(`phases ${host.game.run.phase} and ${guest.game.run.phase}`);
}

test('no contact while either seat is invulnerable', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const hostQueued = queuedEvents(host);
  place(host.game.seats[0].swarm, 0, 16, 9);
  place(host.game.seats[1].swarm, 0, 16, 9);
  host.game.seats[1].remoteInvulnerable = true;
  host.game.online.stepVersus(host.game, STEP);
  host.game.seats[1].remoteInvulnerable = false;
  host.game.seats[0].invulnerableSeconds = 1;
  host.game.online.stepVersus(host.game, STEP);
  assert.equal(host.game.seats[0].aliveCount, 12);
  assert.equal(host.game.seats[1].aliveCount, 12);
  assert.deepEqual(contactKills(hostQueued), []);
});
