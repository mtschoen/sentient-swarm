// Pure pieces of the lab panel (labPanel.js): option lists, slider specs, the frames-per-second
// accumulator and the readout formatter. No DOM, so node:test covers all of it.
import { SPECIES_NAMES } from '../sim/species.js';

// The quality preset capacities (src/settings/presets.js) and the earlier panel choices, sorted.
export const CAPACITY_OPTIONS = [65536, 131072, 262144, 524288, 1048576, 2097152, 4194304];
export const DEFAULT_CAPACITY = 262144;

// Reads ?capacity=N; only the panel's choices are accepted.
export function capacityFromSearch(search) {
  return pinnedCapacityFromSearch(search) ?? DEFAULT_CAPACITY;
}

// The ?capacity=N panel choice, or null when the URL pins none (or an unknown one).
export function pinnedCapacityFromSearch(search) {
  const requested = Number(new URLSearchParams(search).get('capacity'));
  return CAPACITY_OPTIONS.includes(requested) ? requested : null;
}

// The quality probe is off when the URL pins a capacity or carries ?probe=off (browser checks).
export function probeDisabledFromSearch(search) {
  return pinnedCapacityFromSearch(search) !== null || new URLSearchParams(search).get('probe') === 'off';
}

// Each spec: the species row field (or renderer settings key), a label and the slider range.
export const SPECIES_SLIDERS = [
  { key: 'seek', label: 'seek', minimum: 0, maximum: 2, step: 0.01 },
  { key: 'cohesion', label: 'cohesion', minimum: 0, maximum: 2, step: 0.01 },
  { key: 'alignment', label: 'alignment', minimum: 0, maximum: 2, step: 0.01 },
  { key: 'separation', label: 'separation', minimum: 0, maximum: 3, step: 0.01 },
  { key: 'maximumSpeed', label: 'maximum speed', minimum: 0, maximum: 8, step: 0.1 },
  { key: 'maximumTurn', label: 'maximum turn', minimum: 0, maximum: 2, step: 0.01 },
  { key: 'orbitRadius', label: 'orbit radius', minimum: 0, maximum: 8, step: 0.1 },
  { key: 'flee', label: 'flee', minimum: 0, maximum: 4, step: 0.05 },
  { key: 'pressure', label: 'pressure', minimum: 0, maximum: 2, step: 0.01 },
  { key: 'targetDensity', label: 'target density', minimum: 1, maximum: 200, step: 1 },
];

export const SHARE_SLIDER = { minimum: 0, maximum: 1, step: 0.01 };

export const RENDER_SLIDERS = [
  { key: 'trailDecay', label: 'trail decay', minimum: 0, maximum: 0.99, step: 0.01 },
  { key: 'bloomStrength', label: 'bloom strength', minimum: 0, maximum: 3, step: 0.05 },
  { key: 'warpDensityWeight', label: 'warp density weight', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'warpThreatWeight', label: 'warp threat weight', minimum: 0, maximum: 2, step: 0.05 },
  // Ship (glyph) size as a fraction of the arena height; the glyph pass never draws a ship under
  // MINIMUM_SHIP_DEVICE_PIXELS, and the slider floor keeps ships readable (owner ruling R3).
  { key: 'shipArenaFraction', label: 'ship size', minimum: 0.012, maximum: 0.04, step: 0.001 },
  // Multiplier on the composite's shipped exposure (1).
  { key: 'exposure', label: 'exposure', minimum: 0.25, maximum: 4, step: 0.05 },
];

