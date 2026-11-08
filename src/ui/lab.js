// Lab mode (task C6b): entered from the title menu's Lab button (or the backquote key), left back
// to the title. The lab panel (labPanel.js) is open; Watch (the default) holds the run in Ready
// through Game.setWatch: weapons and contact off, spawn pressure at the panel's alive target and
// the player point on the pointer, so the swarm chases it. Play runs the full game with the
// current mix. The right-button inspect zoom is on only here. Share writes #mix=<encoded> into
// the URL (history.replaceState, no reload); a page loaded with #mix= applies the mix and opens the
// lab, and a malformed hash opens it with the shipped defaults and a status line, never an error.
// Mixes (labPresets.js): captureMix reads the live state, applyMix writes it back. Every knob is
// bound by name in LAB_KNOB_BINDINGS to a setter that reaches the current simulation, so a value
// survives a capacity swap (Simulation.carryStateInto carries its own setters' values). A mix
// applies every knob it leaves out at its shipped default (LAB_KNOB_DEFAULTS), so a bundled mix
// (no knobs map) plays the same however the knobs were set before. Leaving the lab restores the
// state captured on entering it (captureLabState), so a run from the title plays the shipped game;
// inside the lab, Play keeps the lab mix. game.labActive is set while the lab is open, so the
// quality probe skips lab runs; onLeave (main.js) then re-applies the player's live settings, so a
// Settings change made inside the lab survives the restore. The backquote key may enter the lab
// only from the title (canEnter).
import { DEFAULT_PICKUP_BLAST_RADIUS } from '../game/game.js';
import { RunPhase } from '../game/run.js';
import { TIME_WARP_SCALE, TIME_WARP_SECONDS } from '../game/time-warp.js';
import { DEFAULT_BASE_KILL_BUDGET, DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES } from '../game/weaponTypes.js';
import { PARTICLE_DEVICE_PIXELS } from '../render/particles.js';
import { DEFAULT_RENDER_SETTINGS } from '../render/renderer.js';
import { SPECIES_COUNT } from '../sim/layout.js';
import {
  DEFAULT_COMFORT_RADIUS, DEFAULT_DEATH_FLOOD_PARTICLES, DEFAULT_KILL_BURST_PARTICLES, DEFAULT_KILL_FRAGMENT_PARTICLES,
  DEFAULT_SPAWN_BAND_WIDTH, DEFAULT_SPAWN_DENSITY_BIAS, DEFAULT_WALL_MARGIN, DEFAULT_WALL_STIFFNESS,
} from '../sim/params.js';
import { DEFAULT_GATE_SCHEDULE } from '../sim/spawn-director.js';
import { DEFAULT_RAMP } from '../sim/spawner.js';
import { MIX_VERSION, RULE_FIELDS, RULE_RANGES, decodeMix } from './labPresets.js';
import { LAB_KNOBS, RENDER_SLIDERS, clampToSpec } from './panelModel.js';

export const DEFAULT_WATCH_ALIVE_FRACTION = 0.3;
const MIX_HASH_PREFIX = '#mix=';
const MATRIX_LIMIT = 4;
const NEIGHBOR_RADIUS_RANGE = [0.05, 0.5];
// Neighbor radii closer than this are the same (a capacity swap rebuilds the grid otherwise).
const NEIGHBOR_RADIUS_EPSILON = 1e-6;

function clamp(value, [minimum, maximum]) {
  return Math.min(maximum, Math.max(minimum, value));
}

const ramp = (key) => ({
  read: ({ game }) => game.spawnPressure.ramp[key],
  write: ({ game }, value) => game.spawnPressure.setRamp({ [key]: value }),
});
const gate = (key) => ({
  read: ({ game }) => game.spawnDirector.schedule[key],
  write: ({ game }, value) => game.spawnDirector.setSchedule({ [key]: value }),
});
const simulationValue = (key, setter) => ({
  read: ({ game }) => game.simulation[key],
  write: ({ game }, value) => game.simulation[setter](value),
});
const renderSetting = (key) => ({
  read: ({ renderer }) => renderer.settings[key],
  write: ({ renderer }, value) => { renderer.settings[key] = value; },
});

