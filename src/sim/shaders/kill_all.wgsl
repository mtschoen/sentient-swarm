// Kill-all (smart bomb and the death clear), run only in the step that requested it
// (params.killAllRequested == 1), after integrate and before any other kill pass. Two entries,
// one thread per agent slot each:
// - countAlive: counts the alive agents (spawning ones included) into the particle pool header's
//   killAllAlive word (zeroed at the start of the step), one atomicAdd per workgroup.
// - main: the clear is total: spawning agents die too. atomicAnd clears every alive bit and only a
//   thread that saw the bit set counts the kill, into killsUnscored (these kills never score).
//   Every kill splashes params.killBurstParticles particles in its species hue while the free
//   particle slots (pool size minus liveCount) cover the whole clear; past that each kill's burst
//   is thinned (thinnedBurstCount, seeded per slot) to an expected free / killAllAlive particles,
//   so a clear through a full arena spreads the pool evenly over the arena instead of spending it
//   on the first slots. The step's shared budget (grantedParticleCount) still caps the total.
//   Every kill adds 1 / THREAT_KILLS_PER_UNIT of a threat unit to its coarse cell (one unit per
//   THREAT_KILLS_PER_UNIT kills per cell, in fixed point).
// The barriers sit outside every branch; threads past capacity still reach them.
//
// Storage buffers: agents, stats, particles (cursor and budget words in its header), threat
// accumulator, species table = 5; uniform: params.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(3) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(4) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> speciesTable: array<f32>;

const THREAT_KILLS_PER_UNIT: u32 = 64u;
const THREAT_PER_KILL: u32 = u32(THREAT_FIXED_POINT_SCALE) / THREAT_KILLS_PER_UNIT;

var<workgroup> workgroupKills: atomic<u32>;

// Claims up to requested particles from the step's shared budget (grantedParticleCount) and
// writes the granted ones radiating from position.
fn emitKillParticles(slot: u32, position: vec2f, species: u32, hueJitter: f32, requested: u32) {
  if (requested == 0u) {
    return;
  }
  let capacity = arrayLength(&pool.particles);
  let claimedBefore = atomicAdd(&pool.claimedThisStep, requested);
  let count = grantedParticleCount(requested, claimedBefore, atomicLoad(&pool.liveCount), capacity);
  if (count == 0u) {
    return;
  }
  let first = atomicAdd(&pool.cursor, count) % capacity;
  let color = killParticleColor(speciesTable[speciesFieldIndex(species, SPECIES_FIELD_HUE)], hueJitter);
  let seed = killBurstSeed(slot, params.frameSequence);
  for (var index = 0u; index < count; index = index + 1u) {
    pool.particles[(first + index) % capacity] = killBurstParticle(index, count, seed, position, color);
  }
}

var<workgroup> workgroupAlive: atomic<u32>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn countAlive(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity && isAlive(atomicLoad(&agents[slot].flags))) {
    atomicAdd(&workgroupAlive, 1u);
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let alive = atomicLoad(&workgroupAlive);
    if (alive > 0u) {
      atomicAdd(&pool.killAllAlive, alive);
    }
  }
}

// Particles this slot's kill asks for: the full burst while the free slots cover every kill,
// otherwise a thinned burst whose expected size shares the free slots evenly.
fn requestedParticles(slot: u32) -> u32 {
  let poolSize = arrayLength(&pool.particles);
  let free = poolSize - min(atomicLoad(&pool.liveCount), poolSize);
  let alive = max(atomicLoad(&pool.killAllAlive), 1u);
  let expected = min(f32(params.killBurstParticles), f32(free) / f32(alive));
  if (expected >= f32(params.killBurstParticles)) {
    return params.killBurstParticles;
  }
  var randomState = pcgHash(slot ^ pcgHash(params.frameSequence * 2u));
  return thinnedBurstCount(expected, nextRandom(&randomState));
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
      emitKillParticles(slot, position, min(agents[slot].species, SPECIES_COUNT - 1u), agents[slot].hueJitter, requestedParticles(slot));
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
