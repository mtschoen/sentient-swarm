// Projectile step, one thread per projectile slot, run before projectiles_collide.wgsl so the
// collide pass sees this step's segment from previousPosition to position. Dead slots and the
// beam (slot 0, rewritten by the CPU every frame while firing) are untouched.
//
// A pulseRing whose lifetime has run out dies; otherwise it stays put, grows radius by
// extra * dt and loses dt of lifetime. Every other kind dies when its lifetime ran out or it left
// the arena in an earlier step (checked before moving, so the collide pass still sees the segment
// that crossed the edge or used the last of the lifetime). A live one then steers (sidewinders
// only), moves by velocity * dt and loses dt of lifetime.
//
// Sidewinders turn toward the gradient of total species density in the blurred coarse field,
// at most extra radians per second, keeping their speed, and weave (see weave).
// A pulseOrb that moves into a detonation (its lifetime ran out, it left the arena, or the total
// density at its coarse cell exceeds extra) keeps its kind for that step, so the collide pass
// still walks the segment it just flew, and converts at the start of the next step, before it
// moves: it becomes a pulseRing at its position (clamped back to the arena) with zero
// velocity, radius RING_START_RADIUS, lifetime RING_LIFETIME and extra RING_GROWTH_SPEED. Each detonation adds 1 to stats ringsThisFrame; the one that took
// count 0 also stores its position as f32 bits in lastRingX and lastRingY, so the pair is always
// one ring's (the CPU turns it into one warp grid impulse per frame).
// A pulseOrb that kills detonates at once in projectiles_collide.wgsl (it is a ring by the next
// step); the detonations here are for an orb that met nothing.
// A sidewinder's detonation ring is made by projectiles_collide.wgsl (MISSILE_RING_LIFETIME, the
// missile flag); this pass grows and expires it like any ring. Ring constants are in common.wgsl.
// Danger: after a live projectile of any kind but the beam and the rings has moved (and still has
// lifetime left, so a bullet that expired or an orb that detonates this step adds none), it adds
// danger to the coarse field ahead of its new position along its velocity direction: points one
// coarse cell apart covering DANGER_LOOKAHEAD_SECONDS of its own flight (at most
// DANGER_MAXIMUM_SAMPLES), weights falling linearly from DANGER_NEAR_WEIGHT to DANGER_FAR_WEIGHT,
// points outside the world skipped. Each point also splats the DANGER_SIDE_CELLS cells either side
// of it perpendicular to the velocity, weight falling linearly to zero one cell past the last, so
// a lane is a wide ridge whose slope reaches about a unit sideways after the blur. The atomicAdd
// count per projectile per step is bounded: at most DANGER_MAXIMUM_SAMPLES * (2 * DANGER_SIDE_CELLS + 1)
// (24 by 7 = 168). The words are the danger half of the field's accumulator
// (DANGER_ACCUMULATOR_OFFSET); the next step's convert folds them into channel 6 before steer.
// Storage buffers: projectiles, field, stats, dangerAccumulator = 4.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> projectiles: array<Projectile>;
@group(0) @binding(2) var<storage, read> field: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;
// The field's threatAccumulator buffer: only the danger words (from DANGER_ACCUMULATOR_OFFSET) are written here.
@group(0) @binding(4) var<storage, read_write> dangerAccumulator: array<atomic<u32>>;

const MINIMUM_LENGTH: f32 = 0.000001;
// Sidewinder weave: radians per second and radians per second of lifetime.
const WEAVE_TURN_RATE: f32 = 3.0;
const WEAVE_FREQUENCY: f32 = 10.0;
// Seconds of the projectile's own flight the danger look-ahead covers, and the most points it uses.
const DANGER_LOOKAHEAD_SECONDS: f32 = 0.5;
const DANGER_MAXIMUM_SAMPLES: u32 = 24u;
// Cells splatted each side of a look-ahead point, perpendicular to the velocity.
const DANGER_SIDE_CELLS: i32 = 3;
// Weight (agents' worth of danger) at the projectile and at the far end of the look-ahead.
const DANGER_NEAR_WEIGHT: f32 = 1.0;
const DANGER_FAR_WEIGHT: f32 = 0.25;
const DANGER_CELL_SIZE: f32 = WORLD_WIDTH / f32(COARSE_COLUMNS);

