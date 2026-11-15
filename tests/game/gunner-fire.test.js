import test from 'node:test';
import assert from 'node:assert/strict';
import { GunnerFire } from '../../src/game/gunner-fire.js';
import { slotHash } from '../../src/game/swarm-hash.js';

const STEP = 1 / 60;
const AIM = { firing: true, aimX: 1, aimY: 0, deltaSeconds: STEP, railTier: 1 };

function seededRandom(seed = 777) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function gunners(count, heading = 0) {
  return Array.from({ length: count }, (_, slot) => ({ slot, x: slot, y: 2 * slot, heading, gunnerIndex: slot }));
}

// Runs fire for seconds at the fixed step; returns the spawns of each update.
function run(fire, ships, seconds, control = AIM) {
  const perUpdate = [];
  for (let step = 0; step < Math.round(seconds / STEP); step += 1) perUpdate.push(fire.fire(ships, control));
  return perUpdate;
}

const total = (perUpdate) => perUpdate.reduce((sum, spawns) => sum + spawns.length, 0);

test('a gunner fires needles along its own heading from its own position', () => {
  const ships = [{ slot: 0, x: 3, y: 4, heading: 1.0, gunnerIndex: 0 }];
  const spawns = run(new GunnerFire({ random: seededRandom() }), ships, 0.6).flat();
  assert.ok(spawns.length >= 1);
  for (const spawn of spawns) {
    assert.equal(spawn.x, 3);
    assert.equal(spawn.y, 4);
    assert.equal(spawn.velocityX, 40 * Math.cos(1.0));
    assert.equal(spawn.velocityY, 40 * Math.sin(1.0));
  }
});

test('tier sets the needle count with parallel offsets', () => {
  const ships = [{ slot: 0, x: 3, y: 4, heading: 0, gunnerIndex: 0 }];
  const first = run(new GunnerFire({ random: seededRandom() }), ships, 0.6, { ...AIM, railTier: 3 }).find((spawns) => spawns.length > 0);
  first.forEach((spawn, index) => assert.ok(Math.abs(spawn.y - 4 - (index - 1) * 0.15) < 1e-12));
  assert.equal(first.length, 3);
  assert.ok(first.every((spawn) => spawn.x === 3));
});

test('a normal ship never fires rail', () => {
  const ships = gunners(4).map((ship) => ({ ...ship, gunnerIndex: -1 }));
  assert.equal(total(run(new GunnerFire({ random: seededRandom() }), ships, 2)), 0);
});

test('twelve tier 2 gunners fire 80 needles per second', () => {
  const count = total(run(new GunnerFire({ random: seededRandom() }), gunners(12), 3, { ...AIM, railTier: 2 }));
  assert.ok(count >= 12 * 2 * 9 && count <= 12 * 2 * 11, `${count} needles in 3 s`);
});

test('gunners are phased, not synchronized', () => {
  const perUpdate = run(new GunnerFire({ random: seededRandom() }), gunners(12), 0.3);
  const volleyFrames = perUpdate.filter((spawns) => spawns.length > 0).length;
  assert.ok(volleyFrames >= 6, `${volleyFrames} frames with a volley in the first interval`);
});

test('no fire without firing or with zero aim, and the phase restarts afterwards', () => {
  const ships = [{ slot: 5, x: 0, y: 0, heading: 0, gunnerIndex: 0 }];
  assert.ok(slotHash(5, 22) > 0.1, 'the test slot has a phase above 0.1');
  for (const idle of [{ ...AIM, firing: false }, { ...AIM, aimX: 0, aimY: 0 }]) {
    const fire = new GunnerFire({ random: seededRandom() });
    run(fire, ships, 1);
    assert.equal(total(run(fire, ships, 1, idle)), 0);
    const resumed = run(fire, ships, 0.3);
    const firstVolley = resumed.findIndex((spawns) => spawns.length > 0);
    assert.ok(firstVolley >= 0, 'a volley fires again after the pause');
    assert.ok((firstVolley + 1) * STEP >= 0.1 * 0.3, `first volley at step ${firstVolley}`);
  }
});

test('a huge delta fires one volley per gunner, not a backlog', () => {
  const fire = new GunnerFire({ random: seededRandom() });
  const ships = gunners(4);
  fire.fire(ships, AIM);
  assert.equal(fire.fire(ships, { ...AIM, deltaSeconds: 5 }).length, 4);
});

test('after a huge delta the next normal steps owe one more volley at most, not the missed ones', () => {
  const fire = new GunnerFire({ random: seededRandom() });
  const ships = gunners(1);
  fire.fire(ships, AIM);
  assert.equal(fire.fire(ships, { ...AIM, deltaSeconds: 5 }).length, 1);
  // A quarter second is under one 0.3 s interval: one catch-up volley, then the carried remainder.
  assert.equal(total(run(fire, ships, 0.25)), 1);
});

test('a slot that stops being a gunner forgets its phase and re-phases by slotHash when promoted again', () => {
  const fire = new GunnerFire({ random: seededRandom() });
  const ships = [{ slot: 5, x: 0, y: 0, heading: 0, gunnerIndex: 0 }];
  run(fire, ships, 1);
  const demoted = [{ ...ships[0], gunnerIndex: -1 }];
  run(fire, demoted, 0.1);
  // Promoted again: the first step schedules (no volley) and the first volley waits out slotHash of the interval.
  const resumed = run(fire, ships, 0.3);
  assert.equal(resumed[0].length, 0);
  const firstVolley = resumed.findIndex((spawns) => spawns.length > 0);
  assert.ok(firstVolley >= 0);
  const phase = slotHash(5, 22) * 0.3;
  assert.ok(Math.abs((firstVolley + 1) * STEP - phase) <= 2 * STEP, `first volley at ${(firstVolley + 1) * STEP}, phase ${phase}`);
});
