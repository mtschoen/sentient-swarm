// Over 500 lines: the capsule, ring and beam entry points share the kill and grid walk helpers here.
// Projectile collision against the spatial grid, run after projectiles_step.wgsl on the freshly
// integrated agents. The grid was built from the step's input agents, so cell membership is one
// step stale while distances use current positions. Every kind pierces except the sidewinder, which
// detonates on its first kill (below); a base bullet (kind
// bullet) with extra of 1 or more (the lab's base gun kill budget, task C6b; 0 is unlimited, the
// default) stops killing once it has spent extra kills, writes the rest back into extra and dies
// at 0. Its thread is the only one walking it, so a private counter is exact.
//
// Entry main, one thread per projectile slot (the beam slot is skipped):
// - bullet, scatter, rail, pulseOrb, sidewinder: that thread walks the capsule from
//   previousPosition to position with reach radius + CAPSULE_KILL_MARGIN. Its cells are walked
//   along the segment's major axis: for every grid column (or row) the capsule touches, the
//   minor-axis cell span is the segment's minor range over that column widened by the reach on
//   both sides, then by the reach along the major axis for the end caps. At most
//   CAPSULE_CELL_BUDGET cells. An agent dies when
//   its distance to the segment is at most the reach. The budget covers a radius 0.2 energy ball
//   at speed 10 on every preset grid (cell size 0.08 to 0.12) at full and half simulation rate:
//   at most 89 cells, worst at cell size 0.08 with a half-rate step (tests/sim/capsule-budget.test.js).
// - sidewinder: walked with a kill budget of 1. If it killed, its slot is rewritten in place as a
//   pulse ring (flag PROJECTILE_FLAG_MISSILE_RING, lifetime MISSILE_RING_LIFETIME, so it grows to
//   half a pulse ring) at its position clamped to the arena, counted in stats ringsThisFrame and
//   lastRingX/Y as an orb's detonation is; the rings entry then collides it. A miss flies on.
// - pulseRing: skipped here, see rings.
// Entry rings, a few workgroups (RING_WORKGROUP_COUNT in projectiles.js): every workgroup scans
// the slots for alive pulse rings (at most MAXIMUM_LISTED_RINGS), then all the dispatch's threads
// walk every ring's cells together, interleaved so consecutive cells land in different
// workgroups. A ring in a dense mass covers hundreds of crowded cells: walked by one thread it
// cost about 9 ms per frame at 262144 agents with 3 rings, and by one workgroup about 2.4 ms. The
// band is [radius - max(RING_MINIMUM_BAND, extra * dt), radius] around position, so a ring
// growing faster than the minimum band per step still sweeps without gaps. Only cells
// intersecting the annulus are walked: per grid row, the column span of the outer circle minus
// the columns lying wholly inside the inner circle, in row-major order. At most RING_CELL_BUDGET
// cells per ring. Each cell's agents are still looped by one thread, as for capsules: the work
// is bounded by cell count, not by agent count.
// Entry beam, one workgroup: slot 0 when it is an alive beam. The beam kills the sector swept
// since the previous step: from position, between the previous direction (seed, extra) and the
// current one (velocity), both unit, over the shortest arc, out to the arena edge, padded by the
// half width (radius) around both edge rays, so a fast turn leaves no gaps between steps. A first
// step has both directions equal, which is the plain capsule. The shortest arc is never wider
// than 180 degrees, so no clamp is needed; an exact reversal takes the counterclockwise half
// disc from the previous direction. Only the grid cells of the sector's bounding box (its origin,
// the two edge ray ends and the arena corners inside it, widened by the reach) are visited, in
// row-major order interleaved across the workgroup; a cell is collided when its center is within
// the reach plus its half diagonal of the sector, at most BEAM_CELL_BUDGET collided cells per
// thread. The beam slot's lifetime is its kill reach scale (task C6b, the lab's beam sweep budget):
// below 1 the sector is also cut at scale times the current ray's length to the edge (the reach
// limit), and the threat trench stops there; at 1 (the default) every path is the full sector.
// Every major-axis step of the current ray also adds BEAM_THREAT_UNITS threat at the
// ray's coarse cell so the trench shows where nothing dies.
//
// A kill is the Plan A kill: the agent must be alive and past its spawn-in frames; atomicAnd
// clears the alive bit and only the thread that saw it set counts the kill, so overlapping
// projectiles never double count. A counted kill adds 1 to the workgroup kill count (one global
// atomicAdd into stats from thread 0), asks for params.killBurstParticles particles in the species
// hue (from the hues uniform) from the step's shared particle budget, which grants them first come
// first served until the free slots run out (a beam through a dense crowd), and adds one threat
// unit at the agent's coarse cell.
// Barriers sit outside every branch.
//
// Storage buffers: projectiles, agents, cellCounts, cellOffsets, sortedIndices, particles (pool
// cursor in its header), threatAccumulator, stats = 8; uniforms: params, hues.

