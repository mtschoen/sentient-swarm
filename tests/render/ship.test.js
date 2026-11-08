import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLINK_HERTZ, SHIP_SHADER_CONSTANTS, SHIP_TURN_RATE, SHIP_VIEW_BYTES, ShipRenderer, easeAngle, packShipView } from '../../src/render/ship.js';
import { MAXIMUM_RAIL_TURRETS, RAIL_TURRET_SPACING_RADIANS, WEAPON_HUES } from '../../src/game/weaponTypes.js';
import { substituteConstants } from '../../src/gpu/shaders.js';
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

test('packShipView fills the 80-byte ShipView layout with the armed hue and ring flag', () => {
  const view = packShipView(base);
  assert.equal(SHIP_VIEW_BYTES, 80);
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

test('the drawn thrust depends on velocity, not on how often it is sampled', () => {
  const sample = (frameSeconds) => {
    const ship = new ShipRenderer(fakeGpu, { viewport, common: '' });
    let thrust = 0;
    for (let frame = 0; frame < Math.round(1 / frameSeconds); frame += 1) thrust = ship.easedThrust(6, 0, frameSeconds);
    return thrust;
  };
  assert.ok(Math.abs(sample(1 / 60) - sample(1 / 144)) < 0.01);
  assert.ok(sample(1 / 144) > 0.99);
  const idle = new ShipRenderer(fakeGpu, { viewport, common: '' });
  assert.equal(idle.easedThrust(0, 0, 1 / 144), 0);
});

// Owner ruling R29: the rail turrets draw as ticks on the charge ring around the drawn facing.
test('packShipView packs the turret count after the facing it rotates with, clamped to the cap', () => {
  const view = packShipView({ ...base, railTurrets: 4 });
  assert.equal(view[10], 1, 'the facing the ticks rotate with');
  assert.deepEqual(Array.from(view.slice(16, 20)), [4, 0, 0, 0]);
  assert.equal(packShipView(base)[16], 0);
  assert.equal(packShipView({ ...base, railTurrets: 40 })[16], MAXIMUM_RAIL_TURRETS);
});

test('ship.wgsl takes the turret spacing, cap and rail hue from the game tables', () => {
  const source = readFileSync(new URL('../../src/render/shaders/ship.wgsl', import.meta.url), 'utf8');
  assert.match(source, /__RAIL_TURRET_SPACING_RADIANS__/);
  assert.deepEqual(SHIP_SHADER_CONSTANTS, {
    RAIL_TURRET_SPACING_RADIANS: RAIL_TURRET_SPACING_RADIANS,
    MAXIMUM_RAIL_TURRETS: MAXIMUM_RAIL_TURRETS,
    RAIL_HUE: WEAPON_HUES.rail,
  });
  assert.doesNotThrow(() => substituteConstants(source, SHIP_SHADER_CONSTANTS));
});

test('mid-turn the drawn facing lags the aim at the finite rate, follows a changing aim and then lands', () => {
  const ship = new ShipRenderer(fakeGpu, { viewport, common: '' });
  const frame = 1 / 60;
  let time = 0;
  assert.equal(ship.easedFacing(0, time), 0);
  // Half a turn away: after 6 frames the ship has turned 6 steps and is still short of the aim.
  let previous = 0;
  for (let index = 0; index < 6; index += 1) {
    time += frame;
    const drawn = ship.easedFacing(Math.PI, time);
    assert.ok(Math.abs(drawn - previous - SHIP_TURN_RATE * frame) < 1e-9, `step ${index}`);
    previous = drawn;
  }
  assert.ok(Math.PI - previous > 1, `lag ${Math.PI - previous}`);
  // The aim swings back across the ship mid-turn: the drawn facing reverses without a snap.
  time += frame;
  const reversed = ship.easedFacing(-1, time);
  assert.ok(Math.abs(reversed - (previous - SHIP_TURN_RATE * frame)) < 1e-9);
  // A steady aim is reached in a bounded number of frames and then stays put.
  let frames = 0;
  while (ship.renderedFacing !== -1 && frames < 600) {
    time += frame;
    ship.easedFacing(-1, time);
    frames += 1;
  }
  assert.equal(ship.renderedFacing, -1);
  assert.ok(frames <= Math.ceil((reversed + 1) / (SHIP_TURN_RATE * frame)) + 1, `frames ${frames}`);
  time += frame;
  assert.equal(ship.easedFacing(-1, time), -1);
});
