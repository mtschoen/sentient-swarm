// Packs the SimParams uniform. Byte layout matches the table at the top of common.wgsl.
import { ARENA_HEIGHT, SPECIES_COUNT } from './layout.js';

export const SIM_PARAMS_BYTES = 240;

// Particles per kill (owner ruling R12, task C0b); the kill passes scale it down only when a step's
// kills would outrun the free particle slots.
export const DEFAULT_KILL_BURST_PARTICLES = 12;
// Depth in world units of the band along the walls where new agents appear (owner ruling R13);
// the integrate pass's 0.5 wall margin pushes them inward. Half the arena height or more covers
// the whole arena (the uniform spawn of Plan A).
export const DEFAULT_SPAWN_BAND_WIDTH = 0.6;
// 0 to 1: the chance that a spawn takes the densest of its candidate positions rather than the
// first, so new agents join existing masses at the walls instead of refilling cleared space.
export const DEFAULT_SPAWN_DENSITY_BIAS = 0.5;
// A lab ceiling on the burst size, well past the default.
export const MAXIMUM_KILL_BURST_PARTICLES = 64;
// Heavy slow fragments per kill beside the sparks (owner ruling R21, task C0b2); a kill asks for
// killBurstParticles + killFragmentParticles particles in all.
export const DEFAULT_KILL_FRAGMENT_PARTICLES = 3;
export const MAXIMUM_KILL_FRAGMENT_PARTICLES = 16;
// Particles of the player death flood (R21), emitted at the ship in the death clear's step.
export const DEFAULT_DEATH_FLOOD_PARTICLES = 480;
export const MAXIMUM_DEATH_FLOOD_PARTICLES = 4096;
// Steering and wall knobs (task C6b fix round 1, lab only); the defaults are the constants
// integrate.wgsl and steer.wgsl used before they became SimParams fields.
// Depth in world units of the band along each wall where integrate pushes agents inward.
export const DEFAULT_WALL_MARGIN = 0.5;
export const MAXIMUM_WALL_MARGIN = 2;
// Velocity change per second per world unit of penetration into the wall margin.
export const DEFAULT_WALL_STIFFNESS = 40;
export const MAXIMUM_WALL_STIFFNESS = 160;
// Straight seek fades to zero inside this distance from the player (0 turns the fade off).
export const DEFAULT_COMFORT_RADIUS = 1;
export const MAXIMUM_COMFORT_RADIUS = 4;
// Gate table rows in SimParams (MAXIMUM_SPAWN_GATES in spawn-director.js).
export const SIM_PARAMS_GATES = 4;

// Range checks for the setters above (Simulation.setKillBurstParticles and friends): each returns
// its value or throws RangeError.
export function validatedKillBurstParticles(count) {
  if (!(Number.isInteger(count) && count >= 0 && count <= MAXIMUM_KILL_BURST_PARTICLES)) {
    throw new RangeError(`killBurstParticles must be an integer in [0, ${MAXIMUM_KILL_BURST_PARTICLES}], got ${count}`);
  }
  return count;
}

function validatedCount(name, count, maximum) {
  if (!(Number.isInteger(count) && count >= 0 && count <= maximum)) throw new RangeError(`${name} must be an integer in [0, ${maximum}], got ${count}`);
  return count;
}

export function validatedKillFragmentParticles(count) {
  return validatedCount('killFragmentParticles', count, MAXIMUM_KILL_FRAGMENT_PARTICLES);
}

export function validatedDeathFloodParticles(count) {
  return validatedCount('deathFloodParticles', count, MAXIMUM_DEATH_FLOOD_PARTICLES);
}

export function validatedSpawnBandWidth(width) {
  if (!(width > 0 && width <= ARENA_HEIGHT / 2)) throw new RangeError(`spawnBandWidth must lie in (0, ${ARENA_HEIGHT / 2}], got ${width}`);
  return width;
}

export function validatedSpawnDensityBias(bias) {
  if (!(bias >= 0 && bias <= 1)) throw new RangeError(`spawnDensityBias must lie in [0, 1], got ${bias}`);
  return bias;
}

function validatedRange(name, value, maximum) {
  if (!(value >= 0 && value <= maximum)) throw new RangeError(`${name} must lie in [0, ${maximum}], got ${value}`);
  return value;
}

export function validatedWallMargin(margin) {
  return validatedRange('wallMargin', margin, MAXIMUM_WALL_MARGIN);
}

export function validatedWallStiffness(stiffness) {
  return validatedRange('wallStiffness', stiffness, MAXIMUM_WALL_STIFFNESS);
}

export function validatedComfortRadius(radius) {
  return validatedRange('comfortRadius', radius, MAXIMUM_COMFORT_RADIUS);
}

