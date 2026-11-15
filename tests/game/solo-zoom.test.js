import test from 'node:test';
import assert from 'node:assert/strict';
import { SOLO_ZOOM_DEFAULTS, SOLO_ZOOM_RANGES, SoloZoomController, ZOOM_HYSTERESIS, zoomFit } from '../../src/game/solo-zoom.js';
import { ZOOM_DEFAULT_CROWD_REFERENCE } from '../../src/game/zoom-pressure.js';

const STEP = 1 / 60;
const VIEW = { viewWidth: 16, viewHeight: 9 };

function drive(controller, seconds, input, onStep = () => {}) {
  let zoom = controller.lastZoom;
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) {
    zoom = controller.update(STEP, { ...VIEW, swarmRadius: 0.5, ...input });
    onStep(zoom);
  }
  return zoom;
}

test('defaults are off and match the spec candidates', () => {
  assert.equal(SOLO_ZOOM_DEFAULTS.enabled, false);
  assert.equal(SOLO_ZOOM_DEFAULTS.maximum, 1.6);
  assert.equal(SOLO_ZOOM_DEFAULTS.minimum, 0.5);
  assert.ok(Math.abs(SOLO_ZOOM_DEFAULTS.punchIn - Math.log(1.4)) < 1e-12);
  assert.ok(Math.abs(SOLO_ZOOM_DEFAULTS.pullOut - Math.log(1 / 0.6)) < 1e-12);
  assert.deepEqual(SOLO_ZOOM_RANGES.crowdReference, [ZOOM_DEFAULT_CROWD_REFERENCE / 100, ZOOM_DEFAULT_CROWD_REFERENCE * 100]);
  assert.equal(new SoloZoomController().settings.enabled, false);
});

test('set validates', () => {
  const controller = new SoloZoomController();
  assert.throws(() => controller.set('maximum', 9), /maximum/);
  assert.throws(() => controller.set('bogus', 1), RangeError);
  assert.throws(() => controller.set('enabled', 1), RangeError);
  assert.throws(() => controller.set('maximum', Number.NaN), RangeError);
  controller.set('maximum', 1);
  assert.throws(() => controller.set('minimum', 1.0000001), RangeError);
  controller.set('minimum', 0.9);
  controller.set('enabled', true);
  assert.equal(controller.settings.minimum, 0.9);
  assert.equal(controller.settings.enabled, true);
  const copy = controller.settings;
  copy.minimum = 0.3;
  assert.equal(controller.settings.minimum, 0.9);
});

test('no pressure gives zoom 1', () => {
  const controller = new SoloZoomController();
  assert.equal(drive(controller, 5, { near: 0, far: 0, swarmRadius: 1 }), 1);
});

test('crowded punches in', () => {
  const controller = new SoloZoomController();
  const zoom = drive(controller, 10, { near: 1, far: 0 });
  assert.ok(Math.abs(zoom - Math.exp(SOLO_ZOOM_DEFAULTS.punchIn)) < 1e-3, `zoom ${zoom}`);
});

test('a negative punchIn pulls out when crowded', () => {
  const controller = new SoloZoomController();
  controller.set('punchIn', -0.5);
  const zoom = drive(controller, 10, { near: 1, far: 0 });
  assert.ok(Math.abs(zoom - Math.exp(-0.5)) < 1e-3, `zoom ${zoom}`);
});

test('far action pulls out only when quiet nearby', () => {
  const quiet = new SoloZoomController();
  assert.ok(Math.abs(drive(quiet, 15, { near: 0, far: 1 }) - Math.exp(-SOLO_ZOOM_DEFAULTS.pullOut)) < 1e-3);
  const crowded = new SoloZoomController();
  assert.ok(Math.abs(drive(crowded, 15, { near: 1, far: 1 }) - Math.exp(SOLO_ZOOM_DEFAULTS.punchIn)) < 1e-3);
});

test('rate limit', () => {
  const controller = new SoloZoomController();
  let previous = 0;
  drive(controller, 5, { near: 1, far: 0 }, (zoom) => {
    const logged = Math.log(zoom);
    assert.ok(Math.abs(logged - previous) <= SOLO_ZOOM_DEFAULTS.rateLimit * STEP + 1e-9);
    previous = logged;
  });
  assert.ok(previous > 0);
});

test('attack is faster than release', () => {
  const controller = new SoloZoomController();
  controller.set('rateLimit', 2);
  const attacked = drive(controller, 1, { near: 1, far: 0 });
  assert.ok(Math.log(attacked) > 0.9 * 0.9 * SOLO_ZOOM_DEFAULTS.punchIn, `attack ${attacked}`);
  const released = drive(controller, 1, { near: 0, far: 0 });
  assert.ok(Math.log(released) > 0.5 * SOLO_ZOOM_DEFAULTS.punchIn, `release ${released}`);
});

