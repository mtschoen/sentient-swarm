// Kill-all (smart bomb and the death clear), one thread per agent slot, run only in the step that
// requested it (params.killAllRequested == 1), after integrate and before any other kill pass.
// The clear is total: spawning agents die too. atomicAnd clears every alive bit and only a thread
// that saw the bit set counts the kill, into killsUnscored (these kills never score). Every
// PARTICLE_SLOT_STRIDE-th slot that dies splashes KILL_PARTICLE_COUNT particles in its species hue,
// which bounds the particle flood, and every kill adds 1 / THREAT_KILLS_PER_UNIT of a threat unit
// to its coarse cell (one unit per THREAT_KILLS_PER_UNIT kills per cell, in fixed point).
// The barrier sits outside every branch; threads past capacity still reach it.
//
// Storage buffers: agents, stats, particles (pool cursor in its header), threat accumulator,
// species table = 5; uniform: params.

// Same 32-byte layout as Agent with the flags word atomic.
struct AtomicAgent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: atomic<u32>,
  phase: f32,
  hueJitter: f32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(3) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(4) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> speciesTable: array<f32>;

const PARTICLE_SLOT_STRIDE: u32 = 8u;
const KILL_PARTICLE_COUNT: u32 = 4u;
const THREAT_KILLS_PER_UNIT: u32 = 64u;
const THREAT_PER_KILL: u32 = u32(THREAT_FIXED_POINT_SCALE) / THREAT_KILLS_PER_UNIT;

var<workgroup> workgroupKills: atomic<u32>;

fn emitKillParticles(slot: u32, position: vec2f, species: u32, hueJitter: f32) {
  let capacity = arrayLength(&pool.particles);
  let first = atomicAdd(&pool.cursor, KILL_PARTICLE_COUNT) % capacity;
  let color = killParticleColor(speciesTable[speciesFieldIndex(species, SPECIES_FIELD_HUE)], hueJitter);
  var randomState = pcgHash(slot ^ pcgHash(params.frameSequence * 2u + 1u));
  let rotation = nextRandom(&randomState) * TAU;
  for (var index = 0u; index < KILL_PARTICLE_COUNT; index = index + 1u) {
    let angle = rotation + f32(index) * TAU / f32(KILL_PARTICLE_COUNT);
    pool.particles[(first + index) % capacity] = killParticle(position, angle, color, &randomState);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity && params.killAllRequested != 0u) {
    let previousFlags = atomicAnd(&agents[slot].flags, ~FLAG_ALIVE);
    if (isAlive(previousFlags)) {
      atomicAdd(&workgroupKills, 1u);
      let position = agents[slot].position;
      if (slot % PARTICLE_SLOT_STRIDE == 0u) {
        emitKillParticles(slot, position, min(agents[slot].species, SPECIES_COUNT - 1u), agents[slot].hueJitter);
      }
      atomicAdd(&threatAccumulator[coarseCellIndexFor(position)], THREAT_PER_KILL);
    }
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let kills = atomicLoad(&workgroupKills);
    if (kills > 0u) {
      atomicAdd(&stats[STAT_KILLS_UNSCORED], kills);
    }
  }
}
