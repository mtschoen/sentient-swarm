// Steering, one thread per agent slot: reads agentsIn, writes agentsOut (velocity only;
// integrate.wgsl moves agents afterwards). Dead agents and agents in spawn-in frames are copied
// through unchanged.
//
// Two ranges of influence:
// - Fine pass over the 3x3 grid cells around the agent, sampling at most MAXIMUM_NEIGHBOR_SAMPLES
//   neighbors with a stride of ceil(total / MAXIMUM_NEIGHBOR_SAMPLES) so the sample spans the
//   whole neighborhood. Separation averages over every sampled neighbor inside neighborRadius;
//   alignment averages over the same-species ones. Averages, never sums.
// - Coarse field (blurred, agents per coarse cell) read at the agent's cell and its four axis
//   neighbors: cohesion up the own-species gradient (the total-density gradient when
//   sameSpeciesCohesion is 0), faded by clamp(1 - density / targetDensity)
//   where density is the total at the agent's cell; the matrix row along the signed sum of the
//   other species' gradients; flee down the threat gradient; pressure down the total-density
//   gradient with weight pressure * (density - targetDensity) once density exceeds targetDensity;
//   like the other field terms its direction saturates (saturatedDirection), so float noise in a
//   flat over-dense interior pushes weakly instead of at full strength in a random direction.
//
// Every term adds to a desired velocity: weight times a direction of length at most 1 times
// maximumSpeed, except seek (weight times seekVelocity, which brakes near the player) and
// alignment (weight times the average neighbor velocity). The steering acceleration is
// (desired - velocity) * STEERING_RESPONSE, clamped to maximumTurn * maximumSpeed; the new
// speed is clamped to maximumSpeed.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read> agentsIn: array<Agent>;
@group(0) @binding(2) var<storage, read_write> agentsOut: array<Agent>;
@group(0) @binding(3) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(4) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(5) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(6) var<storage, read> field: array<vec4f>;
@group(0) @binding(7) var<storage, read> speciesTable: array<f32>;

// Per second: how fast velocity chases the desired velocity before the maximumTurn clamp.
const STEERING_RESPONSE: f32 = 4.0;
// Gradients (agents per coarse cell per cell) at or above this length steer at full weight;
// weaker gradients steer proportionally, so field noise does not steer at full strength.
const GRADIENT_SATURATION: f32 = 2.0;
// Orbiters within this fraction of orbitRadius from the circle move along its tangent.
const ORBIT_TANGENT_BAND: f32 = 0.2;
// Fraction of the time-optimal stopping speed that straight seek allows, leaving acceleration
// headroom for the other terms that share the maximumTurn budget. The lab may expose it.
const ARRIVAL_BRAKING: f32 = 0.7;
const MINIMUM_LENGTH: f32 = 0.000001;

// raw and blurred hold COARSE_CHANNELS floats per cell as vec4 pairs: channels 0..3, then 4..7.
const VECTORS_PER_CELL: u32 = COARSE_CHANNELS / 4u;

struct CoarseSample {
  low: vec4f,
  high: vec4f,
}

fn speciesField(species: u32, fieldIndex: u32) -> f32 {
  return speciesTable[speciesFieldIndex(species, fieldIndex)];
}

fn matrixWeight(species: u32, other: u32) -> f32 {
  return speciesTable[matrixWeightIndex(species, other)];
}

fn coarseSample(coordinate: vec2i) -> CoarseSample {
  let clamped = clamp(coordinate, vec2i(0, 0), vec2i(i32(COARSE_COLUMNS) - 1, i32(COARSE_ROWS) - 1));
  let cell = u32(clamped.x) + u32(clamped.y) * COARSE_COLUMNS;
  return CoarseSample(field[cell * VECTORS_PER_CELL], field[cell * VECTORS_PER_CELL + 1u]);
}

fn channelOf(sample: CoarseSample, channel: u32) -> f32 {
  if (channel < 4u) {
    return sample.low[channel];
  }
  return sample.high[channel - 4u];
}

fn totalDensity(sample: CoarseSample) -> f32 {
  return dot(sample.low, vec4f(1.0)) + sample.high.x;
}

// Full length at GRADIENT_SATURATION and above, proportionally shorter below it.
fn saturatedDirection(gradient: vec2f) -> vec2f {
  return gradient / max(length(gradient), GRADIENT_SATURATION);
}

