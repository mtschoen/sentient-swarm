import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTILE_VIEW_BYTES, packProjectileView } from '../../src/render/projectiles.js';
import { MAXIMUM_PICKUPS, PICKUP_VIEW_BYTES, packPickupView } from '../../src/render/pickups.js';
import { PROJECTILE_KINDS, WEAPON_HUES, WEAPON_TYPE_NAMES } from '../../src/game/weaponTypes.js';
import { Viewport } from '../../src/render/viewport.js';
import { WORLD_BOUNDS } from '../../src/sim/layout.js';
import { SWARM_VIEW_BYTES, packSwarmView } from '../../src/render/swarm.js';
import { SWARM_SHIP_SIZE } from '../../src/game/player-swarm.js';

const viewport = new Viewport();
viewport.setCanvasSize(1600, 900);

test('packSwarmView writes the header and one vec4 per ship, capped at the swarm maximum', () => {
  const ships = Array.from({ length: 300 }, (_, index) => ({ x: index, y: 1, age: 0.5, heading: 0.75 }));
  const { floats, count } = packSwarmView({ viewport, time: 1, ships, facing: 0.25, pointX: 8, pointY: 4.5, pointShown: true, armed: 'pulse' });
  assert.equal(count, 256);
  assert.equal(floats.byteLength, SWARM_VIEW_BYTES);
  assert.deepEqual(Array.from(floats.slice(8, 20)), [0.25, 8, 4.5, 1, Math.fround(WEAPON_HUES.pulse), 256, Math.fround(SWARM_SHIP_SIZE), 0, 1, 1, 1, 0]);
  assert.deepEqual(Array.from(floats.slice(20 + 4 * 255, 20 + 4 * 256)), [255, 1, 0.5, 0.75]);
});

test('every weapon has a distinct hue', () => {
  const names = ['base', ...WEAPON_TYPE_NAMES];
  assert.deepEqual(Object.keys(WEAPON_HUES).sort(), [...names].sort());
  assert.equal(new Set(Object.values(WEAPON_HUES)).size, names.length);
});

test('packProjectileView puts one weapon hue per projectile kind after the world view', () => {
  const view = packProjectileView({ viewport, time: 2, worldBounds: WORLD_BOUNDS });
  assert.equal(view.byteLength, PROJECTILE_VIEW_BYTES);
  assert.equal(view[6], 2);
  const hueOf = (kind) => view[8 + kind];
  const hue = (weapon) => Math.fround(WEAPON_HUES[weapon]);
  assert.equal(hueOf(PROJECTILE_KINDS.bullet), hue('base'));
  assert.equal(hueOf(PROJECTILE_KINDS.pulseOrb), hue('pulse'));
  assert.equal(hueOf(PROJECTILE_KINDS.pulseRing), hue('pulse'));
  assert.equal(hueOf(PROJECTILE_KINDS.sidewinder), hue('sidewinders'));
  assert.equal(hueOf(PROJECTILE_KINDS.beam), hue('beam'));
});

test('packProjectileView ends with the world bounds it is given', () => {
  const tall = new Viewport();
  tall.setCanvasSize(900, 1600);
  const bounds = { minX: 1, minY: 2, maxX: 7, maxY: 8 };
  const view = packProjectileView({ viewport: tall, time: 0, worldBounds: bounds });
  assert.deepEqual(Array.from(view.slice(16, 20)), Array.from(new Float32Array([bounds.minX, bounds.minY, bounds.maxX, bounds.maxY])));
  assert.deepEqual(Array.from(packProjectileView({ viewport, time: 0, worldBounds: WORLD_BOUNDS }).slice(16, 20)), [0, 0, WORLD_BOUNDS.maxX, WORLD_BOUNDS.maxY]);
});

test('packPickupView packs x, y, hue and fade per pickup and caps at 32', () => {
  const pickups = [{ x: 3, y: 4, type: 'scatter', fade: 0.5 }, { x: 5, y: 6, type: 'beam', fade: 1 }];
  const { floats, count } = packPickupView({ viewport, time: 1, pickups });
  assert.equal(floats.byteLength, PICKUP_VIEW_BYTES);
  assert.equal(count, 2);
  assert.deepEqual(Array.from(floats.slice(8, 12)), Array.from(new Float32Array([3, 4, WEAPON_HUES.scatter, 0.5])));
  assert.deepEqual(Array.from(floats.slice(12, 16)), Array.from(new Float32Array([5, 6, WEAPON_HUES.beam, 1])));
  const many = Array.from({ length: 40 }, () => ({ x: 1, y: 1, type: 'rail', fade: 1 }));
  assert.equal(packPickupView({ viewport, time: 0, pickups: many }).count, MAXIMUM_PICKUPS);
});

// Owner ruling R31: the time warp pickup has its own hue, and the hue slot carries the clock shape
// flag (1 added) so the shader draws a clock in place of the hexagon.
test('a time warp pickup packs its cold hue plus the clock shape flag', async () => {
  const { PICKUP_HUES, PICKUP_SHAPE_CLOCK } = await import('../../src/game/weaponTypes.js');
  assert.ok(PICKUP_HUES.timewarp > 0 && PICKUP_HUES.timewarp < 1);
  assert.equal(PICKUP_SHAPE_CLOCK, 1);
  const { floats } = packPickupView({ viewport, time: 0, pickups: [{ x: 1, y: 2, type: 'timewarp', fade: 1 }, { x: 1, y: 2, type: 'rail', fade: 1 }] });
  assert.equal(floats[10], Math.fround(PICKUP_HUES.timewarp + PICKUP_SHAPE_CLOCK));
  assert.equal(floats[14], Math.fround(WEAPON_HUES.rail));
});