// The lab's tuning knobs (task C6b), in panel groups. Each is part of a shared mix's knobs map
// (labPresets.js KNOB_RANGES holds the same names); lab.js binds each key to its live setter.
// integer: the value is rounded; toggle: a 0 or 1 value the panel shows as a checkbox. The ramp ranges are the controller brief's (C0); the gate count
// floor is 2 because one gate inside the aim lane stalls waves for about 3 s (C0b2).
export const LAB_KNOB_GROUPS = [
  { title: 'Watch', knobs: [
    { key: 'watchAliveFraction', label: 'alive target', minimum: 0, maximum: 1, step: 0.01 },
  ] },
  { title: 'Steering and walls', knobs: [
    { key: 'wallMargin', label: 'wall margin', minimum: 0, maximum: 2, step: 0.05 },
    { key: 'wallStiffness', label: 'wall push', minimum: 0, maximum: 160, step: 1 },
    { key: 'comfortRadius', label: 'comfort radius', minimum: 0, maximum: 4, step: 0.05 },
    { key: 'coarseFieldPressure', label: 'coarse-field pressure', minimum: 0, maximum: 1, step: 1, integer: true, toggle: true },
  ] },
  { title: 'Spawn ramp', knobs: [
    { key: 'floorFraction', label: 'floor', minimum: 0, maximum: 0.1, step: 0.001 },
    { key: 'rampSeconds', label: 'ramp seconds', minimum: 10, maximum: 300, step: 1 },
    { key: 'ceilingFraction', label: 'ceiling', minimum: 0.1, maximum: 1, step: 0.01 },
    { key: 'curveExponent', label: 'curve exponent', minimum: 1, maximum: 4, step: 0.1 },
    { key: 'seekFloorFraction', label: 'seek floor', minimum: 0, maximum: 1, step: 0.01 },
    { key: 'spawnDistanceStartFraction', label: 'spawn distance start', minimum: 0.25, maximum: 0.4, step: 0.01 },
    { key: 'refillFractionPerSecond', label: 'refill per second', minimum: 0, maximum: 1, step: 0.01 },
  ] },
  { title: 'Spawn gates', knobs: [
    { key: 'gateCount', label: 'gate count', minimum: 2, maximum: 4, step: 1, integer: true },
    { key: 'gateLifetimeSeconds', label: 'gate lifetime', minimum: 2, maximum: 120, step: 1 },
    { key: 'wavePeriodSeconds', label: 'wave period', minimum: 0.2, maximum: 20, step: 0.1 },
    { key: 'waveSeconds', label: 'wave length', minimum: 0.05, maximum: 5, step: 0.05 },
    { key: 'burstFraction', label: 'burst size', minimum: 0.01, maximum: 1, step: 0.01 },
    { key: 'driftSpeed', label: 'gate drift', minimum: 0, maximum: 3, step: 0.05 },
    { key: 'gateRadius', label: 'gate radius', minimum: 0.2, maximum: 2, step: 0.05 },
    { key: 'speciesBias', label: 'gate species bias', minimum: 0, maximum: 1, step: 0.01 },
    { key: 'spawnBandWidth', label: 'wall band width', minimum: 0.05, maximum: 4.5, step: 0.05 },
    { key: 'spawnDensityBias', label: 'spawn density bias', minimum: 0, maximum: 1, step: 0.01 },
  ] },
  { title: 'Kills and particles', knobs: [
    { key: 'killBurstParticles', label: 'burst sparks', minimum: 0, maximum: 64, step: 1, integer: true },
    { key: 'killFragmentParticles', label: 'burst fragments', minimum: 0, maximum: 16, step: 1, integer: true },
    { key: 'deathFloodParticles', label: 'death flood', minimum: 0, maximum: 4096, step: 16, integer: true },
    { key: 'particleDevicePixels', label: 'particle size', minimum: 1, maximum: 16, step: 0.5 },
  ] },
  { title: 'Weapons', knobs: [
    { key: 'pickupBlastRadius', label: 'pickup blast (0 off)', minimum: 0, maximum: 4, step: 0.05 },
    { key: 'baseKillBudget', label: 'base gun kills (0 unlimited)', minimum: 0, maximum: 64, step: 1, integer: true },
    { key: 'beamSweepThresholdDegrees', label: 'beam sweep budget (0 off)', minimum: 0, maximum: 90, step: 1 },
  ] },
];

export const LAB_KNOBS = LAB_KNOB_GROUPS.flatMap((group) => group.knobs);

// The value inside the spec's range (rounded for an integer spec); a non-number gives the minimum.
export function clampToSpec(spec, value) {
  const number = Number.isFinite(value) ? value : spec.minimum;
  const clamped = Math.min(spec.maximum, Math.max(spec.minimum, number));
  return spec.integer ? Math.round(clamped) : clamped;
}

// The capacity choices up to the quality probe's ceiling capacity (all of them for null).
export function capacityOptionsUpTo(ceilingCapacity) {
  return ceilingCapacity === null ? CAPACITY_OPTIONS : CAPACITY_OPTIONS.filter((capacity) => capacity <= ceilingCapacity);
}

// Frames per second over the last windowSize frame timestamps (milliseconds, from the caller's
// requestAnimationFrame callback; nothing here reads a clock).
export class FramesPerSecond {
  constructor(windowSize = 60) {
    this.windowSize = windowSize;
    this.timestamps = [];
  }

  record(timestampMilliseconds) {
    this.timestamps.push(timestampMilliseconds);
    if (this.timestamps.length > this.windowSize) this.timestamps.shift();
  }

  reset() {
    this.timestamps.length = 0;
  }

  get value() {
    if (this.timestamps.length < 2) return 0;
    const elapsed = this.timestamps[this.timestamps.length - 1] - this.timestamps[0];
    return elapsed > 0 ? ((this.timestamps.length - 1) * 1000) / elapsed : 0;
  }
}

// Readout text: frames per second, alive total and per-species counts (stats may be null).
export function describeStats(stats, framesPerSecond) {
  const lines = ['frames per second: ' + framesPerSecond.toFixed(1)];
  if (stats === null || stats === undefined) {
    lines.push('alive: waiting for stats');
    return lines.join('\n');
  }
  lines.push('alive: ' + stats.aliveTotal.toLocaleString('en-US'));
  SPECIES_NAMES.forEach((name, index) => {
    lines.push('  ' + name + ': ' + (stats.alivePerSpecies[index] ?? 0).toLocaleString('en-US'));
  });
  return lines.join('\n');
}
