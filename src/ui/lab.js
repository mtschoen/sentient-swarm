// Lab mode (task C6b): entered from the title menu's Lab button (or the backquote key), left back
// to the title. The lab panel (labPanel.js) is open; Watch (the default) holds the run in Ready
// through Game.setWatch: weapons and contact off, spawn pressure at the panel's alive target and
// the player point on the pointer, so the swarm chases it. Play runs the full game with the
// current mix. The right-button inspect zoom is on only here. Share writes #mix=<encoded> into
// the URL (history.replaceState, no reload); a page loaded with #mix= applies the mix and opens the
// lab, and a malformed hash opens it with the shipped defaults and a status line, never an error.
// Mixes (labPresets.js): captureMix reads the live state, applyMix writes it back. Every knob is
// bound by name in LAB_KNOB_BINDINGS to a setter that reaches the current simulation, so a value
// survives a capacity swap (Simulation.carryStateInto carries its own setters' values).
import { SPECIES_COUNT } from '../sim/layout.js';
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
  ...Object.fromEntries(RENDER_SLIDERS.map((spec) => [spec.key, renderSetting(spec.key)])),
};

// Every slider spec a mix's knobs map carries (the lab knobs and the renderer sliders).
export const MIX_KNOB_SPECS = [...LAB_KNOBS, ...RENDER_SLIDERS];

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

// Writes a valid mix into the live state. Knobs missing from the mix keep their values; knob
// values are clamped to the lab's slider ranges. A different neighbor radius needs a capacity swap
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
  const knobs = mix.knobs ?? {};
  for (const spec of MIX_KNOB_SPECS) {
    if (knobs[spec.key] !== undefined) writeKnob(context, spec, knobs[spec.key]);
  }
  if (knobs.sameSpeciesCohesion !== undefined) simulation.setSameSpeciesCohesion(knobs.sameSpeciesCohesion >= 0.5);
  if (Math.abs(mix.neighborRadius - simulation.neighborRadius) <= NEIGHBOR_RADIUS_EPSILON) return Promise.resolve(false);
  return game.setCapacity(simulation.capacity, { neighborRadius: mix.neighborRadius });
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
  constructor({ game, renderer, viewport, menu, audio = null }) {
    this.context = { game, renderer, lab: { watchAliveFraction: DEFAULT_WATCH_ALIVE_FRACTION } };
    this.game = game;
    this.viewport = viewport;
    this.menu = menu;
    this.audio = audio;
    this.panel = null;
    this.active = false;
    this.mode = 'watch';
  }

  attachPanel(panel) {
    this.panel = panel;
  }

  enter() {
    if (!this.active) {
      this.active = true;
      this.menu.hide();
      this.viewport.setInspectZoomEnabled(true);
    }
    this.setMode('watch');
    this.panel?.open();
    this.panel?.refresh();
  }

  // Back to the title: the run resets as on Quit to title.
  leave() {
    if (!this.active) return;
    this.active = false;
    this.game.setWatch(null);
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
