import { agentBufferBytes } from '../sim/layout.js';

// Quality presets, ordered low to high. Presets change counts and visual
// budgets only; gameplay never depends on capacity.
export const PRESETS = Object.freeze({
  phoneLow: Object.freeze({ capacity: 65536, particleCapacity: 32768, neighborRadius: 0.12, bloomQuality: 'low', simulationRate: 'half' }),
  phoneHigh: Object.freeze({ capacity: 131072, particleCapacity: 65536, neighborRadius: 0.1, bloomQuality: 'medium', simulationRate: 'full' }),
  desktop: Object.freeze({ capacity: 524288, particleCapacity: 131072, neighborRadius: 0.1, bloomQuality: 'high', simulationRate: 'full' }),
  desktopUltra: Object.freeze({ capacity: 2097152, particleCapacity: 262144, neighborRadius: 0.08, bloomQuality: 'high', simulationRate: 'full' }),
});

export const PRESET_ORDER = Object.freeze(['phoneLow', 'phoneHigh', 'desktop', 'desktopUltra']);

function fitsBindingLimit(name, maxStorageBufferBindingSize) {
  return agentBufferBytes(PRESETS[name].capacity) <= maxStorageBufferBindingSize / 2;
}

export function initialPresetFor({ isMobile, maxStorageBufferBindingSize }) {
  let index = PRESET_ORDER.indexOf(isMobile ? 'phoneLow' : 'desktop');
  while (index > 0 && !fitsBindingLimit(PRESET_ORDER[index], maxStorageBufferBindingSize)) {
    index -= 1;
  }
  return PRESET_ORDER[index];
}

export function stepPreset(name, direction) {
  const index = PRESET_ORDER.indexOf(name);
  if (index < 0) {
    throw new Error(`Unknown preset: ${name}`);
  }
  const offset = direction === 'up' ? 1 : direction === 'down' ? -1 : 0;
  const next = Math.min(PRESET_ORDER.length - 1, Math.max(0, index + offset));
  return PRESET_ORDER[next];
}