// Seek, as a desired velocity. Straight at the player at maximumSpeed, braking inside the
// stopping distance: the speed is capped at ARRIVAL_BRAKING * sqrt(2 * maximumAcceleration *
// distance), so an agent can stop at the player instead of overshooting by speed^2 / (2 *
// acceleration) and oscillating through it. With orbitRadius > 0: toward the nearest point on
// the circle of that radius around the player (inward when outside it, outward when inside),
// except within ORBIT_TANGENT_BAND * orbitRadius of the circle, where the agent follows the
// counterclockwise tangent so every orbiter circles with the same handedness. Orbits never brake.
fn seekVelocity(position: vec2f, orbitRadius: f32, maximumSpeed: f32, maximumAcceleration: f32) -> vec2f {
  let toPlayer = params.playerPosition - position;
  let distance = length(toPlayer);
  if (distance < MINIMUM_LENGTH) {
    return vec2f(0.0, 0.0);
  }
  let radial = toPlayer / distance;
  if (orbitRadius <= 0.0) {
    let brakingSpeed = ARRIVAL_BRAKING * sqrt(2.0 * maximumAcceleration * distance);
    return radial * min(maximumSpeed, brakingSpeed);
  }
  if (abs(distance - orbitRadius) <= ORBIT_TANGENT_BAND * orbitRadius) {
    return vec2f(-radial.y, radial.x) * maximumSpeed;
  }
  return radial * sign(distance - orbitRadius) * maximumSpeed;
}

struct NeighborAverages {
  separation: vec2f,
  alignment: vec2f,
}

