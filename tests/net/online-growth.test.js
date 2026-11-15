import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP, createOnlinePair } from './online-harness.js';
import { onlineGrowth } from '../../src/net/online-game.js';
import { maskFor, stats } from '../game/game-harness.js';

// A stats frame from the step the next update runs.
function scriptFrame(side, fields) {
  side.simulation.scriptedStats.push(stats({ frameSequence: side.simulation.frameSequence + 1, ...fields }));
}

// Records every addKills call on a swarm.
function recordAddKills(swarm) {
  const calls = [];
  const addKills = swarm.addKills.bind(swarm);
  swarm.addKills = (count) => {
    calls.push(count);
    return addKills(count);
  };
  return calls;
}

test('online growth is normalized to the reference capacity', () => {
  assert.equal(onlineGrowth(100, 262144), 200);
  assert.equal(onlineGrowth(100, 524288), 100);
  assert.equal(onlineGrowth(0, 262144), 0);
});

test('the host grows its own seat by scaled owned kills and never the remote one', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  const remoteCalls = recordAddKills(host.game.seats[1].swarm);
  assert.equal(host.game.seats[0].aliveCount, 12);
  scriptFrame(host, { ownerKillsSinceLastRead: [100, 300] });
  stepBoth(0.5);
  assert.equal(host.game.seats[0].aliveCount, 14);
  assert.deepEqual(remoteCalls, []);
  assert.equal(host.game.seats[1].aliveCount, guest.game.seats[1].aliveCount);
  assert.equal(host.game.seats[1].aliveCount, 12);
});

test('the guest grows its own seat by its own credit alone', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  scriptFrame(guest, { ownerKillsSinceLastRead: [300, 50] });
  stepBoth(0.5);
  assert.equal(guest.game.seats[1].aliveCount, 13);
  assert.equal(guest.game.seats[0].aliveCount, 12);
  assert.equal(host.game.seats[1].aliveCount, 13, 'the host sees the growth through the snapshot');
});

test('the remote seat hit mask kills nothing on this machine', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  // Before the first snapshot arrives the host's seat 1 is still its own locally reset swarm.
  const remoteHits = [];
  const seat = host.game.seats[1];
  const applyHits = seat.applyHits.bind(seat);
  seat.applyHits = (frame) => {
    remoteHits.push(frame);
    return applyHits(frame);
  };
  scriptFrame(host, { secondSwarmHitMask: maskFor([0, 1, 2]) });
  stepBoth(0.5);
  assert.deepEqual(remoteHits, []);
  assert.equal(host.game.seats[1].aliveCount, 12);
  assert.equal(guest.game.seats[1].aliveCount, 12);
  assert.equal(host.game.run.phase, 'playing');
});

test('the local seat hit mask kills its ships with a shockwave each', async () => {
  const { host, guest, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  guest.game.takeImpulses();
  scriptFrame(guest, { secondSwarmHitMask: maskFor([0, 1, 2]), swarmHitMask: maskFor([0, 1, 2, 3]) });
  stepBoth(STEP);
  assert.equal(guest.game.seats[1].aliveCount, 9);
  assert.equal(guest.game.seats[0].aliveCount, 12, 'the first mask is the remote seat\'s on the guest');
  assert.equal(guest.game.takeImpulses().filter((impulse) => impulse.strength === 0.12).length, 3);
  stepBoth(0.5);
  assert.equal(host.game.seats[1].aliveCount, 9);
});

test('a capacity change mid-match rescales growth from the next frame and keeps the remote seat invulnerable', async () => {
  const { host, stepBoth, startMatch } = await createOnlinePair();
  await startMatch('versus');
  stepBoth(0.5);
  // As CapacitySwap's install sets it (game.js).
  host.game.capacity = 524288;
  scriptFrame(host, { ownerKillsSinceLastRead: [100, 0] });
  host.simulation.swarmUploads.length = 0;
  stepBoth(0.5);
  assert.equal(host.game.seats[0].aliveCount, 13);
  const remoteUploads = host.simulation.swarmUploads.filter((upload) => upload.seat === 1);
  assert.ok(remoteUploads.length > 0);
  assert.ok(remoteUploads.every((upload) => upload.invulnerable));
});