const FLOAT_FIELDS = { dt: 0, time: 4, neighborRadius: 16, cellSize: 28, debugKillRadius: 80, playerRadius: 92 };
const UNSIGNED_FIELDS = {
  gridColumns: 20, gridRows: 24, capacity: 32, frameSequence: 84,
  playerInvulnerable: 96, acknowledgedHitSequence: 100, killAllRequested: 104,
};
// 1 steers cohesion up the own-species density gradient, 0 up the total-density gradient.
const SAME_SPECIES_COHESION_OFFSET = 88;
// Multiplier on every species' seek weight (SpawnPressure.seekScale); 1, full seek, when omitted.
const SEEK_SCALE_OFFSET = 108;
// Minimum spawn distance from the player as a fraction of the arena width (SpawnPressure); the
// spec's quarter when omitted.
const SPAWN_DISTANCE_FRACTION_OFFSET = 36;
const KILL_BURST_PARTICLES_OFFSET = 112;
const SPAWN_BAND_WIDTH_OFFSET = 116;
const SPAWN_DENSITY_BIAS_OFFSET = 120;
const KILL_FRAGMENT_PARTICLES_OFFSET = 124;
// Gate rows: vec4f (x, y, radius, emission) each, then one u32 favored species per gate.
const SPAWN_GATES_OFFSET = 128;
const SPAWN_GATE_SPECIES_OFFSET = 192;
const SPAWN_GATE_COUNT_OFFSET = 208;
const SPAWN_GATE_SPECIES_BIAS_OFFSET = 212;
const DEATH_FLOOD_PARTICLES_OFFSET = 216;
const WALL_MARGIN_OFFSET = 220;
const WALL_STIFFNESS_OFFSET = 224;
const COMFORT_RADIUS_OFFSET = 228;
// 1 (the default) applies the coarse-field pressure term in steer.wgsl, 0 leaves it out.
const COARSE_FIELD_PRESSURE_OFFSET = 232;
const VECTOR_FIELDS = { playerPosition: 8, debugKillPosition: 40 };
const SPAWN_PER_SPECIES_OFFSET = 48;

export function packSimParams(values) {
  const buffer = new ArrayBuffer(SIM_PARAMS_BYTES);
  const view = new DataView(buffer);
  for (const [name, offset] of Object.entries(FLOAT_FIELDS)) {
    view.setFloat32(offset, values[name] ?? 0, true);
  }
  for (const [name, offset] of Object.entries(UNSIGNED_FIELDS)) {
    view.setUint32(offset, values[name] ?? 0, true);
  }
  for (const [name, offset] of Object.entries(VECTOR_FIELDS)) {
    const vector = values[name] ?? [0, 0];
    view.setFloat32(offset, vector[0], true);
    view.setFloat32(offset + 4, vector[1], true);
  }
  view.setUint32(SAME_SPECIES_COHESION_OFFSET, values.sameSpeciesCohesion ?? 1, true);
  view.setFloat32(SEEK_SCALE_OFFSET, values.seekScale ?? 1, true);
  view.setFloat32(SPAWN_DISTANCE_FRACTION_OFFSET, values.spawnDistanceFraction ?? 0.25, true);
  view.setUint32(KILL_BURST_PARTICLES_OFFSET, values.killBurstParticles ?? DEFAULT_KILL_BURST_PARTICLES, true);
  view.setFloat32(SPAWN_BAND_WIDTH_OFFSET, values.spawnBandWidth ?? DEFAULT_SPAWN_BAND_WIDTH, true);
  view.setFloat32(SPAWN_DENSITY_BIAS_OFFSET, values.spawnDensityBias ?? DEFAULT_SPAWN_DENSITY_BIAS, true);
  view.setUint32(KILL_FRAGMENT_PARTICLES_OFFSET, values.killFragmentParticles ?? DEFAULT_KILL_FRAGMENT_PARTICLES, true);
  view.setUint32(DEATH_FLOOD_PARTICLES_OFFSET, values.deathFloodParticles ?? 0, true);
  view.setFloat32(WALL_MARGIN_OFFSET, values.wallMargin ?? DEFAULT_WALL_MARGIN, true);
  view.setFloat32(WALL_STIFFNESS_OFFSET, values.wallStiffness ?? DEFAULT_WALL_STIFFNESS, true);
  view.setFloat32(COMFORT_RADIUS_OFFSET, values.comfortRadius ?? DEFAULT_COMFORT_RADIUS, true);
  view.setUint32(COARSE_FIELD_PRESSURE_OFFSET, values.coarseFieldPressure ?? 1, true);
  // spawnGates: { gates: [{ x, y, radius, emit, species }], speciesBias } or none (wall band spawns).
  const gates = values.spawnGates?.gates ?? [];
  if (gates.length > SIM_PARAMS_GATES) throw new Error('spawnGates has ' + gates.length + ' gates; at most ' + SIM_PARAMS_GATES);
  gates.forEach(({ x, y, radius, emit, species }, index) => {
    [x, y, radius, emit].forEach((value, component) => view.setFloat32(SPAWN_GATES_OFFSET + index * 16 + component * 4, value, true));
    view.setUint32(SPAWN_GATE_SPECIES_OFFSET + index * 4, species, true);
  });
  view.setUint32(SPAWN_GATE_COUNT_OFFSET, gates.length, true);
  view.setFloat32(SPAWN_GATE_SPECIES_BIAS_OFFSET, values.spawnGates?.speciesBias ?? 0, true);
  // spawnPerSpecies0 holds species 0 to 3, spawnPerSpecies1.x holds species 4; the rest stays 0.
  const spawnPerSpecies = values.spawnPerSpecies ?? [];
  if (spawnPerSpecies.length > SPECIES_COUNT) {
    throw new Error('spawnPerSpecies has ' + spawnPerSpecies.length + ' entries; at most ' + SPECIES_COUNT + ' species');
  }
  spawnPerSpecies.forEach((count, species) => {
    view.setUint32(SPAWN_PER_SPECIES_OFFSET + species * 4, count, true);
  });
  return buffer;
}
