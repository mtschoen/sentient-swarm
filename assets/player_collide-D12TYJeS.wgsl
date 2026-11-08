// Player contact, one workgroup, run after the registered projectile passes on the freshly
// integrated agents. The grid was built from the step's input agents, so cell membership is one
// step stale while distances use current positions.
//
// Thread 0 first releases the latch when it is set and params.acknowledgedHitSequence has reached
// the latched playerHitSequence, then publishes whether contact is armed this step (latch clear
// and params.playerInvulnerable == 0). When armed, the threads walk the grid cells within
// cellSpan = ceil((playerRadius + CONTACT_MARGIN) / cellSize) cells of the player's cell on each
// axis (capped at MAXIMUM_CELL_SPAN), splitting every cell's agents across the workgroup. An alive
// agent past its spawn-in frames within playerRadius + CONTACT_MARGIN of params.playerPosition
// touches the player; the first toucher to set the latch (atomicOr returned 0) stores
// playerHitSequence = frameSequence (atomicMax) and dies: atomicAnd clears its alive bit, the kill
// counts once into killsUnscored (contact never scores), and it splashes params.killBurstParticles
// particles in its species hue (from the step's shared particle budget). Later touchers in the
// same step see the latch and do nothing, so one latch period reports exactly one hit and one
// contact kill.
//
// Storage buffers: agents, cellCounts, cellOffsets, sortedIndices, stats, particles (pool cursor
// in its header), species table = 7; uniform: params.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(3) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(6) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(7) var<storage, read> speciesTable: array<f32>;

const CONTACT_MARGIN: f32 = 0.02;
const MAXIMUM_CELL_SPAN: i32 = 8;

var<workgroup> armed: u32;

// Claims up to requested particles from the step's shared budget (grantedParticleCount) and
// writes the granted ones radiating from position.
fn emitKillParticles(agentIndex: u32, position: vec2f, species: u32, hueJitter: f32, requested: u32) {
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
  let color = killParticleColor(speciesTable[speciesFieldIndex(species, SPECIES_FIELD_HUE)], hueJitter, 1.0);
  let seed = killBurstSeed(agentIndex, params.frameSequence);
  for (var index = 0u; index < count; index = index + 1u) {
    pool.particles[(first + index) % capacity] = killBurstParticle(index, count, params.killFragmentParticles, seed, position, color);
  }
}

fn touch(agentIndex: u32, position: vec2f) {
  if (atomicOr(&stats[STAT_HIT_LATCH], 1u) != 0u) {
    return;
  }
  atomicMax(&stats[STAT_PLAYER_HIT_SEQUENCE], params.frameSequence);
  let previousFlags = atomicAnd(&agents[agentIndex].flags, ~FLAG_ALIVE);
  if (isAlive(previousFlags)) {
    atomicAdd(&stats[STAT_KILLS_UNSCORED], 1u);
    emitKillParticles(agentIndex, position, min(agents[agentIndex].species, SPECIES_COUNT - 1u), agents[agentIndex].hueJitter, params.killBurstParticles + params.killFragmentParticles);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(local_invocation_index) localIndex: u32) {
  if (localIndex == 0u) {
    var latched = atomicLoad(&stats[STAT_HIT_LATCH]) != 0u;
    if (latched && params.acknowledgedHitSequence >= atomicLoad(&stats[STAT_PLAYER_HIT_SEQUENCE])) {
      atomicStore(&stats[STAT_HIT_LATCH], 0u);
      latched = false;
    }
    armed = select(0u, 1u, !latched && params.playerInvulnerable == 0u);
  }
  if (workgroupUniformLoad(&armed) == 0u) {
    return;
  }

  let reach = params.playerRadius + CONTACT_MARGIN;
  let cellSpan = min(i32(ceil(reach / params.cellSize)), MAXIMUM_CELL_SPAN);
  let center = cellIndexFor(params.playerPosition, params);
  let centerColumn = i32(center % params.gridColumns);
  let centerRow = i32(center / params.gridColumns);
  let lastColumn = i32(params.gridColumns) - 1;
  let lastRow = i32(params.gridRows) - 1;
  for (var row = max(centerRow - cellSpan, 0); row <= min(centerRow + cellSpan, lastRow); row = row + 1) {
    for (var column = max(centerColumn - cellSpan, 0); column <= min(centerColumn + cellSpan, lastColumn); column = column + 1) {
      let cell = u32(column) + u32(row) * params.gridColumns;
      let first = cellOffsets[cell];
      let count = cellCounts[cell];
      for (var index = localIndex; index < count; index = index + WORKGROUP_SIZE) {
        let agentIndex = sortedIndices[first + index];
        let flags = atomicLoad(&agents[agentIndex].flags);
        if (isAlive(flags) && spawnFramesRemaining(flags) == 0u) {
          let position = agents[agentIndex].position;
          if (distance(position, params.playerPosition) <= reach) {
            touch(agentIndex, position);
          }
        }
      }
    }
  }
}
