import test from 'node:test';
import assert from 'node:assert/strict';
import { BLINK_HERTZ, SHIP_TURN_RATE, SHIP_VIEW_BYTES, ShipRenderer, easeAngle, packShipView } from '../../src/render/ship.js';
import { WEAPON_HUES } from '../../src/game/weaponTypes.js';
import { Viewport } from '../../src/render/viewport.js';

// Only the buffer-usage constants and createBuffer are touched by the constructor.
globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8 };
const fakeGpu = { device: { createBuffer: () => ({}) } };
const viewport = new Viewport();
viewport.setCanvasSize(1600, 900);
const base = { viewport, time: 0.01, x: 8, y: 4.5, facing: 1, charge: 0.5, armed: 'rail', invulnerable: false };

test('easeAngle moves by at most the step along the shortest arc and lands on the target', () => {
  assert.equal(easeAngle(0, 1, 0.25), 0.25);
  assert.equal(easeAngle(0, -1, 0.25), -0.25);
  assert.equal(easeAngle(0, 0.1, 0.25), 0.1);
  // From just below pi to just above -pi the short way crosses the seam.
  assert.ok(easeAngle(3.0, -3.0, 0.1) > 3.0);
  assert.ok(Math.abs(easeAngle(-3.0, 3.0, 0.1) - (-3.1)) < 1e-9);
});

test('the rendered facing snaps once, then turns at the finite rate and ignores a stalled clock', () => {
  const ship = new ShipRenderer(fakeGpu, { viewport, common: '' });
  assert.equal(ship.easedFacing(0, 10), 0);
  const eased = ship.easedFacing(Math.PI, 10.05);
  assert.ok(Math.abs(Math.abs(eased) - SHIP_TURN_RATE * 0.05) < 1e-9);
  assert.equal(ship.easedFacing(Math.PI, 10.05), eased);
  assert.equal(ship.easedFacing(Math.PI, 9), eased);
  // A long hitch is capped, so a paused tab does not swing the ship in one frame.
  assert.ok(Math.abs(ship.easedFacing(-Math.PI / 2, 20) - eased) < SHIP_TURN_RATE * 0.1 + 1e-9);
});

test('packShipView fills the 64-byte ShipView layout with the armed hue and ring flag', () => {
  const view = packShipView(base);
  assert.equal(view.byteLength, SHIP_VIEW_BYTES);
  assert.deepEqual(Array.from(view.slice(8, 15)), Array.from(new Float32Array([8, 4.5, 1, 0.5, WEAPON_HUES.rail, 1, 1])));
});

test('the charge ring is hidden on the base gun and the charge is clamped', () => {
  const view = packShipView({ ...base, armed: 'base', charge: 3 });
  assert.equal(view[13], 0);
  assert.equal(view[11], 1);
});

test('an invulnerable ship blinks at 8 hertz', () => {
  const on = packShipView({ ...base, invulnerable: true, time: 0.25 / BLINK_HERTZ });
  const off = packShipView({ ...base, invulnerable: true, time: 0.75 / BLINK_HERTZ });
  assert.equal(on[14], 1);
  assert.ok(off[14] < 0.5);
  assert.equal(packShipView({ ...base, time: 0.75 / BLINK_HERTZ })[14], 1);
});
