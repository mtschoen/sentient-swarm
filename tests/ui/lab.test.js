import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WATCH_ALIVE_FRACTION, LAB_KNOB_BINDINGS, LAB_KNOB_DEFAULTS, LabMode, MIX_KNOB_SPECS, applyMix, captureLabState, captureMix,
  hashForMix, mixFromHash, readKnob, restoreLabState, writeKnob,
} from '../../src/ui/lab.js';
import { BUNDLED_MIXES, KNOB_RANGES, decodeMix, encodeMix, isValidMix } from '../../src/ui/labPresets.js';
import { SpawnPressure } from '../../src/sim/spawner.js';
import { SpawnDirector } from '../../src/sim/spawn-director.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';
import { SPECIES_COUNT } from '../../src/sim/layout.js';
import { DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND } from '../../src/game/weaponTypes.js';
import { TIME_WARP_SCALE, TIME_WARP_SECONDS, TimeWarp } from '../../src/game/time-warp.js';

const CAPACITY = 65536;

// The Simulation, Projectiles and Renderer surface the lab touches, with plain storage.
function createContext() {
  const simulation = {
    capacity: CAPACITY,
    neighborRadius: 0.1,
    shares: new Float32Array(SPECIES_COUNT).fill(1 / SPECIES_COUNT),
    species: defaultSpecies(),
    matrix: defaultMatrix(),
    sameSpeciesCohesion: true,
    spawnBandWidth: 0.6,
    spawnDensityBias: 0.5,
    killBurstParticles: 12,
    killFragmentParticles: 3,
    deathFloodParticles: 480,
    setShares(shares) { this.shares = normalizeShares(shares); },
    setSpecies(rows, matrix) { this.species = rows; this.matrix = matrix; },
    setSameSpeciesCohesion(enabled) { this.sameSpeciesCohesion = enabled; },
    setSpawnBandWidth(value) { this.spawnBandWidth = value; },
    setSpawnDensityBias(value) { this.spawnDensityBias = value; },
    setKillBurstParticles(value) { this.killBurstParticles = value; },
    setKillFragmentParticles(value) { this.killFragmentParticles = value; },
    setDeathFloodParticles(value) { this.deathFloodParticles = value; },
    wallMargin: 0.5,
    wallStiffness: 40,
    comfortRadius: 1,
    coarseFieldPressure: true,
    setWallMargin(value) { this.wallMargin = value; },
    setWallStiffness(value) { this.wallStiffness = value; },
    setComfortRadius(value) { this.comfortRadius = value; },
    setCoarseFieldPressure(enabled) { this.coarseFieldPressure = enabled; },
  };
  const game = {
    simulation,
    spawnPressure: new SpawnPressure({ capacity: CAPACITY }),
    spawnDirector: new SpawnDirector({ random: () => 0.5 }),
    projectiles: {
      baseKillBudget: 0,
      beamSweepThresholdDegrees: 0,
      setBaseKillBudget(value) { this.baseKillBudget = value; },
      setBeamSweepThreshold(value) { this.beamSweepThresholdDegrees = value; },
    },
    beamTurnRevolutionsPerSecond: 1.5,
    setBeamTurnRate(value) { this.beamTurnRevolutionsPerSecond = value; },
    pickupBlastRadius: 1.5,
    setPickupBlastRadius(value) { this.pickupBlastRadius = value; },
    timeWarp: new TimeWarp(),
    simulationRate: 'full',
    setSimulationRate(rate) { this.simulationRate = rate; },
    watchFractions: [],
    watching: false,
    setWatch(fraction) { this.watchFractions.push(fraction); this.watching = fraction !== null; },
    capacityRequests: [],
    setCapacity(capacity, options) { this.capacityRequests.push({ capacity, ...options }); return Promise.resolve(true); },
    started: 0,
    start() { this.started += 1; this.watching = false; },
    quits: 0,
    quitToTitle() { this.quits += 1; },
  };
  const renderer = {
    settings: { ...DEFAULT_RENDER_SETTINGS },
    particles: { particleDevicePixels: 4, setParticleDevicePixels(value) { this.particleDevicePixels = value; } },
  };
  return { game, renderer, lab: { watchAliveFraction: DEFAULT_WATCH_ALIVE_FRACTION } };
}