// context: { game, renderer, lab } where lab holds watchAliveFraction (the Watch slider).
export const LAB_KNOB_BINDINGS = {
  watchAliveFraction: {
    read: ({ lab }) => lab.watchAliveFraction,
    write: ({ game, lab }, value) => {
      lab.watchAliveFraction = value;
      if (game.watching) game.setWatch(value);
    },
  },
  floorFraction: ramp('floorFraction'),
  rampSeconds: ramp('rampSeconds'),
  ceilingFraction: ramp('ceilingFraction'),
  curveExponent: ramp('curveExponent'),
  seekFloorFraction: ramp('seekFloorFraction'),
  spawnDistanceStartFraction: ramp('spawnDistanceStartFraction'),
  refillFractionPerSecond: ramp('refillFractionPerSecond'),
  gateCount: gate('gateCount'),
  gateLifetimeSeconds: gate('gateLifetimeSeconds'),
  wavePeriodSeconds: gate('wavePeriodSeconds'),
  waveSeconds: gate('waveSeconds'),
  burstFraction: gate('burstFraction'),
  driftSpeed: gate('driftSpeed'),
  gateRadius: gate('gateRadius'),
  speciesBias: gate('speciesBias'),
  spawnBandWidth: simulationValue('spawnBandWidth', 'setSpawnBandWidth'),
  spawnDensityBias: simulationValue('spawnDensityBias', 'setSpawnDensityBias'),
  killBurstParticles: simulationValue('killBurstParticles', 'setKillBurstParticles'),
  killFragmentParticles: simulationValue('killFragmentParticles', 'setKillFragmentParticles'),
  deathFloodParticles: simulationValue('deathFloodParticles', 'setDeathFloodParticles'),
  wallMargin: simulationValue('wallMargin', 'setWallMargin'),
  wallStiffness: simulationValue('wallStiffness', 'setWallStiffness'),
  comfortRadius: simulationValue('comfortRadius', 'setComfortRadius'),
  coarseFieldPressure: {
    read: ({ game }) => (game.simulation.coarseFieldPressure ? 1 : 0),
    write: ({ game }, value) => game.simulation.setCoarseFieldPressure(value >= 0.5),
  },
  particleDevicePixels: {
    read: ({ renderer }) => renderer.particles.particleDevicePixels,
    write: ({ renderer }, value) => renderer.particles.setParticleDevicePixels(value),
  },
  pickupBlastRadius: {
    read: ({ game }) => game.pickupBlastRadius,
    write: ({ game }, value) => game.setPickupBlastRadius(value),
  },
  baseKillBudget: {
    read: ({ game }) => game.projectiles.baseKillBudget,
    write: ({ game }, value) => game.projectiles.setBaseKillBudget(value),
  },
  beamSweepThresholdDegrees: {
    read: ({ game }) => game.projectiles.beamSweepThresholdDegrees,
    write: ({ game }, value) => game.projectiles.setBeamSweepThreshold(value),
  },
  timeWarpSeconds: {
    read: ({ game }) => game.timeWarp.durationSeconds,
    write: ({ game }, value) => game.timeWarp.setDuration(value),
  },
  timeWarpScale: {
    read: ({ game }) => game.timeWarp.targetScale,
    write: ({ game }, value) => game.timeWarp.setScale(value),
  },
  ...Object.fromEntries(RENDER_SLIDERS.map((spec) => [spec.key, renderSetting(spec.key)])),
};

// Every slider spec a mix's knobs map carries (the lab knobs and the renderer sliders).
export const MIX_KNOB_SPECS = [...LAB_KNOBS, ...RENDER_SLIDERS];

// The shipped value of every mix knob (and same-species cohesion, on).
export const LAB_KNOB_DEFAULTS = Object.freeze({
  watchAliveFraction: DEFAULT_WATCH_ALIVE_FRACTION,
  wallMargin: DEFAULT_WALL_MARGIN,
  wallStiffness: DEFAULT_WALL_STIFFNESS,
  comfortRadius: DEFAULT_COMFORT_RADIUS,
  coarseFieldPressure: 1,
  ...DEFAULT_RAMP,
  ...DEFAULT_GATE_SCHEDULE,
  spawnBandWidth: DEFAULT_SPAWN_BAND_WIDTH,
  spawnDensityBias: DEFAULT_SPAWN_DENSITY_BIAS,
  killBurstParticles: DEFAULT_KILL_BURST_PARTICLES,
  killFragmentParticles: DEFAULT_KILL_FRAGMENT_PARTICLES,
  deathFloodParticles: DEFAULT_DEATH_FLOOD_PARTICLES,
  particleDevicePixels: PARTICLE_DEVICE_PIXELS,
  pickupBlastRadius: DEFAULT_PICKUP_BLAST_RADIUS,
  baseKillBudget: DEFAULT_BASE_KILL_BUDGET,
  beamSweepThresholdDegrees: DEFAULT_BEAM_SWEEP_THRESHOLD_DEGREES,
  timeWarpSeconds: TIME_WARP_SECONDS,
  timeWarpScale: TIME_WARP_SCALE,
  ...Object.fromEntries(RENDER_SLIDERS.map((spec) => [spec.key, DEFAULT_RENDER_SETTINGS[spec.key]])),
  sameSpeciesCohesion: 1,
});

