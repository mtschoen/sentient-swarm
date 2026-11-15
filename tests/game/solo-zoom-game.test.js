import test from 'node:test';
import assert from 'node:assert/strict';
import { bombRadiusForView } from '../../src/game/camera.js';
import { SOLO_ZOOM_RANGES } from '../../src/game/solo-zoom.js';
import { STEP, SWARM_WIPE_MASK, createGame, runFor, stats } from './game-harness.js';

const MINIMUM_REFERENCE = SOLO_ZOOM_RANGES.crowdReference[0];

// A started solo game; the density function and the knobs are set by the scenario.
async function startedGame({ enabled = true, density = () => 1 } = {}) {
  const harness = await createGame();
  const { game, simulation } = harness;
  simulation.densityFunction = density;
  if (enabled) {
    game.setSoloZoomSetting('enabled', true);
    game.setSoloZoomSetting('crowdReference', MINIMUM_REFERENCE);
  }
  game.start();
  game.update(STEP);
  return harness;
}

// Records the options of every camera update.
function spyCamera(game) {
  const calls = [];
  const original = game.camera.update.bind(game.camera);
  game.camera.update = (deltaSeconds, options) => { calls.push(options); return original(deltaSeconds, options); };
  return calls;
}

// Density only beyond six units from the first seat's focus, which is the far ring and not the near one.
function farOnly(game) {
  return (x, y) => {
    const focus = game.seats[0].cameraFocus;
    return Math.hypot(x - focus.x, y - focus.y) > 6 ? 1 : 0;
  };
}

test('the default game never leaves zoom 1 in solo, whatever the density', async () => {
  const { game } = await startedGame({ enabled: false, density: () => 1e9 });
  const calls = spyCamera(game);
  runFor(game, 10);
  assert.equal(game.camera.zoom, 1);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((options) => !('zoomMaximum' in options) && !('zoomMinimum' in options)));
});

test('enabled and crowded zooms in past 1', async () => {
  const { game } = await startedGame();
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.05 && game.camera.zoom <= 1.6, `zoom ${game.camera.zoom}`);
});

test('enabled with far action only zooms out', async () => {
  const harness = await startedGame({ density: () => 0 });
  const { game, simulation } = harness;
  simulation.densityFunction = farOnly(game);
  runFor(game, 10);
  assert.ok(game.camera.zoom < 0.95 && game.camera.zoom >= 0.5, `zoom ${game.camera.zoom}`);
});

test('reduced motion keeps zoom 1, and turning it off lets the zoom move again', async () => {
  const { game } = await startedGame();
  game.setReducedMotion(true);
  runFor(game, 10);
  assert.equal(game.camera.zoom, 1);
  game.setReducedMotion(false);
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.05);
});

test('two live seats ignore the knob', async () => {
  const run = async (enabled) => {
    const harness = await createGame();
    harness.simulation.densityFunction = () => 1;
    if (enabled) {
      harness.game.setSoloZoomSetting('enabled', true);
      harness.game.setSoloZoomSetting('crowdReference', MINIMUM_REFERENCE);
    }
    harness.game.setPlayerCount(2);
    harness.game.start();
    const calls = spyCamera(harness.game);
    const zooms = [];
    for (let index = 0; index < 300; index += 1) {
      harness.game.update(STEP);
      zooms.push(harness.game.camera.zoom);
    }
    return { zooms, calls };
  };
  const on = await run(true);
  const off = await run(false);
  assert.deepEqual(on.zooms, off.zooms);
  assert.ok(on.calls.every((options) => !('zoomMaximum' in options)));
});

test('a down seat hands over to the solo controller without a jump', async () => {
  const harness = await createGame();
  const { game, simulation } = harness;
  simulation.densityFunction = () => 1;
  game.setSoloZoomSetting('enabled', true);
  game.setSoloZoomSetting('crowdReference', MINIMUM_REFERENCE);
  game.setPlayerCount(2);
  game.start();
  runFor(game, 1);
  const before = game.camera.zoom;
  simulation.scriptedStats.push(stats({ frameSequence: simulation.frameSequence + 1, secondSwarmHitMask: SWARM_WIPE_MASK }));
  game.update(STEP);
  assert.equal(game.seats[1].down, true);
  game.update(STEP);
  assert.ok(Math.abs(game.camera.zoom - before) < 0.1);
  assert.ok(Math.abs(game.soloZoom.lastZoom - 1) < 0.01, `lastZoom ${game.soloZoom.lastZoom}`);
});

test('a bomb and an easing time warp hold the target instead of updating it', async () => {
  const { game, input } = await startedGame();
  runFor(game, 5);
  const calls = { update: 0, hold: 0 };
  const { update, hold } = game.soloZoom;
  game.soloZoom.update = (...args) => { calls.update += 1; return update.apply(game.soloZoom, args); };
  game.soloZoom.hold = (...args) => { calls.hold += 1; return hold.apply(game.soloZoom, args); };
  input.state.bomb = true;
  game.update(STEP);
  assert.deepEqual(calls, { update: 0, hold: 1 });
  input.state.bomb = false;
  game.update(STEP);
  assert.deepEqual(calls, { update: 1, hold: 1 });
  game.timeWarp.start();
  game.update(STEP);
  assert.deepEqual(calls, { update: 1, hold: 2 });
  runFor(game, 0.5);
  const holdsAfterRamp = calls.hold;
  game.update(STEP);
  assert.equal(calls.hold, holdsAfterRamp);
});

test('the start cut resets the controller', async () => {
  const { game } = await startedGame();
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.05);
  game.quitToTitle();
  assert.equal(game.camera.zoom, 1);
  assert.equal(game.soloZoom.lastZoom, 1);
  game.start();
  assert.equal(game.camera.zoom, 1);
  assert.equal(game.soloZoom.lastZoom, 1);
});

test('the bomb radius ignores the zoom', async () => {
  const { game, simulation, input } = await startedGame();
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.3);
  input.state.bomb = true;
  game.update(STEP);
  assert.equal(simulation.radialKills.at(-1).radius, bombRadiusForView(game.viewSize.width, game.viewSize.height));
});

test('the spawn ring view caps its zoom at 1', async () => {
  const harness = await startedGame();
  const { game, simulation } = harness;
  const views = [];
  const original = game.spawnDirector.update.bind(game.spawnDirector);
  game.spawnDirector.update = (deltaSeconds, options) => { views.push(options.view); return original(deltaSeconds, options); };
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.3);
  assert.equal(views.at(-1).width, game.viewSize.width);
  simulation.densityFunction = farOnly(game);
  runFor(game, 15);
  assert.ok(game.camera.zoom < 0.9);
  assert.ok(Math.abs(views.at(-1).width - game.viewSize.width / game.camera.zoom) < 1e-9);
});

test('setSoloZoomSetting rejects bad values', async () => {
  const { game } = await createGame();
  assert.throws(() => game.setSoloZoomSetting('maximum', 9), RangeError);
  assert.throws(() => game.setSoloZoomSetting('nonsense', 1), RangeError);
  assert.throws(() => game.setSoloZoomSetting('enabled', 1), RangeError);
});