const specFor = (key) => MIX_KNOB_SPECS.find((spec) => spec.key === key);

test('every mix knob has a binding and a whitelist range that holds its slider range', () => {
  for (const spec of MIX_KNOB_SPECS) {
    assert.ok(LAB_KNOB_BINDINGS[spec.key], spec.key);
    const [minimum, maximum] = KNOB_RANGES[spec.key] ?? [];
    assert.ok(minimum <= spec.minimum && spec.maximum <= maximum, spec.key);
  }
});

test('the shipped defaults read inside every slider range', () => {
  const context = createContext();
  for (const spec of MIX_KNOB_SPECS) {
    const raw = LAB_KNOB_BINDINGS[spec.key].read(context);
    assert.ok(raw >= spec.minimum && raw <= spec.maximum, `${spec.key} ${raw}`);
  }
});

test('captureMix of the defaults is a valid mix that survives encode and decode', () => {
  const mix = captureMix(createContext());
  assert.equal(isValidMix(mix), true);
  assert.deepEqual(decodeMix(encodeMix(mix)), mix);
});

test('applyMix restores a captured mix: knobs, rules, matrix, shares and rate', () => {
  const source = createContext();
  writeKnob(source, specFor('baseKillBudget'), 5);
  writeKnob(source, specFor('gateCount'), 2);
  writeKnob(source, specFor('trailDecay'), 0.3);
  writeKnob(source, specFor('watchAliveFraction'), 0.6);
  source.game.simulation.species[2].seek = 1.25;
  source.game.simulation.matrix[3] = -2;
  source.game.simulation.setShares([1, 0, 0, 0, 1]);
  source.game.setSimulationRate('half');
  source.game.simulation.setSameSpeciesCohesion(false);
  const mix = decodeMix(encodeMix(captureMix(source)));

  const target = createContext();
  applyMix(target, mix);
  assert.equal(target.game.projectiles.baseKillBudget, 5);
  assert.equal(target.game.spawnDirector.schedule.gateCount, 2);
  assert.equal(target.renderer.settings.trailDecay, 0.3);
  assert.equal(target.lab.watchAliveFraction, 0.6);
  assert.equal(target.game.simulation.species[2].seek, 1.25);
  assert.equal(target.game.simulation.matrix[3], -2);
  assert.equal(target.game.simulation.shares[0], 0.5);
  assert.equal(target.game.simulationRate, 'half');
  assert.equal(target.game.simulation.sameSpeciesCohesion, false);
  assert.deepEqual(captureMix(target), mix);
});

test('applyMix clamps knobs to the slider ranges (a spawn distance start of 0.5 stalls spawns)', () => {
  const context = createContext();
  const mix = { ...captureMix(context), knobs: { spawnDistanceStartFraction: 0.5, gateCount: 1 } };
  assert.equal(isValidMix(mix), true);
  applyMix(context, mix);
  assert.equal(context.game.spawnPressure.ramp.spawnDistanceStartFraction, 0.4);
  assert.equal(context.game.spawnDirector.schedule.gateCount, 2);
  assert.equal(readKnob(context, specFor('gateCount')), 2);
});

test('applyMix swaps capacity only when the neighbor radius differs', async () => {
  const context = createContext();
  await applyMix(context, captureMix(context));
  assert.equal(context.game.capacityRequests.length, 0);
  await applyMix(context, { ...captureMix(context), neighborRadius: 0.2 });
  assert.deepEqual(context.game.capacityRequests, [{ capacity: CAPACITY, neighborRadius: 0.2 }]);
});