// Species hues 0..3, then species 4 in second.x; copied from the species table every frame.
struct SpeciesHues {
  first: vec4f,
  second: vec4f,
}

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<uniform> hues: SpeciesHues;
@group(0) @binding(2) var<storage, read_write> projectiles: array<Projectile>;
@group(0) @binding(3) var<storage, read_write> agents: array<AtomicAgent>;
@group(0) @binding(4) var<storage, read> cellCounts: array<u32>;
@group(0) @binding(5) var<storage, read> cellOffsets: array<u32>;
@group(0) @binding(6) var<storage, read> sortedIndices: array<u32>;
@group(0) @binding(7) var<storage, read_write> pool: ParticlePool;
@group(0) @binding(8) var<storage, read_write> threatAccumulator: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read_write> stats: array<atomic<u32>>;

const CAPSULE_KILL_MARGIN: f32 = 0.02;
const CAPSULE_CELL_BUDGET: u32 = 96u;
const RING_MINIMUM_BAND: f32 = 0.08;
const RING_CELL_BUDGET: u32 = 1024u;
const BEAM_THREAT_UNITS: f32 = 4.0;
// Collided cells per beam thread: 65536 for the workgroup, more than the whole grid at the default
// cell size (14400 cells), so a sweep wide enough to cover half the arena is never cut short.
const BEAM_CELL_BUDGET: u32 = 256u;
// The beam slot's previous direction is unit; anything shorter (a zero-filled slot) is a line.
const BEAM_MINIMUM_PREVIOUS_LENGTH_SQUARED: f32 = 0.25;
const BEAM_SLOT: u32 = 0u;
const NO_THREAT: f32 = 0.0;
const UNLIMITED_KILLS: u32 = 0xffffffffu;
// Longer than any ray in the arena: the reach limit of an unscaled beam.
const UNLIMITED_REACH: f32 = 1e9;

// Kills this invocation may still make (the base gun kill budget); unlimited unless main sets it.
var<private> killBudget: u32 = UNLIMITED_KILLS;

var<workgroup> workgroupKills: atomic<u32>;
// Alive pulse ring slots found by this workgroup's scan (zero-initialized per workgroup). The
// pulse weapon keeps at most about 9 rings alive; rings past MAXIMUM_LISTED_RINGS do not collide.
const MAXIMUM_LISTED_RINGS: u32 = 256u;
var<workgroup> ringCount: atomic<u32>;
var<workgroup> ringSlots: array<u32, MAXIMUM_LISTED_RINGS>;

fn speciesHue(species: u32) -> f32 {
  if (species < 4u) {
    return hues.first[species];
  }
  return hues.second.x;
}

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
  let color = killParticleColor(speciesHue(species), hueJitter, 1.0);
  let seed = killBurstSeed(agentIndex, params.frameSequence);
  for (var index = 0u; index < count; index = index + 1u) {
    pool.particles[(first + index) % capacity] = killBurstParticle(index, count, params.killFragmentParticles, seed, position, color);
  }
}

