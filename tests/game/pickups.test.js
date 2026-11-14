import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PickupDirector } from '../../src/game/pickups.js';
import { centeredViewBounds } from '../sim/centered-view-bounds.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

const STEP = 1 / 60;
const WIDTH = WORLD_WIDTH;
const HEIGHT = WORLD_HEIGHT;

function sequenceRandom() {
  let state = 0.1234;
  return () => {
    state = (state * 9301 + 0.49297) % 1;
    return state;
  };
}

function makeDirector() {
  return new PickupDirector({ random: sequenceRandom() });
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
  const director = new PickupDirector({ random: () => 0.75 });
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

test('with densityAt, a spawn takes the lowest-density of up to 8 in-arena candidates', () => {
  const sampled = [];
  const densityAt = (x, y) => { sampled.push([x, y]); return x; };
  const director = makeDirector();
  director.spawn(8, 4.5, densityAt);
  assert.equal(sampled.length, 8);
  const [pickup] = director.pickups;
  assert.equal(pickup.x, Math.min(...sampled.map(([x]) => x)));
  for (const [x, y] of sampled) {
    assert.ok(x >= 0 && x <= WIDTH && y >= 0 && y <= HEIGHT);
  }
});

test('density placement keeps the distance band and is deterministic under the injected random', () => {
  const place = () => {
    const director = makeDirector();
    director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true, densityAt: (x, y) => x * 3 + y });
    return director.pickups[0];
  };
  const first = place();
  assert.deepEqual(place(), first);
  const distance = Math.hypot(first.x - 8, first.y - 4.5);
  assert.ok(distance >= 3 - 1e-9 && distance <= 5 + 1e-9, String(distance));
});

test('density placement avoids a dense half of the arena', () => {
  const director = makeDirector();
  for (let index = 0; index < 20; index += 1) {
    director.spawn(8, 4.5, (x) => (x > 8 ? 100 : 0));
  }
  assert.ok(director.pickups.every((pickup) => pickup.x <= 8));
});

test('densityAt falls back to the 16-attempt clamp when every candidate is outside the arena', () => {
  const director = new PickupDirector({ bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, width: 1, height: 1 }, minimumDistance: 50, maximumDistance: 60, random: sequenceRandom() });
  let calls = 0;
  director.spawn(0.5, 0.5, () => { calls += 1; return 0; });
  assert.equal(calls, 0);
  const [pickup] = director.pickups;
  assert.ok(pickup.x >= 0 && pickup.x <= 1 && pickup.y >= 0 && pickup.y <= 1);
});

test('without densityAt the first valid candidate wins, as before', () => {
  const plain = makeDirector();
  plain.spawn(8, 4.5);
  const withBias = makeDirector();
  withBias.spawn(8, 4.5, () => 0);
  assert.deepEqual(withBias.pickups[0], plain.pickups[0]);
});

// Owner ruling R31: the time warp joins the rotation after the weapons, one slot in six.
test('the rotation offers the weapons in their order, then timewarp, one slot in six', async () => {
  const { PICKUP_TYPE_NAMES, WEAPON_TYPE_NAMES } = await import('../../src/game/weaponTypes.js');
  assert.deepEqual(PICKUP_TYPE_NAMES, [...WEAPON_TYPE_NAMES, 'timewarp']);
  const director = makeDirector();
  const offered = [director.offeredType];
  for (let slot = 1; slot < 12; slot += 1) {
    run(director, 20, { onBaseGun: false });
    offered.push(director.offeredType);
  }
  assert.deepEqual(offered, [...PICKUP_TYPE_NAMES, ...PICKUP_TYPE_NAMES]);
  assert.equal(offered.filter((type) => type === 'timewarp').length, 2);
  director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true });
  assert.equal(director.pickups.at(-1).type, 'timewarp', 'a time warp slot spawns a time warp pickup');
});

