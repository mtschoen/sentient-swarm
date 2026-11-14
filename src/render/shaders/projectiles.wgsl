// Projectiles: one instance per projectile slot (4-vertex triangle strip) pulled straight from the
// projectile storage buffer, max-blended (see MAX_BLEND). Dead slots collapse to a degenerate quad. Common
// and quad headers prepended (Projectile, PROJECTILE_KIND_*, hsvToRgb, segmentDistance).
// All geometry is in world units in a frame whose +x is the projectile's heading (origin at its
// position), so a quad is a centre, a heading and a half extent; each kind has its own silhouette in the fragment shader:
//   bullet     energy ball: white core, hued body, halo        scatter  smaller flickering orange ball
//   rail       very long hair-thin needle, sharp white core    orb      pulsing glow disc
//   ring       thick expanding wave front over a faint disc    sidewinder  missile body with a weaving exhaust ribbon
//   beam       the fat laser from the ship to the arena edge, white core inside a coloured body,
//              plus a fan over the sector swept since the previous step, fading toward the previous aim;
//              a beam slot lifetime under 1 (the lab's beam sweep budget, its kill reach scale) cuts
//              the laser and the fan at that fraction of the current ray's length, as the collide
//              pass cuts the kill sector
// Slot 0 is the beam; the CPU rewrites it every frame while firing, with the previous step's unit
// direction in seed and extra (projectiles_collide.wgsl kills the same sector).

// Uniform layout, total 80 bytes; ProjectileRenderer in projectiles.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, 32 hues vec4f (bullet, scatter, rail, orb), 48 hues vec4f (ring, sidewinder, beam, pad),
//  64 worldBounds vec4f (minX, minY, maxX, maxY: the simulation's playable rectangle in world units)
struct ProjectileView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  huesFirst: vec4f,
  huesSecond: vec4f,
  worldBounds: vec4f,
}

@group(0) @binding(0) var<uniform> view: ProjectileView;
@group(0) @binding(1) var<storage, read> projectiles: array<Projectile>;

// Energy balls (bullet and scatter): the halo reaches BALL_HALO_FACTOR times the radius, about the
// kill reach (radius plus the collide pass's 0.02 margin) and then some, so what shows is what
// kills; the quad adds BALL_QUAD_MARGIN for the feather. The trail decay draws the streak.
const BALL_HALO_FACTOR: f32 = 1.5;
const BALL_QUAD_MARGIN: f32 = 0.02;
const RAIL_SECONDS_OF_TRAVEL: f32 = 0.07;
const RAIL_MINIMUM_LENGTH: f32 = 0.6;
const SIDEWINDER_TAIL: f32 = 0.7;
const ORB_GLOW_RADIUS_FACTOR: f32 = 3.5;
const RING_GLOW_MARGIN: f32 = 0.35;
const BEAM_GLOW_FACTOR: f32 = 2.2;
const BEAM_GLOW_MARGIN: f32 = 0.1;
const SCATTER_FADE_SECONDS: f32 = 0.12;
const GLOW_SATURATION: f32 = 0.85;
// Sweeps narrower than this (radians) draw as the plain beam quad.
const BEAM_MINIMUM_SWEEP: f32 = 0.002;
// The fan's brightness at the previous aim and at the current one (times the body brightness).
const BEAM_FAN_TAIL: f32 = 0.35;
const BEAM_FAN_HEAD: f32 = 1.0;
// White added to the fan at the current aim (cubic falloff toward the previous aim).
const BEAM_FAN_HEAT: f32 = 0.6;
// Longer than any ray in the arena: the draw limit of a beam at full reach (lifetime 1).
const BEAM_UNLIMITED_REACH: f32 = 1e9;