export function readKnob(context, spec) {
  return clampToSpec(spec, LAB_KNOB_BINDINGS[spec.key].read(context));
}

// Writes the value clamped to the slider's range; returns the value written.
export function writeKnob(context, spec, value) {
  const clamped = clampToSpec(spec, value);
  LAB_KNOB_BINDINGS[spec.key].write(context, clamped);
  return clamped;
}

// The live state as a mix (labPresets.js schema), every number inside the schema's ranges.
export function captureMix(context) {
  const { game } = context;
  const simulation = game.simulation;
  return {
    version: MIX_VERSION,
    shares: Array.from(simulation.shares, Number),
    rules: simulation.species.slice(0, SPECIES_COUNT).map((row) => RULE_FIELDS.map((field) => clamp(row[field], RULE_RANGES[field]))),
    matrix: Array.from(simulation.matrix, (value) => clamp(value, [-MATRIX_LIMIT, MATRIX_LIMIT])),
    neighborRadius: clamp(simulation.neighborRadius, NEIGHBOR_RADIUS_RANGE),
    simulationRate: game.simulationRate,
    knobs: {
      ...Object.fromEntries(MIX_KNOB_SPECS.map((spec) => [spec.key, readKnob(context, spec)])),
      sameSpeciesCohesion: simulation.sameSpeciesCohesion ? 1 : 0,
    },
  };
}

// Writes a valid mix into the live state. Knobs missing from the mix (all of them without a knobs
// map) take their shipped defaults; knob values are clamped to the lab's slider ranges. A different neighbor radius needs a capacity swap
// (the grid is rebuilt): the returned promise is that swap's (resolved at once when none is needed).
export function applyMix(context, mix) {
  const { game } = context;
  const simulation = game.simulation;
  simulation.setShares(mix.shares);
  const rows = simulation.species.map((row, index) => (index < SPECIES_COUNT
    ? { ...row, ...Object.fromEntries(RULE_FIELDS.map((field, fieldIndex) => [field, mix.rules[index][fieldIndex]])) }
    : row));
  simulation.setSpecies(rows, Float32Array.from(mix.matrix));
  game.setSimulationRate(mix.simulationRate);
  const knobs = { ...LAB_KNOB_DEFAULTS, ...mix.knobs };
  for (const spec of MIX_KNOB_SPECS) writeKnob(context, spec, knobs[spec.key]);
  simulation.setSameSpeciesCohesion(knobs.sameSpeciesCohesion >= 0.5);
  return setNeighborRadius(game, mix.neighborRadius);
}

// A different neighbor radius needs a capacity swap at the current capacity (the grid is rebuilt).
function setNeighborRadius(game, neighborRadius) {
  const simulation = game.simulation;
  if (Math.abs(neighborRadius - simulation.neighborRadius) <= NEIGHBOR_RADIUS_EPSILON) return Promise.resolve(false);
  return game.setCapacity(simulation.capacity, { neighborRadius });
}

// Everything the lab can change, unclamped (so a restore gives back exactly what was there): the
// species rows, matrix, shares, neighbor radius, rate, same-species cohesion, every knob and the
// renderer settings. The capacity is not part of it.
export function captureLabState(context) {
  const { game, renderer } = context;
  const simulation = game.simulation;
  return {
    species: simulation.species.map((row) => ({ ...row })),
    matrix: Float32Array.from(simulation.matrix),
    shares: Array.from(simulation.shares, Number),
    neighborRadius: simulation.neighborRadius,
    simulationRate: game.simulationRate,
    sameSpeciesCohesion: simulation.sameSpeciesCohesion,
    knobs: Object.fromEntries(MIX_KNOB_SPECS.map((spec) => [spec.key, LAB_KNOB_BINDINGS[spec.key].read(context)])),
    renderSettings: { ...renderer.settings },
  };
}

