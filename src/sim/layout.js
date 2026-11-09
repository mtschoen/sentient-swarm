// CPU-side layout constants shared by every simulation shader and buffer allocation.
import { PROJECTILE_KINDS } from '../game/weaponTypes.js';

export const ARENA_WIDTH = 16;
export const ARENA_HEIGHT = 9;
export const SPECIES_COUNT = 5;
export const AGENT_STRIDE_BYTES = 32;
export const COARSE_COLUMNS = 64;
export const COARSE_ROWS = 36;
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

// The playable arena for a canvas aspect (width over height; owner ruling 2026-11-08: the game
// fills the window at any aspect, no letterbox): the largest rectangle of that aspect inside the
// 16 by 9 world, centered in it. A 16:9 canvas plays the whole world; a narrower one plays a
// centered column of the full height, a wider one a centered strip of the full width. Aspects
// outside [MINIMUM_ARENA_ASPECT, MAXIMUM_ARENA_ASPECT] are clamped (the viewport letterboxes the
// rest), so the arena never gets thinner than 2.25 world units. A non-positive or non-finite aspect
// gives the whole world. Returns { minX, minY, maxX, maxY, width, height } in world units; the
// world's coarse field and neighbor grid still cover the whole 16 by 9.
export const MINIMUM_ARENA_ASPECT = 0.25;
export const MAXIMUM_ARENA_ASPECT = 4;

export function arenaBoundsForAspect(aspect) {
  const fallback = ARENA_WIDTH / ARENA_HEIGHT;
  const requested = Number.isFinite(aspect) && aspect > 0 ? aspect : fallback;
  const ratio = Math.min(MAXIMUM_ARENA_ASPECT, Math.max(MINIMUM_ARENA_ASPECT, requested));
  const width = Math.min(ARENA_WIDTH, ARENA_HEIGHT * ratio);
  const height = Math.min(ARENA_HEIGHT, ARENA_WIDTH / ratio);
  const minX = (ARENA_WIDTH - width) / 2;
  const minY = (ARENA_HEIGHT - height) / 2;
  return Object.freeze({ minX, minY, maxX: minX + width, maxY: minY + height, width, height });
}

// The whole world: what a 16:9 canvas plays, and the default wherever no bounds have been set.
export const FULL_ARENA_BOUNDS = arenaBoundsForAspect(ARENA_WIDTH / ARENA_HEIGHT);

export function gridDimensions(neighborRadius) {
  const cellSize = neighborRadius;
  const columns = Math.ceil(ARENA_WIDTH / cellSize);
  const rows = Math.ceil(ARENA_HEIGHT / cellSize);
  return { columns, rows, cellSize, cellCount: columns * rows };
}

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
};
export const STATS_PERSISTENT_WORD = 16;
export const STATS_WORD_COUNT = 24;

// Token values for substituteConstants on common.wgsl and every compute shader.
export const SHADER_CONSTANTS = {
  WORKGROUP_SIZE,
  SPECIES_COUNT,
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
