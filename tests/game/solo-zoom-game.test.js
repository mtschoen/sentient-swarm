import test from 'node:test';
import assert from 'node:assert/strict';
import { bombRadiusForView } from '../../src/game/camera.js';
import { SOLO_ZOOM_RANGES } from '../../src/game/solo-zoom.js';
import { SOLO_ZOOM_BOMB_HOLD_SECONDS } from '../../src/game/solo-zoom-step.js';
import { STEP, SWARM_WIPE_MASK, createGame, hitNow, runFor, stats } from './game-harness.js';

const MINIMUM_REFERENCE = SOLO_ZOOM_RANGES.crowdReference[0];

// The shipped defaults are calm (owner ruling 2026-11-15); scenarios that need a quick, deep punch-in set it.
function strongZoom(game) {
  game.setSoloZoomSetting('enabled', true);
  game.setSoloZoomSetting('crowdReference', MINIMUM_REFERENCE);
  game.setSoloZoomSetting('maximum', 2.5);
  game.setSoloZoomSetting('punchIn', 1);
  game.setSoloZoomSetting('rateLimit', 2);
  game.setSoloZoomSetting('smoothSeconds', 0.2);
}

// A started solo game; the density function and the knobs are set by the scenario.
async function startedGame({ enabled = true, density = () => 1 } = {}) {
  const harness = await createGame();
  const { game, simulation } = harness;
  simulation.densityFunction = density;
  game.setSoloZoomSetting('enabled', enabled);
  if (enabled) strongZoom(game);
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

test('a fresh game has the solo zoom on, and a crowded default solo game zooms in', async () => {
  const harness = await createGame();
  assert.equal(harness.game.soloZoom.settings.enabled, true);
  harness.simulation.densityFunction = () => 1e9;
  harness.game.start();
  runFor(harness.game, 30);
  assert.ok(harness.game.camera.zoom > 1.2 && harness.game.camera.zoom <= 1.3, `zoom ${harness.game.camera.zoom}`);
});

test('with the solo zoom turned off the game never leaves zoom 1 in solo, whatever the density', async () => {
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
  assert.ok(game.camera.zoom > 1.05 && game.camera.zoom <= 2.5, `zoom ${game.camera.zoom}`);
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
      strongZoom(harness.game);
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
  strongZoom(game);
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

function countCalls(game) {
  const calls = { update: 0, hold: 0 };
  const { update, hold } = game.soloZoom;
  game.soloZoom.update = (...args) => { calls.update += 1; return update.apply(game.soloZoom, args); };
  game.soloZoom.hold = (...args) => { calls.hold += 1; return hold.apply(game.soloZoom, args); };
  return calls;
}

test('a bomb holds the target for a window of game time, then the zoom is free', async () => {
  const { game, simulation, input } = await startedGame();
  runFor(game, 10);
  // The camera spring still closes in on the held target, so the target is what must not move.
  const zoomed = game.soloZoom.lastZoom;
  assert.ok(zoomed > 1.3);
  const calls = countCalls(game);
  input.state.bomb = true;
  game.update(STEP);
  input.state.bomb = false;
  assert.deepEqual(calls, { update: 0, hold: 1 });
  // The clear shows in the density map a few updates later.
  simulation.densityFunction = () => 0;
  const windowSteps = Math.round(SOLO_ZOOM_BOMB_HOLD_SECONDS / STEP);
  for (let step = 0; step < windowSteps - 2; step += 1) {
    game.update(STEP);
    assert.ok(Math.abs(game.soloZoom.lastZoom - zoomed) < 1e-6, `step ${step}: target ${game.soloZoom.lastZoom}`);
    assert.ok(Math.abs(game.camera.zoom - zoomed) < 0.01, `step ${step}: zoom ${game.camera.zoom}`);
  }
  assert.equal(calls.update, 0);
  runFor(game, 0.2);
  assert.ok(calls.update > 0);
  runFor(game, 10);
  assert.ok(game.camera.zoom < zoomed - 0.1, `zoom ${game.camera.zoom}`);
});

test('an easing time warp holds the target instead of updating it', async () => {
  const { game } = await startedGame();
  runFor(game, 5);
  const calls = countCalls(game);
  game.timeWarp.start();
  game.update(STEP);
  assert.deepEqual(calls, { update: 0, hold: 1 });
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

// Bombs once, so a hold window is running, and returns the remaining hold.
function bombOnce({ game, input }) {
  runFor(game, 1);
  input.state.bomb = true;
  game.update(STEP);
  input.state.bomb = false;
  assert.ok(game.bombHoldRemaining > 0, 'the bomb started a hold');
}

test('quitting to the title clears the bomb hold', async () => {
  const harness = await startedGame();
  bombOnce(harness);
  harness.game.quitToTitle();
  assert.equal(harness.game.bombHoldRemaining, 0);
});

test('a new run clears the bomb hold', async () => {
  const harness = await startedGame();
  bombOnce(harness);
  harness.game.start();
  assert.equal(harness.game.bombHoldRemaining, 0);
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

test('leaving solo mode mid-zoom eases back without a pop, then returns to the default call', async () => {
  const leaves = {
    'the knob turns off': (game) => game.setSoloZoomSetting('enabled', false),
    'reduced motion turns on': (game) => game.setReducedMotion(true),
  };
  for (const [name, leave] of Object.entries(leaves)) {
    const { game } = await startedGame();
    runFor(game, 10);
    const before = game.camera.zoom;
    assert.ok(before > 1.3, name);
    const calls = spyCamera(game);
    leave(game);
    game.update(STEP);
    assert.ok(Math.abs(game.camera.zoom - before) < 0.1, `${name}: ${before} to ${game.camera.zoom}`);
    runFor(game, 10);
    assert.ok(game.camera.zoom <= 1.001, name);
    game.update(STEP);
    assert.ok(!('zoomMaximum' in calls.at(-1)), `${name}: back to today's call`);
  }
});

test('the controller gets the unzoomed view, the pressure sampler the zoomed one', async () => {
  const { game } = await startedGame();
  runFor(game, 10);
  assert.ok(game.camera.zoom > 1.3);
  const seen = { controller: null, sampled: [] };
  const { update } = game.soloZoom;
  game.soloZoom.update = (deltaSeconds, input) => { seen.controller = input; return update.call(game.soloZoom, deltaSeconds, input); };
  game.simulation.densityFunction = () => 1;
  const original = game.densityAt;
  let widest = 0;
  game.densityAt = (x, y) => { widest = Math.max(widest, Math.hypot(x - game.seats[0].cameraFocus.x, y - game.seats[0].cameraFocus.y)); return original(x, y); };
  game.update(STEP);
  assert.equal(seen.controller.viewWidth, game.viewSize.width);
  assert.equal(seen.controller.viewHeight, game.viewSize.height);
  // The far ring sits at 1.1 zoomed half-diagonals, so inside the unzoomed one.
  const zoomedRing = 1.1 * Math.hypot(game.viewSize.width, game.viewSize.height) / 2 / game.camera.zoom;
  assert.ok(Math.abs(widest - zoomedRing) < 0.5, `ring ${widest} vs ${zoomedRing}`);
});

test('a solo death and the game over while zoomed in at 1.4 ease out with no per-step jump', async () => {
  const { game, simulation } = await startedGame();
  for (let step = 0; step < 1200 && game.camera.zoom < 1.39; step += 1) game.update(STEP);
  assert.ok(game.camera.zoom >= 1.39, `zoom ${game.camera.zoom}`);
  hitNow(game, simulation);
  const phases = new Set();
  let previous = game.camera.zoom;
  let largestStep = 0;
  for (let step = 0; step < 60 * 20; step += 1) {
    game.update(STEP);
    phases.add(game.run.phase);
    largestStep = Math.max(largestStep, Math.abs(game.camera.zoom - previous));
    previous = game.camera.zoom;
  }
  assert.ok(phases.has('gameOver'), `phases ${[...phases]}`);
  assert.ok(largestStep < 0.1, `largest per-step zoom change ${largestStep}`);
  assert.ok(game.camera.zoom <= 1.001, `zoom ${game.camera.zoom}`);
});

test('uniform far-only density settles the zoom at the minimum without hunting', async () => {
  const { game, simulation } = await startedGame({ density: () => 0 });
  // A pull-out of ln(1 / 0.6) alone would settle at 0.6; 0.9 asks for below the 0.5 minimum.
  game.setSoloZoomSetting('pullOut', 0.9);
  simulation.densityFunction = farOnly(game);
  runFor(game, 20);
  const zooms = [];
  for (let step = 0; step < 60 * 10; step += 1) {
    game.update(STEP);
    zooms.push(game.camera.zoom);
  }
  assert.ok(Math.abs(game.camera.zoom - 0.5) < 0.02, `zoom ${game.camera.zoom}`);
  const range = Math.max(...zooms) - Math.min(...zooms);
  assert.ok(range < 0.01, `range over the last 10 s ${range}`);
});
