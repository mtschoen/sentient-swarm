// Projectiles: one instance per projectile slot (4-vertex triangle strip) pulled straight from the
// projectile storage buffer, max-blended (see MAX_BLEND). Dead slots collapse to a degenerate quad. Common
// header prepended (Projectile, PROJECTILE_KIND_*, ARENA_*, hsvToRgb).
// All geometry is in world units in a frame whose +x is the projectile's heading (origin at its
// position), so a quad is a centre, a heading and a half extent; each kind has its own silhouette in the fragment shader:
//   bullet     short bright streak with a white head          scatter  tiny flickering orange spark
//   rail       very long thin streak, white head, fading tail  orb      pulsing glow disc
//   ring       thin expanding circle                           sidewinder  weaving short trail
//   beam       the fat laser from the ship to the arena edge, white core inside a coloured body,
//              plus a fan over the sector swept since the previous step, fading toward the previous aim
// Slot 0 is the beam; the CPU rewrites it every frame while firing, with the previous step's unit
// direction in seed and extra (projectiles_collide.wgsl kills the same sector).

// Uniform layout, total 64 bytes; ProjectileRenderer in projectiles.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, 32 hues vec4f (bullet, scatter, rail, orb), 48 hues vec4f (ring, sidewinder, beam, pad)
struct ProjectileView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  huesFirst: vec4f,
  huesSecond: vec4f,
}

@group(0) @binding(0) var<uniform> view: ProjectileView;
@group(0) @binding(1) var<storage, read> projectiles: array<Projectile>;

const BULLET_TAIL: f32 = 0.24;
const SCATTER_TAIL: f32 = 0.16;
const RAIL_SECONDS_OF_TRAVEL: f32 = 0.05;
const RAIL_MINIMUM_LENGTH: f32 = 0.6;
const SIDEWINDER_TAIL: f32 = 0.7;
const ORB_GLOW_RADIUS_FACTOR: f32 = 3.5;
const RING_GLOW_MARGIN: f32 = 0.2;
const BEAM_GLOW_FACTOR: f32 = 2.2;
const BEAM_GLOW_MARGIN: f32 = 0.1;
const RING_LIFETIME: f32 = 0.5;
const SCATTER_FADE_SECONDS: f32 = 0.12;
const GLOW_SATURATION: f32 = 0.85;
const PIXEL_FEATHER: f32 = 0.75;
// Sweeps narrower than this (radians) draw as the plain beam quad.
const BEAM_MINIMUM_SWEEP: f32 = 0.002;
// The fan's brightness at the previous aim and at the current one (times the body brightness).
const BEAM_FAN_TAIL: f32 = 0.35;
const BEAM_FAN_HEAD: f32 = 1.0;
// White added to the fan at the current aim (cubic falloff toward the previous aim).
const BEAM_FAN_HEAT: f32 = 0.6;

struct ProjectileVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) hue: f32,
  @location(2) @interpolate(flat) kind: u32,
  // x radius (or half beam width), y half extent along the heading, z seed, w fade 0..1.
  @location(3) @interpolate(flat) shape: vec4f,
  // Beam only: xy the current unit direction, zw the previous one (equal for no sweep).
  @location(4) @interpolate(flat) beamDirections: vec4f,
  // Beam only: the ship position the beam starts from.
  @location(5) @interpolate(flat) beamOrigin: vec2f,
}

fn kindHue(kind: u32) -> f32 {
  switch kind {
    case 0u: { return view.huesFirst.x; }
    case 1u: { return view.huesFirst.y; }
    case 2u: { return view.huesFirst.z; }
    case 3u: { return view.huesFirst.w; }
    case 4u: { return view.huesSecond.x; }
    case 5u: { return view.huesSecond.y; }
    default: { return view.huesSecond.z; }
  }
}

// Distance from the origin along a unit direction to the arena boundary.
fn distanceToArenaEdge(origin: vec2f, direction: vec2f) -> f32 {
  let toEdge = vec2f(
    select(-origin.x, ARENA_WIDTH - origin.x, direction.x > 0.0),
    select(-origin.y, ARENA_HEIGHT - origin.y, direction.y > 0.0),
  );
  let scaled = vec2f(
    select(1e9, toEdge.x / direction.x, abs(direction.x) > 1e-5),
    select(1e9, toEdge.y / direction.y, abs(direction.y) > 1e-5),
  );
  return max(min(scaled.x, scaled.y), 0.0);
}