// Species densities are channels 0..4 (SPECIES_COUNT): the low vector plus the high vector's x.
fn totalDensity(coordinate: vec2i) -> f32 {
  let clamped = clamp(coordinate, vec2i(0, 0), vec2i(i32(COARSE_COLUMNS) - 1, i32(COARSE_ROWS) - 1));
  let cell = u32(clamped.x) + u32(clamped.y) * COARSE_COLUMNS;
  let low = field[cell * VECTORS_PER_CELL];
  let high = field[cell * VECTORS_PER_CELL + 1u];
  return low.x + low.y + low.z + low.w + high.x;
}

// Inside the arena bounds (params.worldBounds), the playable part of the world.
fn isInsideArena(position: vec2f) -> bool {
  return all(position >= params.worldBounds.xy) && all(position <= params.worldBounds.zw);
}

// Rotates velocity toward the density gradient by at most maximumTurn radians. totalDensity clamps
// to the field, so on the edge cells the difference is one-sided.
fn steerTowardDensity(position: vec2f, velocity: vec2f, maximumTurn: f32) -> vec2f {
  let cell = coarseCellCoordinate(position);
  let gradient = vec2f(
    totalDensity(cell + vec2i(1, 0)) - totalDensity(cell - vec2i(1, 0)),
    totalDensity(cell + vec2i(0, 1)) - totalDensity(cell - vec2i(0, 1)),
  );
  let speed = length(velocity);
  if (length(gradient) < MINIMUM_LENGTH || speed < MINIMUM_LENGTH) {
    return velocity;
  }
  let heading = velocity / speed;
  let desiredHeading = normalize(gradient);
  let angle = atan2(heading.x * desiredHeading.y - heading.y * desiredHeading.x, dot(heading, desiredHeading));
  let turn = clamp(angle, -maximumTurn, maximumTurn);
  let cosine = cos(turn);
  let sine = sin(turn);
  return vec2f(heading.x * cosine - heading.y * sine, heading.x * sine + heading.y * cosine) * speed;
}

// A sinusoidal turn added to the steering so the flight path visibly weaves (about 0.3 radians of
// heading swing), out of phase per projectile through its seed.
fn weave(velocity: vec2f, lifetime: f32, seed: f32, dt: f32) -> vec2f {
  let turn = WEAVE_TURN_RATE * sin(lifetime * WEAVE_FREQUENCY + seed * 6.2831853) * dt;
  let cosine = cos(turn);
  let sine = sin(turn);
  return vec2f(velocity.x * cosine - velocity.y * sine, velocity.x * sine + velocity.y * cosine);
}

fn detonate(orb: Projectile) -> Projectile {
  var ring = orb;
  ring.kind = PROJECTILE_KIND_PULSE_RING;
  ring.position = clampToBounds(orb.position, params);
  ring.previousPosition = ring.position;
  ring.velocity = vec2f(0.0, 0.0);
  ring.radius = RING_START_RADIUS;
  ring.lifetime = RING_LIFETIME;
  ring.extra = RING_GROWTH_SPEED;
  return ring;
}

