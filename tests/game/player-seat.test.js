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
});