// Review fix round 1: the recovery guard always offers a weapon; the rotation is unchanged.
test('a pity spawn on the time warp slot offers the next weapon instead; a milestone still offers the time warp', () => {
  const director = makeDirector();
  run(director, 5 * 20 + 0.1, { onBaseGun: false });
  assert.equal(director.offeredType, 'timewarp');
  run(director, 10, { onBaseGun: true });
  assert.equal(director.pickups.length, 1);
  assert.equal(director.pickups[0].type, 'beam', 'the pity spawn skips the time warp slot');
  assert.equal(director.offeredType, 'timewarp', 'the rotation index is unchanged');
  director.update(STEP, { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: true, phasePlaying: true });
  assert.equal(director.pickups.at(-1).type, 'timewarp');
});

test('rotationSeconds at or below zero throws', () => {
  assert.throws(() => new PickupDirector({ rotationSeconds: 0 }), /rotationSeconds/);
  assert.throws(() => new PickupDirector({ rotationSeconds: -5 }), /rotationSeconds/);
});

test('fallback placement keeps the minimum distance from a corner player', () => {
  const director = new PickupDirector({ random: () => 0 });
  // random 0: angle 0, so every attempt lands at playerX + minimumDistance, outside the arena.
  director.spawn(WIDTH - 0.5, 0.5);
  const [pickup] = director.pickups;
  assert.equal(pickup.x >= 0 && pickup.x <= WIDTH && pickup.y >= 0 && pickup.y <= HEIGHT, true);
  const distance = Math.hypot(pickup.x - (WIDTH - 0.5), pickup.y - 0.5);
  assert.equal(distance >= director.minimumDistance - 1e-9, true);
});

const FAR_FROM_EVERYTHING = { playerX: 8, playerY: 4.5, onBaseGun: false, milestone: false };

test('pickups, the rotation and the pity timer are frozen outside play', () => {
  const director = makeDirector();
  director.update(STEP, { ...FAR_FROM_EVERYTHING, milestone: true, phasePlaying: true });
  run(director, 3, { onBaseGun: true });
  const before = JSON.parse(JSON.stringify({ pickups: director.pickups, index: director.rotationIndex, rotation: director.rotationTimer, pity: director.pityTimer }));
  assert.ok(before.pickups[0].age > 2.9 && before.pickups[0].age < 3.1);
  for (let step = 0; step < 60 * 40; step += 1) director.update(STEP, { ...FAR_FROM_EVERYTHING, onBaseGun: true, milestone: true, phasePlaying: false });
  const after = JSON.parse(JSON.stringify({ pickups: director.pickups, index: director.rotationIndex, rotation: director.rotationTimer, pity: director.pityTimer }));
  assert.deepEqual(after, before);
});

test('a milestone spawn restarts the pity timer', () => {
  const director = new PickupDirector({ random: sequenceRandom(), fadeSeconds: 100 });
  run(director, 9);
  director.update(STEP, { ...FAR_FROM_EVERYTHING, onBaseGun: true, milestone: true, phasePlaying: true });
  assert.equal(director.pickups.length, 1);
  assert.equal(director.pityTimer, 0);
  // Without the restart the pity guard would fire about a second later.
  run(director, 5, { onBaseGun: true });
  assert.equal(director.pickups.length, 1);
  run(director, 5.2, { onBaseGun: true });
  assert.equal(director.pickups.length, 2);
});

test('collect takes the nearer of two pickups in reach, whichever order they were spawned in', () => {
  for (const nearerFirst of [true, false]) {
    const director = makeDirector();
    const near = { x: 5.1, y: 5, type: 'rail', age: 0, fade: 1 };
    const far = { x: 5.3, y: 5, type: 'pulse', age: 0, fade: 1 };
    director.pickups.push(...(nearerFirst ? [near, far] : [far, near]));
    assert.equal(director.collect(5, 5), 'rail');
    assert.deepEqual(director.pickups.map((pickup) => pickup.type), ['pulse']);
    assert.equal(director.collect(5, 5), 'pulse');
    assert.equal(director.collect(5, 5), null);
  }
});

