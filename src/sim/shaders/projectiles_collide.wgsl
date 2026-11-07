// Projectile collision against the spatial grid, run after projectiles_step.wgsl on the freshly
// integrated agents. The grid was built from the step's input agents, so cell membership is one
// step stale while distances use current positions. Every kind pierces.
//
// Entry main, one thread per projectile slot (the beam slot is skipped):
// - bullet, scatter, rail, pulseOrb, sidewinder: the capsule from previousPosition to position
//   with reach radius + CAPSULE_KILL_MARGIN. Its cells are walked along the segment's major axis:
//   for every grid column (or row) the capsule touches, the minor-axis cell span is the
//   segment's minor range over that column widened by the reach on both sides, then by the reach
//   along the major axis for the end caps. At most CAPSULE_CELL_BUDGET cells. An agent dies when
//   its distance to the segment is at most the reach.
// - pulseRing: the band [radius - max(RING_MINIMUM_BAND, extra * dt), radius] around position,
//   so a ring growing faster than the minimum band per step still sweeps without gaps. Only cells
//   intersecting the annulus are walked: per grid row, the column span of the outer circle minus
//   the columns lying wholly inside the inner circle. At most RING_CELL_BUDGET cells.
// Entry beam, one workgroup: slot 0 when it is an alive beam. The ray from position along
// velocity (a unit direction) to the arena edge is a capsule of reach radius walked the same way,
// with the workgroup's threads taking interleaved major-axis steps (at most columns + rows
// steps in total); every step also adds BEAM_THREAT_UNITS threat at the ray's coarse cell so the
// trench shows where nothing dies.
//
// A kill is the Plan A kill: the agent must be alive and past its spawn-in frames; atomicAnd
// clears the alive bit and only the thread that saw it set counts the kill, so overlapping
// projectiles never double count. A counted kill adds 1 to the workgroup kill count (one global
// atomicAdd into stats from thread 0), claims KILL_PARTICLE_COUNT particles from the pool in the
// species hue (from the hues uniform) and adds one threat unit at the agent's coarse cell.
// Barriers sit outside every branch.
//
// Storage buffers: projectiles, agents, cellCounts, cellOffsets, sortedIndices, particles (pool
// cursor in its header), threatAccumulator, stats = 8; uniforms: params, hues.

// Same 32-byte layout as Agent with the flags word atomic.
struct AtomicAgent {
  position: vec2f,
  velocity: vec2f,
  species: u32,
  flags: atomic<u32>,
  phase: f32,
  hueJitter: f32,
}