test('hysteresis', () => {
  const controller = new SoloZoomController();
  controller.set('punchIn', 0.03);
  assert.ok(0.03 < ZOOM_HYSTERESIS);
  assert.equal(drive(controller, 10, { near: 1, far: 0 }), 1);
});

test('fit cap', () => {
  const controller = new SoloZoomController();
  controller.set('punchIn', 1);
  const zoom = drive(controller, 10, { near: 1, far: 0, swarmRadius: 8 });
  assert.ok(zoomFit(8, 16, 9) < 0.5);
  assert.equal(zoom, 0.5);
  const roomy = new SoloZoomController();
  roomy.set('punchIn', 1);
  const capped = drive(roomy, 10, { near: 1, far: 0, swarmRadius: 2 });
  assert.ok(Math.abs(capped - zoomFit(2, 16, 9)) < 1e-9, `zoom ${capped} fit ${zoomFit(2, 16, 9)}`);
});

test('output stays inside [minimum, maximum]', () => {
  const controller = new SoloZoomController();
  controller.set('minimum', 0.6);
  controller.set('maximum', 1.4);
  controller.set('rateLimit', 2);
  controller.set('punchIn', 1);
  for (let index = 0; index < 200; index += 1) {
    const near = ((index * 37) % 11) / 10;
    const far = ((index * 53) % 7) / 6;
    const swarmRadius = ((index * 17) % 9) * 0.9;
    const zoom = controller.update(STEP * 10, { near, far, swarmRadius, ...VIEW });
    assert.ok(zoom >= 0.6 && zoom <= 1.4, `zoom ${zoom} at ${index}`);
  }
});

test('hold returns the last zoom and does not advance state', () => {
  const held = new SoloZoomController();
  const twin = new SoloZoomController();
  drive(held, 2, { near: 1, far: 0 });
  drive(twin, 2, { near: 1, far: 0 });
  const last = held.lastZoom;
  assert.equal(held.hold(), last);
  assert.equal(held.hold(), last);
  assert.equal(drive(held, 1, { near: 1, far: 0 }), drive(twin, 1, { near: 1, far: 0 }));
});

test('reset returns to 1', () => {
  const controller = new SoloZoomController();
  drive(controller, 5, { near: 1, far: 0 });
  assert.ok(controller.lastZoom > 1);
  controller.reset();
  assert.equal(controller.lastZoom, 1);
  assert.equal(controller.update(STEP, { near: 0, far: 0, swarmRadius: 1, ...VIEW }), 1);
});

test('the log target is clamped to the zoom limits so it cannot wind up', () => {
  const controller = new SoloZoomController();
  controller.set('punchIn', 1);
  controller.set('rateLimit', 0.05);
  const peak = drive(controller, 30, { near: 1, far: 0 });
  assert.ok(Math.abs(peak - SOLO_ZOOM_DEFAULTS.maximum) < 1e-9);
  // The pressure releases slowly (about 1.5 s until the wish is back under the maximum); a wound-up log
  // target at the slow rate limit would keep the zoom at the maximum for several seconds more.
  let updates = 0;
  let zoom = peak;
  while (zoom >= peak - 1e-9 && updates < 600) {
    zoom = drive(controller, STEP, { near: 0, far: 0 });
    updates += 1;
  }
  assert.ok(updates < 150, `fell after ${updates} updates`);
});

// Settle a controller at the top of its punch-in (log target at punchIn), then hold the near pressure
// at the value that puts the wish `dip` below that target.
function settledThenWish(dip, seconds = 30) {
  const controller = new SoloZoomController();
  drive(controller, 20, { near: 1, far: 0 });
  const settled = controller.lastZoom;
  const near = 1 - dip / SOLO_ZOOM_DEFAULTS.punchIn;
  drive(controller, seconds, { near, far: 0 });
  return { settled, final: controller.lastZoom };
}

test('a wish dip below the hysteresis against the direction of travel does not move the target', () => {
  const { settled, final } = settledThenWish(0.03);
  assert.equal(final, settled);
});

test('a real reversal of at least the hysteresis moves the target', () => {
  const { settled, final } = settledThenWish(0.05);
  assert.ok(final < settled);
  assert.ok(Math.abs(Math.log(final) - (SOLO_ZOOM_DEFAULTS.punchIn - 0.05)) < 1e-3, `zoom ${final}`);
});