fn fineNeighborAverages(index: u32, agent: Agent, species: u32) -> NeighborAverages {
  let homeCell = cellIndexFor(agent.position, params);
  let home = vec2i(i32(homeCell % params.gridColumns), i32(homeCell / params.gridColumns));
  var starts: array<u32, 9>;
  var counts: array<u32, 9>;
  var total = 0u;
  for (var neighborCell = 0u; neighborCell < 9u; neighborCell = neighborCell + 1u) {
    let coordinate = home + vec2i(i32(neighborCell % 3u) - 1, i32(neighborCell / 3u) - 1);
    counts[neighborCell] = 0u;
    starts[neighborCell] = 0u;
    let inside = coordinate.x >= 0 && coordinate.y >= 0 && coordinate.x < i32(params.gridColumns) && coordinate.y < i32(params.gridRows);
    if (inside) {
      let cell = u32(coordinate.x) + u32(coordinate.y) * params.gridColumns;
      starts[neighborCell] = cellOffsets[cell];
      counts[neighborCell] = cellCounts[cell];
      total = total + counts[neighborCell];
    }
  }
  // Global sample positions are sampleOffset, sampleOffset + stride, ... across the 9 cells in
  // order; the offset varies per agent so neighbors see different subsets of a crowd.
  let stride = max(1u, (total + MAXIMUM_NEIGHBOR_SAMPLES - 1u) / MAXIMUM_NEIGHBOR_SAMPLES);
  let sampleOffset = index % stride;
  let radius = params.neighborRadius;
  var separationSum = vec2f(0.0, 0.0);
  var separationCount = 0u;
  var alignmentSum = vec2f(0.0, 0.0);
  var alignmentCount = 0u;
  var sampled = 0u;
  var cellBase = 0u;
  for (var neighborCell = 0u; neighborCell < 9u; neighborCell = neighborCell + 1u) {
    let first = (sampleOffset + stride - cellBase % stride) % stride;
    cellBase = cellBase + counts[neighborCell];
    for (var local = first; local < counts[neighborCell] && sampled < MAXIMUM_NEIGHBOR_SAMPLES; local = local + stride) {
      sampled = sampled + 1u;
      let otherIndex = sortedIndices[starts[neighborCell] + local];
      if (otherIndex == index) {
        continue;
      }
      let other = agentsIn[otherIndex];
      let away = agent.position - other.position;
      let distanceSquared = dot(away, away);
      if (distanceSquared >= radius * radius || distanceSquared < MINIMUM_LENGTH * MINIMUM_LENGTH) {
        continue;
      }
      let distance = sqrt(distanceSquared);
      separationSum = separationSum + away / distance * (1.0 - distance / radius);
      separationCount = separationCount + 1u;
      if (other.species == species) {
        alignmentSum = alignmentSum + other.velocity;
        alignmentCount = alignmentCount + 1u;
      }
    }
  }
  var averages = NeighborAverages(vec2f(0.0, 0.0), vec2f(0.0, 0.0));
  if (separationCount > 0u) {
    averages.separation = separationSum / f32(separationCount);
  }
  if (alignmentCount > 0u) {
    averages.alignment = alignmentSum / f32(alignmentCount);
  }
  return averages;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let index = globalId.x;
  if (index >= params.capacity) {
    return;
  }
  let agent = agentsIn[index];
  if (!isAlive(agent.flags) || spawnFramesRemaining(agent.flags) > 0u) {
    agentsOut[index] = agent;
    return;
  }
  let species = min(agent.species, SPECIES_COUNT - 1u);
  let maximumSpeed = speciesField(species, FIELD_MAXIMUM_SPEED);
  let maximumAcceleration = speciesField(species, FIELD_MAXIMUM_TURN) * maximumSpeed;
  let targetDensity = max(speciesField(species, FIELD_TARGET_DENSITY), MINIMUM_LENGTH);

  let seek = seekVelocity(agent.position, speciesField(species, FIELD_ORBIT_RADIUS), maximumSpeed, maximumAcceleration);
  var desired = seek * speciesField(species, FIELD_SEEK);

  let neighbors = fineNeighborAverages(index, agent, species);
  desired = desired + neighbors.separation * speciesField(species, FIELD_SEPARATION) * maximumSpeed;
  desired = desired + neighbors.alignment * speciesField(species, FIELD_ALIGNMENT);

  let coordinate = coarseCellCoordinate(agent.position);
  let center = coarseSample(coordinate);
  let nextColumn = coarseSample(coordinate + vec2i(1, 0));
  let previousColumn = coarseSample(coordinate - vec2i(1, 0));
  let nextRow = coarseSample(coordinate + vec2i(0, 1));
  let previousRow = coarseSample(coordinate - vec2i(0, 1));
  // Central differences in agents per coarse cell per cell, held in CoarseSample layout.
  let gradientLowX = (nextColumn.low - previousColumn.low) * 0.5;
  let gradientLowY = (nextRow.low - previousRow.low) * 0.5;
  let gradientHighX = (nextColumn.high - previousColumn.high) * 0.5;
  let gradientHighY = (nextRow.high - previousRow.high) * 0.5;
  let gradientX = CoarseSample(gradientLowX, gradientHighX);
  let gradientY = CoarseSample(gradientLowY, gradientHighY);
  let density = totalDensity(center);

  var cohesionGradient = vec2f(channelOf(gradientX, species), channelOf(gradientY, species));
  if (params.sameSpeciesCohesion == 0u) {
    cohesionGradient = vec2f(totalDensity(gradientX), totalDensity(gradientY));
  }
  let cohesionFade = clamp(1.0 - density / targetDensity, 0.0, 1.0);
  desired = desired + saturatedDirection(cohesionGradient) * speciesField(species, FIELD_COHESION) * cohesionFade * maximumSpeed;

  var matrixGradient = vec2f(0.0, 0.0);
  for (var other = 0u; other < SPECIES_COUNT; other = other + 1u) {
    if (other != species) {
      matrixGradient = matrixGradient + vec2f(channelOf(gradientX, other), channelOf(gradientY, other)) * matrixWeight(species, other);
    }
  }
  desired = desired + saturatedDirection(matrixGradient) * maximumSpeed;

  let threatGradient = vec2f(channelOf(gradientX, THREAT_CHANNEL), channelOf(gradientY, THREAT_CHANNEL));
  desired = desired - saturatedDirection(threatGradient) * speciesField(species, FIELD_FLEE) * maximumSpeed;

  if (density > targetDensity) {
    let totalGradient = vec2f(totalDensity(gradientX), totalDensity(gradientY));
    desired = desired - saturatedDirection(totalGradient) * speciesField(species, FIELD_PRESSURE) * (density - targetDensity) * maximumSpeed;
  }

  var steering = (desired - agent.velocity) * STEERING_RESPONSE;
  let steeringLength = length(steering);
  if (steeringLength > maximumAcceleration) {
    steering = steering * (maximumAcceleration / steeringLength);
  }
  var velocity = agent.velocity + steering * params.dt;
  let speed = length(velocity);
  if (speed > maximumSpeed) {
    velocity = velocity * (maximumSpeed / speed);
  }
  var updated = agent;
  updated.velocity = velocity;
  agentsOut[index] = updated;
}