// Species hues 0..3, then species 4 in second.x; copied from the species table every frame.
struct SpeciesHues {
  first: vec4f,
  second: vec4f,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<uniform> hues: SpeciesHues;
@group(0) @binding(2) var<storage, read> projectiles: array<Projectile>;
@group(0) @binding(3) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(4) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(5) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(6) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(7) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(8) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> stats: array<atomic<u32>>;

const STAT_KILLS: u32 = 6u;
const KILL_PARTICLE_COUNT: u32 = 4u;
const CAPSULE_KILL_MARGIN: f32 = 0.02;
const CAPSULE_CELL_BUDGET: u32 = 64u;
const RING_MINIMUM_BAND: f32 = 0.08;
const RING_CELL_BUDGET: u32 = 1024u;
const BEAM_THREAT_UNITS: f32 = 4.0;
// Per beam thread; with fewer major-axis steps than threads each thread walks one step.
const BEAM_CELL_BUDGET: u32 = 256u;
const BEAM_SLOT: u32 = 0u;
const NO_THREAT: f32 = 0.0;

var<workgroup> workgroupKills: atomic<u32>;

fn speciesHue(species: u32) -> f32 {
  if (species < 4u) {
    return hues.first[species];
  }
  return hues.second.x;
}

fn emitKillParticles(agentIndex: u32, position: vec2f, species: u32, hueJitter: f32) {
  let capacity = arrayLength(&pool.particles);
  let first = atomicAdd(&pool.cursor, KILL_PARTICLE_COUNT) % capacity;
  let color = killParticleColor(speciesHue(species), hueJitter);
  var randomState = pcgHash(agentIndex ^ pcgHash(params.frameSequence * 2u + 1u));
  let rotation = nextRandom(&randomState) * TAU;
  for (var index = 0u; index < KILL_PARTICLE_COUNT; index = index + 1u) {
    let angle = rotation + f32(index) * TAU / f32(KILL_PARTICLE_COUNT);
    pool.particles[(first + index) % capacity] = killParticle(position, angle, color, &randomState);
  }
}

fn kill(agentIndex: u32, position: vec2f) {
  let previousFlags = atomicAnd(&agents[agentIndex].flags, ~FLAG_ALIVE);
  if (isAlive(previousFlags)) {
    atomicAdd(&workgroupKills, 1u);
    emitKillParticles(agentIndex, position, min(agents[agentIndex].species, SPECIES_COUNT - 1u), agents[agentIndex].hueJitter);
    atomicAdd(&threatAccumulator[coarseCellIndexFor(position)], u32(THREAT_FIXED_POINT_SCALE));
  }
}

fn isKillable(flags: u32) -> bool {
  return isAlive(flags) && spawnFramesRemaining(flags) == 0u;
}

fn distanceToSegment(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let along = end - start;
  let lengthSquared = dot(along, along);
  var t = 0.0;
  if (lengthSquared > 0.0) {
    t = clamp(dot(point - start, along) / lengthSquared, 0.0, 1.0);
  }
  return distance(point, start + along * t);
}

fn collideCellWithSegment(cell: u32, start: vec2f, end: vec2f, reach: f32) {
  let first = cellOffsets[cell];
  let count = cellCounts[cell];
  for (var index = 0u; index < count; index = index + 1u) {
    let agentIndex = sortedIndices[first + index];
    if (isKillable(atomicLoad(&agents[agentIndex].flags))) {
      let position = agents[agentIndex].position;
      if (distanceToSegment(position, start, end) <= reach) {
        kill(agentIndex, position);
      }
    }
  }
}

fn collideCellWithRing(cell: u32, center: vec2f, inner: f32, outer: f32) {
  let first = cellOffsets[cell];
  let count = cellCounts[cell];
  for (var index = 0u; index < count; index = index + 1u) {
    let agentIndex = sortedIndices[first + index];
    if (isKillable(atomicLoad(&agents[agentIndex].flags))) {
      let position = agents[agentIndex].position;
      let separation = distance(position, center);
      if (separation >= inner && separation <= outer) {
        kill(agentIndex, position);
      }
    }
  }
}

// Grid cell coordinate along one axis holding value, clamped to [0, count - 1].
fn gridCoordinate(value: f32, count: u32) -> u32 {
  return u32(clamp(floor(value / params.cellSize), 0.0, f32(count - 1u)));
}

// Walks the cells of the capsule from start to end with the given reach, taking major-axis steps
// firstStep, firstStep + stepStride, ... and at most cellBudget cells. Adds threatPerStep threat
// units at the segment point of every step when it is above zero.
fn collideCapsule(start: vec2f, end: vec2f, reach: f32, firstStep: u32, stepStride: u32, cellBudget: u32, threatPerStep: f32) {
  let delta = end - start;
  let majorIsX = abs(delta.x) >= abs(delta.y);
  // (major, minor) coordinates.
  let startAxes = select(start.yx, start, majorIsX);
  let endAxes = select(end.yx, end, majorIsX);
  let majorCount = select(params.gridRows, params.gridColumns, majorIsX);
  let minorCount = select(params.gridColumns, params.gridRows, majorIsX);
  let lowMajor = min(startAxes.x, endAxes.x);
  let highMajor = max(startAxes.x, endAxes.x);
  var slope = 0.0;
  if (highMajor > lowMajor) {
    slope = (endAxes.y - startAxes.y) / (endAxes.x - startAxes.x);
  }
  let size = params.cellSize;
  let firstMajor = gridCoordinate(lowMajor - reach, majorCount);
  let lastMajor = gridCoordinate(highMajor + reach, majorCount);
  var budget = cellBudget;
  for (var major = firstMajor + firstStep; major <= lastMajor && budget > 0u; major = major + stepStride) {
    // Segment points that can reach this column lie within reach of it along the major axis.
    let nearLow = clamp(f32(major) * size - reach, lowMajor, highMajor);
    let nearHigh = clamp(f32(major + 1u) * size + reach, lowMajor, highMajor);
    let minorAtLow = startAxes.y + (nearLow - startAxes.x) * slope;
    let minorAtHigh = startAxes.y + (nearHigh - startAxes.x) * slope;
    let firstMinor = gridCoordinate(min(minorAtLow, minorAtHigh) - reach, minorCount);
    let lastMinor = gridCoordinate(max(minorAtLow, minorAtHigh) + reach, minorCount);
    for (var minor = firstMinor; minor <= lastMinor && budget > 0u; minor = minor + 1u) {
      let cell = select(minor + major * params.gridColumns, major + minor * params.gridColumns, majorIsX);
      collideCellWithSegment(cell, start, end, reach);
      budget = budget - 1u;
    }
    if (threatPerStep > 0.0) {
      let middle = clamp((f32(major) + 0.5) * size, lowMajor, highMajor);
      let point = vec2f(middle, startAxes.y + (middle - startAxes.x) * slope);
      let worldPoint = select(point.yx, point, majorIsX);
      atomicAdd(&threatAccumulator[coarseCellIndexFor(worldPoint)], u32(threatPerStep * THREAT_FIXED_POINT_SCALE));
    }
  }
}

// Walks the cells intersecting the annulus [inner, outer] around center, at most
// RING_CELL_BUDGET of them.
fn collideRing(center: vec2f, inner: f32, outer: f32) {
  let size = params.cellSize;
  let firstRow = gridCoordinate(center.y - outer, params.gridRows);
  let lastRow = gridCoordinate(center.y + outer, params.gridRows);
  var budget = RING_CELL_BUDGET;
  for (var row = firstRow; row <= lastRow && budget > 0u; row = row + 1u) {
    let low = f32(row) * size - center.y;
    let high = low + size;
    var nearest = min(abs(low), abs(high));
    if (low <= 0.0 && high >= 0.0) {
      nearest = 0.0;
    }
    let farthest = max(abs(low), abs(high));
    if (nearest > outer) {
      continue;
    }
    let outerHalfWidth = sqrt(outer * outer - nearest * nearest);
    let firstColumn = i32(gridCoordinate(center.x - outerHalfWidth, params.gridColumns));
    let lastColumn = i32(gridCoordinate(center.x + outerHalfWidth, params.gridColumns));
    // Columns wholly inside (center.x - innerHalfWidth, center.x + innerHalfWidth) are within
    // the inner circle for every point of this row; an empty hole has holeFirst > holeLast.
    var holeFirst = 1;
    var holeLast = 0;
    if (inner > farthest) {
      let innerHalfWidth = sqrt(inner * inner - farthest * farthest);
      holeFirst = i32(floor((center.x - innerHalfWidth) / size)) + 1;
      holeLast = i32(ceil((center.x + innerHalfWidth) / size)) - 2;
    }
    for (var column = firstColumn; column <= lastColumn && budget > 0u; column = column + 1) {
      if (column >= holeFirst && column <= holeLast) {
        column = holeLast;
        continue;
      }
      collideCellWithRing(u32(column) + row * params.gridColumns, center, inner, outer);
      budget = budget - 1u;
    }
  }
}

fn flushKills(localIndex: u32) {
  if (localIndex == 0u) {
    let kills = atomicLoad(&workgroupKills);
    if (kills > 0u) {
      atomicAdd(&stats[STAT_KILLS], kills);
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(
  @builtin(global_invocation_id) globalId: vec3u,
  @builtin(local_invocation_index) localIndex: u32,
) {
  let slot = globalId.x;
  if (slot < arrayLength(&projectiles)) {
    let projectile = projectiles[slot];
    if ((projectile.flags & PROJECTILE_FLAG_ALIVE) != 0u && projectile.kind != PROJECTILE_KIND_BEAM) {
      if (projectile.kind == PROJECTILE_KIND_PULSE_RING) {
        let band = max(RING_MINIMUM_BAND, projectile.extra * params.dt);
        collideRing(projectile.position, max(0.0, projectile.radius - band), projectile.radius);
      } else {
        collideCapsule(projectile.previousPosition, projectile.position, projectile.radius + CAPSULE_KILL_MARGIN, 0u, 1u, CAPSULE_CELL_BUDGET, NO_THREAT);
      }
    }
  }
  workgroupBarrier();
  flushKills(localIndex);
}

// Distance along direction from origin (inside the arena) to the arena edge.
fn distanceToArenaEdge(origin: vec2f, direction: vec2f) -> f32 {
  var nearest = ARENA_WIDTH + ARENA_HEIGHT;
  if (direction.x > 0.0) { nearest = min(nearest, (ARENA_WIDTH - origin.x) / direction.x); }
  if (direction.x < 0.0) { nearest = min(nearest, -origin.x / direction.x); }
  if (direction.y > 0.0) { nearest = min(nearest, (ARENA_HEIGHT - origin.y) / direction.y); }
  if (direction.y < 0.0) { nearest = min(nearest, -origin.y / direction.y); }
  return nearest;
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn beam(@builtin(local_invocation_index) localIndex: u32) {
  let projectile = projectiles[BEAM_SLOT];
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) != 0u && projectile.kind == PROJECTILE_KIND_BEAM) {
    let origin = clampToArena(projectile.position);
    let end = origin + projectile.velocity * distanceToArenaEdge(origin, projectile.velocity);
    collideCapsule(origin, end, projectile.radius, localIndex, WORKGROUP_SIZE, BEAM_CELL_BUDGET, BEAM_THREAT_UNITS);
  }
  workgroupBarrier();
  flushKills(localIndex);
}
