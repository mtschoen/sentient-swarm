// CPU-side layout constants shared by every simulation shader and buffer allocation. The world's
// size and the derived coarse field and grid sizes live in world.js and are re-exported here.
import { PROJECTILE_KINDS } from '../game/weaponTypes.js';
import { COARSE_COLUMNS, COARSE_ROWS, WORLD_HEIGHT, WORLD_WIDTH } from './world.js';

export * from './world.js';
export const SPECIES_COUNT = 5;
export const AGENT_STRIDE_BYTES = 32;
export const COARSE_CHANNELS = 8;
export const MAXIMUM_NEIGHBOR_SAMPLES = 32;
export const WORKGROUP_SIZE = 256;

// Agent struct: position vec2f, velocity vec2f, species u32, flags u32, phase f32, hueJitter f32.
export const AGENT_OFFSETS = { position: 0, velocity: 8, species: 16, flags: 20, phase: 24, hueJitter: 28 };
export const AGENT_FLAG_ALIVE = 1;
export const AGENT_SPAWN_FRAMES_SHIFT = 8;
export const AGENT_SPAWN_FRAMES_MASK = 0xff00;
// Projectile struct flags bit 0 (common.wgsl).
export const PROJECTILE_FLAG_ALIVE = 1;
// Bit 1: a pulse ring made by a sidewinder detonation (drawn in the sidewinder hue).
export const PROJECTILE_FLAG_MISSILE_RING = 2;

export function agentBufferBytes(capacity) {
  return capacity * AGENT_STRIDE_BYTES;
}

// Stats buffer words (u32). Words below STATS_PERSISTENT_WORD are per frame: the step clears them
// before any pass runs. Words from STATS_PERSISTENT_WORD on persist across steps (the clear skips
// them) and carry cross-frame state: the cumulative scored kills and the player hit latch. Both regions keep spare words
// so later stats extend the layout without moving existing indices.
export const STATS_INDICES = {
  aliveTotal: 0,
  firstSpecies: 1,
  frameSequence: 7,
  killsUnscored: 8,
  // Pulse rings detonated this step (projectiles_step.wgsl), and the position (f32 bits) of the
  // ring that took count 0, so the pair always comes from one ring.
  ringsThisFrame: 9,
  lastRingX: 10,
  lastRingY: 11,
  playerHitSequence: 16,
  hitLatch: 17,
  kills: 18,
  // Player swarm contact (player_collide.wgsl): bit s % 32 of word swarmHitMask + s / 32 (8 words,
  // MAXIMUM_SWARM_SHIPS bits) is set when an agent touched swarm ship slot s; the pass clears a
  // slot's bit while the slot is dead or in its first uploaded step.
  swarmHitMask: 24,
};
export const STATS_PERSISTENT_WORD = 16;
export const STATS_WORD_COUNT = 32;
// Player swarm slots (src/game/player-swarm.js): the contact uniform and the hit mask hold this many.
export const MAXIMUM_SWARM_SHIPS = 256;
export const SWARM_HIT_MASK_WORDS = MAXIMUM_SWARM_SHIPS / 32;

// Token values for substituteConstants on common.wgsl and every compute shader.
export const SHADER_CONSTANTS = {
  WORKGROUP_SIZE,
  SPECIES_COUNT,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  MAXIMUM_NEIGHBOR_SAMPLES,
  COARSE_COLUMNS,
  COARSE_ROWS,
  COARSE_CHANNELS,
  STATS_WORD_COUNT,
  STAT_ALIVE_TOTAL: STATS_INDICES.aliveTotal,
  STAT_FIRST_SPECIES: STATS_INDICES.firstSpecies,
  STAT_KILLS: STATS_INDICES.kills,
  STAT_FRAME_SEQUENCE: STATS_INDICES.frameSequence,
  STAT_KILLS_UNSCORED: STATS_INDICES.killsUnscored,
  STAT_RINGS_THIS_FRAME: STATS_INDICES.ringsThisFrame,
  STAT_LAST_RING_X: STATS_INDICES.lastRingX,
  STAT_LAST_RING_Y: STATS_INDICES.lastRingY,
  STAT_PLAYER_HIT_SEQUENCE: STATS_INDICES.playerHitSequence,
  STAT_HIT_LATCH: STATS_INDICES.hitLatch,
  STAT_SWARM_HIT_MASK: STATS_INDICES.swarmHitMask,
  MAXIMUM_SWARM_SHIPS,
  PROJECTILE_KIND_BULLET: PROJECTILE_KINDS.bullet,
  PROJECTILE_KIND_SCATTER: PROJECTILE_KINDS.scatter,
  PROJECTILE_KIND_RAIL: PROJECTILE_KINDS.rail,
  PROJECTILE_KIND_PULSE_ORB: PROJECTILE_KINDS.pulseOrb,
  PROJECTILE_KIND_PULSE_RING: PROJECTILE_KINDS.pulseRing,
  PROJECTILE_KIND_SIDEWINDER: PROJECTILE_KINDS.sidewinder,
  PROJECTILE_KIND_BEAM: PROJECTILE_KINDS.beam,
  PROJECTILE_FLAG_ALIVE,
  PROJECTILE_FLAG_MISSILE_RING,
};
