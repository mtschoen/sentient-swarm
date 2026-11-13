// Player swarm contact, one workgroup per swarm slot (MAXIMUM_SWARM_SHIPS workgroups), run after
// the registered projectile passes on the freshly integrated agents. The grid was built from the
// step's input agents, so cell membership is one step stale while distances use current positions.
//
// Slot s owns bit s of the persistent swarm hit mask (stats words STAT_SWARM_HIT_MASK and the one
// after it); only workgroup s touches that bit, so there is no cross-workgroup race. Thread 0 first
// clears the bit when the slot is dead or fresh (its first uploaded step: a ship grown into a reused
// slot never inherits an old hit), then arms the slot when it is alive, swarm.armed is 1 and its bit
// is still clear (a hit ship stays hit until the CPU reads it back and uploads the slot dead). When
// armed, the threads walk the grid cells within cellSpan = ceil((radius + CONTACT_MARGIN) / cellSize)
// cells of the ship's cell (capped at MAXIMUM_CELL_SPAN). An alive agent past its spawn-in frames
// within reach touches the ship: the first toucher to set the bit (atomicOr saw it clear) dies,
// counted once in killsUnscored (contact never scores), and splashes its kill burst; later touchers
// in the same step do nothing.
//
// Storage buffers: agents, cellCounts, cellOffsets, sortedIndices, stats, particles (pool cursor
// in its header), species table = 7; uniforms: params, swarm.

struct SwarmShip {
  position: vec2f,
  // Bit 0 alive, bit 1 fresh (the slot's first uploaded step).
  state: u32,
  padding: u32,
}

struct Swarm {
  radius: f32,
  armed: u32,
  paddingOne: u32,
  paddingTwo: u32,
  ships: array<SwarmShip, MAXIMUM_SWARM_SHIPS>,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(2) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(3) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(4) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(5) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
@group(0) @binding(6) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(7) var<storage, read> speciesTable: array<f32>;
@group(0) @binding(8) var<uniform> swarm: Swarm;

const CONTACT_MARGIN: f32 = 0.02;
const MAXIMUM_CELL_SPAN: i32 = 8;
const SHIP_ALIVE: u32 = 1u;
const SHIP_FRESH: u32 = 2u;

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

fn touch(word: u32, bit: u32, agentIndex: u32, position: vec2f) {
  if ((atomicOr(&stats[word], bit) & bit) != 0u) {
    return;
  }
  let previousFlags = atomicAnd(&agents[agentIndex].flags, ~FLAG_ALIVE);
  if (isAlive(previousFlags)) {
    atomicAdd(&stats[STAT_KILLS_UNSCORED], 1u);
    emitKillParticles(agentIndex, position, min(agents[agentIndex].species, SPECIES_COUNT - 1u), agents[agentIndex].hueJitter, params.killBurstParticles + params.killFragmentParticles);
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) localIndex: u32) {
  let slot = group.x;
  let ship = swarm.ships[slot];
  let word = STAT_SWARM_HIT_MASK + slot / 32u;
  let bit = 1u << (slot % 32u);
  if (localIndex == 0u) {
    let alive = (ship.state & SHIP_ALIVE) != 0u;
    if (!alive || (ship.state & SHIP_FRESH) != 0u) {
      atomicAnd(&stats[word], ~bit);
    }
    let clear = (atomicLoad(&stats[word]) & bit) == 0u;
    armed = select(0u, 1u, alive && clear && swarm.armed == 1u);
  }
  if (workgroupUniformLoad(&armed) == 0u) {
    return;
  }

  let reach = swarm.radius + CONTACT_MARGIN;
  let cellSpan = min(i32(ceil(reach / params.cellSize)), MAXIMUM_CELL_SPAN);
  let center = cellIndexFor(ship.position, params);
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
          if (distance(position, ship.position) <= reach) {
            touch(word, bit, agentIndex, position);
          }
        }
      }
    }
  }
}