// Writes a captureLabState result back; returns the neighbor radius swap's promise (resolved at
// once when the radius is unchanged).
export function restoreLabState(context, state) {
  const { game, renderer } = context;
  const simulation = game.simulation;
  simulation.setShares(state.shares);
  simulation.setSpecies(state.species.map((row) => ({ ...row })), Float32Array.from(state.matrix));
  game.setSimulationRate(state.simulationRate);
  simulation.setSameSpeciesCohesion(state.sameSpeciesCohesion);
  for (const spec of MIX_KNOB_SPECS) LAB_KNOB_BINDINGS[spec.key].write(context, state.knobs[spec.key]);
  Object.assign(renderer.settings, state.renderSettings);
  return setNeighborRadius(game, state.neighborRadius);
}

// { present: false } without a #mix= hash; else { present: true, mix } with mix null when malformed.
export function mixFromHash(hash) {
  if (typeof hash !== 'string' || !hash.startsWith(MIX_HASH_PREFIX)) return { present: false, mix: null };
  return { present: true, mix: decodeMix(hash.slice(MIX_HASH_PREFIX.length)) };
}

export function hashForMix(encoded) {
  return MIX_HASH_PREFIX + encoded;
}

// The lab mode state machine. menu: the title menu (shown on leave); viewport: the inspect zoom
// switch; audio (optional): unlocked on Play; panel: { open(), close(), refresh(), setMode(mode),
// showStatus(text) } from labPanel.js, attached later with attachPanel.
export class LabMode {
  constructor({ game, renderer, viewport, menu, audio = null, onLeave = () => {} }) {
    this.context = { game, renderer, lab: { watchAliveFraction: DEFAULT_WATCH_ALIVE_FRACTION } };
    this.game = game;
    this.viewport = viewport;
    this.menu = menu;
    this.audio = audio;
    this.onLeave = onLeave;
    this.panel = null;
    this.active = false;
    this.mode = 'watch';
    // captureLabState on entering, restored on leaving.
    this.enteredState = null;
  }

  attachPanel(panel) {
    this.panel = panel;
  }

  // The title: Ready, not paused, no run in progress.
  get canEnter() {
    return this.active || (this.game.run.phase === RunPhase.Ready && !this.game.paused);
  }

  enter() {
    if (!this.active) {
      this.active = true;
      this.game.labActive = true;
      this.enteredState = captureLabState(this.context);
      this.menu.hide();
      this.viewport.setInspectZoomEnabled(true);
    }
    this.setMode('watch');
    this.panel?.open();
    this.panel?.refresh();
  }

  // Back to the title: the state from entering comes back (the capacity stays) and the run resets
  // as on Quit to title. A failed neighbor radius swap keeps the previous simulation running with
  // the lab's radius (the panel is closed; the next lab visit shows the radius in effect).
  leave() {
    if (!this.active) return;
    this.active = false;
    this.game.labActive = false;
    this.game.setWatch(null);
    restoreLabState(this.context, this.enteredState).catch(() => {});
    this.enteredState = null;
    this.onLeave();
    this.game.quitToTitle();
    this.viewport.setInspectZoomEnabled(false);
    this.panel?.close();
    this.menu.show();
  }

  // 'watch' or 'play'.
  setMode(mode) {
    this.mode = mode === 'play' ? 'play' : 'watch';
    if (this.mode === 'play') {
      this.audio?.unlock?.();
      this.game.start();
    } else {
      this.game.setWatch(this.context.lab.watchAliveFraction);
    }
    this.panel?.setMode(this.mode);
  }

  capture() {
    return captureMix(this.context);
  }

  apply(mix) {
    const swap = applyMix(this.context, mix);
    if (this.game.watching) this.game.setWatch(this.context.lab.watchAliveFraction);
    this.panel?.refresh();
    return swap.then(() => this.panel?.refresh(), (error) => this.panel?.showStatus(`Neighbor radius change failed: ${error.message}`));
  }

  // Boot: a #mix= hash opens the lab with that mix (or the defaults when it is malformed).
  loadFromHash(hash) {
    const { present, mix } = mixFromHash(hash);
    if (!present) return false;
    this.enter();
    if (mix === null) this.panel?.showStatus('The shared mix could not be read; the defaults are loaded.');
    else this.apply(mix);
    return true;
  }
}
