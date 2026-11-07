import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECTILE_VIEW_BYTES, packProjectileView } from '../../src/render/projectiles.js';
import { MAXIMUM_PICKUPS, PICKUP_VIEW_BYTES, packPickupView } from '../../src/render/pickups.js';
import { PROJECTILE_KINDS, WEAPON_HUES, WEAPON_TYPE_NAMES } from '../../src/game/weaponTypes.js';
import { Viewport } from '../../src/render/viewport.js';

const viewport = new Viewport();
viewport.setCanvasSize(1600, 900);

test('every weapon has a distinct hue', () => {
  const names = ['base', ...WEAPON_TYPE_NAMES];
  assert.deepEqual(Object.keys(WEAPON_HUES).sort(), [...names].sort());
  assert.equal(new Set(Object.values(WEAPON_HUES)).size, names.length);
});

test('packProjectileView puts one weapon hue per projectile kind after the world view', () => {
  const view = packProjectileView({ viewport, time: 2 });
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