test('mixFromHash: absent, malformed and valid hashes', () => {
  assert.deepEqual(mixFromHash(''), { present: false, mix: null });
  assert.deepEqual(mixFromHash('#other'), { present: false, mix: null });
  assert.deepEqual(mixFromHash('#mix=%%%'), { present: true, mix: null });
  assert.deepEqual(mixFromHash(hashForMix(encodeMix({ version: 1 }))), { present: true, mix: null });
  const mix = captureMix(createContext());
  assert.deepEqual(mixFromHash(hashForMix(encodeMix(mix))), { present: true, mix });
});

function createLab() {
  const context = createContext();
  const menu = { visible: true, show() { this.visible = true; }, hide() { this.visible = false; } };
  const viewport = { inspectZoomEnabled: false, setInspectZoomEnabled(enabled) { this.inspectZoomEnabled = enabled; } };
  const audio = { unlocks: 0, unlock() { this.unlocks += 1; } };
  const lab = new LabMode({ game: context.game, renderer: context.renderer, viewport, menu, audio });
  const panel = {
    opened: 0, closed: 0, refreshed: 0, modes: [], statuses: [],
    open() { this.opened += 1; }, close() { this.closed += 1; }, refresh() { this.refreshed += 1; },
    setMode(mode) { this.modes.push(mode); }, showStatus(text) { this.statuses.push(text); },
  };
  lab.attachPanel(panel);
  return { lab, game: context.game, menu, viewport, audio, panel };
}

test('LabMode: enter watches with the zoom on, Play starts the run, leave returns to the title', () => {
  const { lab, game, menu, viewport, audio, panel } = createLab();
  lab.enter();
  assert.equal(lab.active, true);
  assert.equal(menu.visible, false);
  assert.equal(viewport.inspectZoomEnabled, true);
  assert.equal(game.watching, true);
  assert.deepEqual(game.watchFractions, [DEFAULT_WATCH_ALIVE_FRACTION]);
  assert.equal(panel.opened, 1);
  lab.setMode('play');
  assert.equal(game.started, 1);
  assert.equal(game.watching, false);
  assert.equal(audio.unlocks, 1);
  assert.deepEqual(panel.modes, ['watch', 'play']);
  lab.leave();
  assert.equal(lab.active, false);
  assert.equal(game.quits, 1);
  assert.equal(menu.visible, true);
  assert.equal(viewport.inspectZoomEnabled, false);
  assert.equal(panel.closed, 1);
  lab.leave();
  assert.equal(game.quits, 1);
});

test('LabMode.loadFromHash: a malformed mix opens the lab on defaults with a status, no hash does nothing', () => {
  const { lab, game, panel } = createLab();
  assert.equal(lab.loadFromHash(''), false);
  assert.equal(lab.active, false);
  assert.equal(lab.loadFromHash('#mix=%%%'), true);
  assert.equal(lab.active, true);
  assert.equal(game.watching, true);
  assert.equal(panel.statuses.length, 1);
});

test('LabMode.loadFromHash applies a valid mix', async () => {
  const source = createContext();
  writeKnob(source, specFor('beamSweepThresholdDegrees'), 20);
  const { lab, game } = createLab();
  lab.loadFromHash(hashForMix(encodeMix(captureMix(source))));
  assert.equal(game.projectiles.beamSweepThresholdDegrees, 20);
});

test('every mix knob has a shipped default inside its slider range; the new knobs default to the old constants', () => {
  for (const spec of MIX_KNOB_SPECS) {
    const value = LAB_KNOB_DEFAULTS[spec.key];
    assert.ok(value >= spec.minimum && value <= spec.maximum, `${spec.key} ${value}`);
  }
  assert.deepEqual(
    ['wallMargin', 'wallStiffness', 'comfortRadius', 'coarseFieldPressure', 'exposure'].map((key) => LAB_KNOB_DEFAULTS[key]),
    [0.5, 40, 1, 1, 1],
  );
  // The fake context holds the shipped values, so its knobs read as the defaults.
  const context = createContext();
  for (const spec of MIX_KNOB_SPECS) assert.equal(LAB_KNOB_BINDINGS[spec.key].read(context), LAB_KNOB_DEFAULTS[spec.key], spec.key);
});