@vertex
fn projectileVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> ProjectileVaryings {
  var output: ProjectileVaryings;
  output.position = vec4f(2.0, 2.0, 0.0, 1.0);
  output.local = vec2f(0.0);
  output.hue = 0.0;
  output.kind = 0u;
  output.shape = vec4f(0.0);
  output.beamDirections = vec4f(0.0);
  output.beamOrigin = vec2f(0.0);
  let projectile = projectiles[instanceIndex];
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) == 0u) {
    return output;
  }
  let kind = projectile.kind;
  let speed = length(projectile.velocity);
  let direction = select(vec2f(1.0, 0.0), projectile.velocity / max(speed, 1e-6), speed > 1e-5);
  let side = vec2f(-direction.y, direction.x);
  var center = projectile.position;
  var halfExtent = vec2f(0.1);
  var fade = 1.0;
  // The swept beam's quad is the sector's world-axis bounding box instead of a heading frame.
  var axisAligned = false;
  switch kind {
    case PROJECTILE_KIND_BULLET: {
      // Centred on the streak (-BULLET_TAIL to 0.04) with a 0.14 margin all round, where the
      // falloff-30 glow is down to about 4 percent, so the quad edge never shows.
      halfExtent = vec2f(BULLET_TAIL * 0.5 + 0.16, 0.14);
      center = projectile.position - direction * (BULLET_TAIL * 0.5 - 0.02);
    }
    case PROJECTILE_KIND_SCATTER: {
      halfExtent = vec2f(SCATTER_TAIL * 0.5 + 0.08, 0.1);
      center = projectile.position - direction * (SCATTER_TAIL * 0.5 - 0.03);
      fade = clamp(projectile.lifetime / SCATTER_FADE_SECONDS, 0.0, 1.0);
    }
    case PROJECTILE_KIND_RAIL: {
      let length = max(speed * RAIL_SECONDS_OF_TRAVEL, RAIL_MINIMUM_LENGTH);
      halfExtent = vec2f(length * 0.5 + 0.12, 0.14);
      center = projectile.position - direction * (length * 0.5 - 0.05);
    }
    case PROJECTILE_KIND_PULSE_ORB: {
      halfExtent = vec2f(projectile.radius * ORB_GLOW_RADIUS_FACTOR);
    }
    case PROJECTILE_KIND_PULSE_RING: {
      halfExtent = vec2f(projectile.radius + RING_GLOW_MARGIN);
      fade = clamp(projectile.lifetime / RING_LIFETIME, 0.0, 1.0);
    }
    case PROJECTILE_KIND_SIDEWINDER: {
      halfExtent = vec2f(SIDEWINDER_TAIL * 0.5 + 0.1, 0.2);
      center = projectile.position - direction * (SIDEWINDER_TAIL * 0.5 - 0.06);
    }
    default: {
      // Beam: from the ship (position) along the unit direction to the arena edge.
      let length = distanceToArenaEdge(projectile.position, direction);
      let glowWidth = projectile.radius * BEAM_GLOW_FACTOR + BEAM_GLOW_MARGIN;
      halfExtent = vec2f(length * 0.5 + 0.05, glowWidth);
      center = projectile.position + direction * (length * 0.5);
      let previous = beamPreviousDirection(projectile, direction);
      output.beamDirections = vec4f(direction, previous);
      output.beamOrigin = projectile.position;
      if (sweptAngle(previous, direction) > BEAM_MINIMUM_SWEEP) {
        let bounds = beamSweepBounds(projectile.position, previous, direction, glowWidth + 0.05);
        center = (bounds.xy + bounds.zw) * 0.5;
        halfExtent = (bounds.zw - bounds.xy) * 0.5;
        axisAligned = true;
      }
      // shape.w carries the beam length to the fragment.
      fade = length;
    }
  }
  let corner = vec2f(f32(vertexIndex & 1u), f32(vertexIndex >> 1u)) * 2.0 - vec2f(1.0);
  let local = corner * halfExtent;
  let quadDirection = select(direction, vec2f(1.0, 0.0), axisAligned);
  let quadSide = vec2f(-quadDirection.y, quadDirection.x);
  // World y grows downward like the screen, so the world offset maps through the signed scale.
  let world = center + quadDirection * local.x + quadSide * local.y;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  // Fragment coordinates are relative to the projectile's position (its head) in its heading frame,
  // except the beam's, which are the world offset from the ship.
  output.local = select(local + vec2f(dot(center - projectile.position, direction), 0.0), world - projectile.position, kind == PROJECTILE_KIND_BEAM);
  output.hue = kindHue(kind);
  output.kind = kind;
  output.shape = vec4f(projectile.radius, halfExtent.x, projectile.seed, fade);
  return output;
}

fn crossProduct(first: vec2f, second: vec2f) -> f32 {
  return first.x * second.y - first.y * second.x;
}

// The beam slot's previous unit direction (seed, extra), or current when it is unset.
fn beamPreviousDirection(projectile: Projectile, current: vec2f) -> vec2f {
  let previous = vec2f(projectile.seed, projectile.extra);
  return select(current, normalize(previous), dot(previous, previous) > 0.25);
}

