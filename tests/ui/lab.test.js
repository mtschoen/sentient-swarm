import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WATCH_ALIVE_FRACTION, LAB_KNOB_BINDINGS, LabMode, MIX_KNOB_SPECS, applyMix, captureMix, hashForMix, mixFromHash, readKnob, writeKnob,
} from '../../src/ui/lab.js';
import { KNOB_RANGES, decodeMix, encodeMix, isValidMix } from '../../src/ui/labPresets.js';
import { SpawnPressure } from '../../src/sim/spawner.js';
import { SpawnDirector } from '../../src/sim/spawn-director.js';
import { defaultMatrix, defaultSpecies, normalizeShares } from '../../src/sim/species.js';
import { DEFAULT_RENDER_SETTINGS } from '../../src/render/renderer.js';
import { SPECIES_COUNT } from '../../src/sim/layout.js';

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
    pickupBlastRadius: 1.5,
    setPickupBlastRadius(value) { this.pickupBlastRadius = value; },
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
