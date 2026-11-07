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

const TAU: f32 = 6.283185307;

// Stats buffer word indices (STATS_INDICES in layout.js). Words from STATS_PERSISTENT_WORD on
// survive the per-step clear.
const STATS_WORD_COUNT: u32 = __STATS_WORD_COUNT__u;
const STAT_ALIVE_TOTAL: u32 = __STAT_ALIVE_TOTAL__u;
const STAT_FIRST_SPECIES: u32 = __STAT_FIRST_SPECIES__u;
const STAT_KILLS: u32 = __STAT_KILLS__u;
const STAT_FRAME_SEQUENCE: u32 = __STAT_FRAME_SEQUENCE__u;
const STAT_KILLS_UNSCORED: u32 = __STAT_KILLS_UNSCORED__u;
const STAT_PLAYER_HIT_SEQUENCE: u32 = __STAT_PLAYER_HIT_SEQUENCE__u;
const STAT_HIT_LATCH: u32 = __STAT_HIT_LATCH__u;

const FLAG_ALIVE: u32 = 1u;
const SPAWN_FRAMES_SHIFT: u32 = 8u;
const SPAWN_FRAMES_MASK: u32 = 255u;
// Spawn-in frames a new agent starts with (spawn.wgsl); the glyph pass fades ships in over them.
const SPAWN_IN_FRAMES: u32 = 30u;

// 32 bytes, 16-byte aligned for storage arrays.
struct Agent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: u32,
  phase: f32,
  hueJitter: f32,
}

// Uniform layout (byte offsets), total 112 bytes:
//   0 dt                 f32
//   4 time               f32
//   8 playerPosition     vec2f
//  16 neighborRadius     f32
//  20 gridColumns        u32
//  24 gridRows           u32
//  28 cellSize           f32
//  32 capacity           u32
//  36 aliveTarget        u32 (reserved: written by no caller and read by no shader)
//  40 debugKillPosition  vec2f
//  48 spawnPerSpecies0   vec4u (species 0 to 3)
//  64 spawnPerSpecies1   vec4u (species 4 in .x, rest 0)
//  80 debugKillRadius    f32
//  84 frameSequence      u32
//  88 sameSpeciesCohesion u32 (1: own-species gradient, 0: total-density gradient)
//  92 playerRadius       f32 (player contact reach is playerRadius + 0.02)
//  96 playerInvulnerable u32 (1: contact never hits)
// 100 acknowledgedHitSequence u32 (newest hit frameSequence the CPU has read)
// 104 killAllRequested   u32 (1 only in the step that runs kill_all.wgsl)
// 108 padding1           u32
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
  sameSpeciesCohesion: u32,
  playerRadius: f32,
  playerInvulnerable: u32,
  acknowledgedHitSequence: u32,
  killAllRequested: u32,
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
const SPECIES_FIELD_HUE: u32 = 10u;

// Index helpers only: common.wgsl declares no bindings, so the shader that binds the table
// wraps these in speciesField and matrixWeight.
fn speciesFieldIndex(species: u32, fieldIndex: u32) -> u32 {
  return species * SPECIES_FIELD_COUNT + fieldIndex;
}

fn matrixWeightIndex(species: u32, other: u32) -> u32 {
  return SPECIES_MATRIX_OFFSET + species * SPECIES_COUNT + other;
}

// 32 bytes. color is packed rgba8 with r in the low byte. A slot with lifetime <= 0 or
// age >= lifetime is dead.
struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: u32,
  age: f32,
  lifetime: f32,
  padding: f32,
}

fn isParticleAlive(particle: Particle) -> bool {
  return particle.lifetime > 0.0 && particle.age < particle.lifetime;
}

// The particles buffer: a 16-byte header whose first word is the spawn cursor (killers claim
// slots with one atomicAdd, wrapping modulo the particle count), then the particles. Read-only
// views (the particle renderer) declare the same layout with a plain u32 cursor.
struct ParticlePool {
  cursor: atomic<u32>,
  headerPadding0: u32,
  headerPadding1: u32,
  headerPadding2: u32,
  particles: array<Particle>,
}

// 48 bytes, 16-byte aligned for storage arrays. flags bit 0 is alive. extra is the ring growth
// speed for a pulseRing, the detonation density threshold for a pulseOrb and the turn rate in
// radians per second for a sidewinder. A beam's velocity is its unit direction and its radius its
// half width.
struct Projectile {
  position: vec2f,
  previousPosition: vec2f,
  velocity: vec2f,
  radius: f32,
  lifetime: f32,
  kind: u32,
  flags: u32,
  seed: f32,
  extra: f32,
}