test('the wall, comfort, coarse-field and exposure knobs round-trip through a shared mix', () => {
  const source = createContext();
  writeKnob(source, specFor('wallMargin'), 1.5);
  writeKnob(source, specFor('wallStiffness'), 90);
  writeKnob(source, specFor('comfortRadius'), 2.25);
  writeKnob(source, specFor('coarseFieldPressure'), 0);
  writeKnob(source, specFor('exposure'), 2);
  const target = createContext();
  applyMix(target, decodeMix(encodeMix(captureMix(source))));
  const simulation = target.game.simulation;
  assert.deepEqual([simulation.wallMargin, simulation.wallStiffness, simulation.comfortRadius, simulation.coarseFieldPressure], [1.5, 90, 2.25, false]);
  assert.equal(target.renderer.settings.exposure, 2);
});

test('applying a mix without a knobs map (a bundled mix) resets every knob to its default first', () => {
  const context = createContext();
  writeKnob(context, specFor('baseKillBudget'), 9);
  writeKnob(context, specFor('wallMargin'), 1.75);
  writeKnob(context, specFor('trailDecay'), 0.2);
  writeKnob(context, specFor('rampSeconds'), 30);
  writeKnob(context, specFor('coarseFieldPressure'), 0);
  context.game.simulation.setSameSpeciesCohesion(false);
  applyMix(context, BUNDLED_MIXES.allChasers);
  for (const spec of MIX_KNOB_SPECS) assert.equal(readKnob(context, spec), clampedDefault(spec), spec.key);
  assert.equal(context.game.simulation.sameSpeciesCohesion, true);
  assert.equal(context.game.simulation.shares[0], 1);
});

function clampedDefault(spec) {
  return Math.min(spec.maximum, Math.max(spec.minimum, LAB_KNOB_DEFAULTS[spec.key]));
}

test('restoreLabState gives back exactly what captureLabState read, unclamped', async () => {
  const context = createContext();
  const state = captureLabState(context);
  writeKnob(context, specFor('comfortRadius'), 3);
  context.game.simulation.species[0].seek = 1.9;
  context.game.simulation.matrix[1] = 2;
  context.game.simulation.setShares([0, 1, 0, 0, 0]);
  context.renderer.settings.glowScale = 3;
  await restoreLabState(context, state);
  assert.deepEqual(captureLabState(context), state);
  assert.equal(context.game.capacityRequests.length, 0);
});

test('LabMode: leaving restores the state from entering, Play inside the lab keeps the lab mix', async () => {
  const { lab, game } = createLab();
  const renderer = lab.context.renderer;
  const before = captureLabState(lab.context);
  lab.enter();
  writeKnob(lab.context, specFor('baseKillBudget'), 4);
  writeKnob(lab.context, specFor('wallMargin'), 1.25);
  writeKnob(lab.context, specFor('exposure'), 3);
  writeKnob(lab.context, specFor('floorFraction'), 0.05);
  game.simulation.species[1].maximumSpeed = 7;
  game.simulation.setSameSpeciesCohesion(false);
  game.setSimulationRate('half');
  game.simulation.neighborRadius = 0.2;
  lab.setMode('play');
  assert.equal(game.projectiles.baseKillBudget, 4, 'Play keeps the lab mix');
  lab.leave();
  assert.equal(game.projectiles.baseKillBudget, 0);
  assert.equal(game.simulation.wallMargin, 0.5);
  assert.equal(renderer.settings.exposure, 1);
  assert.equal(game.spawnPressure.ramp.floorFraction, before.knobs.floorFraction);
  assert.equal(game.simulation.species[1].maximumSpeed, before.species[1].maximumSpeed);
  assert.equal(game.simulation.sameSpeciesCohesion, true);
  assert.equal(game.simulationRate, 'full');
  // The neighbor radius comes back through a swap at the current capacity.
  assert.deepEqual(game.capacityRequests, [{ capacity: CAPACITY, neighborRadius: 0.1 }]);
  game.simulation.neighborRadius = 0.1;
  assert.deepEqual(captureLabState(lab.context), before);
});

