// Spawn, one thread per agent slot. A dead slot claims one unit from spawnBudget (one counter per
// species, written by the CPU every frame as u32 and bound here as i32, bit-identical below
// 2^31), scanning species 0 to 4 in order.
// Claiming: skip a species whose budget atomicLoads at or below 0, else atomicSub 1; the claim
// holds when the value before the subtraction was positive, otherwise atomicAdd gives the unit
// straight back and the scan moves on. Successful claims never exceed the budget (each one saw a
// positive value that already counted every earlier claim), so no unit is spent twice, and the
// counter only dips below 0 between a failed subtraction and its give-back. A compare-exchange
// retry loop was measured to give up under contention and leave much of the budget unspent.
// The claimed agent lands in the wall band (owner ruling R13, task C0b): the strip of depth
// params.spawnBandWidth along all four walls, sampled uniformly by area (a band of half the
// arena height or more is the whole arena), at least ARENA_WIDTH * params.spawnDistanceFraction
// from the player (SpawnPressure ramps it from 0.4 down to the spec's quarter). It never lands in
// the interior, so space the player clears refills only by agents steering in from the walls;
// integrate's wall margin pushes it inward and its own steering carries it in.
// With probability params.spawnDensityBias the spawn takes the densest (coarse field total, the
// previous step's blurred field) of up to DENSITY_CANDIDATES placeable draws, else the first
// placeable draw, so new agents join existing masses. Up to POSITION_ATTEMPTS draws; when none
// is placeable (a far spawn distance leaves only the corners far enough) one last draw sits in
// the band-deep square at the corner farthest from the player; with bands up to about 0.9 that
// square lies more than half the arena width from any player position, so every spawn distance
// up to SpawnPressure's 0.5 maximum still places. If that draw is too close as well the slot
// stays dead and the unit goes back with atomicAdd. The agent gets zero velocity,
// SPAWN_IN_FRAMES spawn-in frames (the harmless pulse), the alive bit, the species, a random
// phase in [0, tau) and a random hueJitter in [-1, 1].
// Randomness: a PCG hash (Jarzynski and Olano, "Hash Functions for GPU Rendering", 2020) seeded
// by the slot index and params.frameSequence, then re-hashed for every draw
// (pcgHash and nextRandom live in common.wgsl, shared with the kill pass).

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> spawnBudget: array<atomic<i32>, SPECIES_COUNT>;
// The blurred coarse field, two vec4f per cell: species 0..3, then species 4, threat, padding.
@group(0) @binding(3) var<storage, read> field: array<vec4f>;

const POSITION_ATTEMPTS: u32 = 16u;
const DENSITY_CANDIDATES: u32 = 4u;
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

fn bandDepth() -> f32 {
  return clamp(params.spawnBandWidth, 0.0, ARENA_HEIGHT * 0.5);
}

// A uniform point in the wall band: the top and bottom strips span the full width, the left and
// right strips the height between them.
fn bandPoint(randomState: ptr<function, u32>) -> vec2f {
  let depth = bandDepth();
  let horizontalArea = 2.0 * ARENA_WIDTH * depth;
  let verticalArea = 2.0 * depth * (ARENA_HEIGHT - 2.0 * depth);
  let pick = nextRandom(randomState) * (horizontalArea + verticalArea);
  let along = nextRandom(randomState);
  let inward = nextRandom(randomState) * depth;
  if (pick < horizontalArea) {
    let x = along * ARENA_WIDTH;
    return vec2f(x, select(ARENA_HEIGHT - inward, inward, pick < horizontalArea * 0.5));
  }
  let y = depth + along * (ARENA_HEIGHT - 2.0 * depth);
  return vec2f(select(ARENA_WIDTH - inward, inward, pick - horizontalArea < verticalArea * 0.5), y);
}

// A point in the band-deep square at the arena corner farthest from the player.
fn farCornerPoint(randomState: ptr<function, u32>) -> vec2f {
  let depth = bandDepth();
  let offset = vec2f(nextRandom(randomState), nextRandom(randomState)) * depth;
  let farX = params.playerPosition.x < ARENA_WIDTH * 0.5;
  let farY = params.playerPosition.y < ARENA_HEIGHT * 0.5;
  return vec2f(select(offset.x, ARENA_WIDTH - offset.x, farX), select(offset.y, ARENA_HEIGHT - offset.y, farY));
}

fn coarseDensity(position: vec2f) -> f32 {
  let cell = coarseCellIndexFor(position);
  return dot(field[cell * 2u], vec4f(1.0)) + field[cell * 2u + 1u].x;
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
  let minimumDistance = ARENA_WIDTH * params.spawnDistanceFraction;
  let wanted = select(1u, DENSITY_CANDIDATES, nextRandom(&randomState) < params.spawnDensityBias);
  var position = vec2f(0.0, 0.0);
  var bestDensity = -1.0;
  var found = 0u;
  for (var attempt = 0u; attempt < POSITION_ATTEMPTS && found < wanted; attempt = attempt + 1u) {
    let candidate = bandPoint(&randomState);
    if (distance(candidate, params.playerPosition) >= minimumDistance) {
      found = found + 1u;
      let density = coarseDensity(candidate);
      if (density > bestDensity) {
        bestDensity = density;
        position = candidate;
      }
    }
  }
  if (found == 0u) {
    let candidate = farCornerPoint(&randomState);
    if (distance(candidate, params.playerPosition) >= minimumDistance) {
      position = candidate;
      found = 1u;
    }
  }
  if (found == 0u) {
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