// Adds the look-ahead danger of a moving projectile at its new position.
fn splatDanger(position: vec2f, velocity: vec2f) {
  let speed = length(velocity);
  if (speed < MINIMUM_LENGTH) {
    return;
  }
  let direction = velocity / speed;
  let perpendicular = vec2f(-direction.y, direction.x);
  let sampleCount = clamp(u32(ceil(speed * DANGER_LOOKAHEAD_SECONDS / DANGER_CELL_SIZE)), 1u, DANGER_MAXIMUM_SAMPLES);
  for (var index = 0u; index < sampleCount; index = index + 1u) {
    let point = position + direction * (DANGER_CELL_SIZE * f32(index));
    if (any(point < vec2f(0.0, 0.0)) || point.x >= WORLD_WIDTH || point.y >= WORLD_HEIGHT) {
      continue;
    }
    let along = select(f32(index) / f32(sampleCount - 1u), 0.0, sampleCount == 1u);
    let weight = mix(DANGER_NEAR_WEIGHT, DANGER_FAR_WEIGHT, along);
    for (var side = -DANGER_SIDE_CELLS; side <= DANGER_SIDE_CELLS; side = side + 1) {
      let sidePoint = point + perpendicular * (DANGER_CELL_SIZE * f32(side));
      if (any(sidePoint < vec2f(0.0, 0.0)) || sidePoint.x >= WORLD_WIDTH || sidePoint.y >= WORLD_HEIGHT) {
        continue;
      }
      let sideWeight = weight * (1.0 - f32(abs(side)) / f32(DANGER_SIDE_CELLS + 1));
      atomicAdd(&dangerAccumulator[DANGER_ACCUMULATOR_OFFSET + coarseCellIndexFor(sidePoint)], u32(sideWeight * THREAT_FIXED_POINT_SCALE));
    }
  }
}

@compute @workgroup_size(WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) globalId: vec3u) {
  let slot = globalId.x;
  if (slot >= arrayLength(&projectiles)) {
    return;
  }
  var projectile = projectiles[slot];
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) == 0u || projectile.kind == PROJECTILE_KIND_BEAM) {
    return;
  }
  // Real time, not the swarm's: projectiles keep full speed through a time warp.
  let dt = params.projectileDt;
  if (projectile.kind == PROJECTILE_KIND_PULSE_RING) {
    if (projectile.lifetime <= 0.0) {
      projectile.flags = projectile.flags & ~PROJECTILE_FLAG_ALIVE;
    } else {
      projectile.radius = projectile.radius + projectile.extra * dt;
      projectile.lifetime = projectile.lifetime - dt;
    }
    projectiles[slot] = projectile;
    return;
  }
  if (projectile.kind == PROJECTILE_KIND_PULSE_ORB && projectile.lifetime <= 0.0) {
    projectile = detonate(projectile);
    if (atomicAdd(&stats[STAT_RINGS_THIS_FRAME], 1u) == 0u) {
      atomicStore(&stats[STAT_LAST_RING_X], bitcast<u32>(projectile.position.x));
      atomicStore(&stats[STAT_LAST_RING_Y], bitcast<u32>(projectile.position.y));
    }
    projectiles[slot] = projectile;
    return;
  }
  if (projectile.kind != PROJECTILE_KIND_PULSE_ORB && (projectile.lifetime <= 0.0 || !isInsideArena(projectile.position))) {
    projectile.flags = projectile.flags & ~PROJECTILE_FLAG_ALIVE;
    projectiles[slot] = projectile;
    return;
  }
  if (projectile.kind == PROJECTILE_KIND_SIDEWINDER) {
    projectile.velocity = steerTowardDensity(projectile.position, projectile.velocity, projectile.extra * dt);
    projectile.velocity = weave(projectile.velocity, projectile.lifetime, projectile.seed, dt);
  }
  projectile.previousPosition = projectile.position;
  projectile.position = projectile.position + projectile.velocity * dt;
  projectile.lifetime = projectile.lifetime - dt;
  if (projectile.kind == PROJECTILE_KIND_PULSE_ORB) {
    let detonates = projectile.lifetime <= 0.0
      || !isInsideArena(projectile.position)
      || totalDensity(coarseCellCoordinate(projectile.position)) > projectile.extra;
    if (detonates) {
      // Marked, not converted: the collide pass still capsule-walks this step's segment (it
      // skips rings), and the next step converts the orb before it moves.
      projectile.lifetime = 0.0;
    }
  }
  if (projectile.lifetime > 0.0) {
    splatDanger(projectile.position, projectile.velocity);
  }
  projectiles[slot] = projectile;
}
