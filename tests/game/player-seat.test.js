import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerSeat, SWARM_PICKUP_RADIUS } from '../../src/game/player-seat.js';
import { PickupDirector } from '../../src/game/pickups.js';
import { InputState } from '../../src/input/input.js';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../../src/sim/layout.js';

test('reset puts the point at the bounds center, or at start, with the given ships', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(12);
  assert.deepEqual(seat.point, { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 });
  assert.equal(seat.aliveCount, 12);
  seat.reset(5, { x: 3, y: 4 });
  assert.deepEqual(seat.point, { x: 3, y: 4 });
  assert.equal(seat.aliveCount, 5);
  assert.equal(seat.down, false);
});

test('controlsFrom aims from the point to the pointer unless the stick aims', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(12);
  const inputState = new InputState();
  inputState.pointerWorld = { x: seat.point.x + 1, y: seat.point.y };
  assert.deepEqual(seat.controlsFrom(inputState).aim, { x: 1, y: 0 });
  inputState.aim = { x: 0, y: 1 };
  assert.deepEqual(seat.controlsFrom(inputState).aim, { x: 0, y: 1 });
});

test('collectPickup takes a pickup at the point first, else at a ship within SWARM_PICKUP_RADIUS', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(12);
  const pickups = new PickupDirector({ random: () => 0.5 });
  assert.equal(seat.collectPickup(pickups), null);
  const { x, y } = seat.point;
  pickups.pickups.push({ x, y, type: 'scatter', age: 0, fade: 1 });
  assert.equal(seat.collectPickup(pickups), 'scatter');
  assert.equal(pickups.pickups.length, 0);
  const ship = seat.swarm.ships[0];
  pickups.pickups.push({ x: ship.x + SWARM_PICKUP_RADIUS / 2, y: ship.y, type: 'pulse', age: 0, fade: 1 });
  assert.equal(seat.collectPickup(pickups), 'pulse');
  assert.equal(pickups.pickups.length, 0);
});

test('fire reports the kind and tier fired and queues nothing while not playing', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(12);
  seat.weapons.collect('scatter');
  seat.weapons.collect('scatter');
  const idle = seat.fire(1 / 60, { playing: false, firing: true });
  assert.equal(idle.kind, 'scatter');
  assert.equal(idle.tier, 2);
  assert.equal(idle.shots.spawns.length, 0);
  const playing = seat.fire(1 / 60, { playing: true, firing: true });
  assert.equal(playing.kind, 'scatter');
  assert.equal(playing.tier, 2);
  let spawned = 0;
  for (let step = 0; step < 120; step += 1) {
    seat.flock(1 / 60, true);
    spawned += seat.fire(1 / 60, { playing: true, firing: true }).shots.spawns.length;
  }
  assert.ok(spawned > 0, `ships in the cone fired ${spawned} shots`);
});

test('controlsFrom gives no aim for a pointer on the point, and fires on the button or the primary pointer', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(12);
  const inputState = new InputState();
  inputState.pointerWorld = { ...seat.point };
  assert.deepEqual(seat.controlsFrom(inputState).aim, { x: 0, y: 0 });
  assert.equal(seat.controlsFrom(inputState).firing, false);
  inputState.pointerPrimaryDown = true;
  assert.equal(seat.controlsFrom(inputState).firing, true);
  inputState.pointerPrimaryDown = false;
  inputState.firing = true;
  assert.equal(seat.controlsFrom(inputState).firing, true);
});

test('firingEdge and bombEdge are true once per rising input', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  const inputState = new InputState();
  assert.equal(seat.firingEdge(inputState), false);
  inputState.firing = true;
  inputState.bomb = true;
  assert.equal(seat.firingEdge(inputState), true);
  assert.equal(seat.firingEdge(inputState), false);
  assert.equal(seat.bombEdge(inputState), true);
  assert.equal(seat.bombEdge(inputState), false);
  inputState.bomb = false;
  assert.equal(seat.bombEdge(inputState), false);
  assert.equal(seat.bombHeld, false);
});

test('hudFields and cameraFocus read the point, swarm and weapon', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(7, { x: 3, y: 4 });
  seat.weapons.collect('pulse');
  const fields = seat.hudFields();
  assert.equal(fields.lives, 7);
  assert.equal(fields.armed, 'pulse');
  assert.equal(fields.tier, 1);
  assert.equal(fields.playerX, 3);
  assert.equal(fields.playerY, 4);
  const focus = seat.cameraFocus;
  assert.ok(Math.abs(focus.x - 3) < 1 && Math.abs(focus.y - 4) < 1);
});

test('sceneEntry extrapolates the point and names the armed weapon', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(5, { x: 3, y: 4 });
  const entry = seat.sceneEntry(0, 1 / 60, true);
  assert.equal(entry.pointX, 3);
  assert.equal(entry.pointY, 4);
  assert.equal(entry.pointShown, true);
  assert.equal(entry.armed, 'base');
  assert.equal(entry.ships.length, 5);
});

test('applyHits reports the killed ships and wiped only when the last one dies', () => {
  const seat = new PlayerSeat({ random: () => 0.5 });
  seat.reset(3);
  const slots = seat.swarm.contactShips(1).map((ship, index) => (ship.alive ? index : -1)).filter((index) => index >= 0);
  const some = new Uint32Array(8);
  some[Math.floor(slots[0] / 32)] |= 1 << (slots[0] % 32);
  const first = seat.applyHits({ swarmHitMask: some, frameSequence: 2 });
  assert.equal(first.killed.length, 1);
  assert.equal(first.wiped, false);
  assert.equal(first.last, null);
  const all = new Uint32Array(8).fill(0xffffffff);
  const second = seat.applyHits({ swarmHitMask: all, frameSequence: 3 });
  assert.equal(second.killed.length, 2);
  assert.equal(second.wiped, true);
  assert.equal(second.last, second.killed[1]);
  assert.deepEqual(seat.applyHits({ frameSequence: 4 }), { killed: [], last: null, wiped: false });
});
