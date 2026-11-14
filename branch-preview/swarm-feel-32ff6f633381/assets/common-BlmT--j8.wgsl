// Shared header prepended to every compute shader. Structs, constants and functions only:
// no entry points, no bindings. Double-underscore tokens are replaced by substituteConstants.

const WORKGROUP_SIZE: u32 = __WORKGROUP_SIZE__u;
const SPECIES_COUNT: u32 = __SPECIES_COUNT__u;
const MAXIMUM_NEIGHBOR_SAMPLES: u32 = __MAXIMUM_NEIGHBOR_SAMPLES__u;
const COARSE_COLUMNS: u32 = __COARSE_COLUMNS__u;
const COARSE_ROWS: u32 = __COARSE_ROWS__u;
const COARSE_CHANNELS: u32 = __COARSE_CHANNELS__u;
// Coarse field buffers viewed as array<vec4f> hold each cell as a vec4 pair: channels 0..3, then 4..7.
const VECTORS_PER_CELL: u32 = COARSE_CHANNELS / 4u;
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
const STAT_RINGS_THIS_FRAME: u32 = __STAT_RINGS_THIS_FRAME__u;
const STAT_LAST_RING_X: u32 = __STAT_LAST_RING_X__u;
const STAT_LAST_RING_Y: u32 = __STAT_LAST_RING_Y__u;
const STAT_PLAYER_HIT_SEQUENCE: u32 = __STAT_PLAYER_HIT_SEQUENCE__u;
const STAT_HIT_LATCH: u32 = __STAT_HIT_LATCH__u;
// First of the two swarm hit mask words (low, then high).
const STAT_SWARM_HIT_MASK: u32 = __STAT_SWARM_HIT_MASK__u;
const MAXIMUM_SWARM_SHIPS: u32 = __MAXIMUM_SWARM_SHIPS__u;

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

// Uniform layout (byte offsets), total 256 bytes:
//   0 dt                 f32
//   4 time               f32
//   8 playerPosition     vec2f
//  16 neighborRadius     f32
//  20 gridColumns        u32
//  24 gridRows           u32
//  28 cellSize           f32
//  32 capacity           u32
//  36 spawnDistanceFraction f32 (minimum spawn distance from the player, of the arena bounds width)
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
// 108 seekScale          f32 (multiplier on every species' seek weight, from SpawnPressure)
// 112 killBurstParticles u32 (particles per kill before pool scaling)
// 116 spawnBandWidth     f32 (depth in world units of the wall band where spawns land)
// 120 spawnDensityBias   f32 (0 to 1: chance a spawn takes its densest candidate)
// 124 killFragmentParticles u32 (heavy fragments per kill, beside killBurstParticles sparks)
// 128 spawnGates         array<vec4f, 4> (x, y, radius, emission weight; SpawnDirector)
// 192 spawnGateSpecies   vec4u (favored species per gate)
// 208 spawnGateCount     u32 (rows in use; 0 spawns in the wall band)
// 212 spawnGateSpeciesBias f32 (0 to 1: how strongly a gate keeps to its favored species)
// 216 deathFloodParticles u32 (player death flood size, nonzero only in the death clear's step)
// 220 wallMargin         f32 (depth of the wall band where integrate pushes inward)
// 224 wallStiffness      f32 (velocity change per second per world unit of penetration)
// 228 comfortRadius      f32 (straight seek fades to zero inside it; 0 turns the fade off)
// 232 coarseFieldPressure u32 (1: steer applies the coarse-field pressure term, 0: it does not)
// 236 projectileDt       f32 (the projectile step's dt: unscaled real time during a time warp)
// 240 arenaBounds        vec4f (the playable arena inside the world: minX, minY, maxX, maxY)
struct SimParams {
  dt: f32,
  time: f32,
  playerPosition: vec2f,
  neighborRadius: f32,
  gridColumns: u32,
  gridRows: u32,
  cellSize: f32,
  capacity: u32,
  spawnDistanceFraction: f32,
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
  seekScale: f32,
  killBurstParticles: u32,
  spawnBandWidth: f32,
  spawnDensityBias: f32,
  killFragmentParticles: u32,
  spawnGates: array<vec4f, 4>,
  spawnGateSpecies: vec4u,
  spawnGateCount: u32,
  spawnGateSpeciesBias: f32,
  deathFloodParticles: u32,
  wallMargin: f32,
  wallStiffness: f32,
  comfortRadius: f32,
  coarseFieldPressure: u32,
  projectileDt: f32,
  arenaBounds: vec4f,
}