struct ProjectileVaryings {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) @interpolate(flat) hue: f32,
  @location(2) @interpolate(flat) kind: u32,
  // x radius (or half beam width), y half extent along the heading, z seed, w fade 0..1.
  @location(3) @interpolate(flat) shape: vec4f,
  // Beam only: xy the current unit direction, zw the previous one (equal for no sweep).
  @location(4) @interpolate(flat) beamDirections: vec4f,
  // Beam only: xy the ship position the beam starts from, z the distance past which nothing is
  // drawn (BEAM_UNLIMITED_REACH at full reach), w unused.
  @location(5) @interpolate(flat) beamOrigin: vec4f,
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
    select(view.worldBounds.x - origin.x, view.worldBounds.z - origin.x, direction.x > 0.0),
    select(view.worldBounds.y - origin.y, view.worldBounds.w - origin.y, direction.y > 0.0),
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
  output.beamOrigin = vec4f(0.0);
  let projectile = projectiles[instanceIndex];
  if ((projectile.flags & PROJECTILE_FLAG_ALIVE) == 0u) {
    return output;
  }
  let kind = projectile.kind;
  let speed = length(projectile.velocity);
  let direction = select(vec2f(1.0, 0.0), projectile.velocity / max(speed, 1e-6), speed > 1e-5);
  let side = vec2f(-direction.y, direction.x);
  var center = projectile.position;
  let isMissileRing = (projectile.flags & PROJECTILE_FLAG_MISSILE_RING) != 0u;
  var halfExtent = vec2f(0.1);
  var fade = 1.0;
  // The swept beam's quad is the sector's world-axis bounding box instead of a heading frame.
  var axisAligned = false;
  switch kind {
    case PROJECTILE_KIND_BULLET: {
      // Centred on the ball; the halo is zero at BALL_HALO_FACTOR times the radius.
      halfExtent = vec2f(projectile.radius * BALL_HALO_FACTOR + BALL_QUAD_MARGIN);
    }
    case PROJECTILE_KIND_SCATTER: {
      halfExtent = vec2f(projectile.radius * BALL_HALO_FACTOR + BALL_QUAD_MARGIN);
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
      fade = clamp(projectile.lifetime / select(RING_LIFETIME, MISSILE_RING_LIFETIME, isMissileRing), 0.0, 1.0);
    }
    case PROJECTILE_KIND_SIDEWINDER: {
      halfExtent = vec2f(SIDEWINDER_TAIL * 0.5 + 0.1, 0.3);
      center = projectile.position - direction * (SIDEWINDER_TAIL * 0.5 - 0.06);
    }
    default: {
      // Beam: from the ship (position) along the unit direction to the arena edge, or to the reach
      // limit (beamReachLimit) when the slot's lifetime scales the reach down.
      let limit = beamReachLimit(projectile, direction);
      let length = min(distanceToArenaEdge(projectile.position, direction), limit);
      let glowWidth = projectile.radius * BEAM_GLOW_FACTOR + BEAM_GLOW_MARGIN;
      halfExtent = vec2f(length * 0.5 + 0.05, glowWidth);
      center = projectile.position + direction * (length * 0.5);
      let previous = beamPreviousDirection(projectile, direction);
      output.beamDirections = vec4f(direction, previous);
      output.beamOrigin = vec4f(projectile.position, limit, 0.0);
      if (sweptAngle(previous, direction) > BEAM_MINIMUM_SWEEP) {
        let bounds = beamSweepBounds(projectile.position, previous, direction, limit, glowWidth + 0.05);
        center = (bounds.xy + bounds.zw) * 0.5;
        halfExtent = (bounds.zw - bounds.xy) * 0.5;
        axisAligned = true;
      }
      // shape.w carries the beam length to the fragment.
      fade = length;
    }
  }
  let corner = quadCorner(vertexIndex);
  let local = corner * halfExtent;
  let quadDirection = select(direction, vec2f(1.0, 0.0), axisAligned);
  let quadSide = vec2f(-quadDirection.y, quadDirection.x);
  // World y grows downward like the screen, so the world offset maps through the signed scale.
  let world = center + quadDirection * local.x + quadSide * local.y;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  // Fragment coordinates are relative to the projectile's position (its head) in its heading frame,
  // except the beam's, which are the world offset from the ship.
  output.local = select(local + vec2f(dot(center - projectile.position, direction), 0.0), world - projectile.position, kind == PROJECTILE_KIND_BEAM);
  output.hue = kindHue(select(kind, PROJECTILE_KIND_SIDEWINDER, kind == PROJECTILE_KIND_PULSE_RING && isMissileRing));
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

