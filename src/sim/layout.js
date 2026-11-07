// CPU-side layout constants shared by every simulation shader and buffer allocation.
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

export function gridDimensions(neighborRadius) {
  const cellSize = neighborRadius;
  const columns = Math.ceil(ARENA_WIDTH / cellSize);
  const rows = Math.ceil(ARENA_HEIGHT / cellSize);
  return { columns, rows, cellSize, cellCount: columns * rows };
}

export function agentBufferBytes(capacity) {
  return capacity * AGENT_STRIDE_BYTES;
}
