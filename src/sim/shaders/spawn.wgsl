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
// params.spawnBandWidth along all four edges of the world bounds (params.worldBounds, the playable
// rectangle inside the world), sampled uniformly by area (a band of half the bounds' shorter side
// or more is the whole rectangle), at least params.spawnDistance world units from the player
// (Simulation: SpawnPressure's fraction, ramped from 0.4 down to the spec's quarter, times the view
// width). It never lands in
// the interior, so space the player clears refills only by agents steering in from the walls;
// integrate's wall margin pushes it inward and its own steering carries it in.
// With probability params.spawnDensityBias the spawn takes the densest (coarse field total, the
// previous step's blurred field) of up to DENSITY_CANDIDATES placeable draws, else the first
// placeable draw, so new agents join existing masses. Up to POSITION_ATTEMPTS draws; when none
// is placeable (a far spawn distance leaves only the corners far enough) one last draw sits in
// the band-deep square at the bounds corner farthest from the player; in the full 32 by 18 world,
// with bands up to about 0.9, that square lies more than 9 world units from any player position,
// past SpawnPressure's 0.5 maximum of a 16-unit view width, so every spawn distance still places. If that draw is too close as well the slot
// stays dead and the unit goes back with atomicAdd. The agent gets zero velocity (a gate spawn its
// outward ejection),
// SPAWN_IN_FRAMES spawn-in frames (the harmless pulse), the alive bit, the species, a random
// phase in [0, tau) and a random hueJitter in [-1, 1].
// Spawn gates (owner ruling R14, task C0b2): while params.spawnGateCount > 0 and some gate emits,
// the agent instead lands uniformly in the disc of one gate, picked per attempt with weight
// emission times (1 for the gate's favored species, 1 - spawnGateSpeciesBias for the others; the
// plain emission weights when that leaves nothing), clamped into the bounds and still at least the
// minimum distance from the player. A gate overflows instead of piling up: a draw whose coarse
// cell (the previous step's field) already holds GATE_OVERFLOW_DENSITY agents is redrawn with the
// disc grown by GATE_OVERFLOW_GROWTH per attempt (the last attempt takes its draw anyway), so a big
// wave pours out around the gate. A gate spawn leaves radially at up to GATE_EJECT_SPEED (it
// moves through its spawn-in, so a wave visibly bursts out of the gate). After POSITION_ATTEMPTS
// unplaceable draws it falls back to the wall band below. No gate emits only between waves, when
// SpawnPressure requests nothing.
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
const GATE_WALL_MARGIN: f32 = 0.05;
const GATE_OVERFLOW_DENSITY: f32 = 48.0;
const GATE_OVERFLOW_GROWTH: f32 = 0.35;
const GATE_EJECT_SPEED: f32 = 1.6;

struct GateDraw {
  position: vec2f,
  outward: vec2f,
}

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

// Half the shorter side of the bounds fills the whole rectangle.
fn bandDepth() -> f32 {
  let size = boundsSize(params);
  return clamp(params.spawnBandWidth, 0.0, min(size.x, size.y) * 0.5);
}

// A uniform point in the wall band of the bounds: the top and bottom strips span the full bounds
// width, the left and right strips the height between them.
fn bandPoint(randomState: ptr<function, u32>) -> vec2f {
  let depth = bandDepth();
  let low = params.worldBounds.xy;
  let high = params.worldBounds.zw;
  let size = boundsSize(params);
  let horizontalArea = 2.0 * size.x * depth;
  let verticalArea = 2.0 * depth * (size.y - 2.0 * depth);
  let pick = nextRandom(randomState) * (horizontalArea + verticalArea);
  let along = nextRandom(randomState);
  let inward = nextRandom(randomState) * depth;
  if (pick < horizontalArea) {
    let x = low.x + along * size.x;
    return vec2f(x, select(high.y - inward, low.y + inward, pick < horizontalArea * 0.5));
  }
  let y = low.y + depth + along * (size.y - 2.0 * depth);
  return vec2f(select(high.x - inward, low.x + inward, pick - horizontalArea < verticalArea * 0.5), y);
}

