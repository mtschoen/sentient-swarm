// Spawn, one thread per agent slot. A dead slot claims one unit from spawnBudget (one counter per
// species, written by the CPU every frame as u32 and bound here as i32, bit-identical below
// 2^31), scanning species 0 to 4 in order.
// Claiming: skip a species whose budget atomicLoads at or below 0, else atomicSub 1; the claim
// holds when the value before the subtraction was positive, otherwise atomicAdd gives the unit
// straight back and the scan moves on. Successful claims never exceed the budget (each one saw a
// positive value that already counted every earlier claim), so no unit is spent twice, and the
// counter only dips below 0 between a failed subtraction and its give-back. A compare-exchange
// retry loop was measured to give up under contention and leave much of the budget unspent.
// The claimed agent gets a random position at least ARENA_WIDTH / 4 from the player (up to
// POSITION_ATTEMPTS draws; if every draw is too close the slot stays dead and the unit goes back
// with atomicAdd), zero velocity, SPAWN_IN_FRAMES spawn-in frames, the alive bit, the species, a
// random phase in [0, tau) and a random hueJitter in [-1, 1].
// Randomness: a PCG hash (Jarzynski and Olano, "Hash Functions for GPU Rendering", 2020) seeded
// by the slot index and params.frameSequence, then re-hashed for every draw
// (pcgHash and nextRandom live in common.wgsl, shared with the kill pass).

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> spawnBudget: array<atomic<i32>, SPECIES_COUNT>;

const SPAWN_IN_FRAMES: u32 = 30u;
const POSITION_ATTEMPTS: u32 = 4u;
const NO_SPECIES: u32 = 0xffffffffu;

fn claimUnit(species: u32) -> bool {
  if (atomicLoad(&spawnBudget[species]) <= 0) {
    return false;
  }
  if (atomicSub(&spawnBudget[species], 1) > 0) {
    return true;
  }
  atomicAdd(&spawnBudget[species], 1);
  return false;
}

fn claimSpecies() -> u32 {
  for (var species = 0u; species < SPECIES_COUNT; species = species + 1u) {
    if (claimUnit(species)) {
      return species;
    }
  }
  return NO_SPECIES;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let slot = globalId.x;
  if (slot >= params.capacity) {
    return;
  }
  if (isAlive(agents[slot].flags)) {
    return;
  }
  let species = claimSpecies();
  if (species == NO_SPECIES) {
    return;
  }

  var randomState = pcgHash(slot ^ pcgHash(params.frameSequence));
  let minimumDistance = ARENA_WIDTH / 4.0;
  var position = vec2f(0.0, 0.0);
  var placed = false;
  for (var attempt = 0u; attempt < POSITION_ATTEMPTS; attempt = attempt + 1u) {
    let candidate = vec2f(nextRandom(&randomState) * ARENA_WIDTH, nextRandom(&randomState) * ARENA_HEIGHT);
    if (distance(candidate, params.playerPosition) >= minimumDistance) {
      position = candidate;
      placed = true;
      break;
    }
  }
  if (!placed) {
    atomicAdd(&spawnBudget[species], 1);
    return;
  }

  var agent: Agent;
  agent.position = position;
  agent.velocity = vec2f(0.0, 0.0);
  agent.species = species;
  agent.flags = FLAG_ALIVE | (SPAWN_IN_FRAMES << SPAWN_FRAMES_SHIFT);
  agent.phase = nextRandom(&randomState) * TAU;
  agent.hueJitter = nextRandom(&randomState) * 2.0 - 1.0;
  agents[slot] = agent;
}
