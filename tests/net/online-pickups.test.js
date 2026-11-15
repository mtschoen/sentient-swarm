import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';

const BLAST_STRENGTH = 0.5;
const BLAST_RADIUS = 1.5;

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

// A pickup the host's director placed (as PickupDirector.spawn pushes it).
function hostPickup(host, x, y, type = 'scatter') {
  const pickup = { x, y, type, age: 0, fade: 1 };
  host.game.pickups.pickups.push(pickup);
  return pickup;
}

function placePoint(seat, x, y) {
  seat.player.positionX = x;
  seat.player.positionY = y;
}

const blasts = (side) => side.game.pendingImpulses.filter((impulse) => impulse.strength === BLAST_STRENGTH).map(({ x, y }) => ({ x, y }));

async function sameMomentMatch() {
  const pair = await createOnlinePair({ delaySeconds: 0.05 });
  const { host, guest, stepBoth, startMatch } = pair;
  await startMatch('versus');
  stepBoth(0.5);
  const guestQueued = queuedEvents(guest);
  hostPickup(host, 16.3, 12.7);
  stepBoth(0.1);
  assert.equal(guest.game.pickups.pickups.length, 1, 'the guest has the announce');
  // Both points on the pickup in the same update.
  placePoint(host.game.seats[0], 16.3, 12.7);
  placePoint(guest.game.seats[1], 16.3, 12.7);
  stepBoth(0.3);
  return { ...pair, guestQueued };
}

test('both players reaching one pickup in the same moment: only the host collects', async () => {
  const { host, guest } = await sameMomentMatch();
  assert.equal(host.game.seats[0].weapons.armed, 'scatter');
  assert.equal(guest.game.seats[1].weapons.armed, 'base');
  assert.equal(host.game.pickups.pickups.length, 0);
  assert.equal(guest.game.pickups.pickups.length, 0);
  const at = { x: Math.fround(16.3), y: Math.fround(12.7), radius: BLAST_RADIUS };
  for (const side of [host, guest]) {
    assert.deepEqual(side.simulation.radialKills, [at], side.online.role);
    assert.deepEqual(blasts(side), [{ x: at.x, y: at.y }], side.online.role);
  }
});

test('a refused claim never fires later', async () => {
  const { host, guest, stepBoth, guestQueued } = await sameMomentMatch();
  stepBoth(2);
  assert.equal(guest.game.seats[1].weapons.armed, 'base');
  assert.equal(guestQueued.filter((event) => event.type === 'pickupClaim').length, 1);
  for (const side of [host, guest]) assert.equal(side.simulation.radialKills.length, 1, side.online.role);
  assert.equal(guest.online.pickupClaimsPending, 0);
});

test('a guest claim is granted and the guest arms the weapon', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.5);
  const hostQueued = queuedEvents(host);
  hostPickup(host, 20.6, 7.2, 'pulse');
  stepBoth(0.1);
  placePoint(guest.game.seats[1], 20.6, 7.2);
  stepBoth(0.3);
  assert.equal(guest.game.seats[1].weapons.armed, 'pulse');
  assert.equal(host.game.seats[0].weapons.armed, 'base');
  assert.deepEqual(hostQueued.filter((event) => event.type === 'pickupCollected').map(({ seat, pickupType }) => ({ seat, pickupType })), [{ seat: 1, pickupType: 'pulse' }]);
  const at = guest.simulation.radialKills;
  assert.equal(at.length, 1);
  assert.ok(Math.abs(at[0].x - 20.6) < 1e-5 && Math.abs(at[0].y - 7.2) < 1e-5);
  assert.deepEqual(host.simulation.radialKills, at, 'the blast at the guest\'s claim point on both');
  for (const side of [host, guest]) assert.equal(blasts(side).length, 1, side.online.role);
  assert.equal(host.game.pickups.pickups.length, 0);
  assert.equal(guest.game.pickups.pickups.length, 0);
  stepBoth(0.3);
  assert.equal(host.game.seats[1].weapons.armed, 'pulse', 'the host\'s mirror shows the guest\'s weapon');
});

test('a pickup that expires on the host disappears on the guest', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.2);
  const pickup = hostPickup(host, 16, 14, 'rail');
  stepBoth(0.2);
  const mirrored = guest.game.pickups.pickups.find((entry) => entry.type === 'rail');
  assert.ok(mirrored !== undefined);
  let lowestFade = 1;
  for (let update = 0; update < Math.round(10.2 / STEP); update += 1) {
    stepBoth(STEP);
    if (guest.game.pickups.pickups.includes(mirrored)) lowestFade = Math.min(lowestFade, mirrored.fade);
  }
  assert.ok(!host.game.pickups.pickups.includes(pickup));
  assert.ok(!guest.game.pickups.pickups.includes(mirrored));
  assert.ok(lowestFade < 0.05, `the guest's fade reached ${lowestFade}`);
  assert.equal(guest.game.seats[1].weapons.armed, 'base');
});

test('the guest never runs the pickup director', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  let calls = 0;
  guest.game.pickups.update = () => { calls += 1; };
  stepBoth(0.5);
  hostPickup(host, 12.25, 5.5);
  hostPickup(host, 21.75, 13.5, 'rail');
  stepBoth(0.2);
  assert.equal(calls, 0);
  const positions = (side) => side.game.pickups.pickups.map(({ x, y, type }) => ({ x: Math.fround(x), y: Math.fround(y), type }));
  assert.deepEqual(positions(guest), positions(host));
});

test('every couch seat still collects at its own point', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  host.game.online.detach(host.game);
  stepBoth(0.1);
  hostPickup(host, host.game.seats[1].point.x, host.game.seats[1].point.y, 'rail');
  stepBoth(STEP);
  assert.equal(host.game.seats[1].weapons.railTurrets, 1);
});

test('resetPickups forgets the guest claims', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair({ delaySeconds: 0.05 });
  await startMatch('versus');
  stepBoth(0.2);
  hostPickup(host, 16, 14);
  stepBoth(0.2);
  placePoint(guest.game.seats[1], 16, 14);
  guest.game.update(STEP);
  assert.equal(guest.online.pickupClaimsPending, 1);
  guest.online.resetPickups();
  host.online.resetPickups();
  assert.equal(guest.online.pickupClaimsPending, 0);
});
