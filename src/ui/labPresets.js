// Lab mixes: a mix is a plain object that names everything the lab can change about the swarm, plus
// encode/decode for the URL hash (#mix=<text>), the bundled mixes and saved mixes.
//
// Mix schema (version 1; decodeMix rejects any other version, any unknown key and any value out of range):
//   version: 1
//   shares: 5 non-negative numbers, not all zero (spawn share per species, normalized on use)
//   rules: 5 rows (species order of SPECIES_NAMES), each RULE_FIELDS.length numbers in the order of
//          RULE_FIELDS, each within RULE_RANGES (hue and glyph are not part of a mix)
//   matrix: 25 numbers in [-4, 4], row-major interaction matrix (row acts on column)
//   neighborRadius: number in [0.05, 0.5]
//   simulationRate: 'full' | 'half'
//   knobs (optional): map of lab slider values; only the names in KNOB_RANGES, each a finite number
//          inside its range; a lab applies them through SpawnPressure.setRamp, the Simulation
//          setters (spawn band, density bias, burst particles, same-species cohesion 0 or 1) and the
//          renderer settings (effects, shake and trails in percent).
// The encoded text is the compact JSON as URL-safe base64 without padding.
import { SPECIES_COUNT } from '../sim/layout.js';
import { defaultMatrix, defaultSpecies } from '../sim/species.js';

export const MIX_VERSION = 1;
export const SAVED_MIXES_KEY = 'murmuration.mixes.v1';
export const RULE_FIELDS = ['seek', 'cohesion', 'alignment', 'separation', 'maximumSpeed', 'maximumTurn', 'orbitRadius', 'flee', 'pressure', 'targetDensity'];

const RULE_RANGES = {
  seek: [0, 5], cohesion: [0, 5], alignment: [0, 5], separation: [0, 5], maximumSpeed: [0, 20],
  maximumTurn: [0, 5], orbitRadius: [0, 8], flee: [0, 10], pressure: [0, 5], targetDensity: [0, 200],
};
const MATRIX_RANGE = [-4, 4];
const NEIGHBOR_RADIUS_RANGE = [0.05, 0.5];
const SIMULATION_RATES = ['full', 'half'];
export const KNOB_RANGES = {
  floorFraction: [0, 1], rampSeconds: [1, 3600], ceilingFraction: [0, 1], curveExponent: [0.1, 8],
  seekFloorFraction: [0, 1], spawnDistanceStartFraction: [0.25, 0.5], refillFractionPerSecond: [0, 1],
  spawnBandWidth: [0.05, 4.5], spawnDensityBias: [0, 1], killBurstParticles: [0, 64], sameSpeciesCohesion: [0, 1],
  effects: [0, 300], shake: [0, 300], trails: [0, 300],
};
const TOP_LEVEL_KEYS = ['version', 'shares', 'rules', 'matrix', 'neighborRadius', 'simulationRate', 'knobs'];

function inRange(value, [minimum, maximum]) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validKnobs(knobs) {
  if (!isPlainObject(knobs)) return false;
  return Object.entries(knobs).every(([name, value]) => Object.hasOwn(KNOB_RANGES, name) && inRange(value, KNOB_RANGES[name]));
}

function validRules(rules) {
  return Array.isArray(rules) && rules.length === SPECIES_COUNT && rules.every((row) =>
    Array.isArray(row) && row.length === RULE_FIELDS.length && row.every((value, index) => inRange(value, RULE_RANGES[RULE_FIELDS[index]])));
}

function validShares(shares) {
  return Array.isArray(shares) && shares.length === SPECIES_COUNT
    && shares.every((share) => inRange(share, [0, Number.MAX_VALUE])) && shares.some((share) => share > 0);
}

export function isValidMix(mix) {
  if (!isPlainObject(mix)) return false;
  if (!Object.keys(mix).every((key) => TOP_LEVEL_KEYS.includes(key))) return false;
  return mix.version === MIX_VERSION
    && validShares(mix.shares)
    && validRules(mix.rules)
    && Array.isArray(mix.matrix) && mix.matrix.length === SPECIES_COUNT * SPECIES_COUNT && mix.matrix.every((value) => inRange(value, MATRIX_RANGE))
    && inRange(mix.neighborRadius, NEIGHBOR_RADIUS_RANGE)
    && SIMULATION_RATES.includes(mix.simulationRate)
    && (mix.knobs === undefined || validKnobs(mix.knobs));
}

export function encodeMix(mix) {
  return btoa(JSON.stringify(mix)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

// The mix, or null on any error (bad base64, bad JSON, wrong shape or version, out-of-range numbers).
export function decodeMix(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/');
    const mix = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
    return isValidMix(mix) ? mix : null;
  } catch {
    return null;
  }
}

function mixFrom(shares) {
  return {
    version: MIX_VERSION,
    shares,
    rules: defaultSpecies().map((row) => RULE_FIELDS.map((field) => row[field])),
    matrix: Array.from(defaultMatrix()),
    neighborRadius: 0.1,
    simulationRate: 'full',
  };
}

// Built from the shipped species rows and matrix; only the shares differ from the default.
// Species order: Chaser, Orbiter, Skittish, Lattice, Predator.
export const BUNDLED_MIXES = Object.freeze({
  allChasers: mixFrom([1, 0, 0, 0, 0]),
  mixedFive: mixFrom([0.3, 0.2, 0.2, 0.2, 0.1]),
  predatorsVsPrey: mixFrom([0.35, 0, 0.35, 0.1, 0.2]),
  latticeStorm: mixFrom([0.1, 0.05, 0.05, 0.75, 0.05]),
  default: mixFrom([0.2, 0.2, 0.2, 0.2, 0.2]),
});

function loadSaved(store) {
  try {
    const parsed = JSON.parse(store?.getItem(SAVED_MIXES_KEY) ?? 'null');
    if (!isPlainObject(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([name, mix]) => !Object.hasOwn(BUNDLED_MIXES, name) && isValidMix(mix)));
  } catch {
    return {};
  }
}

// Persists a valid mix under a trimmed name that is not a bundled name; false when refused or storage fails.
export function saveMix(store, name, mix) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || Object.hasOwn(BUNDLED_MIXES, trimmed) || !isValidMix(mix)) return false;
  try {
    store.setItem(SAVED_MIXES_KEY, JSON.stringify({ ...loadSaved(store), [trimmed]: mix }));
    return true;
  } catch {
    return false;
  }
}

// Bundled names first, then saved names in save order.
export function listMixes(store) {
  return [...Object.keys(BUNDLED_MIXES), ...Object.keys(loadSaved(store))];
}

export function loadMix(store, name) {
  return BUNDLED_MIXES[name] ?? loadSaved(store)[name] ?? null;
}