// A point in the band-deep square at the bounds corner farthest from the player.
fn farCornerPoint(randomState: ptr<function, u32>) -> vec2f {
  let depth = bandDepth();
  let low = params.worldBounds.xy;
  let high = params.worldBounds.zw;
  let center = boundsCenter(params);
  let offset = vec2f(nextRandom(randomState), nextRandom(randomState)) * depth;
  let farX = params.playerPosition.x < center.x;
  let farY = params.playerPosition.y < center.y;
  return vec2f(select(low.x + offset.x, high.x - offset.x, farX), select(low.y + offset.y, high.y - offset.y, farY));
}

// Gate pick weights for species: emission, scaled down for gates that favor another species.
fn gateWeight(gate: u32, species: u32, biased: bool) -> f32 {
  let emission = max(params.spawnGates[gate].w, 0.0);
  if (!biased || params.spawnGateSpecies[gate] == species) {
    return emission;
  }
  return emission * (1.0 - clamp(params.spawnGateSpeciesBias, 0.0, 1.0));
}

fn gateWeightTotal(species: u32, biased: bool) -> f32 {
  var total = 0.0;
  for (var gate = 0u; gate < min(params.spawnGateCount, 4u); gate = gate + 1u) {
    total = total + gateWeight(gate, species, biased);
  }
  return total;
}

// A uniform point in the disc of a gate drawn by weight (total is gateWeightTotal), its radius
// times spread, kept a little inside the bounds; outward is the unit direction from the gate center.
fn gatePoint(species: u32, biased: bool, total: f32, spread: f32, randomState: ptr<function, u32>) -> GateDraw {
  var remaining = nextRandom(randomState) * total;
  var chosen = 0u;
  for (var gate = 0u; gate < min(params.spawnGateCount, 4u); gate = gate + 1u) {
    let weight = gateWeight(gate, species, biased);
    if (weight > 0.0) {
      chosen = gate;
      if (remaining < weight) {
        break;
      }
      remaining = remaining - weight;
    }
  }
  let row = params.spawnGates[chosen];
  let angle = nextRandom(randomState) * TAU;
  let reach = sqrt(nextRandom(randomState)) * row.z * spread;
  let direction = vec2f(cos(angle), sin(angle));
  let position = clamp(row.xy + direction * reach, params.worldBounds.xy + vec2f(GATE_WALL_MARGIN), params.worldBounds.zw - vec2f(GATE_WALL_MARGIN));
  return GateDraw(position, direction * (reach / max(row.z * spread, 0.001)));
}

fn coarseDensity(position: vec2f) -> f32 {
  let cell = coarseCellIndexFor(position);
  return dot(field[cell * VECTORS_PER_CELL], vec4f(1.0)) + field[cell * VECTORS_PER_CELL + 1u].x;
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
  let minimumDistance = params.spawnDistance;
  var position = vec2f(0.0, 0.0);
  var velocity = vec2f(0.0, 0.0);
  var found = 0u;
  var biased = true;
  var gateTotal = gateWeightTotal(species, true);
  if (gateTotal <= 0.0) {
    biased = false;
    gateTotal = gateWeightTotal(species, false);
  }
  if (gateTotal > 0.0) {
    for (var attempt = 0u; attempt < POSITION_ATTEMPTS && found == 0u; attempt = attempt + 1u) {
      let draw = gatePoint(species, biased, gateTotal, 1.0 + f32(attempt) * GATE_OVERFLOW_GROWTH, &randomState);
      let crowded = coarseDensity(draw.position) >= GATE_OVERFLOW_DENSITY && attempt + 1u < POSITION_ATTEMPTS;
      if (!crowded && distance(draw.position, params.playerPosition) >= minimumDistance) {
        position = draw.position;
        velocity = draw.outward * GATE_EJECT_SPEED;
        found = 1u;
      }
    }
  }
  let wanted = select(select(1u, DENSITY_CANDIDATES, nextRandom(&randomState) < params.spawnDensityBias), 0u, found > 0u);
  var bestDensity = -1.0;
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
  agent.velocity = velocity;
  agent.species = species;
  agent.flags = FLAG_ALIVE | (SPAWN_IN_FRAMES << SPAWN_FRAMES_SHIFT);
  agent.phase = nextRandom(&randomState) * TAU;
  agent.hueJitter = nextRandom(&randomState) * 2.0 - 1.0;
  agents[slot] = agent;
}
