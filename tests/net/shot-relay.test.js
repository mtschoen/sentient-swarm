import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotRelay, ageSpawn } from '../../src/net/shot-relay.js';

const SPAWN = Object.freeze({ x: 1, y: 2, velocityX: 3, velocityY: -1, radius: 0.05, lifetime: 0.5, kind: 1, seed: 0.25, extra: 0 });

test('ageSpawn moves the shot along its velocity and cuts its lifetime by its age', () => {
  assert.deepEqual(ageSpawn(SPAWN, 0.1), { ...SPAWN, x: 1.3, y: 1.9, lifetime: 0.4 });
  assert.equal(ageSpawn(SPAWN, 0.6), null);
  assert.equal(ageSpawn(SPAWN, 0.5), null);
  assert.deepEqual(ageSpawn(SPAWN, -0.2), SPAWN);
});

test('record makes one shots event of an update\'s spawns and none when there are none', () => {
  const relay = new ShotRelay();
  assert.equal(relay.record(0, [], 3), null);
  const spawns = [SPAWN, { ...SPAWN, x: 4 }];
  const event = relay.record(1, spawns, 3.5);
  assert.deepEqual(event, { type: 'shots', owner: 1, matchSeconds: 3.5, spawns });
  spawns.length = 0;
  assert.equal(event.spawns.length, 2, 'the event keeps its own list');
});

test('replay queues each spawn aged to the sender\'s time now with the event\'s owner', () => {
  const relay = new ShotRelay();
  const queued = [];
  const projectiles = { queueSpawn: (spawn, owner) => queued.push({ spawn, owner }) };
  const event = { type: 'shots', owner: 1, matchSeconds: 10, spawns: [SPAWN, { ...SPAWN, lifetime: 0.05 }] };
  assert.equal(relay.replay(event, 10.25, projectiles), 1);
  assert.deepEqual(queued, [{ spawn: { ...SPAWN, x: 1.75, y: 1.75, lifetime: 0.25 }, owner: 1 }]);
});