// Returns whether this call made the kill (the alive bit was set), after spending one unit of a
// limited kill budget.
fn kill(agentIndex: u32, position: vec2f) -> bool {
  let previousFlags = atomicAnd(&agents[agentIndex].flags, ~FLAG_ALIVE);
  if (isAlive(previousFlags)) {
    if (killBudget != UNLIMITED_KILLS) {
      killBudget = killBudget - 1u;
    }
    atomicAdd(&workgroupKills, 1u);
    emitKillParticles(agentIndex, position, min(agents[agentIndex].species, SPECIES_COUNT - 1u), agents[agentIndex].hueJitter, params.killBurstParticles + params.killFragmentParticles);
    atomicAdd(&threatAccumulator[coarseCellIndexFor(position)], u32(THREAT_FIXED_POINT_SCALE));
    return true;
  }
  return false;
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
  for (var index = 0u; index < count && killBudget > 0u; index = index + 1u) {
    let agentIndex = sortedIndices[first + index];
    if (isKillable(atomicLoad(&agents[agentIndex].flags))) {
      let position = agents[agentIndex].position;
      if (distanceToSegment(position, start, end) <= reach) {
        _ = kill(agentIndex, position);
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
        _ = kill(agentIndex, position);
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
    for (var minor = firstMinor; minor <= lastMinor && budget > 0u && killBudget > 0u; minor = minor + 1u) {
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

// Collides the cells of one row's column segment [segmentFirst, segmentLast]; base is the ring's
// running cell index at the segment start. This thread takes the cells whose running index is
// firstCell modulo cellStride, below RING_CELL_BUDGET. Returns the running index after the segment.
fn collideRingSegment(row: u32, segmentFirst: i32, segmentLast: i32, base: u32, firstCell: u32, cellStride: u32, center: vec2f, inner: f32, outer: f32) -> u32 {
  if (segmentLast < segmentFirst) {
    return base;
  }
  let length = u32(segmentLast - segmentFirst + 1);
  let limit = min(base + length, RING_CELL_BUDGET);
  for (var cellIndex = base + (firstCell + cellStride - base % cellStride) % cellStride; cellIndex < limit; cellIndex = cellIndex + cellStride) {
    let column = u32(segmentFirst + i32(cellIndex - base));
    collideCellWithRing(column + row * params.gridColumns, center, inner, outer);
  }
  return base + length;
}

// Walks the cells intersecting the annulus [inner, outer] around center, at most
// RING_CELL_BUDGET of them, taking the running cell indices firstCell, firstCell + cellStride, ...
fn collideRing(center: vec2f, inner: f32, outer: f32, firstCell: u32, cellStride: u32) {
  let size = params.cellSize;
  let firstRow = gridCoordinate(center.y - outer, params.gridRows);
  let lastRow = gridCoordinate(center.y + outer, params.gridRows);
  var base = 0u;
  for (var row = firstRow; row <= lastRow && base < RING_CELL_BUDGET; row = row + 1u) {
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
    var holeFirst = lastColumn + 1;
    var holeLast = lastColumn;
    if (inner > farthest) {
      let innerHalfWidth = sqrt(inner * inner - farthest * farthest);
      let first = i32(floor((center.x - innerHalfWidth) / size)) + 1;
      let last = i32(ceil((center.x + innerHalfWidth) / size)) - 2;
      if (first <= last) {
        holeFirst = first;
        holeLast = last;
      }
    }
    base = collideRingSegment(row, firstColumn, min(lastColumn, holeFirst - 1), base, firstCell, cellStride, center, inner, outer);
    base = collideRingSegment(row, max(firstColumn, holeLast + 1), lastColumn, base, firstCell, cellStride, center, inner, outer);
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
    let isCapsule = projectile.kind != PROJECTILE_KIND_BEAM && projectile.kind != PROJECTILE_KIND_PULSE_RING;
    if ((projectile.flags & PROJECTILE_FLAG_ALIVE) != 0u && isCapsule) {
      let budgeted = projectile.kind == PROJECTILE_KIND_BULLET && projectile.extra >= 1.0;
      if (budgeted) {
        killBudget = u32(projectile.extra);
      }
      let detonates = projectile.kind == PROJECTILE_KIND_SIDEWINDER;
      if (detonates) {
        killBudget = 1u;
      }
      collideCapsule(projectile.previousPosition, projectile.position, projectile.radius + CAPSULE_KILL_MARGIN, 0u, 1u, CAPSULE_CELL_BUDGET, NO_THREAT);
      if (detonates && killBudget == 0u) {
        var ring = projectile;
        ring.kind = PROJECTILE_KIND_PULSE_RING;
        ring.position = clampToArena(projectile.position);
        ring.previousPosition = ring.position;
        ring.velocity = vec2f(0.0, 0.0);
        ring.radius = RING_START_RADIUS;
        ring.lifetime = MISSILE_RING_LIFETIME;
        ring.extra = RING_GROWTH_SPEED;
        ring.flags = projectile.flags | PROJECTILE_FLAG_MISSILE_RING;
        projectiles[slot] = ring;
        if (atomicAdd(&stats[STAT_RINGS_THIS_FRAME], 1u) == 0u) {
          atomicStore(&stats[STAT_LAST_RING_X], bitcast<u32>(ring.position.x));
          atomicStore(&stats[STAT_LAST_RING_Y], bitcast<u32>(ring.position.y));
        }
      }
      if (budgeted) {
        projectiles[slot].extra = f32(killBudget);
        if (killBudget == 0u) {
          projectiles[slot].flags = projectile.flags & ~PROJECTILE_FLAG_ALIVE;
        }
      }
    }
  }
  workgroupBarrier();
  flushKills(localIndex);
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn rings(
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3u,
  @builtin(num_workgroups) workgroupCount: vec3u,
) {
  let slotCount = arrayLength(&projectiles);
  for (var slot = localIndex; slot < slotCount; slot = slot + WORKGROUP_SIZE) {
    if ((projectiles[slot].flags & PROJECTILE_FLAG_ALIVE) != 0u && projectiles[slot].kind == PROJECTILE_KIND_PULSE_RING) {
      let index = atomicAdd(&ringCount, 1u);
      if (index < MAXIMUM_LISTED_RINGS) {
        ringSlots[index] = slot;
      }
    }
  }
  workgroupBarrier();
  let ringTotal = min(atomicLoad(&ringCount), MAXIMUM_LISTED_RINGS);
  // Workgroup-minor thread numbering, so a ring's consecutive cells go to different workgroups;
  // ring r starts r * RING_CELL_BUDGET threads on, so rings use disjoint threads where they can.
  // The list order differs between workgroups, so the offset comes from the slot, not the index.
  let threadTotal = workgroupCount.x * WORKGROUP_SIZE;
  let thread = localIndex * workgroupCount.x + workgroupId.x;
  for (var ring = 0u; ring < ringTotal; ring = ring + 1u) {
    let slot = ringSlots[ring];
    let projectile = projectiles[slot];
    let band = max(RING_MINIMUM_BAND, projectile.extra * params.projectileDt);
    let offset = (slot * RING_CELL_BUDGET) % threadTotal;
    collideRing(projectile.position, max(0.0, projectile.radius - band), projectile.radius, (thread + threadTotal - offset) % threadTotal, threadTotal);
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

// The beam's swept sector (see the header): start and finish are its edge directions in
// counterclockwise order (start to finish turns from +x toward +y), and startEnd, finishEnd the
// ends of the edge rays on the arena edge.
struct BeamSector {
  origin: vec2f,
  start: vec2f,
  finish: vec2f,
  bisector: vec2f,
  startEnd: vec2f,
  finishEnd: vec2f,
  reach: f32,
  // Distance from the origin past which nothing is killed (UNLIMITED_REACH for an unscaled beam).
  limit: f32,
}

fn crossProduct(first: vec2f, second: vec2f) -> f32 {
  return first.x * second.y - first.y * second.x;
}

fn beamSector(projectile: Projectile) -> BeamSector {
  var sector: BeamSector;
  sector.origin = clampToArena(projectile.position);
  let current = projectile.velocity;
  var previous = vec2f(projectile.seed, projectile.extra);
  if (dot(previous, previous) < BEAM_MINIMUM_PREVIOUS_LENGTH_SQUARED) {
    previous = current;
  }
  let clockwise = crossProduct(previous, current) < 0.0;
  sector.start = select(previous, current, clockwise);
  sector.finish = select(current, previous, clockwise);
  sector.bisector = sector.start + sector.finish;
  if (dot(sector.bisector, sector.bisector) < 1e-8) {
    sector.bisector = vec2f(-sector.start.y, sector.start.x);
  }
  sector.limit = UNLIMITED_REACH;
  if (projectile.lifetime < 1.0) {
    sector.limit = max(projectile.lifetime, 0.0) * distanceToArenaEdge(sector.origin, current);
  }
  sector.startEnd = sector.origin + sector.start * min(distanceToArenaEdge(sector.origin, sector.start), sector.limit);
  sector.finishEnd = sector.origin + sector.finish * min(distanceToArenaEdge(sector.origin, sector.finish), sector.limit);
  sector.reach = projectile.radius;
  return sector;
}

// True when the offset from the origin points between start and finish (the arc is at most 180
// degrees, so the two half planes and the bisector side bound it exactly).
fn insideSectorArc(sector: BeamSector, offset: vec2f) -> bool {
  return crossProduct(sector.start, offset) >= 0.0 && crossProduct(offset, sector.finish) >= 0.0 && dot(offset, sector.bisector) >= 0.0;
}

// Distance from an arena point to the sector clipped by the arena: 0 inside the arc, else the
// distance to the nearer edge ray.
fn distanceToSector(sector: BeamSector, point: vec2f) -> f32 {
  let offset = point - sector.origin;
  if (insideSectorArc(sector, offset)) {
    // Past the reach limit the nearest sector point lies on the limit's arc.
    return max(length(offset) - sector.limit, 0.0);
  }
  return min(distanceToSegment(point, sector.origin, sector.startEnd), distanceToSegment(point, sector.origin, sector.finishEnd));
}

fn collideCellWithSector(cell: u32, sector: BeamSector) {
  let first = cellOffsets[cell];
  let count = cellCounts[cell];
  for (var index = 0u; index < count; index = index + 1u) {
    let agentIndex = sortedIndices[first + index];
    if (isKillable(atomicLoad(&agents[agentIndex].flags))) {
      let position = agents[agentIndex].position;
      if (distanceToSector(sector, position) <= sector.reach) {
        _ = kill(agentIndex, position);
      }
    }
  }
}

// bounds is (minimum x, minimum y, maximum x, maximum y).
fn includeCorner(sector: BeamSector, corner: vec2f, bounds: vec4f) -> vec4f {
  if (insideSectorArc(sector, corner - sector.origin) && length(corner - sector.origin) <= sector.limit) {
    return vec4f(min(bounds.xy, corner), max(bounds.zw, corner));
  }
  return bounds;
}

// Walks the cells of the sector's bounding box, taking the row-major cell indices firstCell,
// firstCell + cellStride, ... and colliding at most BEAM_CELL_BUDGET cells near the sector.
fn collideSector(sector: BeamSector, firstCell: u32, cellStride: u32) {
  var bounds = vec4f(min(sector.origin, min(sector.startEnd, sector.finishEnd)), max(sector.origin, max(sector.startEnd, sector.finishEnd)));
  bounds = includeCorner(sector, vec2f(0.0, 0.0), bounds);
  bounds = includeCorner(sector, vec2f(ARENA_WIDTH, 0.0), bounds);
  bounds = includeCorner(sector, vec2f(0.0, ARENA_HEIGHT), bounds);
  bounds = includeCorner(sector, vec2f(ARENA_WIDTH, ARENA_HEIGHT), bounds);
  if (sector.limit < UNLIMITED_REACH) {
    // The limit's arc can bulge past the edge ray ends: the square around the origin bounds it.
    bounds = vec4f(min(bounds.xy, sector.origin - vec2f(sector.limit)), max(bounds.zw, sector.origin + vec2f(sector.limit)));
  }
  let firstColumn = gridCoordinate(bounds.x - sector.reach, params.gridColumns);
  let lastColumn = gridCoordinate(bounds.z + sector.reach, params.gridColumns);
  let firstRow = gridCoordinate(bounds.y - sector.reach, params.gridRows);
  let lastRow = gridCoordinate(bounds.w + sector.reach, params.gridRows);
  let width = lastColumn - firstColumn + 1u;
  let total = width * (lastRow - firstRow + 1u);
  let size = params.cellSize;
  // The reach plus half a cell diagonal: every point of a cell is that close to its center.
  let cellReach = sector.reach + size * 0.70710678;
  var budget = BEAM_CELL_BUDGET;
  for (var cellIndex = firstCell; cellIndex < total && budget > 0u; cellIndex = cellIndex + cellStride) {
    let column = firstColumn + cellIndex % width;
    let row = firstRow + cellIndex / width;
    let center = (vec2f(f32(column), f32(row)) + vec2f(0.5)) * size;
    if (distanceToSector(sector, center) <= cellReach) {
      collideCellWithSector(column + row * params.gridColumns, sector);
      budget = budget - 1u;
    }
  }
}

// Adds BEAM_THREAT_UNITS threat at every major-axis step of the ray from start to end, taking the
// steps firstStep, firstStep + stepStride, ...
fn addRayThreat(start: vec2f, end: vec2f, firstStep: u32, stepStride: u32) {
  let delta = end - start;
  let majorIsX = abs(delta.x) >= abs(delta.y);
  let startAxes = select(start.yx, start, majorIsX);
  let endAxes = select(end.yx, end, majorIsX);
  let majorCount = select(params.gridRows, params.gridColumns, majorIsX);
  let lowMajor = min(startAxes.x, endAxes.x);
  let highMajor = max(startAxes.x, endAxes.x);
  var slope = 0.0;
  if (highMajor > lowMajor) {
    slope = (endAxes.y - startAxes.y) / (endAxes.x - startAxes.x);
  }
  let size = params.cellSize;
  let lastMajor = gridCoordinate(highMajor, majorCount);
  for (var major = gridCoordinate(lowMajor, majorCount) + firstStep; major <= lastMajor; major = major + stepStride) {
    let middle = clamp((f32(major) + 0.5) * size, lowMajor, highMajor);
    let point = vec2f(middle, startAxes.y + (middle - startAxes.x) * slope);
    atomicAdd(&threatAccumulator[coarseCellIndexFor(select(point.yx, point, majorIsX))], u32(BEAM_THREAT_UNITS * THREAT_FIXED_POINT_SCALE));
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn beam(@builtin(local_invocation_index) localIndex: u32) {
  let projectile = projectiles[BEAM_SLOT];
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) != 0u && projectile.kind == PROJECTILE_KIND_BEAM) {
    let sector = beamSector(projectile);
    collideSector(sector, localIndex, WORKGROUP_SIZE);
    let origin = sector.origin;
    addRayThreat(origin, origin + projectile.velocity * min(distanceToArenaEdge(origin, projectile.velocity), sector.limit), localIndex, WORKGROUP_SIZE);
  }
  workgroupBarrier();
  flushKills(localIndex);
}
