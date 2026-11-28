// Pickups: one instanced quad per pickup (at most MAXIMUM_PICKUPS, drawn as the instance count),
// read from a small uniform array. A slowly rotating hexagon outline in the weapon's hue with a
// soft pulse and a glowing core, alpha times the pickup's fade. floor(hue) is the shape
// (PICKUP_SHAPE_CLOCK and PICKUP_SHAPE_SHARD added in pickups.js): 0 hexagon, 1 the time warp, a
// paler ring with a sweeping hand and a brighter core, a clock, 2 a beam shard, a bright rotating
// diamond that pulses fast with a thick outline. Common and quad headers prepended (hsvToRgb, segmentDistance).

// Uniform layout, total 544 bytes; PickupRenderer in pickups.js writes it.
//   0 worldToClipScale vec2f, 8 worldToClipOffset vec2f, 16 devicePixelToClip vec2f, 24 time f32,
//  28 header padding f32, then 32 pickups of vec4f (x, y, hue, fade).
struct PickupView {
  worldToClipScale: vec2f,
  worldToClipOffset: vec2f,
  devicePixelToClip: vec2f,
  time: f32,
  headerPadding: f32,
  pickups: array<vec4f, 32>,
}

@group(0) @binding(0) var<uniform> view: PickupView;

const HALF_EXTENT: f32 = 0.5;
const HEXAGON_RADIUS: f32 = 0.24;
const OUTLINE_HALF_WIDTH: f32 = 0.028;
const ROTATION_RATE: f32 = 1.2;
const PULSE_RATE: f32 = 3.0;
const SATURATION: f32 = 0.85;
// The time warp clock: hand sweep in radians per second, hand length as a share of the ring,
// a whiter tint and a brighter core than the weapons.
const CLOCK_HAND_RATE: f32 = 2.5;
const CLOCK_HAND_SHARE: f32 = 0.8;
const CLOCK_SATURATION: f32 = 0.45;
const CLOCK_CORE: f32 = 1.4;
const WEAPON_CORE: f32 = 0.8;
const SHAPE_CLOCK: f32 = 1.0;
const SHAPE_SHARD: f32 = 2.0;
// The beam shard diamond: L1 radius inside the half extent, a faster pulse, a thicker outline.
const SHARD_RADIUS: f32 = 0.30;
const SHARD_PULSE_RATE: f32 = PULSE_RATE * 2.0;
const SHARD_OUTLINE_HALF_WIDTH: f32 = OUTLINE_HALF_WIDTH * 1.4;
const SHARD_SATURATION: f32 = 0.7;
const SHARD_CORE: f32 = 1.8;

struct PickupVaryings {
  @builtin(position) position: vec4f,
  @location(0) offset: vec2f,
  @location(1) @interpolate(flat) hue: f32,
  @location(2) @interpolate(flat) fade: f32,
  @location(3) @interpolate(flat) phase: f32,
}

@vertex
fn pickupVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) instanceIndex: u32) -> PickupVaryings {
  var output: PickupVaryings;
  let pickup = view.pickups[instanceIndex];
  let corner = quadCorner(vertexIndex);
  output.offset = corner * HALF_EXTENT;
  let world = pickup.xy + output.offset;
  output.position = vec4f(world * view.worldToClipScale + view.worldToClipOffset, 0.0, 1.0);
  output.hue = pickup.z;
  output.fade = pickup.w;
  output.phase = f32(instanceIndex) * 1.7;
  return output;
}

// Regular hexagon with the given circumradius (Inigo Quilez), flat sides up.
fn hexagonDistance(point: vec2f, radius: f32) -> f32 {
  let constants = vec3f(-0.866025404, 0.5, 0.577350269);
  var folded = abs(point);
  folded -= 2.0 * min(dot(constants.xy, folded), 0.0) * constants.xy;
  folded -= vec2f(clamp(folded.x, -constants.z * radius, constants.z * radius), radius);
  return length(folded) * sign(folded.y);
}

@fragment
fn pickupFragment(input: PickupVaryings) -> @location(0) vec4f {
  let feather = worldFeather(view.devicePixelToClip, view.worldToClipScale);
  let angle = view.time * ROTATION_RATE + input.phase;
  let cosine = cos(angle);
  let sine = sin(angle);
  let rotated = vec2f(cosine * input.offset.x + sine * input.offset.y, -sine * input.offset.x + cosine * input.offset.y);
  let shape = floor(input.hue);
  let clock = shape == SHAPE_CLOCK;
  let shard = shape == SHAPE_SHARD;
  let pulseRate = select(PULSE_RATE, SHARD_PULSE_RATE, shard);
  let pulse = 1.0 + 0.1 * sin(view.time * pulseRate + input.phase);
  let halfWidth = select(OUTLINE_HALF_WIDTH, SHARD_OUTLINE_HALF_WIDTH, shard);
  var outline = abs(hexagonDistance(rotated, HEXAGON_RADIUS * pulse));
  if (clock) {
    let handAngle = view.time * CLOCK_HAND_RATE + input.phase;
    let hand = vec2f(sin(handAngle), cos(handAngle)) * HEXAGON_RADIUS * CLOCK_HAND_SHARE;
    outline = min(abs(length(input.offset) - HEXAGON_RADIUS * pulse), segmentDistance(input.offset, vec2f(0.0), hand));
  }
  if (shard) {
    outline = abs(abs(rotated.x) + abs(rotated.y) - SHARD_RADIUS * pulse) * 0.70710678;
  }
  let band = 1.0 - smoothstep(halfWidth, halfWidth + feather * 2.0, outline);
  let glow = exp(-max(outline - halfWidth, 0.0) * 16.0) * 0.6;
  var coreStrength = WEAPON_CORE;
  var saturation = SATURATION;
  if (clock) {
    coreStrength = CLOCK_CORE;
    saturation = CLOCK_SATURATION;
  }
  if (shard) {
    coreStrength = SHARD_CORE;
    saturation = SHARD_SATURATION;
  }
  let core = exp(-length(input.offset) * 14.0) * coreStrength;
  let tint = hsvToRgb(fract(input.hue), saturation, 1.0);
  let color = tint * (band * 1.5 + glow + core) + vec3f(band * 0.4);
  return vec4f(color * input.fade, 0.0);
}