fn sweptAngle(previous: vec2f, current: vec2f) -> f32 {
  return acos(clamp(dot(previous, current), -1.0, 1.0));
}

// Signed angle of offset from previous, positive in the sweep's turning sense: counterclockwise
// unless the shortest arc to current is clockwise (an exact reversal turns counterclockwise, as
// in projectiles_collide.wgsl).
fn angleFromPrevious(previous: vec2f, current: vec2f, offset: vec2f) -> f32 {
  let turn = select(1.0, -1.0, crossProduct(previous, current) < 0.0);
  return atan2(turn * crossProduct(previous, offset), dot(previous, offset));
}

// The world-axis box (minimum xy, maximum xy) around the sector swept from previous to current,
// clipped by the arena: the origin, both edge ray ends and the arena corners inside the arc,
// widened by margin.
fn beamSweepBounds(origin: vec2f, previous: vec2f, current: vec2f, margin: f32) -> vec4f {
  let previousEnd = origin + previous * distanceToArenaEdge(origin, previous);
  let currentEnd = origin + current * distanceToArenaEdge(origin, current);
  var low = min(origin, min(previousEnd, currentEnd));
  var high = max(origin, max(previousEnd, currentEnd));
  let sweep = sweptAngle(previous, current);
  for (var index = 0u; index < 4u; index = index + 1u) {
    let corner = vec2f(f32(index & 1u) * ARENA_WIDTH, f32(index >> 1u) * ARENA_HEIGHT);
    let angle = angleFromPrevious(previous, current, corner - origin);
    if (angle >= 0.0 && angle <= sweep) {
      low = min(low, corner);
      high = max(high, corner);
    }
  }
  return vec4f(low - vec2f(margin), high + vec2f(margin));
}

fn segmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let along = point - start;
  let segment = end - start;
  let fraction = clamp(dot(along, segment) / dot(segment, segment), 0.0, 1.0);
  return length(along - segment * fraction);
}

// A bright body of the given half thickness around a distance, plus an exponential glow; returns
// (body, glow). feather is the antialiasing width in world units.
fn bodyAndGlow(distance: f32, thickness: f32, feather: f32, glowFalloff: f32) -> vec2f {
  return vec2f(1.0 - smoothstep(thickness - feather, thickness + feather, distance), exp(-max(distance - thickness, 0.0) * glowFalloff));
}

fn neon(hue: f32, saturation: f32) -> vec3f {
  return hsvToRgb(hue, saturation, 1.0);
}

