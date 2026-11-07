// Shared header prepended to every compute shader. Structs, constants and functions only:
// no entry points, no bindings. Double-underscore tokens are replaced by substituteConstants.

const WORKGROUP_SIZE: u32 = __WORKGROUP_SIZE__u;
const SPECIES_COUNT: u32 = __SPECIES_COUNT__u;
const MAXIMUM_NEIGHBOR_SAMPLES: u32 = __MAXIMUM_NEIGHBOR_SAMPLES__u;
const COARSE_COLUMNS: u32 = __COARSE_COLUMNS__u;
const COARSE_ROWS: u32 = __COARSE_ROWS__u;
const COARSE_CHANNELS: u32 = __COARSE_CHANNELS__u;
const THREAT_FIXED_POINT_SCALE: f32 = 256.0;

const ARENA_WIDTH: f32 = 16.0;
const ARENA_HEIGHT: f32 = 9.0;

const FLAG_ALIVE: u32 = 1u;
const SPAWN_FRAMES_SHIFT: u32 = 8u;
const SPAWN_FRAMES_MASK: u32 = 255u;

// 32 bytes, 16-byte aligned for storage arrays.
struct Agent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: u32,
  phase: f32,
  hueJitter: f32,
}

// Uniform layout (byte offsets), total 96 bytes:
//   0 dt                 f32
//   4 time               f32
//   8 playerPosition     vec2f
//  16 neighborRadius     f32
//  20 gridColumns        u32
//  24 gridRows           u32
//  28 cellSize           f32
//  32 capacity           u32
//  36 aliveTarget        u32
//  40 debugKillPosition  vec2f
//  48 spawnPerSpecies0   vec4u (species 0 to 3)
//  64 spawnPerSpecies1   vec4u (species 4 in .x, rest 0)
//  80 debugKillRadius    f32
//  84 frameSequence      u32
//  88 padding0           u32
//  92 padding1           u32
struct SimParams {
  dt: f32,
  time: f32,
  playerPosition: vec2f,
  neighborRadius: f32,
  gridColumns: u32,
  gridRows: u32,
  cellSize: f32,
  capacity: u32,
  aliveTarget: u32,
  debugKillPosition: vec2f,
  spawnPerSpecies0: vec4u,
  spawnPerSpecies1: vec4u,
  debugKillRadius: f32,
  frameSequence: u32,
  padding0: u32,
  padding1: u32,
}

// Bit 0 alive, bits 8..15 spawn-in frames remaining.
fn isAlive(flags: u32) -> bool {
  return (flags & FLAG_ALIVE) != 0u;
}

fn spawnFramesRemaining(flags: u32) -> u32 {
  return (flags >> SPAWN_FRAMES_SHIFT) & SPAWN_FRAMES_MASK;
}

fn clampToArena(position: vec2f) -> vec2f {
  return clamp(position, vec2f(0.0, 0.0), vec2f(ARENA_WIDTH, ARENA_HEIGHT));
}

fn cellIndexFor(position: vec2f, params: SimParams) -> u32 {
  let clamped = clampToArena(position);
  let column = min(u32(clamped.x / params.cellSize), params.gridColumns - 1u);
  let row = min(u32(clamped.y / params.cellSize), params.gridRows - 1u);
  return column + row * params.gridColumns;
}

fn coarseCellIndexFor(position: vec2f) -> u32 {
  let clamped = clampToArena(position);
  let column = min(u32(clamped.x / ARENA_WIDTH * f32(COARSE_COLUMNS)), COARSE_COLUMNS - 1u);
  let row = min(u32(clamped.y / ARENA_HEIGHT * f32(COARSE_ROWS)), COARSE_ROWS - 1u);
  return column + row * COARSE_COLUMNS;
}

// Coarse field channels: species densities 0..4 (agents per coarse cell), threat at 5, 6 and 7 padding.
const THREAT_CHANNEL: u32 = 5u;

fn coarseCellCoordinate(position: vec2f) -> vec2i {
  let cell = coarseCellIndexFor(position);
  return vec2i(i32(cell % COARSE_COLUMNS), i32(cell / COARSE_COLUMNS));
}

// Species table (packSpeciesTable in species.js): SPECIES_COUNT rows of SPECIES_FIELD_COUNT floats,
// then the SPECIES_COUNT by SPECIES_COUNT interaction matrix at SPECIES_MATRIX_OFFSET.
// Field indices follow SPECIES_FIELDS order.
const SPECIES_FIELD_COUNT: u32 = 12u;
const SPECIES_MATRIX_OFFSET: u32 = 60u;
const FIELD_SEEK: u32 = 0u;
const FIELD_COHESION: u32 = 1u;
const FIELD_ALIGNMENT: u32 = 2u;
const FIELD_SEPARATION: u32 = 3u;
const FIELD_MAXIMUM_SPEED: u32 = 4u;
const FIELD_MAXIMUM_TURN: u32 = 5u;
const FIELD_ORBIT_RADIUS: u32 = 6u;
const FIELD_FLEE: u32 = 7u;
const FIELD_PRESSURE: u32 = 8u;
const FIELD_TARGET_DENSITY: u32 = 9u;

// Index helpers only: common.wgsl declares no bindings, so the shader that binds the table
// wraps these in speciesField and matrixWeight.
fn speciesFieldIndex(species: u32, fieldIndex: u32) -> u32 {
  return species * SPECIES_FIELD_COUNT + fieldIndex;
}

fn matrixWeightIndex(species: u32, other: u32) -> u32 {
  return SPECIES_MATRIX_OFFSET + species * SPECIES_COUNT + other;
}