// The beam's draw limit: lifetime (its kill reach scale) times the current ray's length to the
// edge when below 1, as beamSector in projectiles_collide.wgsl, else BEAM_UNLIMITED_REACH.
fn beamReachLimit(projectile: Projectile, current: vec2f) -> f32 {
  if (projectile.lifetime < 1.0) {
    return max(projectile.lifetime, 0.0) * distanceToArenaEdge(projectile.position, current);
  }
  return BEAM_UNLIMITED_REACH;
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
// clipped by the arena and the reach limit: the origin, both edge ray ends and the arena corners
// inside the arc and the limit, widened by margin. A limited sector's arc can bulge past its ray
// ends, so the box then also takes in the limit circle's box (clipped by the arena).
fn beamSweepBounds(origin: vec2f, previous: vec2f, current: vec2f, limit: f32, margin: f32) -> vec4f {
  let previousEnd = origin + previous * min(distanceToArenaEdge(origin, previous), limit);
  let currentEnd = origin + current * min(distanceToArenaEdge(origin, current), limit);
  var low = min(origin, min(previousEnd, currentEnd));
  var high = max(origin, max(previousEnd, currentEnd));
  let sweep = sweptAngle(previous, current);
  for (var index = 0u; index < 4u; index = index + 1u) {
    let corner = select(view.worldBounds.xy, view.worldBounds.zw, vec2<bool>((index & 1u) == 1u, (index >> 1u) == 1u));
    let angle = angleFromPrevious(previous, current, corner - origin);
    if (angle >= 0.0 && angle <= sweep && length(corner - origin) <= limit) {
      low = min(low, corner);
      high = max(high, corner);
    }
  }
  if (limit < BEAM_UNLIMITED_REACH) {
    low = min(low, max(origin - vec2f(limit), view.worldBounds.xy));
    high = max(high, min(origin + vec2f(limit), view.worldBounds.zw));
  }
  return vec4f(low - vec2f(margin), high + vec2f(margin));
}

// A bright body of the given half thickness around a distance, plus an exponential glow; returns
// (body, glow). feather is the antialiasing width in world units.
fn bodyAndGlow(distance: f32, thickness: f32, feather: f32, glowFalloff: f32) -> vec2f {
  return vec2f(1.0 - smoothstep(thickness - feather, thickness + feather, distance), exp(-max(distance - thickness, 0.0) * glowFalloff));
}

// An energy ball at distance from its center: (core, body, halo). The white core fills about half
// the radius, the hued body the radius, and the halo falls from the radius to zero at
// BALL_HALO_FACTOR times it.
fn energyBall(distance: f32, radius: f32, feather: f32) -> vec3f {
  let core = 1.0 - smoothstep(radius * 0.35 - feather, radius * 0.55 + feather, distance);
  let body = 1.0 - smoothstep(radius * 0.85 - feather, radius + feather, distance);
  let haloExtent = max(radius * (BALL_HALO_FACTOR - 1.0), 0.001);
  let halo = pow(clamp(1.0 - max(distance - radius, 0.0) / haloExtent, 0.0, 1.0), 2.0) * (1.0 - body);
  return vec3f(core, body, halo);
}

fn neon(hue: f32, saturation: f32) -> vec3f {
  return hsvToRgb(hue, saturation, 1.0);
}

@fragment
fn projectileFragment(input: ProjectileVaryings) -> @location(0) vec4f {
  let feather = worldFeather(view.devicePixelToClip, view.worldToClipScale);
  let local = input.local;
  let radius = input.shape.x;
  let halfLength = input.shape.y;
  let seed = input.shape.z;
  let fade = input.shape.w;
  let time = view.time;
  var color = vec3f(0.0);
  switch input.kind {
    case PROJECTILE_KIND_BULLET: {
      let ball = energyBall(length(local), radius, feather);
      let shimmer = 0.92 + 0.08 * sin(time * 30.0 + seed * 6.28);
      color = (vec3f(1.5) * ball.x + neon(input.hue, GLOW_SATURATION) * (ball.y * 0.75 + ball.z * 0.55)) * shimmer;
    }
    case PROJECTILE_KIND_SCATTER: {
      let flicker = 0.7 + 0.3 * sin(time * 90.0 + seed * 40.0);
      let ball = energyBall(length(local), radius, feather);
      color = (vec3f(1.0, 0.95, 0.8) * ball.x * 1.2 + neon(input.hue, 1.0) * (ball.y * 0.8 + ball.z * 0.6)) * flicker * fade;
    }
    case PROJECTILE_KIND_RAIL: {
      // A needle: a hair-thin white core with a hard edge, a tight glow hugging it, a long fading
      // tail and a sharp spark at the head; the glow is narrow across and long along, never a disc.
      let tail = 0.05 - (halfLength - 0.12) * 2.0;
      let along = pow(smoothstep(tail, 0.05, local.x), 0.7);
      let shape = bodyAndGlow(segmentDistance(local, vec2f(tail, 0.0), vec2f(0.05, 0.0)), max(0.012, feather * 1.3), feather, 40.0);
      let spark = exp(-abs(local.y) * 70.0) * exp(-abs(local.x - 0.05) * 9.0);
      color = (vec3f(3.5) * shape.x + neon(input.hue, 0.8) * shape.y * 1.8) * along + vec3f(0.85, 0.95, 1.0) * spark * 1.2;
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
      // A thick bright wave front with a white edge and a faint filled disc behind it; the fade
      // eases off so the ring stays readable while it expands.
      let ringDistance = length(local);
      let shape = bodyAndGlow(abs(ringDistance - radius), 0.04, feather, 11.0);
      let disc = (1.0 - smoothstep(radius - 0.05, radius, ringDistance)) * 0.14;
      let visibility = pow(fade, 0.6);
      color = (neon(input.hue, GLOW_SATURATION) * (shape.x * 1.6 + shape.y * 0.8 + disc) + vec3f(shape.x * 0.8)) * visibility;
    }
    case PROJECTILE_KIND_SIDEWINDER: {
      // A missile: a white dart body with a pointed nose and two small fins, a hot exhaust flare at
      // its tail and a weaving exhaust ribbon that fades behind it.
      let bodyTail = -0.2;
      let nose = 0.06;
      let bodyFraction = clamp((local.x - bodyTail) / (nose - bodyTail), 0.0, 1.0);
      let bodyThickness = 0.042 * (1.0 - pow(bodyFraction, 4.0)) + 0.004;
      let bodyDistance = segmentDistance(local, vec2f(bodyTail, 0.0), vec2f(nose, 0.0));
      let bodyMask = (1.0 - smoothstep(bodyThickness - feather, bodyThickness + feather, abs(local.y))) * step(bodyTail, local.x) * step(local.x, nose + 0.01);
      let finOffset = 0.09 * (1.0 - clamp((local.x - bodyTail) / 0.1, 0.0, 1.0));
      let finMask = (1.0 - smoothstep(0.0, feather * 2.0, abs(abs(local.y) - finOffset) - 0.012)) * step(bodyTail, local.x) * step(local.x, bodyTail + 0.1);
      let bodyGlow = exp(-bodyDistance * 22.0);
      let flare = exp(-length((local - vec2f(bodyTail, 0.0)) * vec2f(0.8, 2.0)) * 20.0) * (0.8 + 0.2 * sin(time * 80.0 + seed * 40.0));
      let ribbonTail = bodyTail - (SIDEWINDER_TAIL - 0.26);
      let progress = clamp((local.x - ribbonTail) / (bodyTail - ribbonTail), 0.0, 1.0);
      let wobble = 0.09 * (1.0 - progress) * sin(local.x * 16.0 - time * 30.0 + seed * 6.28);
      let ribbon = bodyAndGlow(abs(local.y - wobble), 0.024, feather, 20.0);
      let ribbonMask = pow(progress, 1.1) * step(local.x, bodyTail + 0.02);
      color = vec3f(1.2, 1.1, 1.3) * (bodyMask + finMask * 0.8) + neon(input.hue, 1.0) * (bodyGlow * 0.7 + flare * 1.4)
        + (vec3f(0.9, 0.7, 1.0) * ribbon.x + neon(input.hue, 1.0) * ribbon.y * 1.0) * ribbonMask;
    }
    default: {
      // Beam: local is the world offset from the ship, shape.w the beam length, radius the half width.
      let current = input.beamDirections.xy;
      let previous = input.beamDirections.zw;
      let origin = input.beamOrigin.xy;
      let limit = input.beamOrigin.z;
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
        let previousEnd = previous * min(distanceToArenaEdge(origin, previous), limit);
        let currentEnd = current * min(distanceToArenaEdge(origin, current), limit);
        let edgeDistance = min(segmentDistance(local, vec2f(0.0), previousEnd), segmentDistance(local, vec2f(0.0), currentEnd));
        // Inside the arc, past the reach limit the nearest sector point lies on the limit's arc.
        let sectorDistance = select(edgeDistance, max(length(local) - limit, 0.0), inside);
        let fanBody = 1.0 - smoothstep(radius * 0.85 - feather, radius + feather, sectorDistance);
        let fanGlow = pow(clamp(1.0 - max(sectorDistance - radius, 0.0) / glowExtent, 0.0, 1.0), 2.5);
        let progress = clamp(angle / sweep, 0.0, 1.0);
        let world = origin + local;
        let inArena = f32(all(world >= view.worldBounds.xy) && all(world <= view.worldBounds.zw));
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