test('the rotation moving on does not retype a pickup already on the field', () => {
  const director = new PickupDirector({ random: sequenceRandom(), fadeSeconds: 100 });
  director.update(STEP, { ...FAR_FROM_EVERYTHING, milestone: true, phasePlaying: true });
  assert.equal(director.pickups[0].type, 'beam');
  run(director, 20, FAR_FROM_EVERYTHING);
  assert.equal(director.offeredType, 'scatter');
  director.update(STEP, { ...FAR_FROM_EVERYTHING, milestone: true, phasePlaying: true });
  assert.deepEqual(director.pickups.map((pickup) => pickup.type), ['beam', 'scatter']);
  run(director, 20, FAR_FROM_EVERYTHING);
  assert.deepEqual(director.pickups.map((pickup) => pickup.type), ['beam', 'scatter']);
});

test('pickups spawn inside narrow bounds, and setBounds changes where they may land', () => {
  const bounds = centeredViewBounds(1);
  const director = new PickupDirector({ bounds, random: sequenceRandom() });
  for (let index = 0; index < 40; index += 1) director.spawn(8, 4.5);
  assert.ok(director.pickups.every((pickup) => pickup.x >= bounds.minX && pickup.x <= bounds.maxX && pickup.y >= bounds.minY && pickup.y <= bounds.maxY));
  const wider = new PickupDirector({ random: sequenceRandom() });
  wider.setBounds(bounds);
  assert.equal(wider.bounds, bounds);
});

test('the fallback placement steps toward the bounds center and clamps to the bounds edges', () => {
  const bounds = { minX: 4, minY: 2, maxX: 6, maxY: 4, width: 2, height: 2 };
  const director = new PickupDirector({ bounds, minimumDistance: 50, maximumDistance: 60, random: sequenceRandom() });
  director.spawn(4.2, 2.2);
  const [pickup] = director.pickups;
  assert.ok(pickup.x >= 4 && pickup.x <= 6 && pickup.y >= 2 && pickup.y <= 4);
  assert.deepEqual({ x: pickup.x, y: pickup.y }, { x: 6, y: 4 });
});

test('pickups land within reach: on the 3 to 5 annulus and inside a view-sized rectangle around the player', () => {
  const director = new PickupDirector({ random: sequenceRandom() });
  const player = { x: 20, y: 6 };
  for (let index = 0; index < 60; index += 1) director.spawn(player.x, player.y);
  for (const pickup of director.pickups) {
    const distance = Math.hypot(pickup.x - player.x, pickup.y - player.y);
    assert.ok(distance >= 3 - 1e-9 && distance <= 5 + 1e-9, `distance ${distance}`);
    assert.ok(Math.abs(pickup.y - player.y) <= 4.5 + 1e-9, `y ${pickup.y}`);
  }
});

test('setView scales the annulus by the view half-diagonal and narrows the placement rectangle', () => {
  const director = new PickupDirector({ random: sequenceRandom() });
  director.setView(9, 9);
  const scale = Math.hypot(9, 9) / Math.hypot(16, 9);
  assert.ok(Math.abs(director.minimumDistance - 3 * scale) < 1e-9);
  assert.ok(Math.abs(director.maximumDistance - 5 * scale) < 1e-9);
  for (let index = 0; index < 60; index += 1) director.spawn(16, 9);
  for (const pickup of director.pickups) {
    assert.ok(Math.abs(pickup.x - 16) <= 4.5 + 1e-9 && Math.abs(pickup.y - 9) <= 4.5 + 1e-9, `(${pickup.x}, ${pickup.y})`);
  }
  director.setView(16, 9);
  assert.equal(director.minimumDistance, 3);
  assert.equal(director.maximumDistance, 5);
});