@fragment
fn projectileFragment(input: ProjectileVaryings) -> @location(0) vec4f {
  let feather = max(abs(view.devicePixelToClip.x / view.worldToClipScale.x), 1e-5) * PIXEL_FEATHER;
  let local = input.local;
  let radius = input.shape.x;
  let halfLength = input.shape.y;
  let seed = input.shape.z;
  let fade = input.shape.w;
  let time = view.time;
  var color = vec3f(0.0);
  switch input.kind {
    case PROJECTILE_KIND_BULLET: {
      let along = smoothstep(-BULLET_TAIL, 0.04, local.x);
      let shape = bodyAndGlow(segmentDistance(local, vec2f(-BULLET_TAIL, 0.0), vec2f(0.04, 0.0)), 0.035, feather, 30.0);
      color = (vec3f(1.4) * shape.x + neon(input.hue, GLOW_SATURATION) * shape.y * 0.7) * along;
    }
    case PROJECTILE_KIND_SCATTER: {
      let flicker = 0.7 + 0.3 * sin(time * 90.0 + seed * 40.0);
      let along = smoothstep(-SCATTER_TAIL, 0.03, local.x);
      let shape = bodyAndGlow(segmentDistance(local, vec2f(-SCATTER_TAIL, 0.0), vec2f(0.03, 0.0)), 0.03, feather, 22.0);
      color = (vec3f(1.0, 0.95, 0.8) * shape.x + neon(input.hue, 1.0) * shape.y * 1.1) * along * flicker * fade;
    }
    case PROJECTILE_KIND_RAIL: {
      let tail = 0.05 - (halfLength - 0.12) * 2.0;
      let along = pow(smoothstep(tail, 0.05, local.x), 0.8);
      let shape = bodyAndGlow(segmentDistance(local, vec2f(tail, 0.0), vec2f(0.05, 0.0)), 0.02, feather, 30.0);
      let flare = exp(-length(local - vec2f(0.05, 0.0)) * 22.0);
      color = (vec3f(2.2) * shape.x + neon(input.hue, 0.6) * shape.y * 1.2) * along + vec3f(0.8, 0.95, 1.0) * flare;
    }
    case PROJECTILE_KIND_PULSE_ORB: {
      let pulse = 0.85 + 0.15 * sin(time * 14.0 + seed * 6.28);
      let distance = length(local);
      let body = 1.0 - smoothstep(radius * 0.8 - feather, radius * 1.1 + feather, distance);
      let hot = 1.0 - smoothstep(0.0, radius * 0.7, distance);
      let halo = exp(-distance / (radius * 0.9)) * 0.9;
      color = (neon(input.hue, GLOW_SATURATION) * (body * 0.9 + halo) + vec3f(hot * 1.2)) * pulse;
    }
    case PROJECTILE_KIND_PULSE_RING: {
      let shape = bodyAndGlow(abs(length(local) - radius), 0.022, feather, 16.0);
      color = (neon(input.hue, GLOW_SATURATION) * shape.x * 1.4 + vec3f(shape.x * 0.5) + neon(input.hue, GLOW_SATURATION) * shape.y * 0.6) * fade;
    }
    case PROJECTILE_KIND_SIDEWINDER: {
      let tail = 0.06 - SIDEWINDER_TAIL;
      let progress = clamp((local.x - tail) / (0.06 - tail), 0.0, 1.0);
      let wobble = 0.07 * (1.0 - progress) * sin(local.x * 20.0 - time * 34.0 + seed * 6.28);
      let trail = bodyAndGlow(abs(local.y - wobble), 0.02, feather, 24.0);
      let head = exp(-length(local - vec2f(0.06, 0.0)) * 26.0);
      color = (vec3f(1.0, 0.9, 1.0) * trail.x + neon(input.hue, 1.0) * trail.y * 0.9) * pow(progress, 1.3) + neon(input.hue, 0.5) * head * 1.4;
    }
    default: {
      // Beam: local is the world offset from the ship, shape.w the beam length, radius the half width.
      let current = input.beamDirections.xy;
      let previous = input.beamDirections.zw;
      let origin = input.beamOrigin;
      let beamLength = fade;
      let along = dot(local, current);
      let across = abs(crossProduct(current, local));
      let ripple = 0.88 + 0.12 * sin(along * 7.0 - time * 45.0);
      let flicker = 0.92 + 0.08 * sin(time * 70.0);
      let glowExtent = max(radius * (BEAM_GLOW_FACTOR - 1.0) + BEAM_GLOW_MARGIN, 0.001);
      let body = 1.0 - smoothstep(radius * 0.85 - feather, radius + feather, across);
      let core = 1.0 - smoothstep(radius * 0.25, radius * 0.5 + feather, across);
      let glow = pow(clamp(1.0 - max(across - radius, 0.0) / glowExtent, 0.0, 1.0), 2.5);
      let endFade = smoothstep(0.0, 0.05, 0.05 + min(along, beamLength - along));
      color = (neon(input.hue, GLOW_SATURATION) * (body * 0.9 * ripple + glow * 0.8) + vec3f(core * 1.6)) * flicker * endFade;
      let sweep = sweptAngle(previous, current);
      if (sweep > BEAM_MINIMUM_SWEEP) {
        // The swept fan: the kill sector padded by the half width, brightening toward the current aim.
        let angle = angleFromPrevious(previous, current, local);
        let inside = angle >= 0.0 && angle <= sweep;
        let previousEnd = previous * distanceToArenaEdge(origin, previous);
        let currentEnd = current * distanceToArenaEdge(origin, current);
        let edgeDistance = min(segmentDistance(local, vec2f(0.0), previousEnd), segmentDistance(local, vec2f(0.0), currentEnd));
        let sectorDistance = select(edgeDistance, 0.0, inside);
        let fanBody = 1.0 - smoothstep(radius * 0.85 - feather, radius + feather, sectorDistance);
        let fanGlow = pow(clamp(1.0 - max(sectorDistance - radius, 0.0) / glowExtent, 0.0, 1.0), 2.5);
        let progress = clamp(angle / sweep, 0.0, 1.0);
        let world = origin + local;
        let inArena = f32(all(world >= vec2f(0.0)) && all(world <= vec2f(ARENA_WIDTH, ARENA_HEIGHT)));
        let ramp = mix(BEAM_FAN_TAIL, BEAM_FAN_HEAD, progress);
        // White heat rises toward the current aim so the core blends into the fan instead of leaving comb lines.
        let heat = vec3f(fanBody * BEAM_FAN_HEAT * progress * progress * progress);
        let fan = (neon(input.hue, GLOW_SATURATION) * (fanBody * 0.9 * ripple + fanGlow * 0.5) * ramp + heat) * flicker * inArena;
        color = max(color, fan);
      }
    }
  }
  return vec4f(color, 0.0);
}
