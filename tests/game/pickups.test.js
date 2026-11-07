import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PickupDirector } from '../../src/game/pickups.js';

const STEP = 1 / 60;
const WIDTH = 16;
const HEIGHT = 9;

function sequenceRandom() {
  let state = 0.1234;
  return () => {
    state = (state * 9301 + 0.49297) % 1;
    return state;
  };
}

function makeDirector() {
  return new PickupDirector({ arenaWidth: WIDTH, arenaHeight: HEIGHT, random: sequenceRandom() });
}

function run(director, seconds, context) {
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) {
    director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: true, milestone: false, phasePlaying: true, ...context });
  }
}

test('no pickup before 10 s on base gun, one at 10 s, another at 20 s', () => {
  const director = makeDirector();
  run(director, 9.9);
  assert.equal(director.pickups.length, 0);
  run(director, 0.2);
  assert.equal(director.pickups.length, 1);
  const [first] = director.pickups;
  assert.equal(director.collect(first.x, first.y), 'beam');
  run(director, 9.7);
  assert.equal(director.pickups.length, 0);
  run(director, 0.2);
  assert.equal(director.pickups.length, 1);
});

test('pity timer restarts when the player holds an upgrade', () => {
  const director = makeDirector();
  run(director, 9);
  run(director, 1, { onBaseGun: false });
  run(director, 9);
  assert.equal(director.pickups.length, 0);
});

test('timers do not advance outside the playing phase', () => {
  const director = makeDirector();
  run(director, 30, { phasePlaying: false });
  assert.equal(director.pickups.length, 0);
  assert.equal(director.offeredType, 'beam');
});

test('a milestone spawns immediately', () => {
  const director = makeDirector();
  director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true });
  assert.equal(director.pickups.length, 1);
  assert.equal(director.pickups[0].type, 'beam');
});

test('offered type rotates every 20 s', () => {
  const director = makeDirector();
  assert.equal(director.offeredType, 'beam');
  run(director, 20.1, { onBaseGun: false });
  assert.equal(director.offeredType, 'scatter');
  run(director, 20, { onBaseGun: false });
  assert.equal(director.offeredType, 'rail');
});

test('placement stays within [3, 5] of the player and inside the arena at a corner', () => {
  const director = makeDirector();
  for (let index = 0; index < 50; index += 1) {
    director.update(STEP, { playerX: 0, playerY: 0, onBaseGun: false, milestone: true, phasePlaying: true });
  }
  assert.equal(director.pickups.length, 50);
  for (const pickup of director.pickups) {
    const distance = Math.hypot(pickup.x, pickup.y);
    assert.ok(distance >= 3 - 1e-9 && distance <= 5 + 1e-9, `distance ${distance}`);
    assert.ok(pickup.x >= 0 && pickup.x <= WIDTH && pickup.y >= 0 && pickup.y <= HEIGHT);
  }
});

test('placement falls back to clamping when random never finds a valid angle', () => {
  const director = new PickupDirector({ arenaWidth: WIDTH, arenaHeight: HEIGHT, random: () => 0.75 });
  director.update(STEP, { playerX: 0, playerY: 0, onBaseGun: false, milestone: true, phasePlaying: true });
  const [pickup] = director.pickups;
  assert.ok(pickup.x >= 0 && pickup.x <= WIDTH && pickup.y >= 0 && pickup.y <= HEIGHT);
});

test('pickups fade and vanish after 10 s', () => {
  const director = makeDirector();
  director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true });
  run(director, 5, { onBaseGun: false });
  const [pickup] = director.pickups;
  assert.ok(Math.abs(pickup.fade - 0.5) < 0.02);
  run(director, 5.1, { onBaseGun: false });
  assert.equal(director.pickups.length, 0);
});

test('collect returns the type and removes the nearest pickup within radius', () => {
  const director = makeDirector();
  director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true });
  const [pickup] = director.pickups;
  assert.equal(director.collect(pickup.x + 2, pickup.y), null);
  assert.equal(director.pickups.length, 1);
  assert.equal(director.collect(pickup.x + 0.2, pickup.y), 'beam');
  assert.equal(director.pickups.length, 0);
  assert.equal(director.collect(pickup.x, pickup.y), null);
});

test('reset clears pickups, timers and rotation', () => {
  const director = makeDirector();
  run(director, 25);
  director.reset();
  assert.equal(director.pickups.length, 0);
  assert.equal(director.offeredType, 'beam');
  run(director, 9.9);
  assert.equal(director.pickups.length, 0);
});
