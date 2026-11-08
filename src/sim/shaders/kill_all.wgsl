// Kill-all (smart bomb and the death clear) and the pickup blast, run only in the step that
// requested it (params.killAllRequested == 1), after integrate and before any other kill pass.
// The area uniform picks the mode: radial 0 kills every alive agent, radial 1 only the alive
// agents within radius of center (the pickup blast, owner ruling R22); both entries apply it, so
// the count and the thinning see only the agents this step kills. Two entries, one thread per
// agent slot each:
// - countAlive: counts the alive agents (spawning ones included) into the particle pool header's
//   killAllAlive word (zeroed at the start of the step), one atomicAdd per workgroup. In the death
//   clear (params.deathFloodParticles > 0, task C0b2) thread 0 also emits the player death flood
//   at params.playerPosition (deathFloodParticle: a white flash, an afterglow and a hot spray),
//   claimed before the clear's bursts and granted even when the pool is full.
// - main: the clear is total: spawning agents die too. atomicAnd clears every alive bit and only a
//   thread that saw the bit set counts the kill, into killsUnscored (these kills never score).
//   Every kill splashes params.killBurstParticles + params.killFragmentParticles particles in its
//   species hue (dimmed by killAllParticleValue, a light budget) while the free particle slots (pool size minus
//   liveCount and the death flood) cover the whole clear; past that each kill's burst is thinned
//   (thinnedBurstCount, seeded per slot) to an expected free / killAllAlive particles,
//   so a clear through a full arena spreads the pool evenly over the arena instead of spending it
//   on the first slots. The step's shared budget (grantedParticleCount) still caps the total, so
//   the bursts never ask for more particles than were free; slots are reused from the cursor,
//   oldest first.
//   Every kill adds 1 / THREAT_KILLS_PER_UNIT of a threat unit to its coarse cell (one unit per
//   THREAT_KILLS_PER_UNIT kills per cell, in fixed point).
// The barriers sit outside every branch; threads past capacity still reach them.
//
// Storage buffers: agents, stats, particles (cursor and budget words in its header), threat
// accumulator, species table = 5; uniforms: params, area.

struct KillArea {
  center: vec2f,
  radius: f32,
  radial: u32,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(3) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(4) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> speciesTable: array<f32>;
@group(0) @binding(6) var<uniform> area: KillArea;

fn isInKillArea(position: vec2f) -> bool {
  return area.radial == 0u || distance(position, area.center) <= area.radius;
}

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
  let color = killParticleColor(speciesTable[speciesFieldIndex(species, SPECIES_FIELD_HUE)], hueJitter, killAllParticleValue(clearParticles()));
  let seed = killBurstSeed(slot, params.frameSequence);
  for (var index = 0u; index < count; index = index + 1u) {
    pool.particles[(first + index) % capacity] = killBurstParticle(index, count, params.killFragmentParticles, seed, position, color);
  }
}

var<workgroup> workgroupAlive: atomic<u32>;

@compute @workgroup_size(WORKGROUP_SIZE)
fn countAlive(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < params.capacity && isAlive(atomicLoad(&agents[slot].flags)) && isInKillArea(agents[slot].position)) {
    atomicAdd(&workgroupAlive, 1u);
  }
  workgroupBarrier();

  if (localIndex == 0u) {
    let alive = atomicLoad(&workgroupAlive);
    if (alive > 0u) {
      atomicAdd(&pool.killAllAlive, alive);
    }
  }
  if (slot == 0u && params.deathFloodParticles > 0u) {
    emitDeathFlood();
  }
}

// The flood always gets its particles, overwriting the oldest ring slots when the pool is full (a
// bomb just before the death); it still counts against the step's claims.
fn emitDeathFlood() {
  let capacity = arrayLength(&pool.particles);
  atomicAdd(&pool.claimedThisStep, params.deathFloodParticles);
  let count = min(params.deathFloodParticles, capacity);
  let first = atomicAdd(&pool.cursor, count) % capacity;
  let seed = pcgHash(params.frameSequence * 3u + 7u);
  for (var index = 0u; index < count; index = index + 1u) {
    pool.particles[(first + index) % capacity] = deathFloodParticle(index, seed, params.playerPosition);
  }
}

// The pool slots the clear's bursts may use: free after the last particle step and the flood.
fn clearFreeSlots() -> u32 {
  let poolSize = arrayLength(&pool.particles);
  return poolSize - min(atomicLoad(&pool.liveCount) + params.deathFloodParticles, poolSize);
}

// About how many particles the whole clear emits: every kill's burst, or the free slots.
fn clearParticles() -> f32 {
  let burst = params.killBurstParticles + params.killFragmentParticles;
  return min(f32(clearFreeSlots()), f32(atomicLoad(&pool.killAllAlive)) * f32(burst));
}

// Particles this slot's kill asks for: the full burst while the free slots cover every kill,
// otherwise a thinned burst whose expected size shares the free slots evenly.
fn requestedParticles(slot: u32) -> u32 {
  let free = clearFreeSlots();
  let alive = max(atomicLoad(&pool.killAllAlive), 1u);
  let burst = params.killBurstParticles + params.killFragmentParticles;
  let expected = min(f32(burst), f32(free) / f32(alive));
  if (expected >= f32(burst)) {
    return burst;
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
  if (slot < params.capacity && params.killAllRequested != 0u && isInKillArea(agents[slot].position)) {
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
