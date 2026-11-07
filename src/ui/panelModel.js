// Pure pieces of the debug panel: option lists, slider specs, the frames-per-second accumulator
// and the readout formatter. No DOM, so node:test covers all of it.
import { SPECIES_NAMES } from '../sim/species.js';

export const CAPACITY_OPTIONS = [65536, 262144, 1048576, 4194304];
export const DEFAULT_CAPACITY = 262144;

// Reads ?capacity=N; only the panel's choices are accepted.
export function capacityFromSearch(search) {
  const requested = Number(new URLSearchParams(search).get('capacity'));
  return CAPACITY_OPTIONS.includes(requested) ? requested : DEFAULT_CAPACITY;
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
  { key: 'targetDensity', label: 'target density', minimum: 1, maximum: 300, step: 1 },
];

export const SHARE_SLIDER = { minimum: 0, maximum: 1, step: 0.01 };

export const RENDER_SLIDERS = [
  { key: 'trailDecay', label: 'trail decay', minimum: 0, maximum: 0.99, step: 0.01 },
  { key: 'bloomStrength', label: 'bloom strength', minimum: 0, maximum: 3, step: 0.05 },
  { key: 'warpDensityWeight', label: 'warp density weight', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'warpThreatWeight', label: 'warp threat weight', minimum: 0, maximum: 2, step: 0.05 },
];

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