test('LabMode marks the game as in the lab, so the quality probe skips lab runs', () => {
  const { lab, game } = createLab();
  lab.enter();
  assert.equal(game.labActive, true);
  lab.setMode('play');
  assert.equal(game.labActive, true, 'a lab Play run is still the lab');
  lab.leave();
  assert.equal(game.labActive, false);
});

test('LabMode calls onLeave after restoring the entry state, so the live settings go back on top', () => {
  const context = createContext();
  const menu = { show() {}, hide() {} };
  const viewport = { setInspectZoomEnabled() {} };
  const seen = [];
  const lab = new LabMode({
    game: context.game, renderer: context.renderer, viewport, menu,
    onLeave: () => seen.push(context.renderer.settings.trailDecay),
  });
  context.renderer.settings.trailDecay = 0.3;
  lab.enter();
  context.renderer.settings.trailDecay = 0.9;
  lab.leave();
  assert.deepEqual(seen, [0.3], 'called once, after the restore');
});

test('LabMode.canEnter: only from the title (Ready, not paused)', () => {
  const { lab, game } = createLab();
  game.run = { phase: 'ready' };
  game.paused = false;
  assert.equal(lab.canEnter, true);
  game.paused = true;
  assert.equal(lab.canEnter, false, 'paused');
  game.paused = false;
  for (const phase of ['playing', 'dying', 'respawning', 'gameOver']) {
    game.run = { phase };
    assert.equal(lab.canEnter, false, phase);
  }
});

// Owner ruling R31: two lab sliders tune the time warp; the shipped values are the defaults.
test('the time warp duration and scale are lab knobs with the shipped defaults, written to the game', () => {
  const context = createContext();
  assert.equal(LAB_KNOB_DEFAULTS.timeWarpSeconds, TIME_WARP_SECONDS);
  assert.equal(LAB_KNOB_DEFAULTS.timeWarpScale, TIME_WARP_SCALE);
  assert.equal(readKnob(context, specFor('timeWarpSeconds')), TIME_WARP_SECONDS);
  assert.equal(readKnob(context, specFor('timeWarpScale')), TIME_WARP_SCALE);
  writeKnob(context, specFor('timeWarpSeconds'), 10);
  writeKnob(context, specFor('timeWarpScale'), 0.5);
  assert.equal(context.game.timeWarp.durationSeconds, 10);
  assert.equal(context.game.timeWarp.targetScale, 0.5);
});

test('the beam turn rate is a lab knob with the shipped default, written to the game and carried by a mix', () => {
  const context = createContext();
  assert.equal(LAB_KNOB_DEFAULTS.beamTurnRevolutionsPerSecond, DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND);
  assert.equal(readKnob(context, specFor('beamTurnRevolutionsPerSecond')), DEFAULT_BEAM_TURN_REVOLUTIONS_PER_SECOND);
  writeKnob(context, specFor('beamTurnRevolutionsPerSecond'), 3);
  assert.equal(context.game.beamTurnRevolutionsPerSecond, 3);
  const mix = decodeMix(encodeMix(captureMix(context)));
  assert.equal(mix.knobs.beamTurnRevolutionsPerSecond, 3);
  writeKnob(context, specFor('beamTurnRevolutionsPerSecond'), 0);
  applyMix(context, mix);
  assert.equal(context.game.beamTurnRevolutionsPerSecond, 3);
  const state = captureLabState(context);
  writeKnob(context, specFor('beamTurnRevolutionsPerSecond'), 0.5);
  restoreLabState(context, state);
  assert.equal(context.game.beamTurnRevolutionsPerSecond, 3);
});