const PROJECTILE_KIND_BULLET: u32 = 0u;
const PROJECTILE_KIND_SCATTER: u32 = 1u;
const PROJECTILE_KIND_RAIL: u32 = 2u;
const PROJECTILE_KIND_PULSE_ORB: u32 = 3u;
const PROJECTILE_KIND_PULSE_RING: u32 = 4u;
const PROJECTILE_KIND_SIDEWINDER: u32 = 5u;
const PROJECTILE_KIND_BEAM: u32 = 6u;
const PROJECTILE_FLAG_ALIVE: u32 = 1u;

fn pcgHash(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// Advances the state and returns a float in [0, 1) built from its top 24 bits.
fn nextRandom(state: ptr<function, u32>) -> f32 {
  *state = pcgHash(*state);
  return f32(*state >> 8u) / 16777216.0;
}

fn hsvToRgb(hue: f32, saturation: f32, value: f32) -> vec3f {
  let offsets = fract(vec3f(hue) + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0));
  let ramps = clamp(abs(offsets * 6.0 - vec3f(3.0)) - vec3f(1.0), vec3f(0.0), vec3f(1.0));
  return value * mix(vec3f(1.0), ramps, saturation);
}

// Opaque rgba8 with r in the low byte.
fn packColor(rgb: vec3f) -> u32 {
  let channels = vec3u(clamp(rgb, vec3f(0.0), vec3f(1.0)) * 255.0 + vec3f(0.5));
  return channels.x | (channels.y << 8u) | (channels.z << 16u) | (255u << 24u);
}

// Kill splash particles, shared by every pass that kills agents: the agent's species hue shifted
// by its hueJitter, radiating at a random speed with a random lifetime.
const KILL_PARTICLE_MINIMUM_SPEED: f32 = 1.5;
const KILL_PARTICLE_SPEED_RANGE: f32 = 1.5;
const KILL_PARTICLE_MINIMUM_LIFETIME: f32 = 0.4;
const KILL_PARTICLE_LIFETIME_RANGE: f32 = 0.3;
const KILL_PARTICLE_HUE_JITTER_SPREAD: f32 = 0.05;
const KILL_PARTICLE_SATURATION: f32 = 0.8;

fn killParticleColor(hue: f32, hueJitter: f32) -> u32 {
  return packColor(hsvToRgb(fract(hue + KILL_PARTICLE_HUE_JITTER_SPREAD * hueJitter), KILL_PARTICLE_SATURATION, 1.0));
}

fn killParticle(position: vec2f, angle: f32, color: u32, randomState: ptr<function, u32>) -> Particle {
  var particle: Particle;
  particle.position = position;
  particle.velocity = vec2f(cos(angle), sin(angle)) * (KILL_PARTICLE_MINIMUM_SPEED + KILL_PARTICLE_SPEED_RANGE * nextRandom(randomState));
  particle.color = color;
  particle.age = 0.0;
  particle.lifetime = KILL_PARTICLE_MINIMUM_LIFETIME + KILL_PARTICLE_LIFETIME_RANGE * nextRandom(randomState);
  particle.padding = 0.0;
  return particle;
}

// Same 32-byte layout as Agent with the flags word atomic, for passes that kill agents.
struct AtomicAgent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: atomic<u32>,
  phase: f32,
  hueJitter: f32,
}

// One kill splash is `count` particles evenly spaced around a circle from a random rotation.
// Storage pointers cannot be function parameters, so each pass keeps a thin wrapper that claims
// slots on its own pool binding and fills them from this: seed comes from killBurstSeed and
// particle index of count is derived from it alone, so the particles are independent.
fn killBurstSeed(agentIndex: u32, frameSequence: u32) -> u32 {
  return pcgHash(agentIndex ^ pcgHash(frameSequence * 2u + 1u));
}

fn killBurstParticle(index: u32, count: u32, seed: u32, position: vec2f, color: u32) -> Particle {
  var rotationState = seed;
  let rotation = nextRandom(&rotationState) * TAU;
  var randomState = pcgHash(seed + index + 1u);
  let angle = rotation + f32(index) * TAU / f32(count);
  return killParticle(position, angle, color, &randomState);
}