// Bit 0 alive, bits 8..15 spawn-in frames remaining.
fn isAlive(flags: u32) -> bool {
  return (flags & FLAG_ALIVE) != 0u;
}

fn spawnFramesRemaining(flags: u32) -> u32 {
  return (flags >> SPAWN_FRAMES_SHIFT) & SPAWN_FRAMES_MASK;
}

// The whole world, for cell indices; gameplay edges use clampToBounds.
fn clampToArena(position: vec2f) -> vec2f {
  return clamp(position, vec2f(0.0, 0.0), vec2f(ARENA_WIDTH, ARENA_HEIGHT));
}

// The playable arena, a sub-rectangle of the world (the whole world at a 16:9 canvas).
fn boundsSize(params: SimParams) -> vec2f {
  return params.arenaBounds.zw - params.arenaBounds.xy;
}

fn boundsCenter(params: SimParams) -> vec2f {
  return (params.arenaBounds.xy + params.arenaBounds.zw) * 0.5;
}

fn clampToBounds(position: vec2f, params: SimParams) -> vec2f {
  return clamp(position, params.arenaBounds.xy, params.arenaBounds.zw);
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
// age >= lifetime is dead. size multiplies the drawn quad (1 a spark, about 2.6 a heavy fragment,
// tens for the death flash; 0 draws as 1).
struct Particle {
  position: vec2f,
  velocity: vec2f,
  color: u32,
  age: f32,
  lifetime: f32,
  size: f32,
}

fn isParticleAlive(particle: Particle) -> bool {
  return particle.lifetime > 0.0 && particle.age < particle.lifetime;
}

// The particles buffer: a 16-byte header, then the particles. Header words:
//   cursor          the spawn cursor: killers claim slots with one atomicAdd, wrapping modulo the
//                   particle count;
//   liveCount       particles alive after the last particle step (it zeroes and recounts it);
//   claimedThisStep particles requested by this step's kills so far (the step zeroes it first);
//   killAllAlive    alive agents counted by kill_all.wgsl's count entry in a kill-all step (the
//                   step zeroes it first).
// Read-only views (the particle renderer) declare the same layout with plain u32 words.
struct ParticlePool {
  cursor: atomic<u32>,
  liveCount: atomic<u32>,
  claimedThisStep: atomic<u32>,
  killAllAlive: atomic<u32>,
  particles: array<Particle>,
}

// Kill bursts share one per-step budget, the slots that were free after the last particle step
// (pool size minus liveCount), so the step's bursts never ask for more particles than were free.
// The budget bounds only the count: slots are reused from the cursor, oldest first, so near a full
// pool a burst can still overwrite particles in flight at the cursor. A kill asks for requested
// particles after the step's kills before it asked for claimedBefore in total, and gets what is
// left of the budget, at most requested.
fn grantedParticleCount(requested: u32, claimedBefore: u32, liveCount: u32, poolSize: u32) -> u32 {
  let free = poolSize - min(liveCount, poolSize);
  if (claimedBefore >= free) {
    return 0u;
  }
  return min(requested, free - claimedBefore);
}

// A burst thinned to an expected size: at or above KILL_BURST_MINIMUM_PARTICLES it rounds
// stochastically to a neighboring integer; below it the kill emits a minimum-size burst with
// probability expected / minimum or none, so a thinned flood still reads as small bursts rather
// than single sparks. random lies in [0, 1).
const KILL_BURST_MINIMUM_PARTICLES: u32 = 4u;

fn thinnedBurstCount(expected: f32, random: f32) -> u32 {
  let minimum = f32(KILL_BURST_MINIMUM_PARTICLES);
  if (expected >= minimum) {
    return u32(floor(expected + random));
  }
  if (random * minimum < expected) {
    return KILL_BURST_MINIMUM_PARTICLES;
  }
  return 0u;
}

// 48 bytes, 16-byte aligned for storage arrays. flags bit 0 is alive. extra is the ring growth
// speed for a pulseRing, the detonation density threshold for a pulseOrb and the turn rate in
// radians per second for a sidewinder. A beam's velocity is its unit direction, its radius its
// half width, and (seed, extra) the previous step's unit direction, so the beam sweeps the sector
// between the two (equal on a beam's first step); its lifetime is never read.
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

// Kind numbers come from PROJECTILE_KINDS (weaponTypes.js) and the flag from PROJECTILE_FLAG_ALIVE
// (layout.js), through SHADER_CONSTANTS.
const PROJECTILE_KIND_BULLET: u32 = __PROJECTILE_KIND_BULLET__u;
const PROJECTILE_KIND_SCATTER: u32 = __PROJECTILE_KIND_SCATTER__u;
const PROJECTILE_KIND_RAIL: u32 = __PROJECTILE_KIND_RAIL__u;
const PROJECTILE_KIND_PULSE_ORB: u32 = __PROJECTILE_KIND_PULSE_ORB__u;
const PROJECTILE_KIND_PULSE_RING: u32 = __PROJECTILE_KIND_PULSE_RING__u;
const PROJECTILE_KIND_SIDEWINDER: u32 = __PROJECTILE_KIND_SIDEWINDER__u;
const PROJECTILE_KIND_BEAM: u32 = __PROJECTILE_KIND_BEAM__u;
const PROJECTILE_FLAG_ALIVE: u32 = __PROJECTILE_FLAG_ALIVE__u;
const PROJECTILE_FLAG_MISSILE_RING: u32 = __PROJECTILE_FLAG_MISSILE_RING__u;

// Pulse ring shape, shared by the orb detonation (projectiles_step.wgsl) and the sidewinder
// detonation (projectiles_collide.wgsl). A missile ring lives MISSILE_RING_LIFETIME, so it grows
// to half a pulse ring's radius.
const RING_START_RADIUS: f32 = 0.05;
const RING_LIFETIME: f32 = 0.5;
const MISSILE_RING_LIFETIME: f32 = 0.25;
// World units per second.
const RING_GROWTH_SPEED: f32 = 6.0;

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
// by its hueJitter. Sparks radiate fast and die young; heavy fragments (owner ruling R21, task
// C0b2) are larger, slower and live longer. value scales the color (kill-all floods use less, so a
// bomb through a full arena stays bright without washing out).
const KILL_PARTICLE_MINIMUM_SPEED: f32 = 1.5;
const KILL_PARTICLE_SPEED_RANGE: f32 = 1.5;
const KILL_PARTICLE_MINIMUM_LIFETIME: f32 = 0.4;
const KILL_PARTICLE_LIFETIME_RANGE: f32 = 0.3;
const KILL_FRAGMENT_MINIMUM_SPEED: f32 = 0.35;
const KILL_FRAGMENT_SPEED_RANGE: f32 = 0.6;
const KILL_FRAGMENT_MINIMUM_LIFETIME: f32 = 0.8;
const KILL_FRAGMENT_LIFETIME_RANGE: f32 = 0.5;
const KILL_FRAGMENT_SIZE: f32 = 2.6;
const KILL_PARTICLE_HUE_JITTER_SPREAD: f32 = 0.05;
const KILL_PARTICLE_SATURATION: f32 = 0.65;
// Kill-all bursts (bombs and the death clear) share a light budget: a clear that emits more than
// KILL_ALL_LIGHT_PARTICLES particles dims each one to that over the particles emitted (never under
// KILL_ALL_MINIMUM_VALUE), so a clear stays bright but its total light, and the arena mean, stays
// bounded whatever the crowd and pool size (task C0b2, finding 3).
const KILL_ALL_LIGHT_PARTICLES: f32 = 12000.0;
const KILL_ALL_MINIMUM_VALUE: f32 = 0.12;

fn killAllParticleValue(emitted: f32) -> f32 {
  return clamp(KILL_ALL_LIGHT_PARTICLES / max(emitted, 1.0), KILL_ALL_MINIMUM_VALUE, 1.0);
}

fn killParticleColor(hue: f32, hueJitter: f32, value: f32) -> u32 {
  return packColor(hsvToRgb(fract(hue + KILL_PARTICLE_HUE_JITTER_SPREAD * hueJitter), KILL_PARTICLE_SATURATION, value));
}

fn killParticle(position: vec2f, angle: f32, color: u32, randomState: ptr<function, u32>) -> Particle {
  var particle: Particle;
  particle.position = position;
  particle.velocity = vec2f(cos(angle), sin(angle)) * (KILL_PARTICLE_MINIMUM_SPEED + KILL_PARTICLE_SPEED_RANGE * nextRandom(randomState));
  particle.color = color;
  particle.age = 0.0;
  particle.lifetime = KILL_PARTICLE_MINIMUM_LIFETIME + KILL_PARTICLE_LIFETIME_RANGE * nextRandom(randomState);
  particle.size = 1.0;
  return particle;
}

fn killFragment(position: vec2f, color: u32, randomState: ptr<function, u32>) -> Particle {
  var particle: Particle;
  let angle = nextRandom(randomState) * TAU;
  particle.position = position;
  particle.velocity = vec2f(cos(angle), sin(angle)) * (KILL_FRAGMENT_MINIMUM_SPEED + KILL_FRAGMENT_SPEED_RANGE * nextRandom(randomState));
  particle.color = color;
  particle.age = 0.0;
  particle.lifetime = KILL_FRAGMENT_MINIMUM_LIFETIME + KILL_FRAGMENT_LIFETIME_RANGE * nextRandom(randomState);
  particle.size = KILL_FRAGMENT_SIZE;
  return particle;
}

// Heavy fragments in a granted burst of count particles: the requested fragments, but at most a
// quarter of the burst, so a thinned burst keeps mostly sparks.
fn fragmentsIn(count: u32, fragments: u32) -> u32 {
  return min(fragments, count / 4u);
}

// Player death flood (R21), from kill_all.wgsl in the death clear's step: particle 0 is a large
// white flash, particle 1 a smaller longer one, the rest a wide fast spray of hot white and warm
// particles of mixed sizes.
const DEATH_FLASH_SIZE: f32 = 70.0;
const DEATH_FLASH_LIFETIME: f32 = 0.22;
const DEATH_AFTERGLOW_SIZE: f32 = 28.0;
const DEATH_AFTERGLOW_LIFETIME: f32 = 0.5;

fn deathFloodParticle(index: u32, seed: u32, position: vec2f) -> Particle {
  var randomState = pcgHash(seed + index * 7919u + 3u);
  var particle: Particle;
  particle.position = position;
  particle.age = 0.0;
  if (index < 2u) {
    particle.velocity = vec2f(0.0, 0.0);
    particle.color = packColor(vec3f(1.0, 0.97, 0.92) * select(0.6, 1.0, index == 0u));
    particle.lifetime = select(DEATH_AFTERGLOW_LIFETIME, DEATH_FLASH_LIFETIME, index == 0u);
    particle.size = select(DEATH_AFTERGLOW_SIZE, DEATH_FLASH_SIZE, index == 0u);
    return particle;
  }
  let angle = nextRandom(&randomState) * TAU;
  let speedRandom = nextRandom(&randomState);
  particle.velocity = vec2f(cos(angle), sin(angle)) * (0.8 + 7.0 * speedRandom * speedRandom);
  particle.color = packColor(hsvToRgb(0.06 + 0.08 * nextRandom(&randomState), 0.45 * nextRandom(&randomState), 1.0));
  particle.lifetime = 0.6 + 1.0 * nextRandom(&randomState);
  particle.size = 1.0 + 2.0 * nextRandom(&randomState);
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

// One kill splash is `count` particles: the first fragmentsIn(count, fragments) are heavy
// fragments at random angles, the rest sparks evenly spaced around a circle from a random
// rotation. Storage pointers cannot be function parameters, so each pass keeps a thin wrapper
// that claims slots on its own pool binding and fills them from this: seed comes from
// killBurstSeed and particle index of count is derived from it alone, so the particles are
// independent.
fn killBurstSeed(agentIndex: u32, frameSequence: u32) -> u32 {
  return pcgHash(agentIndex ^ pcgHash(frameSequence * 2u + 1u));
}

fn killBurstParticle(index: u32, count: u32, fragments: u32, seed: u32, position: vec2f, color: u32) -> Particle {
  var rotationState = seed;
  let rotation = nextRandom(&rotationState) * TAU;
  var randomState = pcgHash(seed + index + 1u);
  let heavy = fragmentsIn(count, fragments);
  if (index < heavy) {
    return killFragment(position, color, &randomState);
  }
  let angle = rotation + f32(index - heavy) * TAU / f32(count - heavy);
  return killParticle(position, angle, color, &randomState);
}
