// Debug kill, one thread per agent slot, run on agentsOut after integrate and before stats.
// An agent is killed when it is alive, past its spawn-in frames (spawning agents cannot be
// killed), and within params.debugKillRadius of params.debugKillPosition. The alive bit is
// cleared with atomicAnd and the kill only counts when the old flags had it, so concurrent
// killers never double count. Each kill then:
//   adds 1 to the kills stat (reduced per workgroup, one global atomicAdd from thread 0),
//   asks for params.killBurstParticles particles from the step's shared particle budget
//   (grantedParticleCount in common.wgsl), claims the granted slots with one atomicAdd on the pool
//   cursor (wrapping modulo the pool capacity) and writes particles radiating from the agent in
//   its species hue,
//   adds one threat unit (THREAT_FIXED_POINT_SCALE fixed point) to its coarse cell.
// The barrier sits outside every branch; threads past capacity still reach it.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(3) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(4) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> speciesTable: array<f32>;


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

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity) {
    let flags = atomicLoad(&agents[slot].flags);
    let position = agents[slot].position;
    if (isAlive(flags) && spawnFramesRemaining(flags) == 0u && distance(position, params.debugKillPosition) <= params.debugKillRadius) {
      let previousFlags = atomicAnd(&agents[slot].flags, ~FLAG_ALIVE);
      if (isAlive(previousFlags)) {
        atomicAdd(&workgroupKills, 1u);
        emitKillParticles(slot, position, min(agents[slot].species, SPECIES_COUNT - 1u), agents[slot].hueJitter, params.killBurstParticles);
        atomicAdd(&threatAccumulator[coarseCellIndexFor(position)], u32(THREAT_FIXED_POINT_SCALE));
      }
    }
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let kills = atomicLoad(&workgroupKills);
    if (kills > 0u) {
      atomicAdd(&stats[STAT_KILLS], kills);
    }
  }
}
