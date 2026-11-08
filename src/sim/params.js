// Packs the SimParams uniform. Byte layout matches the table at the top of common.wgsl.
import { SPECIES_COUNT } from './layout.js';

export const SIM_PARAMS_BYTES = 112;

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
