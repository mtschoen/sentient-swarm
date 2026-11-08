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
// A pulseOrb detonates after moving when its lifetime ran out, it left the arena (clamped back
// to the edge), or the total density at its coarse cell exceeds extra: it becomes a pulseRing
// at that point with zero velocity, radius RING_START_RADIUS, lifetime RING_LIFETIME and
// extra RING_GROWTH_SPEED. Each detonation adds 1 to stats ringsThisFrame; the one that took
// count 0 also stores its position as f32 bits in lastRingX and lastRingY, so the pair is always
// one ring's (the CPU turns it into one warp grid impulse per frame).
// Storage buffers: projectiles, field, stats = 3.

@group(0) @binding(0) var<uniform> params: SimParams;
@group(0) @binding(1) var<storage, read_write> projectiles: array<Projectile>;
@group(0) @binding(2) var<storage, read> field: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> stats: array<atomic<u32>, STATS_WORD_COUNT>;

// field holds COARSE_CHANNELS floats per cell as vec4 pairs: channels 0..3, then 4..7.
const VECTORS_PER_CELL: u32 = COARSE_CHANNELS / 4u;
const RING_START_RADIUS: f32 = 0.05;
const RING_LIFETIME: f32 = 0.5;
// World units per second.
const RING_GROWTH_SPEED: f32 = 6.0;
const MINIMUM_LENGTH: f32 = 0.000001;
// Sidewinder weave: radians per second and radians per second of lifetime.
const WEAVE_TURN_RATE: f32 = 3.0;
const WEAVE_FREQUENCY: f32 = 10.0;

// Species densities are channels 0..4 (SPECIES_COUNT): the low vector plus the high vector's x.
fn totalDensity(coordinate: vec2i) -> f32 {
  let clamped = clamp(coordinate, vec2i(0, 0), vec2i(i32(COARSE_COLUMNS) - 1, i32(COARSE_ROWS) - 1));
  let cell = u32(clamped.x) + u32(clamped.y) * COARSE_COLUMNS;
  let low = field[cell * VECTORS_PER_CELL];
  let high = field[cell * VECTORS_PER_CELL + 1u];
  return low.x + low.y + low.z + low.w + high.x;
}

fn isInsideArena(position: vec2f) -> bool {
  return all(position >= vec2f(0.0, 0.0)) && all(position <= vec2f(ARENA_WIDTH, ARENA_HEIGHT));
}

// Rotates velocity toward the density gradient by at most maximumTurn radians.
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
  ring.position = clampToArena(orb.position);
  ring.previousPosition = ring.position;
  ring.velocity = vec2f(0.0, 0.0);
  ring.radius = RING_START_RADIUS;
  ring.lifetime = RING_LIFETIME;
  ring.extra = RING_GROWTH_SPEED;
  return ring;
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
      projectile = detonate(projectile);
      if (atomicAdd(&stats[STAT_RINGS_THIS_FRAME], 1u) == 0u) {
        atomicStore(&stats[STAT_LAST_RING_X], bitcast<u32>(projectile.position.x));
        atomicStore(&stats[STAT_LAST_RING_Y], bitcast<u32>(projectile.position.y));
      }
    }
  }
  projectiles[slot] = projectile;
}
